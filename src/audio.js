// The shared audio player for extracted game sounds (NPC voice/combat, zone music).
//
// One <audio> element for the whole app, deliberately: these are 1-10 second clips and
// zone music tracks, and letting two play at once is never what you meant. Whichever
// button starts a sound takes the element over and the previous button resets itself.
//
// A row's `files` is the SoundEntries variant list -- the client picks one at random per
// play, so several are interchangeable takes of the same sound ("RagnarosAttackA/B/C").
// They render as numbered chips rather than separate rows.
//
// Audio comes from R2 (config.SOUNDS_BASE); nothing about it is in the DB but the path.

import { SOUNDS_BASE } from "./config.js";
import { esc } from "./render.js";

let el = null;          // the one <audio>
let active = null;      // the .snd element currently bound to it
let scrubbing = false;  // a drag is in progress; timeupdate must not fight it
let pendingSeek = null; // fraction to apply once the new src reports its duration

function audio() {
  if (!el) {
    el = new Audio();
    el.preload = "none";
    // Deliberately NO crossOrigin here. Playback does not need CORS, and requiring it
    // makes playback depend on cache state: Chrome reuses one cache entry across request
    // modes, so a clip already cached from a plain media load fails outright
    // (MEDIA_ERR_SRC_NOT_SUPPORTED) once the element starts demanding CORS headers the
    // cached response doesn't carry. Measured on the live site: a clip cached by ordinary
    // playback errored with crossOrigin set and played fine without it. The download path
    // solves its own CORS problem instead -- see download().
    for (const ev of ["ended", "pause", "play", "timeupdate", "error"]) {
      el.addEventListener(ev, () => paint(ev === "error"));
    }
    // Seeking a sound that isn't loaded yet can't set currentTime until the duration is
    // known, so the click's position is held here and applied on metadata.
    el.addEventListener("loadedmetadata", () => {
      if (pendingSeek !== null && isFinite(el.duration)) {
        el.currentTime = pendingSeek * el.duration;
        pendingSeek = null;
      }
      paint(false);
    });
    // In the document rather than detached. It has no controls, so it renders nothing and
    // costs no layout, but it is then inspectable -- which is how "did that click actually
    // start the right take" is answerable in devtools and in the smoke suite, where
    // autoplay policy blocks real playback and `src` is the only evidence left.
    document.body.appendChild(el);
  }
  return el;
}

/**
 * A rejected play() is not necessarily a broken file. Browsers reject with
 * NotAllowedError when the call didn't come from a user gesture (autoplay policy) --
 * flagging that as an error left a perfectly good clip showing "!".
 */
function onPlayReject(err) {
  paint(err && err.name !== "NotAllowedError");
}

/** Fraction 0..1 of a pointer/keyboard position along a .snd-bar. */
function barFraction(bar, clientX) {
  const r = bar.getBoundingClientRect();
  if (!r.width) return 0;
  return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
}

function seekTo(box, frac) {
  const fill = box.querySelector(".snd-bar span");
  const bar = box.querySelector(".snd-bar");
  if (fill) fill.style.width = `${frac * 100}%`;
  if (bar) bar.setAttribute("aria-valuenow", Math.round(frac * 100));
  const total = box === active && isFinite(el?.duration) ? el.duration : durMs(box) / 1000;
  const t = box.querySelector(".snd-dur");
  if (t) t.textContent = fmtClock(frac * total) + " / " + fmtClock(total);
  if (box === active && el && isFinite(el.duration)) el.currentTime = frac * el.duration;
  else pendingSeek = frac;
}

/** Reflect the element's state onto the button that owns it. */
function paint(failed) {
  if (!active) return;
  const btn = active.querySelector(".snd-play");
  const bar = active.querySelector(".snd-bar span");
  if (failed) {
    active.classList.add("snd-error");
    active.classList.remove("snd-on");
    if (btn) btn.textContent = "!";
    return;
  }
  const playing = !el.paused && !el.ended;
  active.classList.toggle("snd-on", playing);
  if (btn) btn.textContent = playing ? "⏸" : "▶";
  if (bar) {
    const d = el.duration;
    const frac = d && isFinite(d) ? el.currentTime / d : 0;
    bar.style.width = `${frac * 100}%`;
    bar.parentElement?.setAttribute("aria-valuenow", Math.round(frac * 100));
  }
  const t = active.querySelector(".snd-dur");
  if (t && !scrubbing) t.textContent = fmtClock(el.currentTime) + " / " + fmtClock(el.duration || durMs(active) / 1000);
}

const fmtClock = (s) => (!s || !isFinite(s) ? "0:00"
  : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
const durMs = (box) => Number(box.dataset.ms) || 0;

/** Hand the element back: this player returns to its idle, unplayed appearance. */
function release() {
  if (!active) return;
  const btn = active.querySelector(".snd-play");
  const bar = active.querySelector(".snd-bar");
  const t = active.querySelector(".snd-dur");
  // snd-error and aria-valuenow are part of that idle state too: leaving them set
  // stranded a failed player showing "!" with a 0%-wide bar still reporting 50%.
  active.classList.remove("snd-on", "snd-error");
  if (btn) btn.textContent = "▶";
  if (bar) {
    bar.querySelector("span").style.width = "0%";
    bar.setAttribute("aria-valuenow", "0");
  }
  if (t) t.textContent = fmtDur(durMs(active));
  pendingSeek = null;
  active = null;
}

/** Stop whatever is playing (route changes call this so audio doesn't outlive its page). */
export function stopAudio() {
  if (el) { el.pause(); el.removeAttribute("src"); }
  release();
}

export const soundUrl = (rel) => SOUNDS_BASE + rel;

/** "1:04" / "0:07" -- ms come from the extractor's ffprobe pass, 0 when unknown. */
export function fmtDur(ms) {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fileList(row) {
  try {
    const f = typeof row.files === "string" ? JSON.parse(row.files) : row.files;
    return Array.isArray(f) ? f : [];
  } catch { return []; }
}

/**
 * A play control for one sound row ({ id, name, files, ms }).
 * `opts.label` false renders just the button (for a table cell that already names it).
 * `opts.take` preselects a numbered take. Takes are DIFFERENT LINES, not alternate
 * recordings of one, so a row that exists because take 6 matched a search must open on
 * take 6 -- defaulting to 1 played the user something they did not search for.
 */
export function soundPlayer(row, opts = {}) {
  const files = fileList(row);
  if (!files.length) return "";
  const sel = Math.min(Math.max(Number(opts.take ?? row.take ?? 0) || 0, 0), files.length - 1);
  const takes = files.length > 1
    ? `<span class="snd-takes">${files.map((_, i) =>
      `<button class="snd-take${i === sel ? " on" : ""}" data-take="${i}" title="Take ${i + 1}">${i + 1}</button>`).join("")}</span>`
    : "";
  const name = row.name || "sound";
  // The controls are one unbreakable row and the take chips are a second row under it.
  // The wrapper is what makes that true: with the chips as a direct flex child, the
  // table's auto layout took the cell's min-content width to be the widest single control
  // (~70px) and stacked play / bar / duration on top of each other -- measured 98px for a
  // player that needs ~195px. A `.snd-ctl` that cannot wrap gives the column an honest
  // minimum, so only the chips move.
  return `<span class="snd" data-files="${esc(JSON.stringify(files))}" data-ms="${row.ms || 0}" data-name="${esc(name)}">
    <span class="snd-ctl">
      <button class="snd-play" aria-label="Play ${esc(name)}">▶</button>
      ${opts.label === false ? "" : `<span class="snd-name">${esc(row.name || "")}</span>`}
      <span class="snd-bar" role="slider" tabindex="0" aria-label="Seek ${esc(name)}"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></span>
      <span class="snd-dur muted">${fmtDur(row.ms)}</span>
      <button class="snd-dl" aria-label="Download ${esc(name)}" title="Download">⭳</button>
    </span>
    ${takes}
  </span>`;
}

/** The take the user has selected on this player (0 when there's only one file). */
function currentFile(box) {
  let files;
  try { files = JSON.parse(box.dataset.files); } catch { return null; }
  const i = Number(box.querySelector(".snd-take.on")?.dataset.take || 0);
  return files[i] || files[0] || null;
}

/**
 * Download the selected take.
 *
 * Fetched to a Blob rather than just `<a download>`: the audio is served cross-origin
 * from R2, and browsers IGNORE the download attribute on a cross-origin URL unless the
 * response carries Content-Disposition -- the link would open a tab instead of saving.
 * The bucket's CORS is `*`, so the fetch is fine. Falls back to a plain navigation if it
 * isn't (an opened tab still beats a dead button).
 */
async function download(box) {
  const rel = currentFile(box);
  if (!rel) return;
  const url = soundUrl(rel);
  // Name it after the sound, not the client's path -- "RagnarosSlay01.ogg" beats
  // "a_ragnarosslay01.ogg", and a multi-take player says which take you got.
  const ext = rel.slice(rel.lastIndexOf("."));
  const take = box.querySelector(".snd-take.on")?.dataset.take;
  const takes = box.querySelectorAll(".snd-take").length;
  const base = (box.dataset.name || "sound").replace(/[^\w.-]+/g, "_");
  const file = `${base}${takes > 1 ? `-${Number(take || 0) + 1}` : ""}${ext}`;
  const a = document.createElement("a");
  a.download = file;
  try {
    // ALWAYS bypass the HTTP cache. Playing a clip stores a non-CORS entry for its URL,
    // and a cors-mode fetch that reuses that entry finds no CORS headers on it and dies
    // with "Failed to fetch" -- so download failed on precisely the clips you had just
    // listened to. cache:"reload" forces a fresh request that carries Origin and gets the
    // headers back. It re-transfers the bytes, which is the right trade for a button the
    // user pressed on purpose: these are at most a few MB, and correctness here beats
    // saving a round trip.
    const res = await fetch(url, { cache: "reload" });
    if (!res.ok) throw new Error(res.status);
    const href = URL.createObjectURL(await res.blob());
    a.href = href;
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  } catch {
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  }
}

/**
 * Play a player box from the start of its selected take, taking over from whatever was
 * playing before. Unconditional: callers that want toggle semantics check `active` first.
 */
function startBox(box) {
  let files;
  try { files = JSON.parse(box.dataset.files); } catch { return; }
  const idx = Number(box.querySelector(".snd-take.on")?.dataset.take || 0);
  if (active && active !== box) release();
  active = box;
  box.classList.remove("snd-error");
  const a = audio();
  a.src = soundUrl(files[idx] || files[0]);
  a.currentTime = 0;
  a.play().catch(onPlayReject);
}

/**
 * Delegated wiring. Safe to call on any container, and on the same one twice (the
 * listener is flagged) -- views that re-render a pane call it again after mounting.
 */
export function wireAudio(root) {
  if (!root || root.__sndWired) return;
  root.__sndWired = true;
  root.addEventListener("click", (e) => {
    // A transcript line IS its clip, so clicking the words plays the words -- the same
    // reading as clicking into the seek bar, which also starts an idle player. Delegating
    // to the take chip instead would only ARM it: a chip click deliberately does not start
    // playback (see below), because clicking through variants must not blast audio.
    // The line lives in a different cell from the player, so it finds it by row.
    // A line can contain a link (the sound page credits its speaker inside the line), and
    // preventDefault on a click meant for that link would silently swallow the navigation.
    const line = e.target.closest("a") ? null : e.target.closest(".snd-line");
    if (line) {
      // NOT `.snd-lines`: that is the line's own wrapper inside the transcript cell, so
      // closest() would stop there and never reach the cell holding the player.
      const row = line.closest("tr, .sound-page");
      const box = row?.querySelector(".snd");
      if (box) {
        e.preventDefault();
        // A line with no take (a server-derived transcript, which names a sound and not a
        // file) just plays whatever take is selected.
        const chip = line.dataset.take == null ? null
          : box.querySelector(`.snd-take[data-take="${line.dataset.take}"]`);
        if (chip) for (const b of box.querySelectorAll(".snd-take")) b.classList.toggle("on", b === chip);
        startBox(box);
        return;
      }
    }
    const take = e.target.closest(".snd-take");
    const play = e.target.closest(".snd-play");
    const dl = e.target.closest(".snd-dl");
    if (!take && !play && !dl) return;
    const box = e.target.closest(".snd");
    if (!box) return;
    e.preventDefault();
    if (dl) { download(box); return; }

    if (take) {
      for (const b of box.querySelectorAll(".snd-take")) b.classList.toggle("on", b === take);
      // Switching take while this sound is playing restarts on the new one; otherwise
      // just arm it, so clicking through variants doesn't blast audio unasked.
      if (box !== active) return;
    }
    if (box === active && !take) {
      const a = audio();
      if (a.paused) a.play().catch(onPlayReject); else a.pause();
      return;
    }
    startBox(box);
  });

  // ---- seeking ----
  // Pointer events (not mouse) so a touch drag scrubs too, with capture on the bar so
  // the drag keeps tracking after the pointer leaves it.
  root.addEventListener("pointerdown", (e) => {
    const bar = e.target.closest(".snd-bar");
    if (!bar) return;
    const box = bar.closest(".snd");
    if (!box) return;
    e.preventDefault();
    scrubbing = true;
    bar.setPointerCapture?.(e.pointerId);
    // Seeking an idle player starts it -- clicking into the middle of a clip you haven't
    // played is a play command, not just a cursor move.
    if (box !== active) {
      const file = currentFile(box);
      if (!file) return;
      if (active) release();
      active = box;
      box.classList.remove("snd-error");
      const a = audio();
      a.src = soundUrl(file);
      seekTo(box, barFraction(bar, e.clientX));
      a.play().catch(onPlayReject);
      return;
    }
    seekTo(box, barFraction(bar, e.clientX));
  });
  root.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    const bar = e.target.closest(".snd-bar");
    const box = bar?.closest(".snd");
    if (!box || box !== active) return;
    seekTo(box, barFraction(bar, e.clientX));
  });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    const bar = e.target.closest?.(".snd-bar");
    bar?.releasePointerCapture?.(e.pointerId);
    paint(false);
  };
  root.addEventListener("pointerup", endScrub);
  root.addEventListener("pointercancel", endScrub);

  // Keyboard: the bar is a slider, so arrows scrub it by 5% and Home/End jump.
  root.addEventListener("keydown", (e) => {
    const bar = e.target.closest?.(".snd-bar");
    if (!bar) return;
    const box = bar.closest(".snd");
    const step = { ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 }[e.key];
    if (step === undefined || !box) return;
    e.preventDefault();
    const cur = (Number(bar.getAttribute("aria-valuenow")) || 0) / 100;
    seekTo(box, Math.abs(step) === 1 ? (step > 0 ? 1 : 0) : Math.min(1, Math.max(0, cur + step)));
  });
}
