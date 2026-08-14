import { page, nav, T, smoke } from "../harness.mjs";

// The extracted game audio: the NPC Sounds tab, the zone Music tab, and the ?voicelines
// browse with its transcript full-text search.
//
// Nothing here plays audio -- the files live on R2 and a smoke run has no business
// fetching a megabyte of Opus. What is checked is that the MAPPING survived the build:
// a boss lists its own sounds under the right categories, a zone lists its own music,
// and searching a phrase finds the creature that says it.

async function openTab(id) {
  await page.waitForSelector(`.tab[data-tab="${id}"]`, { timeout: T });
  await page.$eval(`.tab[data-tab="${id}"]`, (e) => e.click());
  await page.waitForSelector(`.tabpane[data-pane="${id}"]:not(.hidden) table tbody tr`, { timeout: T });
  // Wait for the row count to stop changing. createTable mounts and can re-render (sort,
  // grouping, a debounced filter), so reading straight after the first row appears raced
  // the second render -- which showed up as ~1 flaky test per 3 full-suite runs, landing
  // on a different test each time rather than any one being wrong.
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    const n = await page.$$eval(`.tabpane[data-pane="${id}"] table tbody tr`, (r) => r.length);
    if (n === prev) return;
    prev = n;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Data rows only: a grouped table interleaves `.grouprow` headers into the same tbody.
const paneRows = (id) => page.$$eval(`.tabpane[data-pane="${id}"] table tbody tr:not(.grouprow)`, (rs) =>
  rs.map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim())));

// Ragnaros is the reference case: a C++ boss with client model sounds (Attack/Death),
// a looping ambient sound, AND scripted voice lines that carry a transcript. If the
// three sources ever collapse into one, this catches it.
async function testNpcSounds() {
  await nav(`?npc=11502`);
  await openTab("sounds");
  await page.waitForFunction(() => {
    const rs = document.querySelectorAll('.tabpane[data-pane="sounds"] table tbody tr:not(.grouprow)');
    const ps = document.querySelectorAll('.tabpane[data-pane="sounds"] .snd .snd-play');
    return rs.length >= 5 && ps.length === rs.length;
  }, { timeout: T }).catch(() => {});
  const rows = await paneRows("sounds");
  const players = await page.$$eval(".tabpane[data-pane='sounds'] .snd .snd-play", (e) => e.length);
  const groups = await page.$$eval(".tabpane[data-pane='sounds'] tr.grouprow", (e) => e.map((g) => g.dataset.group));
  const text = rows.map((r) => r.join(" | ")).join("\n");
  const hasLoop = /RagnarosLoop/.test(text);
  const hasCombat = /RagnarosDeath|RagnarosAttack/.test(text);
  const hasTranscript = rows.some((r) => r.some((c) => /insects|purged|sulfuron/i.test(c)));
  console.log(`npc sounds 11502: rows=${rows.length} players=${players} groups=[${groups.join(",")}] loop=${hasLoop} combat=${hasCombat} transcript=${hasTranscript}`);
  return rows.length >= 5 && players === rows.length && hasLoop && hasCombat && hasTranscript
    && groups.includes("NPC Loops") && groups.includes("Voice Lines");
}

// Multi-variant sounds render take chips (SoundEntries holds up to 10 interchangeable
// files and the client picks one at random).
async function testTakes() {
  await nav(`?npc=11502`);
  await openTab("sounds");
  await page.waitForFunction(() => document.querySelectorAll('.tabpane[data-pane="sounds"] .snd-takes').length > 0,
    { timeout: T }).catch(() => {});
  const takes = await page.$$eval(".tabpane[data-pane='sounds'] .snd-takes", (e) =>
    e.map((t) => t.querySelectorAll(".snd-take").length));
  const on = await page.$$eval(".tabpane[data-pane='sounds'] .snd-take.on", (e) => e.length);
  console.log(`sound takes: groups=${takes.length} counts=[${takes.join(",")}] preselected=${on}`);
  return takes.length >= 1 && takes.every((n) => n > 1) && on === takes.length;
}

// A zone lists its own music + ambience. Day and night are separate SoundEntries rows;
// build-db collapses them when identical, so Elwynn shows one Music row and a day/night
// ambience pair.
async function testZoneMusic() {
  await nav(`?zone=12`);
  await openTab("sounds");
  // WAIT for the expected rows rather than sampling once. A zone page also boots a
  // Leaflet map, and createTable can re-render after mount, so a single read right after
  // the first row appears is a race -- this was the one test that failed CI while passing
  // locally, and it failed on a different test each run because the race is in the timing,
  // not the assertion.
  const ok = await page.waitForFunction(() => {
    const rs = [...document.querySelectorAll('.tabpane[data-pane="sounds"] table tbody tr:not(.grouprow)')];
    const kinds = rs.map((r) => (r.querySelectorAll("td")[2] || {}).textContent || "");
    return rs.length >= 2 && kinds.some((k) => k.trim() === "Music") && kinds.some((k) => /^Ambience/.test(k.trim()));
  }, { timeout: T }).then(() => true, () => false);
  const rows = await paneRows("sounds");
  console.log(`zone 12 music: rows=${rows.length} kinds=[${rows.map((r) => r[2]).join(",")}] ok=${ok}`);
  return ok;
}

// A sub-area is its own AreaTable row and carries its own music/ambience -- Northshire
// Valley plays something different from Elwynn at large. ~half of all subzones have one.
async function testSubzoneMusic() {
  await nav(`?subzone=9`);           // Northshire Valley
  await openTab("sounds");
  const ok = await page.waitForFunction(() => {
    const rs = [...document.querySelectorAll('.tabpane[data-pane="sounds"] table tbody tr:not(.grouprow)')];
    const kinds = rs.map((r) => ((r.querySelectorAll("td")[2] || {}).textContent || "").trim());
    return rs.length >= 2 && kinds.some((k) => /^(Music|Ambience)/.test(k));
  }, { timeout: T }).then(() => true, () => false);
  const rows = await paneRows("sounds");
  console.log(`subzone 9 music: rows=${rows.length} kinds=[${rows.map((r) => r[2]).join(",")}] ok=${ok}`);
  return ok;
}

// The unified ?search= page carries a Voice Lines tab, so a phrase typed into the top
// bar finds the clip. Two paths in: the transcript (FTS) and the sound's name -- the
// name half is what surfaces Turtle's voice acting, most of which no text row references.
async function testSearchVoiceTab(term, expect) {
  await nav(`?search=${encodeURIComponent(term)}`);
  await page.waitForSelector(`.tab[data-tab="voice"]`, { timeout: T });
  await page.$eval(`.tab[data-tab="voice"]`, (e) => e.click());
  await page.waitForSelector(`.tabpane[data-pane="voice"]:not(.hidden) table tbody tr`, { timeout: T });
  const rows = await paneRows("voice");
  const players = await page.$$eval(".tabpane[data-pane='voice'] .snd-play", (e) => e.length);
  const hit = rows.some((r) => r.join(" | ").toLowerCase().includes(expect.toLowerCase()));
  console.log(`search voice "${term}": rows=${rows.length} players=${players} found "${expect}"=${hit}`);
  return rows.length > 0 && players === rows.length && hit;
}

async function testVoiceLines() {
  await nav(`?voicelines`);
  await page.waitForSelector(".voice-page table tbody tr", { timeout: T });
  const rows = await page.$$eval(".voice-page table tbody tr", (e) => e.length);
  const players = await page.$$eval(".voice-page .snd-play", (e) => e.length);
  console.log(`voicelines: rows=${rows} players=${players}`);
  return rows > 0 && players === rows;
}

// The transcript FTS. This is the regression guard for the `rank` ambiguity that made
// every search silently return nothing: `creatures` has its own `rank` column, so the
// bare FTS `rank` was ambiguous across the join and the query threw.
async function testVoiceSearch(term, expectSpeaker) {
  await nav(`?voicelines=${encodeURIComponent(term)}`);
  await page.waitForSelector(".voice-page table tbody tr", { timeout: T });
  const rows = await page.$$eval(".voice-page table tbody tr", (rs) =>
    rs.map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim()).join(" | ")));
  const hit = rows.some((r) => r.toLowerCase().includes(expectSpeaker.toLowerCase()));
  console.log(`voice search "${term}": rows=${rows.length} found "${expectSpeaker}"=${hit}`);
  return rows.length > 0 && hit;
}

// Seek + download controls. Playback itself is NOT asserted: an automated Chrome
// profile has no media engagement, so play() is rejected by autoplay policy no matter
// how real the click is. What is asserted is everything around it -- the slider
// semantics, that a click maps to the right position, and that the download button
// exists and points at the selected take.
async function testSeekControls() {
  await nav(`?voicelines=insects`);
  await page.waitForSelector(".voice-page .snd", { timeout: T });
  const shape = await page.$eval(".voice-page .snd", (b) => ({
    role: b.querySelector(".snd-bar")?.getAttribute("role"),
    tabindex: b.querySelector(".snd-bar")?.getAttribute("tabindex"),
    valuenow: b.querySelector(".snd-bar")?.getAttribute("aria-valuenow"),
    dl: !!b.querySelector(".snd-dl"),
    dlLabel: b.querySelector(".snd-dl")?.getAttribute("aria-label") || "",
    ms: Number(b.dataset.ms) || 0,
  }));
  // Click at 50% of the bar and read back where it landed.
  const seeked = await page.$eval(".voice-page .snd .snd-bar", (bar) => {
    const r = bar.getBoundingClientRect();
    bar.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return {
      valuenow: Number(bar.getAttribute("aria-valuenow")),
      fill: bar.querySelector("span").style.width,
      label: bar.parentElement.querySelector(".snd-dur").textContent,
    };
  });
  // Keyboard checked HERE rather than in its own test: a second nav() to the same page
  // meant a second render, and the bar captured before the 180ms debounce settled was
  // detached -- the keydown handler is delegated on #app, so a detached node's events go
  // nowhere and every press silently did nothing. That made a standalone keyboard test
  // flaky 1-in-3 no matter how the assertion was written. Same DOM, no extra navigation.
  const keys = await page.$eval(".voice-page .snd .snd-bar", (bar) => {
    bar.setAttribute("aria-valuenow", "0");
    const at = () => Number(bar.getAttribute("aria-valuenow"));
    const press = (k) => bar.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    press("ArrowRight"); const right = at();
    press("ArrowLeft"); const back = at();
    press("End"); const end = at();
    press("Home"); const home = at();
    return { right, back, end, home };
  });
  console.log(`seek: role=${shape.role} tabindex=${shape.tabindex} dl=${shape.dl} ms=${shape.ms} -> valuenow=${seeked.valuenow} fill=${seeked.fill} label="${seeked.label}" keys=${JSON.stringify(keys)}`);
  return shape.role === "slider" && shape.tabindex === "0" && shape.valuenow === "0"
    && shape.dl && /^Download /.test(shape.dlLabel) && shape.ms > 0
    && seeked.valuenow === 50 && seeked.fill === "50%" && /\d:\d\d \/ \d:\d\d/.test(seeked.label)
    && keys.right === 5 && keys.back === 0 && keys.end === 100 && keys.home === 0;
}

// Reachability. The voice-line page shipped working but unlinked from the nav for a
// while -- built, deployed, and findable only by typing the URL. A page nobody can get
// to is not a shipped feature, so assert the menu entry exists and goes somewhere.
async function testNavEntry() {
  await nav(`?`);
  await page.waitForSelector("#topnav a", { timeout: T });
  const href = await page.$$eval("#topnav a", (as) => {
    const a = as.find((x) => /voice lines/i.test(x.textContent));
    return a ? a.getAttribute("href") : null;
  });
  console.log(`nav entry: href=${href}`);
  if (!href) return false;
  await nav(href);
  await page.waitForSelector(".voice-page table tbody tr", { timeout: T });
  const rows = await page.$$eval(".voice-page table tbody tr", (e) => e.length);
  console.log(`nav entry -> rows=${rows}`);
  return rows > 0;
}

// The bar is a real slider: arrows scrub by 5, Home/End jump to the ends.
// Asserted as DELTAS from wherever it starts, deliberately. An earlier test in this file
// leaves the bar at 50%, and nav() to the same URL is a pushState that does not rebuild
// the table -- an absolute expectation like [5,10,5,100,0] then passes or fails depending
// on test order, which made this the one flaky test in the suite.

smoke("npc sounds tab (ragnaros)", () => testNpcSounds());
smoke("voicelines reachable from nav", () => testNavEntry());
smoke("seek + download controls", () => testSeekControls());
smoke("sound variant takes", () => testTakes());
smoke("zone music tab (elwynn)", () => testZoneMusic());
smoke("subzone music tab (northshire)", () => testSubzoneMusic());
smoke("voicelines index", () => testVoiceLines());
smoke("voicelines transcript search", () => testVoiceSearch("insects", "Ragnaros"));
smoke("voicelines name search", () => testVoiceSearch("ragnarosslay", "Ragnaros"));
smoke("search voice tab (transcript)", () => testSearchVoiceTab("insects", "Ragnaros"));
smoke("search voice tab (sound name)", () => testSearchVoiceTab("satyrboss", "Satyrboss"));

// WMOAreaTable: audio bound to a BUILDING, which never reaches the zone's AreaTable row.
// The Deadmines' intro sting exists only there, so a zone-only reading misses it entirely.
async function testInteriorMusic() {
  await nav(`?zone=1581`);            // The Deadmines
  await openTab("sounds");
  const rows = await paneRows("sounds");
  const text = rows.map((r) => r.join(" | ")).join("\n");
  console.log(`deadmines music: rows=${rows.length} kinds=[${rows.map((r) => r[2]).join(",")}]`);
  return rows.length >= 3 && /Interior/.test(text) && /Spooky/i.test(text);
}
smoke("zone interior music (deadmines WMO)", () => testInteriorMusic());

// NPC gossip (greeting/farewell/annoyed) belongs on the voice-line page. These are the
// lines players actually quote -- "Time is money, friend" is the goblin vendor greeting --
// and they were filtered out because they live under creature/ with no transcript.
async function testGossipListed() {
  await nav(`?voicelines=vendor`);
  await page.waitForSelector(".voice-page table tbody tr", { timeout: T });
  const rows = await page.$$eval(".voice-page table tbody tr", (rs) =>
    rs.map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim()).join(" | ")));
  const goblin = rows.some((r) => /goblin/i.test(r));
  const named = rows.filter((r) => r.split(" | ").some((c) => /^[A-Z]/.test(c) && c.length > 3)).length;
  console.log(`voicelines vendor: rows=${rows.length} goblinVendor=${goblin} withText=${named}`);
  return rows.length >= 5 && goblin;
}
smoke("voicelines includes NPC gossip", () => testGossipListed());

// NPC gossip: what an NPC says when you talk to it. This is where a quoted phrase
// actually lives -- a voice clip is shared across a whole voice type and the data never
// links it to words, so "Time is money, friend" is only findable through gossip text.
async function testGossipSearch() {
  await nav(`?search=${encodeURIComponent("time is money")}`);
  await page.waitForSelector(`.tab[data-tab="gossip"]`, { timeout: T });
  await page.$eval(`.tab[data-tab="gossip"]`, (e) => e.click());
  await page.waitForSelector(`.tabpane[data-pane="gossip"]:not(.hidden) table tbody tr`, { timeout: T });
  const rows = await paneRows("gossip");
  const hit = rows.some((r) => /clemence/i.test(r.join(" ")));
  console.log(`gossip search "time is money": rows=${rows.length} foundClemence=${hit}`);
  return rows.length > 0 && hit;
}

// The same text on the NPC's own page.
async function testGossipTab() {
  await nav(`?npc=61486`);
  await openTab("gossip");
  const rows = await paneRows("gossip");
  console.log(`npc 61486 gossip rows=${rows.length}: ${rows[0] && rows[0][0].slice(0, 40)}`);
  return rows.length >= 1 && /time is money/i.test(rows.map((r) => r.join(" ")).join(" "));
}
smoke("gossip search finds NPC by phrase", () => testGossipSearch());
smoke("npc gossip tab (61486)", () => testGossipTab());

// ?sounds lists EVERY extracted sound, not just the ones with words. Music, ambience and
// creature audio (~1,500 sounds) previously had no page at all.
async function testSoundsBrowse() {
  await nav(`?sounds=battle`);
  await page.waitForSelector(".voice-page table tbody tr", { timeout: T });
  const rows = await page.$$eval(".voice-page table tbody tr:not(.grouprow)", (rs) =>
    rs.map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent.trim()).join(" | ")));
  const hit = rows.find((r) => /Moment - Battle06/.test(r));
  console.log(`sounds browse "battle": rows=${rows.length} battle06=${hit ? hit.slice(0, 70) : "MISSING"}`);
  return rows.length >= 5 && !!hit && /1:02/.test(hit);   // 62.4s
}
smoke("sounds browse by name (Moment - Battle06)", () => testSoundsBrowse());
