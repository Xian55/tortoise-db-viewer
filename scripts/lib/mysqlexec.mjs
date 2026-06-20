// Minimal MySQL-dump -> SQLite statement applier for the Tortoise-WoW world
// migrations (sql/database_updates). It is NOT a general SQL engine: it splits a
// migration file into statements, re-escapes string literals from MySQL rules to
// SQLite rules, and rewrites the handful of MySQL-isms the migrations use so the
// statements can be fed to a SQLite `exec`. Statements that target a table we are
// not staging are skipped by the caller (see `tableOf`).
//
// Handled: INSERT [IGNORE], REPLACE INTO, UPDATE, DELETE, DROP TABLE, CREATE
// TABLE, ON DUPLICATE KEY UPDATE. Skipped: SET/LOCK/UNLOCK/DELIMITER/START/
// COMMIT and /*! ... */ exec-comments (session/no-op for our purposes).

// Walk `sql` char-by-char, honouring MySQL string escaping and comments, and
// split into statements at top-level `;`. String literals are rewritten in place
// to SQLite form (only '' escapes a quote; no backslash escapes), so the result
// is safe to hand to SQLite. Comments are dropped.
export function splitStatements(sql) {
  const out = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // line comment: -- ... (MySQL requires whitespace after --) or # ...
    if ((c === "-" && sql[i + 1] === "-" && (sql[i + 2] === " " || sql[i + 2] === "\t" || sql[i + 2] === "\n" || sql[i + 2] === "\r" || sql[i + 2] === undefined)) || c === "#") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // block comment: /* ... */  (including /*! executable */ -- we drop these;
    // the migrations only use them for session pragmas we don't need)
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // backtick identifier: copy verbatim (SQLite accepts backticks)
    if (c === "`") {
      buf += c;
      i++;
      while (i < n && sql[i] !== "`") { buf += sql[i]; i++; }
      if (i < n) { buf += "`"; i++; }
      continue;
    }
    // double-quoted string (rare in these dumps) -> treat as a string literal,
    // emit as a SQLite single-quoted literal
    if (c === '"' || c === "'") {
      const { value, next } = readString(sql, i, c);
      buf += "'" + value.replace(/'/g, "''") + "'";
      i = next;
      continue;
    }
    if (c === ";") {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

// Read a MySQL string literal starting at `start` (which is the opening quote
// `q`), decoding MySQL escape sequences into the actual characters. Returns the
// decoded value and the index just past the closing quote.
function readString(sql, start, q) {
  let i = start + 1;
  let value = "";
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "\\") {
      const e = sql[i + 1];
      switch (e) {
        case "0": value += "\0"; break;
        case "n": value += "\n"; break;
        case "r": value += "\r"; break;
        case "t": value += "\t"; break;
        case "b": value += "\b"; break;
        case "Z": value += "\x1a"; break;
        case "\\": value += "\\"; break;
        case "'": value += "'"; break;
        case '"': value += '"'; break;
        case "%": value += "\\%"; break; // LIKE wildcard escapes keep the backslash
        case "_": value += "\\_"; break;
        default: value += e ?? ""; break;
      }
      i += 2;
      continue;
    }
    // doubled quote = literal quote
    if (c === q && sql[i + 1] === q) { value += q; i += 2; continue; }
    if (c === q) { i++; break; }
    value += c;
    i++;
  }
  return { value, next: i };
}

// Identify the verb + target table of a (comment-free) statement. Returns
// { verb, table } with table lowercased and unquoted, or { verb:'other' }.
export function classify(stmt) {
  const m = stmt.match(/^\s*(INSERT\s+IGNORE|INSERT|REPLACE|UPDATE|DELETE|DROP\s+TABLE|CREATE\s+TABLE)\b/i);
  if (!m) return { verb: "other" };
  const verb = m[1].toUpperCase().replace(/\s+/g, " ");
  // table name after the verb keyword(s)
  let rest = stmt.slice(m[0].length);
  // INSERT/REPLACE -> INTO; DELETE -> FROM; DROP/CREATE TABLE -> [IF (NOT )EXISTS]
  rest = rest.replace(/^\s+(INTO|FROM)\b/i, "");
  rest = rest.replace(/^\s+IF\s+(NOT\s+)?EXISTS\b/i, "");
  const tm = rest.match(/^\s*`?([a-zA-Z0-9_]+)`?/);
  return { verb, table: tm ? tm[1].toLowerCase() : undefined };
}

// Rewrite the (single) target-table token of a statement to `tgt`. The
// migrations are single-table DML (no JOINs/subqueries), so only the leading
// table reference after the verb keyword needs rewriting.
function rewriteTable(stmt, verb, tgt) {
  if (verb === "UPDATE") return stmt.replace(/^(\s*UPDATE\s+)`?[a-zA-Z0-9_]+`?/i, `$1\`${tgt}\``);
  if (verb === "DELETE") return stmt.replace(/^(\s*DELETE\s+FROM\s+)`?[a-zA-Z0-9_]+`?/i, `$1\`${tgt}\``);
  // INSERT [OR ...] INTO / REPLACE INTO
  return stmt.replace(/^(\s*(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+)`?[a-zA-Z0-9_]+`?/i, `$1\`${tgt}\``);
}

// Rewrite MySQL-isms in a statement so SQLite accepts it, retargeting the table
// to `pfx + table` (the staging table). `staged` is a Set of real table names we
// maintain; statements for other tables are returned as null (caller skips).
export function translate(stmt, staged, pfx = "") {
  const { verb, table } = classify(stmt);
  if (verb === "other") return null; // SET/LOCK/etc.
  if (!table || !staged.has(table)) return null;
  const tgt = pfx + table;

  if (verb === "DROP TABLE") return `DELETE FROM \`${tgt}\``; // keep our schema, clear rows
  if (verb === "CREATE TABLE") return null; // we already created a compatible staging table

  let s = stmt;
  if (verb === "INSERT IGNORE") s = s.replace(/^\s*INSERT\s+IGNORE/i, "INSERT OR IGNORE");
  // ON DUPLICATE KEY UPDATE -> upsert by replace (drop the trailing clause)
  if (/ON\s+DUPLICATE\s+KEY\s+UPDATE/i.test(s)) {
    s = s.replace(/\s+ON\s+DUPLICATE\s+KEY\s+UPDATE[\s\S]*$/i, "");
    s = s.replace(/^\s*INSERT(\s+OR\s+\w+)?\s+INTO/i, "INSERT OR REPLACE INTO");
  }
  return rewriteTable(s, verb === "INSERT IGNORE" ? "INSERT" : verb, tgt);
}
