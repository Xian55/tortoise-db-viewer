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
# The speech archives hold the spoken VO (Sound\Creature\...\*.wav) that extract-sounds
# reads; they are locale-side too, and absent from every other extractor's needs -- but
# opening them costs only the handle, so one list stays correct for all of them.
TBC_ARCHIVES = [
    "common.MPQ",
    "expansion.MPQ",
    os.path.join("enGB", "locale-enGB.MPQ"),
    os.path.join("enGB", "expansion-locale-enGB.MPQ"),
    os.path.join("enGB", "speech-enGB.MPQ"),
    os.path.join("enGB", "expansion-speech-enGB.MPQ"),
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
    # ---- audio (extract-sounds.py) ----
    # SoundEntries.dbc is 29 fields in BOTH 1.12 and 2.4.3 (it carries no localized
    # string), so nothing here moves; listed for readability, not portability.
    "se_type": 1, "se_name": 2, "se_files": 3, "se_freq": 13, "se_dir": 23,
    # CreatureDisplayInfo.dbc: SoundID overrides the model's set; NPCSoundID is the
    # separate greeting/farewell/pissed trio. TBC widened the row and moved the latter.
    "cdi_model": 1, "cdi_sound": 2, "cdi_npc_sound": 11,
    "cmd_sound": 13,             # CreatureModelData.dbc -> CreatureSoundData id
    # CreatureModelData.ModelPath, e.g. "Creature\\Illidan\\Illidan.mdx". Field 2 in both
    # 1.12 (16 fields) and 2.4.3 (24) -- the row carries no localized string. Its FOLDER
    # is usually the same folder the model's audio sits in under Sound\\Creature, which is
    # how extract-sounds binds a whole directory of boss lines to a display id.
    "cmd_path": 2,
    "npcsounds_first": 1,        # NPCSounds.dbc: Sound[4] at 1..4
    # AreaTable.dbc -- all three precede the name block, so unchanged in TBC.
    "area_ambience": 7, "area_zone_music": 8, "area_intro_sound": 9,
    # WMOAreaTable.dbc -- music/ambience tied to a BUILDING rather than a zone. Some of
    # the most recognisable tracks live only here: the Deadmines' intro sting is a WMO
    # row (wmo 499 -> area 1581), with nothing on the AreaTable side at all. All four
    # fields precede the localized name block, so TBC doesn't move them.
    "wmo_ambience": 6, "wmo_music": 7, "wmo_intro": 8, "wmo_area": 10,
    "zm_day": 6, "zm_night": 7,  # ZoneMusic.dbc
    "sa_day": 1, "sa_night": 2,  # SoundAmbience.dbc
    "zi_sound": 2,               # ZoneIntroMusicTable.dbc
    # CreatureSoundData.dbc slot -> label. Fields 1..22 are identical in 1.12 and 2.4.3;
    # only the tail differs (TBC inserted NPCSoundID at 23, pushing the rest by one and
    # adding six more slots). Field 9 is SoundFootstepID -- a terrain-type index, NOT a
    # SoundEntries id -- so it is deliberately absent.
    "csd_slots": [
        (1, "Exertion"), (2, "Exertion Critical"), (3, "Injury"), (4, "Injury Critical"),
        (5, "Injury Crushing Blow"), (6, "Death"), (7, "Stun"), (8, "Stand"),
        (10, "Aggro"), (11, "Wing Flap"), (12, "Wing Glide"), (13, "Alert"),
        (14, "Fidget"), (15, "Fidget"), (16, "Fidget"), (17, "Fidget"), (18, "Fidget"),
        (19, "Custom Attack"), (20, "Custom Attack"), (21, "Custom Attack"), (22, "Custom Attack"),
        (23, "Loop"),
        (25, "Jump Start"), (26, "Jump End"),
        (27, "Pet Attack"), (28, "Pet Order"), (29, "Pet Dismiss"),
    ],
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
    # CreatureDisplayInfo grew 12 -> 14 fields (a BloodID and a ParticleColorID), which
    # pushes NPCSoundID one slot. ModelID/SoundID stay put.
    "cdi_npc_sound": 12,
    # CreatureSoundData grew 30 -> 37: NPCSoundID appears at 23 (unused -- every TBC row
    # is 0, the id lives on CreatureDisplayInfo instead), shifting Loop/Jump/Pet by one,
    # and six slots were appended. Verified against the 2.4.3 client, not from memory.
    "csd_slots": VANILLA_DBC["csd_slots"][:21] + [
        (24, "Loop"),
        (26, "Jump Start"), (27, "Jump End"),
        (28, "Pet Attack"), (29, "Pet Order"), (30, "Pet Dismiss"),
        (33, "Birth"), (34, "Spell Cast"), (35, "Submerge"), (36, "Submerged"),
    ],
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
