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
  const rows = await paneRows("sounds");
  const kinds = rows.map((r) => r[2]);
  console.log(`zone 12 music: rows=${rows.length} kinds=[${kinds.join(",")}]`);
  return rows.length >= 2 && kinds.some((k) => k === "Music") && kinds.some((k) => /^Ambience/.test(k));
}

// A sub-area is its own AreaTable row and carries its own music/ambience -- Northshire
// Valley plays something different from Elwynn at large. ~half of all subzones have one.
async function testSubzoneMusic() {
  await nav(`?subzone=9`);           // Northshire Valley
  await openTab("sounds");
  const rows = await paneRows("sounds");
  const kinds = rows.map((r) => r[2]);
  console.log(`subzone 9 music: rows=${rows.length} kinds=[${kinds.join(",")}]`);
  return rows.length >= 2 && kinds.some((k) => /^(Music|Ambience)/.test(k));
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
  console.log(`seek: role=${shape.role} tabindex=${shape.tabindex} dl=${shape.dl} ms=${shape.ms} -> valuenow=${seeked.valuenow} fill=${seeked.fill} label="${seeked.label}"`);
  return shape.role === "slider" && shape.tabindex === "0" && shape.valuenow === "0"
    && shape.dl && /^Download /.test(shape.dlLabel) && shape.ms > 0
    && seeked.valuenow === 50 && seeked.fill === "50%" && /\d:\d\d \/ \d:\d\d/.test(seeked.label);
}

// The bar is a real slider: arrows scrub 5%, Home/End jump to the ends.
async function testSeekKeyboard() {
  await nav(`?voicelines=insects`);
  await page.waitForSelector(".voice-page .snd .snd-bar", { timeout: T });
  const seq = await page.$eval(".voice-page .snd .snd-bar", (bar) => {
    const press = (key) => bar.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    const at = () => Number(bar.getAttribute("aria-valuenow"));
    const out = [];
    press("ArrowRight"); out.push(at());
    press("ArrowRight"); out.push(at());
    press("ArrowLeft"); out.push(at());
    press("End"); out.push(at());
    press("Home"); out.push(at());
    return out;
  });
  console.log(`seek keyboard: [${seq.join(",")}]`);
  return String(seq) === String([5, 10, 5, 100, 0]);
}

// Reachability. The voice-line page shipped working but unlinked from the nav for a
// while -- built, deployed, and findable only by typing the URL. A page nobody can get
// to is not a shipped feature, so assert the menu entry exists and goes somewhere.
async function testNavEntry() {
  await nav(`?`);
  await page.waitForSelector(".topnav", { timeout: T });
  const href = await page.$$eval(".topnav a", (as) => {
    const a = as.find((x) => /voice lines/i.test(x.textContent));
    return a ? a.getAttribute("href") : null;
  });
  console.log(`nav entry: href=${href}`);
  if (!href) return false;
  await nav(href.replace(/^\?/, "?"));
  await page.waitForSelector(".voice-page table tbody tr", { timeout: T });
  const rows = await page.$$eval(".voice-page table tbody tr", (e) => e.length);
  console.log(`nav entry -> rows=${rows}`);
  return rows > 0;
}

smoke("npc sounds tab (ragnaros)", () => testNpcSounds());
smoke("voicelines reachable from nav", () => testNavEntry());
smoke("seek + download controls", () => testSeekControls());
smoke("seek keyboard (slider)", () => testSeekKeyboard());
smoke("sound variant takes", () => testTakes());
smoke("zone music tab (elwynn)", () => testZoneMusic());
smoke("subzone music tab (northshire)", () => testSubzoneMusic());
smoke("voicelines index", () => testVoiceLines());
smoke("voicelines transcript search", () => testVoiceSearch("insects", "Ragnaros"));
smoke("voicelines name search", () => testVoiceSearch("ragnarosslay", "Ragnaros"));
smoke("search voice tab (transcript)", () => testSearchVoiceTab("insects", "Ragnaros"));
smoke("search voice tab (sound name)", () => testSearchVoiceTab("satyrboss", "Satyrboss"));
