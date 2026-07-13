# Notices & attribution

This project (a static database viewer) ships data derived from several third-party
sources. Attribution and the applicable licenses are recorded here.

## cMaNGOS classic-db — GPL v3

The **`vanilla/cmangos`** dataset (`data-vanilla-cmangos/…` on the CDN) and the vanilla-ID
allowlist `scripts/data/vanilla-ids.json` are **derived from** the cMaNGOS *classic-db*
project, which is licensed under the **GNU General Public License v3**:

- Upstream: <https://github.com/cmangos/classic-db>
- License (verbatim): [`third_party/cmangos-classic-db/LICENSE.md`](third_party/cmangos-classic-db/LICENSE.md) (GPL v3)
- Copyright notice (verbatim): [`third_party/cmangos-classic-db/COPYRIGHT.md`](third_party/cmangos-classic-db/COPYRIGHT.md)

Per GPL v3, the **corresponding source** for that derived data is this repository: the build
that produces the dataset is `scripts/build-db.mjs` with `SQL_SOURCE=cmangos`
(`scripts/lib/cmangos-adapter.mjs`), reading cMaNGOS's published Classic SQLite DB; the
allowlist is produced by `scripts/extract-vanilla-ids.mjs`. Neither the cMaNGOS data nor its
copyright/license notices may be removed from redistributed copies.

## Turtle-WoW server data (main / dev datasets)

The **main** and **dev** datasets are built from the Turtle-WoW server SQL dumps
(<https://github.com/Penqle/tortoise-wow>), a 1.12 MaNGOS fork.

## Blizzard content (all datasets)

World of Warcraft content and materials — including the client-extracted assets in this repo
(zone maps, minimap tiles, item/spell/class icons, talent trees, DBC-derived tables) — are
trademarks and copyright of **Blizzard Entertainment or its licensors**. They are used here
only for a non-commercial, educational, fan reference, and are not affiliated with or endorsed
by Blizzard. See `third_party/cmangos-classic-db/COPYRIGHT.md` for cMaNGOS's statement of the
same fair-use intent, which applies equally to this project's use of the client art.
