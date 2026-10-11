// Tolerant Garmin TCX (TrainingCenterDatabase v2) reader/writer built on regex tokenizing
// (no DOMParser, so it runs in Node and Web Workers). Tag names are matched prefix-agnostically.
// Only Latitude/LongitudeDegrees and trackpoint/lap DistanceMeters element texts are ever edited.
import { haversine } from './geo.js';

const TAG_RE = /<(\/?)(?:[\w.-]+:)?(Activity|Lap|Trackpoint|Track)\b([^>]*?)(\/?)>/g;
const NO_GPS = 'This TCX file has no GPS positions. Only activities recorded with GPS can be tidied.';

/** Find the first <name>text</name> in `body`; returns absolute offsets of the trimmed text. */
function elem(body, name, base) {
  const re = new RegExp(`(<(?:[\\w.-]+:)?${name}\\b[^>]*>)(\\s*)([^<]*?)(\\s*)<\\/(?:[\\w.-]+:)?${name}\\s*>`);
  const m = re.exec(body);
  if (!m) return null;
  const start = base + m.index + m[1].length + m[2].length;
  return { start, end: start + m[3].length, text: m[3] };
}

/**
 * Scan the document into activities > laps > tracks > trackpoints, recording the exact character
 * spans of the editable values. Missing containers are created implicitly.
 */
function scan(text) {
  const activities = [];
  let act = null, lap = null, track = null;
  const newAct = () => { act = { laps: [], trackpoints: [] }; activities.push(act); lap = null; track = null; };
  const newLap = (bodyStart) => { if (!act) newAct(); lap = { bodyStart, dist: null, headDone: false, trackpoints: [] }; act.laps.push(lap); track = null; };
  const finishHead = (endAt) => {
    if (!lap || lap.headDone) return;
    lap.headDone = true;
    lap.dist = elem(text.slice(lap.bodyStart, endAt), 'DistanceMeters', lap.bodyStart);
  };

  TAG_RE.lastIndex = 0;
  let m;
  let order = 0;
  while ((m = TAG_RE.exec(text))) {
    const [full, closing, name, , selfClose] = m;
    const start = m.index;
    const end = start + full.length;
    if (name === 'Activity') {
      if (!closing) newAct(); else { act = lap = track = null; }
    } else if (name === 'Lap') {
      if (!closing) { finishHead(start); newLap(end); if (selfClose) lap.headDone = true; } else { finishHead(start); lap = null; track = null; }
    } else if (name === 'Track') {
      if (closing) { track = null; continue; }
      if (!act) newAct();
      if (!lap) newLap(end);
      finishHead(start);
      track = { trackpoints: [] };
      lap.tracks = lap.tracks || [];
      lap.tracks.push(track);
      act.tracks = act.tracks || [];
      act.tracks.push(track);
    } else if (!closing) {
      let body = '';
      let bodyEnd = end;
      if (!selfClose) {
        const close = /<\/(?:[\w.-]+:)?Trackpoint\s*>/g;
        close.lastIndex = end;
        const c = close.exec(text);
        bodyEnd = c ? c.index : text.length;
        body = text.slice(end, bodyEnd);
      }
      TAG_RE.lastIndex = bodyEnd;
      if (!act) newAct();
      if (!lap) newLap(end);
      finishHead(start);
      if (!track) {
        track = { trackpoints: [] };
        lap.tracks = lap.tracks || [];
        lap.tracks.push(track);
        act.tracks = act.tracks || [];
        act.tracks.push(track);
      }
      const posM = /<(?:[\w.-]+:)?Position\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Position\s*>/.exec(body);
      let latE = null, lonE = null;
      if (posM) {
        const pBase = end + posM.index + posM[0].indexOf(posM[1]);
        latE = elem(posM[1], 'LatitudeDegrees', pBase);
        lonE = elem(posM[1], 'LongitudeDegrees', pBase);
      }
      const timeE = elem(body, 'Time', end);
      const tp = {
        order: order++,
        hasPosition: !!posM,
        latE, lonE, timeE,
        dist: elem(body, 'DistanceMeters', end),
      };
      track.trackpoints.push(tp);
      lap.trackpoints.push(tp);
      act.trackpoints.push(tp);
    }
  }
  return activities;
}

function parseTime(s) {
  if (s === undefined) return NaN;
  // ISO without a zone designator is treated as UTC (TCX times are UTC by convention).
  const t = /T\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(s) ? `${s}Z` : s;
  return Date.parse(t);
}

function positionOf(tp, n) {
  const lat = tp.latE ? parseFloat(tp.latE.text) : NaN;
  const lon = tp.lonE ? parseFloat(tp.lonE.text) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`TCX trackpoint ${n} has a <Position> without valid latitude/longitude.`);
  }
  return [lat, lon];
}

/** Trackpoints that carry a Position, in document order. */
function positioned(activities) {
  return activities.flatMap((a) => a.trackpoints).filter((tp) => tp.hasPosition);
}

export function parseTcx(text) {
  const activities = scan(text);
  const tracks = [];
  let index = 0;
  let seen = 0;
  for (const act of activities) {
    const track = { segments: [] };
    for (const tr of act.tracks || []) {
      const segment = { points: [] };
      for (const tp of tr.trackpoints) {
        seen++;
        if (!tp.hasPosition) continue;
        const [lat, lon] = positionOf(tp, seen);
        const time = parseTime(tp.timeE?.text);
        if (!Number.isFinite(time)) {
          throw new Error(
            `TCX trackpoint ${seen} has no valid <Time>. Real timestamps are required for map matching.`);
        }
        segment.points.push({ lat, lon, time, index });
        index++;
      }
      track.segments.push(segment);
    }
    if (track.segments.length) tracks.push(track);
  }
  if (index === 0) throw new Error(NO_GPS);
  return { tracks, pointCount: index };
}

function applyEdits(text, edits) {
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let last = 0;
  for (const e of edits) {
    out += text.slice(last, e.start) + e.value;
    last = e.end;
  }
  return out + text.slice(last);
}

/**
 * Replace only the LatitudeDegrees/LongitudeDegrees text (7 decimals) of every trackpoint that has a
 * Position, in document order. Everything else is left byte-identical.
 */
export function rewriteTcxPositions(originalText, newLatLons) {
  const pts = positioned(scan(originalText));
  if (newLatLons.length < pts.length) throw new Error('Fewer new positions than positioned trackpoints in the TCX.');
  if (newLatLons.length > pts.length) throw new Error('More new positions than positioned trackpoints in the TCX.');
  const edits = [];
  pts.forEach((tp, i) => {
    positionOf(tp, i + 1);
    edits.push({ ...tp.latE, value: newLatLons[i][0].toFixed(7) });
    edits.push({ ...tp.lonE, value: newLatLons[i][1].toFixed(7) });
  });
  return applyEdits(originalText, edits);
}

const decimalsOf = (s) => {
  const m = /\.(\d+)/.exec(s);
  return m ? m[1].length : 1;
};
const fmt = (v, like) => v.toFixed(decimalsOf(like));

/**
 * Recompute cumulative trackpoint DistanceMeters (and Lap DistanceMeters) for the new positions.
 * `newLatLons` follows the same order as rewriteTcxPositions. Per activity, at a positioned trackpoint:
 * new = (original distance at the first positioned trackpoint that has one) + haversine path length of
 * the new positions since that trackpoint. Unpositioned trackpoints with a distance carry the previous
 * positioned trackpoint's change. Original decimal counts are preserved.
 */
export function updateTcxDistances(text, newLatLons) {
  const activities = scan(text);
  if (newLatLons.length !== positioned(activities).length) {
    throw new Error('Number of new positions does not match the positioned trackpoints in the TCX.');
  }
  const edits = [];
  let n = 0;
  for (const act of activities) {
    const newDist = new Map(); // tp -> new numeric distance
    let anchorOld = null, cum = 0, anchorCum = 0, prevLL = null;
    let delta = 0, prevNew = -Infinity;
    for (const tp of act.trackpoints) {
      let value;
      const oldV = tp.dist ? parseFloat(tp.dist.text) : NaN;
      if (tp.hasPosition) {
        const ll = newLatLons[n++];
        if (prevLL) cum += haversine(prevLL[0], prevLL[1], ll[0], ll[1]);
        prevLL = ll;
        if (Number.isFinite(oldV)) {
          if (anchorOld === null) { anchorOld = oldV; anchorCum = cum; }
          value = anchorOld + (cum - anchorCum);
          delta = value - oldV;
        }
      } else if (Number.isFinite(oldV)) {
        value = oldV + delta;
      }
      if (value === undefined) continue;
      value = Math.max(value, prevNew); // keep the cumulative series non-decreasing
      prevNew = value;
      newDist.set(tp, value);
      edits.push({ ...tp.dist, value: fmt(value, tp.dist.text) });
    }
    for (const lap of act.laps) {
      if (!lap.dist) continue;
      const lapOld = parseFloat(lap.dist.text);
      const withDist = lap.trackpoints.filter((tp) => newDist.has(tp));
      if (!Number.isFinite(lapOld) || withDist.length < 2) continue;
      const first = withDist[0], last = withDist[withDist.length - 1];
      const change = (newDist.get(last) - newDist.get(first)) -
        (parseFloat(last.dist.text) - parseFloat(first.dist.text));
      edits.push({ ...lap.dist, value: fmt(lapOld + change, lap.dist.text) });
    }
  }
  return applyEdits(text, edits);
}

/** Replace positions and fix up cumulative distances in one step. */
export function applyTidiedPositionsToTcx(text, latLons) {
  // Distances use the 7-decimal values that actually get written.
  const rounded = latLons.map(([a, b]) => [parseFloat(a.toFixed(7)), parseFloat(b.toFixed(7))]);
  return updateTcxDistances(rewriteTcxPositions(text, rounded), rounded);
}
