// Before/after statistics for a matched track (port of match.py's report).
import { haversine } from './geo.js';

export const LONG_OFF_RUN_S = 10; // report off-network runs longer than this

export function formatPace(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '--:--';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function totalDist(ll) {
  let d = 0;
  for (let i = 1; i < ll.length; i++) d += haversine(ll[i - 1].lat, ll[i - 1].lon, ll[i].lat, ll[i].lon);
  return d;
}

/** Full-km splits by cumulative distance with interpolated crossing times (seconds). */
function computeSplits(ll, ts) {
  const res = [];
  let cum = 0, km = 1, lastT = ts[0];
  for (let i = 1; i < ll.length; i++) {
    const d = haversine(ll[i - 1].lat, ll[i - 1].lon, ll[i].lat, ll[i].lon);
    const prevCum = cum;
    cum += d;
    while (cum >= km * 1000 && d > 0) {
      const t = ts[i - 1] + ((km * 1000 - prevCum) / d) * (ts[i] - ts[i - 1]);
      res.push({ secPerKm: t - lastT });
      lastT = t;
      km++;
    }
  }
  const rem = cum - (km - 1) * 1000;
  if (rem > 1) res.push({ secPerKm: ((ts[ts.length - 1] - lastT) * 1000) / rem, partialMeters: rem });
  return res;
}

function stepSpeeds(ll, ts) {
  const out = [];
  for (let i = 1; i < ll.length; i++) {
    out.push(haversine(ll[i - 1].lat, ll[i - 1].lon, ll[i].lat, ll[i].lon) / Math.max(ts[i] - ts[i - 1], 1e-9));
  }
  return out;
}

const maxOf = (a) => a.reduce((m, v) => Math.max(m, v), 0);

/** points: [{lat, lon, time(ms)}]; positions: [{lat, lon, onNetwork}] (same length). */
export function summarize(points, positions) {
  const n = points.length;
  const ts = points.map((p) => p.time / 1000);
  const sr = computeSplits(points, ts);
  const sm = computeSplits(positions, ts);
  const splits = [];
  for (let i = 0; i < Math.max(sr.length, sm.length); i++) {
    const entry = { km: i + 1, rawSecPerKm: sr[i]?.secPerKm ?? null, matchedSecPerKm: sm[i]?.secPerKm ?? null };
    const partial = sr[i]?.partialMeters ?? sm[i]?.partialMeters;
    if (partial !== undefined) entry.partialMeters = partial;
    splits.push(entry);
  }

  let snappedCount = 0, maxDisp = 0, dispSum = 0;
  for (let i = 0; i < n; i++) {
    if (!positions[i].onNetwork) continue;
    snappedCount++;
    const d = haversine(points[i].lat, points[i].lon, positions[i].lat, positions[i].lon);
    dispSum += d;
  }
  for (let i = 0; i < n; i++) {
    maxDisp = Math.max(maxDisp, haversine(points[i].lat, points[i].lon, positions[i].lat, positions[i].lon));
  }

  const offNetworkRuns = [];
  for (let k = 0; k < n;) {
    if (positions[k].onNetwork) { k++; continue; }
    let j = k;
    while (j + 1 < n && !positions[j + 1].onNetwork) j++;
    const durationS = ts[j] - ts[k];
    if (durationS > LONG_OFF_RUN_S) offNetworkRuns.push({ startTime: points[k].time, durationS, pointCount: j - k + 1 });
    k = j + 1;
  }

  return {
    rawDistanceM: totalDist(points),
    matchedDistanceM: totalDist(positions),
    splits,
    snappedCount,
    offNetworkCount: n - snappedCount,
    maxDisplacementM: maxDisp,
    meanDisplacementM: dispSum / Math.max(snappedCount, 1),
    maxStepSpeedRaw: maxOf(stepSpeeds(points, ts)),
    maxStepSpeedMatched: maxOf(stepSpeeds(positions, ts)),
    offNetworkRuns,
  };
}
