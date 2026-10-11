// Tolerant GPX reader/writer built on regex tokenizing (no DOMParser, so it
// runs in Node and Web Workers). Only trkpt lat/lon attributes are ever edited.

const TAG_RE = /<(\/?)(?:[\w.-]+:)?(trkpt|trkseg|trk)\b([^>]*?)(\/?)>/g;
const TIME_RE = /<(?:[\w.-]+:)?time\b[^>]*>\s*([^<]*?)\s*<\/(?:[\w.-]+:)?time>/;
const LAT_ATTR_RE = /(\blat\s*=\s*)(["'])([^"']*)\2/;
const LON_ATTR_RE = /(\blon\s*=\s*)(["'])([^"']*)\2/;

function attr(re, attrs, what, n) {
  const m = re.exec(attrs);
  const v = m ? parseFloat(m[3]) : NaN;
  if (!Number.isFinite(v)) throw new Error(`GPX trackpoint ${n + 1} has no valid ${what}.`);
  return v;
}

/** Iterate trkpt/trkseg/trk tokens. Each trkpt token carries its body text. */
function* tokens(text) {
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text))) {
    const [full, closing, name, attrs, selfClose] = m;
    const start = m.index;
    const end = start + full.length;
    if (name === 'trkpt' && !closing) {
      let body = '';
      let bodyEnd = end;
      if (!selfClose) {
        const close = /<\/(?:[\w.-]+:)?trkpt\s*>/g;
        close.lastIndex = end;
        const c = close.exec(text);
        bodyEnd = c ? c.index : text.length;
        body = text.slice(end, bodyEnd);
      }
      yield { kind: 'pt', start, end, attrs, body };
      TAG_RE.lastIndex = bodyEnd;
    } else if (name !== 'trkpt') {
      yield { kind: closing ? `/${name}` : name, start, end };
    }
  }
}

export function parseGpx(text) {
  const tracks = [];
  let track = null;
  let segment = null;
  let index = 0;
  for (const t of tokens(text)) {
    if (t.kind === 'trk') {
      track = { segments: [] };
      tracks.push(track);
      segment = null;
    } else if (t.kind === 'trkseg') {
      if (!track) {
        track = { segments: [] };
        tracks.push(track);
      }
      segment = { points: [] };
      track.segments.push(segment);
    } else if (t.kind === '/trkseg') {
      segment = null;
    } else if (t.kind === '/trk') {
      track = null;
      segment = null;
    } else if (t.kind === 'pt') {
      if (!track) {
        track = { segments: [] };
        tracks.push(track);
      }
      if (!segment) {
        segment = { points: [] };
        track.segments.push(segment);
      }
      const lat = attr(LAT_ATTR_RE, t.attrs, 'lat', index);
      const lon = attr(LON_ATTR_RE, t.attrs, 'lon', index);
      const tm = TIME_RE.exec(t.body);
      const time = tm ? Date.parse(tm[1]) : NaN;
      if (!Number.isFinite(time)) {
        throw new Error(
          `GPX trackpoint ${index + 1} has no valid <time>. Real timestamps are required for map matching.`);
      }
      segment.points.push({ lat, lon, time, index });
      index++;
    }
  }
  if (index === 0) throw new Error('No track points (<trkpt>) found in the GPX file.');
  return { tracks, pointCount: index };
}

/**
 * Replace only the lat/lon attribute values (7 decimals) of every trkpt, in
 * document order. Everything else in the text is left byte-identical.
 */
export function rewriteGpxPositions(originalText, newLatLons) {
  let out = '';
  let last = 0;
  let n = 0;
  for (const t of tokens(originalText)) {
    if (t.kind !== 'pt') continue;
    const ll = newLatLons[n++];
    if (!ll) throw new Error('Fewer new positions than trackpoints in the GPX.');
    const attrs = t.attrs
      .replace(LAT_ATTR_RE, (_, p, q) => `${p}${q}${ll[0].toFixed(7)}${q}`)
      .replace(LON_ATTR_RE, (_, p, q) => `${p}${q}${ll[1].toFixed(7)}${q}`);
    const open = originalText.slice(t.start, t.end);
    const attrsAt = open.indexOf(t.attrs);
    out += originalText.slice(last, t.start) + open.slice(0, attrsAt) + attrs +
      open.slice(attrsAt + t.attrs.length);
    last = t.end;
  }
  if (n !== newLatLons.length) throw new Error('More new positions than trackpoints in the GPX.');
  return out + originalText.slice(last);
}

/** Append `suffix` to the first <name> of the first <trk> (before its first segment). */
export function renameTrack(text, suffix = ' (tidied)') {
  const trk = /<(?:[\w.-]+:)?trk\s*>/.exec(text);
  if (!trk) return text;
  const from = trk.index + trk[0].length;
  const stop = /<(?:[\w.-]+:)?(?:trkseg|trkpt)\b/g;
  stop.lastIndex = from;
  const s = stop.exec(text);
  const limit = s ? s.index : text.length;
  const re = /(<(?:[\w.-]+:)?name\s*>)([^<]*)(<\/(?:[\w.-]+:)?name\s*>)/g;
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m || m.index >= limit) return text;
  return text.slice(0, m.index) + m[1] + m[2] + suffix + m[3] + text.slice(m.index + m[0].length);
}
