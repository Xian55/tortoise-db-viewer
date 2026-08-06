"""Per-expansion game-client profiles: which MPQs to open, and where the fields we read
live inside each DBC.

The extract-*.py scripts were written against a 1.12 client and hardcoded both. A TBC
2.4.3 client breaks both assumptions, and in a nasty way:

  * `Data\\*.MPQ` contains **zero** `DBFilesClient\\` entries -- in TBC the whole DBC tree
    moved to the LOCALE archives (`Data\\enGB\\locale-enGB.MPQ` and its patches). But
    `Data\\patch.MPQ` / `patch-2.MPQ` still exist, so the "no archives opened" guard
    passes, two 2 GB archives open fine, and the run only dies later on the first DBC
    read. Art (WorldMap/minimap BLPs) does stay on the non-locale side, so a TBC profile
    has to open both.
  * Localized strings widened from a 9-field block (8 locales + flags) to 17 (16 + flags),
    which shifts every field after the first name in a DBC that has one.

Field indices below were derived by probing the actual client, not from memory: locale
blocks were located by their signature (a string offset followed by 15 zeroes and a flags
word), and every numeric field was checked against known values (Map 429 Dire Maul =
InstanceType 1, 533 Naxxramas = 2, 30 Alterac = 3; Faction 72 Stormwind = rep index 19;
TalentTab 161 = Warrior/Arms classmask 1 order 0). Re-verify with --verify if the client
is patched.

Selected with the CLIENT_PROFILE env var (default "vanilla", which reproduces the exact
pre-existing behaviour for the Turtle/vanilla clients).
"""
import os

PROFILE = os.environ.get("CLIENT_PROFILE", "vanilla").lower()

# ---- MPQ archive orders (LOWEST precedence first; readers try the last-opened first) ----

# TBC 2.4.3. Art on the non-locale side, DBCs only on the locale side; patches last.
TBC_ARCHIVES = [
    "common.MPQ",
    "expansion.MPQ",
    os.path.join("enGB", "locale-enGB.MPQ"),
    os.path.join("enGB", "expansion-locale-enGB.MPQ"),
    "patch.MPQ",
    "patch-2.MPQ",
    os.path.join("enGB", "patch-enGB.MPQ"),
    os.path.join("enGB", "patch-enGB-2.MPQ"),
]

# ---- DBC field offsets ----
# Only the fields the extractors actually read. "loc" marks a localized string: its index
# is the first (enUS) slot of the block.
VANILLA_DBC = {
    "locale_block": 9,          # 8 locales + a flags word
    "area_name": 11,
    "map_name": 4, "map_type": 2,
    "faction_name": 19, "faction_rep_index": 1,
    "ft_faction": 1, "ft_group": 3,
    "idi_icon": 5,
    "sla_req_train_points": 12,
    "spell_description": 138, "spell_aura_description": 147,
    "talenttab_class_mask": 12, "talenttab_order": 13,
    # ItemSet.dbc: ID, Name_lang(block), ItemID[17], SetSpellID[8], SetThreshold[8], ...
    "itemset_items": 10, "itemset_spells": 27, "itemset_thresholds": 35,
    # SpellItemEnchantment.dbc name: field 13 in BOTH 1.12 (24f) and 2.4.3 (34f) --
    # the locale block that widened sits after it.
    "sie_name": 13,
}

# TBC 2.4.3. Nearly everything kept its index -- the localized blocks that widened all sit
# AFTER the fields we read, except in Spell.dbc (three blocks precede Description) and
# TalentTab.dbc (the name block precedes ClassMask/OrderIndex). SkillLineAbility gained a
# field, pushing CharacterPoints/req_train_points from 12 to 14.
TBC_DBC = dict(VANILLA_DBC, **{
    "locale_block": 17,         # 16 locales + a flags word
    "sla_req_train_points": 14,
    "spell_description": 161, "spell_aura_description": 178,
    "talenttab_class_mask": 20, "talenttab_order": 21,
    # Everything after ItemSet's name block shifts by the +8 locale widening.
    "itemset_items": 18, "itemset_spells": 35, "itemset_thresholds": 43,
})

_PROFILES = {
    "vanilla": {"archives": None, "dbc": VANILLA_DBC},   # None = keep the script's own list
    "tbc": {"archives": TBC_ARCHIVES, "dbc": TBC_DBC},
}


def profile(name=None):
    n = (name or PROFILE).lower()
    if n not in _PROFILES:
        raise SystemExit(f"unknown CLIENT_PROFILE {n!r}; known: {', '.join(_PROFILES)}")
    return _PROFILES[n]


def archives(default_list, name=None):
    """The archive order for the active profile, or the caller's own list for vanilla."""
    return profile(name)["archives"] or default_list


def dbc_fields(name=None):
    return profile(name)["dbc"]
