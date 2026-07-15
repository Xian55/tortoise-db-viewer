// bun --preload target: wires the shared browser lifecycle around every test in
// this process (a shard). Registered ONCE per process, so beforeAll launches +
// warms a single browser that all test files reuse.
//   bun test --preload ./scripts/smoke/setup.mjs scripts/smoke
import { beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { launch, warm, resetState, assertNoErrors, close } from "./harness.mjs";

// Explicit timeouts OVERRIDE bun's 5000ms default (which also caps hooks). A cold
// first run downloads the ~34 MB DB into a fresh per-shard OPFS profile -- under
// parallel shard contention that easily exceeds 5s, so beforeAll needs real headroom
// (else the hook times out and every test in the process fails instantly). resetState
// may do a full shell reload when healing from a foreign-doc test.
beforeAll(async () => { await launch(); await warm(); }, 180000);
afterAll(close, 15000); // close() self-caps at 8s (graceful) then force-kills
beforeEach(resetState, 90000);
afterEach(assertNoErrors);
