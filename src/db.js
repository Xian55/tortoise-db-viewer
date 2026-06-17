// sql.js-httpvfs: query a remote SQLite file over HTTP range requests.
// Only the B-tree pages needed for each query are downloaded, so a single
// item lookup costs a few KB even though the DB is ~27 MB.
import { createDbWorker } from "sql.js-httpvfs";

const workerUrl = new URL("sql.js-httpvfs/dist/sqlite.worker.js", import.meta.url);
const wasmUrl = new URL("sql.js-httpvfs/dist/sql-wasm.wasm", import.meta.url);

const DB_URL = import.meta.env.BASE_URL + "data/tortoise.sqlite";

let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = createDbWorker(
      [{
        from: "inline",
        config: {
          serverMode: "full",
          url: DB_URL,
          requestChunkSize: 4096,
        },
      }],
      workerUrl.toString(),
      wasmUrl.toString(),
    );
  }
  return workerPromise;
}

/** Run a SQL query, returning an array of row objects. */
export async function query(sql, params = []) {
  const worker = await getWorker();
  return worker.db.query(sql, params);
}

/** Run a query and return the first row (or null). */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/** Warm up the worker + DB header in the background. */
export function preconnect() {
  getWorker().catch(() => {});
}
