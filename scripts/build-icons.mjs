// OPTIONAL: augment public/data/icons.json with icon names from a client
// ItemDisplayInfo.dbc. scripts/build-db.mjs already builds icons.json from the
// repo's item_display_info table (covers standard items); run this only to add
// icons for custom Turtle displays that aren't in that table. It MERGES into the
// existing icons.json rather than replacing it.
//
// Get ItemDisplayInfo.dbc out of your Turtle client (patch MPQs hold the custom
// icons) with any MPQ extractor, then:
//
//   ITEMDISPLAYINFO_DBC="X:/path/ItemDisplayInfo.dbc" node scripts/build-icons.mjs
//
// Icons are served from the Blizzard render CDN:
//   https://render-us.worldofwarcraft.com/icons/56/<iconname>.jpg
//
// ICON_FIELD overrides the 0-based field index of inventoryIcon[0] (default 5,
// correct for build 5875 / patch 1.12.x).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DBC = process.env.ITEMDISPLAYINFO_DBC || process.argv[2];
const ICON_FIELD = Number(process.env.ICON_FIELD || 5);
const OUT = join(ROOT, "public", "data", "icons.json");

if (!DBC) {
  console.error("Usage: ITEMDISPLAYINFO_DBC=path/ItemDisplayInfo.dbc node scripts/build-icons.mjs");
  process.exit(1);
}

const buf = readFileSync(DBC);
if (buf.toString("ascii", 0, 4) !== "WDBC") {
  console.error("Not a WDBC file:", DBC);
  process.exit(1);
}

const recordCount = buf.readUInt32LE(4);
const fieldCount = buf.readUInt32LE(8);
const recordSize = buf.readUInt32LE(12);
const stringSize = buf.readUInt32LE(16);
const HEADER = 20;
const stringStart = HEADER + recordCount * recordSize;

function readString(offset) {
  if (offset <= 0 || offset >= stringSize) return "";
  let end = stringStart + offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString("utf8", stringStart + offset, end);
}

console.log(`WDBC: ${recordCount} records, ${fieldCount} fields, recordSize ${recordSize}`);
if (ICON_FIELD >= fieldCount) {
  console.error(`ICON_FIELD ${ICON_FIELD} >= fieldCount ${fieldCount}`);
  process.exit(1);
}

// merge into the existing (SQL-derived) icons.json
const map = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const before = Object.keys(map).length;
let n = 0;
for (let r = 0; r < recordCount; r++) {
  const base = HEADER + r * recordSize;
  const id = buf.readUInt32LE(base);
  const iconOffset = buf.readUInt32LE(base + ICON_FIELD * 4);
  const icon = readString(iconOffset).trim().toLowerCase();
  if (id && icon) { map[id] = icon; n++; }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(map));
console.log(`Merged ${n} DBC icons -> ${OUT} (${before} -> ${Object.keys(map).length} total)`);
