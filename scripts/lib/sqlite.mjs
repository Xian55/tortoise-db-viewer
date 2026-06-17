// Runtime-agnostic SQLite wrapper.
// Under Bun: native bun:sqlite (no native compile needed).
// Under Node: better-sqlite3.
// Exposes the small subset build-db.mjs uses: pragma / exec / prepare / transaction / close.

const isBun = typeof globalThis.Bun !== "undefined";

// better-sqlite3 accepts a single array of params; bun:sqlite wants them spread.
// Normalize either calling style to a flat positional list.
function flat(args) {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

class Wrapped {
  constructor(db, bun) {
    this.db = db;
    this.bun = bun;
  }
  pragma(s) {
    // bun:sqlite has no .pragma(); run it as a statement instead.
    this.bun ? this.db.exec(`PRAGMA ${s};`) : this.db.pragma(s);
  }
  exec(s) {
    this.db.exec(s);
  }
  prepare(s) {
    const st = this.db.prepare(s);
    return {
      run: (...a) => st.run(...flat(a)),
      all: (...a) => st.all(...flat(a)),
      get: (...a) => st.get(...flat(a)),
    };
  }
  transaction(fn) {
    return this.db.transaction(fn);
  }
  close() {
    this.db.close();
  }
}

export async function openDatabase(path) {
  if (isBun) {
    const { Database } = await import("bun:sqlite");
    return new Wrapped(new Database(path, { create: true }), true);
  }
  const { default: Database } = await import("better-sqlite3");
  return new Wrapped(new Database(path), false);
}

export const RUNTIME = isBun ? "bun" : "node";
