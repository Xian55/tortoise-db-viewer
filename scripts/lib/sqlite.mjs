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
    const bun = this.bun;
    return {
      run: (...a) => st.run(...flat(a)),
      all: (...a) => st.all(...flat(a)),
      get: (...a) => st.get(...flat(a)),
      // Rows as POSITIONAL arrays instead of objects. For the staging read-back that is
      // most of a row's cost: building an object per row and then mapping it back to an
      // array showed up at ~12% of the whole build in a CPU profile, for data that was
      // positional on both sides of the trip. better-sqlite3 makes raw mode sticky on the
      // statement, so it is switched back off afterwards.
      values: (...a) => {
        if (bun) return st.values(...flat(a));
        st.raw(true);
        try { return st.all(...flat(a)); } finally { st.raw(false); }
      },
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
