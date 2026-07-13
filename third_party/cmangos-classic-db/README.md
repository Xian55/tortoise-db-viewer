# cMaNGOS classic-db (vendored license + copyright notices)

These files are copied **verbatim** from the [cMaNGOS classic-db](https://github.com/cmangos/classic-db)
project and are included to comply with its **GPL v3** license, which requires the license and
copyright notices to accompany any redistributable derived from that software.

| file | source |
|------|--------|
| `LICENSE.md`   | classic-db `LICENSE.md` — GNU General Public License v3 |
| `COPYRIGHT.md` | classic-db `COPYRIGHT.md` — Blizzard-content copyright / fair-use notice |

## What this project derives from classic-db

- The **`vanilla/cmangos`** dataset — built from cMaNGOS's published Classic SQLite world DB by
  `scripts/build-db.mjs` (`SQL_SOURCE=cmangos`, `scripts/lib/cmangos-adapter.mjs`).
- `scripts/data/vanilla-ids.json` — the canonical vanilla-1.12 id allowlist, extracted from the
  same DB by `scripts/extract-vanilla-ids.mjs`.

See the root [`NOTICE.md`](../../NOTICE.md) for the full attribution. Do not remove these notices
from redistributed copies.
