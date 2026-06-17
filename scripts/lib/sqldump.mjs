// Minimal, fast parser for mysqldump / mariadb-dump output.
// Handles: CREATE TABLE column order, multi-row extended INSERTs,
// backslash escapes, NULL, quoted strings. No external deps.
import { readFileSync } from "node:fs";

const NULL = Symbol("NULL");
export { NULL };

/** Read column names from the CREATE TABLE block, in definition order. */
export function parseColumns(sql) {
  const start = sql.indexOf("CREATE TABLE");
  if (start < 0) throw new Error("no CREATE TABLE found");
  const open = sql.indexOf("(", start);
  const cols = [];
  let i = open + 1;
  let depth = 1;
  // Walk lines until matching close paren depth.
  const len = sql.length;
  let line = "";
  for (; i < len; i++) {
    const c = sql[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) break;
    }
    if (c === "\n") {
      const m = line.match(/^\s*`([^`]+)`\s/);
      if (m) cols.push(m[1]);
      line = "";
    } else {
      line += c;
    }
  }
  return cols;
}

/**
 * Iterate every row of every `INSERT INTO <table> VALUES (...)` statement.
 * Yields arrays of values (numbers, strings, or NULL symbol) positionally.
 * `table` filters to a specific table name.
 */
export function* iterRows(sql, table) {
  const needle = "INSERT INTO `" + table + "`";
  let pos = 0;
  const len = sql.length;
  while ((pos = sql.indexOf(needle, pos)) !== -1) {
    // Move to "VALUES" then to first "(".
    let i = sql.indexOf("VALUES", pos);
    if (i < 0) return;
    i = sql.indexOf("(", i);
    pos = i;
    // Parse a comma-separated list of (...) tuples until the terminating ";".
    while (i < len) {
      const c = sql[i];
      if (c === "(") {
        const [row, next] = parseTuple(sql, i);
        yield row;
        i = next;
        // skip until ',' (next tuple) or ';' (end of statement)
        while (i < len && sql[i] !== "," && sql[i] !== ";") i++;
        if (i >= len || sql[i] === ";") {
          pos = i + 1;
          break;
        }
        i++; // skip comma
      } else if (c === ";" || c === "\n" || c === " " || c === "\r") {
        if (c === ";") {
          pos = i + 1;
          break;
        }
        i++;
      } else {
        i++;
      }
    }
  }
}

// Parse one (...) tuple starting at sql[start] === '('. Returns [values[], indexAfterCloseParen].
function parseTuple(sql, start) {
  const values = [];
  let i = start + 1;
  const len = sql.length;
  while (i < len) {
    const c = sql[i];
    if (c === ")") {
      i++;
      break;
    }
    if (c === ",") {
      i++;
      continue;
    }
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i++;
      continue;
    }
    if (c === "'") {
      // quoted string with backslash + doubled-quote escapes
      let s = "";
      i++;
      while (i < len) {
        const ch = sql[i];
        if (ch === "\\") {
          const n = sql[i + 1];
          switch (n) {
            case "n": s += "\n"; break;
            case "r": s += "\r"; break;
            case "t": s += "\t"; break;
            case "0": s += "\0"; break;
            case "b": s += "\b"; break;
            case "Z": s += "\x1a"; break;
            default: s += n; // \' \\ \" and any other
          }
          i += 2;
          continue;
        }
        if (ch === "'") {
          if (sql[i + 1] === "'") { s += "'"; i += 2; continue; } // doubled quote
          i++;
          break;
        }
        s += ch;
        i++;
      }
      values.push(s);
    } else {
      // unquoted token: number or NULL, ends at , or )
      let tok = "";
      while (i < len && sql[i] !== "," && sql[i] !== ")") {
        tok += sql[i];
        i++;
      }
      tok = tok.trim();
      if (tok === "NULL") values.push(NULL);
      else {
        const num = Number(tok);
        values.push(Number.isNaN(num) ? tok : num);
      }
    }
  }
  return [values, i];
}

/** Load a dump file and return { columns, rows } where rows are objects keyed by column. */
export function loadTable(path, table) {
  const sql = readFileSync(path, "utf8");
  const columns = parseColumns(sql);
  return { columns, sql, rows: iterRows(sql, table) };
}
