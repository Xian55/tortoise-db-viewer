// Comparative context: "is this number big?".
//
// A raw stat ("3,379 armor", "54.6 DPS") says nothing on its own. Every page that
// shows one can put it next to the median of a comparable cohort -- creatures of the
// same level+rank (Q_NPC_PEERS), gear in the same slot/quality/ilvl band (item_peer)
// -- and the reader instantly knows whether it's typical or an outlier. This module
// owns the shared vocabulary for that: the ratio bar cell and the outlier headline.
//
// The cohorts themselves are each page's business; this only formats them.

// Cohorts smaller than this aren't representative -- callers drop the comparison
// rather than quote a median computed from a handful of rows. Mirrors
// scripts/lib/itempeers.mjs PEER_MIN (the item cohorts are built to the same floor).
export const PEER_MIN = 10;

const BAR_HALF = 46;  // px; half the bar's width, = a ±100% deviation

// A value's ratio to its cohort median, as a number + a deviation bar. Above the
// median is red and below is green by default, because these started life on the NPC
// Stats tab where "more than typical" means a harder fight. `positive: true` flips
// the colouring (not the bar) for stats where more is better -- item armor, DPS.
export function ratioCell(ratio, { positive = false } = {}) {
  if (ratio == null || !isFinite(ratio) || ratio <= 0) return "";
  // Within ±2% of the median is "typical" -- show the number, skip the bar.
  const dir = ratio > 1.02 ? "over" : ratio < 0.98 ? "under" : "";
  const w = Math.min(BAR_HALF, Math.round(Math.abs(ratio - 1) * 100));
  return `<span class="cmp${positive ? " pos" : ""}"><span class="cmp-num${dir ? " " + dir : ""}">×${ratio.toFixed(2)}</span>` +
    `<span class="cmp-bar">${dir ? `<i class="${dir}" style="width:${w}px"></i>` : ""}</span></span>`;
}

// Share of the cohort this value beats, from a competition rank (1 = highest).
// Ties share a rank, so the number is "at least this many are worse" -- never
// overstated.
export const pctBeaten = (rank, n) => (n > 1 ? Math.round(((n - rank) / (n - 1)) * 100) : 0);

// The one-line "did you know" above a stat table: the single most extreme stat the
// entity has, in words. Only fires on a genuine outlier (top/bottom decile) -- a
// headline on every page would be noise, and a page with nothing remarkable
// deserves nothing.
//
// `metrics`: [{ label, ratio, rank, n }] -- rank/n from the cohort, ratio vs its
// median. `cohortPlural`: "level 54 mobs", "Epic ilvl 60–64 One-Hand Swords".
export function outlierLine(metrics, cohortPlural) {
  let best = null, bestScore = 0;
  for (const m of metrics) {
    if (!m || !m.rank || !(m.n >= PEER_MIN) || !m.ratio || !isFinite(m.ratio)) continue;
    const pct = pctBeaten(m.rank, m.n);
    if (pct < 90 && pct > 10) continue;                 // not an outlier
    const score = Math.abs(Math.log(m.ratio));          // furthest from the median wins
    if (score > bestScore) { bestScore = score; best = { ...m, pct }; }
  }
  if (!best || bestScore < Math.log(1.15)) return "";   // within ±15% isn't a story
  const high = best.pct >= 90;
  const times = best.ratio >= 10 ? Math.round(best.ratio) : best.ratio.toFixed(1);
  const what = best.rank === 1
    ? `<b>Highest ${best.label}</b> of all ${best.n.toLocaleString()} ${cohortPlural}`
    : high
      ? `More <b>${best.label}</b> than <b>${best.pct}%</b> of ${cohortPlural}`
      : `Less <b>${best.label}</b> than <b>${100 - best.pct}%</b> of ${cohortPlural}`;
  return `<p class="trivia ${high ? "hi" : "lo"}">${what} — ×${times} the median.</p>`;
}
