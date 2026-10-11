// OSM data: parsing (API 0.6 XML and Overpass JSON), filtering, bbox helpers.
// Both parsers yield the same way shape:
//   { id, highway, tags, coords: [[lat, lon], ...], nodeIds: [string, ...] }
// Node ids are derived from coordinates, so ways connect only where they share
// a node position (a bridge crossing another road without a node stays unlinked)
// and ways from different downloads/tiles still join up.
import { coordId } from './geo.js';

export const ALLOWED_HIGHWAYS = new Set([
  'residential', 'service', 'footway', 'path', 'cycleway', 'pedestrian',
  'living_street', 'unclassified', 'tertiary', 'secondary', 'primary',
  'trunk', 'track', 'steps', 'bridleway',
  'primary_link', 'secondary_link', 'tertiary_link', 'trunk_link',
]);
const EXCLUDED_HIGHWAYS = new Set(['motorway', 'motorway_link']);
const EXCLUDED_SERVICE = new Set(['driveway', 'parking_aisle']);
const EXCLUDED_ACCESS = new Set(['private', 'no']);
const KEPT_TAGS = ['highway', 'name', 'service', 'access', 'bridge', 'tunnel', 'layer', 'surface'];

export function wayAllowed(tags) {
  const hw = tags.highway;
  if (hw === undefined || EXCLUDED_HIGHWAYS.has(hw) || !ALLOWED_HIGHWAYS.has(hw)) return false;
  if (EXCLUDED_SERVICE.has(tags.service)) return false;
  if (EXCLUDED_ACCESS.has(tags.access)) return false;
  return true;
}

function makeWay(id, tags, coords) {
  if (!wayAllowed(tags) || coords.length < 2) return null;
  const kept = {};
  for (const k of KEPT_TAGS) if (tags[k] !== undefined) kept[k] = tags[k];
  return {
    id: String(id),
    highway: tags.highway,
    tags: kept,
    coords,
    nodeIds: coords.map(([la, lo]) => coordId(la, lo)),
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()];
  });
}

function attrs(s) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = decode(m[2] !== undefined ? m[2] : m[3]);
  return out;
}

export function parseOsmXml(text) {
  const nodes = new Map();
  const nodeRe = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = nodeRe.exec(text))) {
    const a = attrs(m[1]);
    const lat = parseFloat(a.lat);
    const lon = parseFloat(a.lon);
    if (a.id !== undefined && Number.isFinite(lat) && Number.isFinite(lon)) nodes.set(a.id, [lat, lon]);
  }
  const ways = [];
  const wayRe = /<way\b([^>]*?)>([\s\S]*?)<\/way\s*>/g;
  while ((m = wayRe.exec(text))) {
    const id = attrs(m[1]).id;
    const body = m[2];
    const tags = {};
    const tagRe = /<tag\b([^>]*?)\/?>/g;
    let t;
    while ((t = tagRe.exec(body))) {
      const a = attrs(t[1]);
      if (a.k !== undefined) tags[a.k] = a.v ?? '';
    }
    const coords = [];
    const ndRe = /<nd\b([^>]*?)\/?>/g;
    let n;
    while ((n = ndRe.exec(body))) {
      const c = nodes.get(attrs(n[1]).ref);
      if (c) coords.push(c);
    }
    const way = makeWay(id, tags, coords);
    if (way) ways.push(way);
  }
  return ways;
}

export function parseOverpassJson(obj) {
  const ways = [];
  for (const el of obj?.elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const coords = el.geometry.filter((g) => g && Number.isFinite(g.lat)).map((g) => [g.lat, g.lon]);
    const way = makeWay(el.id, el.tags ?? {}, coords);
    if (way) ways.push(way);
  }
  return ways;
}

export function mergeWays(listOfWayArrays) {
  const seen = new Set();
  const out = [];
  for (const arr of listOfWayArrays) {
    for (const w of arr) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      out.push(w);
    }
  }
  return out;
}

// ------------------------------------------------------------------- bboxes
// bbox = { minLat, minLon, maxLat, maxLon }
const M_PER_DEG = 111320.0;

export function bboxForTrack(points, marginM = 150) {
  if (!points.length) throw new Error('Cannot compute a bounding box for an empty track.');
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity, sumLat = 0;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    sumLat += p.lat;
  }
  const mLat = marginM / M_PER_DEG;
  const mLon = marginM / (M_PER_DEG * Math.cos((sumLat / points.length) * Math.PI / 180));
  return { minLat: minLat - mLat, minLon: minLon - mLon, maxLat: maxLat + mLat, maxLon: maxLon + mLon };
}

export function osmApiUrl(b) {
  const f = (v) => v.toFixed(6);
  return `https://api.openstreetmap.org/api/0.6/map?bbox=${f(b.minLon)},${f(b.minLat)},${f(b.maxLon)},${f(b.maxLat)}`;
}

export function overpassQuery(b) {
  const f = (v) => v.toFixed(6);
  return `[out:json][timeout:60];way["highway"](${f(b.minLat)},${f(b.minLon)},${f(b.maxLat)},${f(b.maxLon)});out geom tags;`;
}

/**
 * Split a bbox into cells of at most maxDeg per side. If `points` is given,
 * keep only cells the track passes within marginM of, so an L-shaped run does
 * not download its whole bounding rectangle.
 */
export function tileBbox(bbox, maxDeg = 0.02, points = null, marginM = 150) {
  const nx = Math.max(1, Math.ceil((bbox.maxLon - bbox.minLon) / maxDeg));
  const ny = Math.max(1, Math.ceil((bbox.maxLat - bbox.minLat) / maxDeg));
  const dLon = (bbox.maxLon - bbox.minLon) / nx;
  const dLat = (bbox.maxLat - bbox.minLat) / ny;
  const cells = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      cells.push({
        minLat: bbox.minLat + j * dLat, maxLat: bbox.minLat + (j + 1) * dLat,
        minLon: bbox.minLon + i * dLon, maxLon: bbox.minLon + (i + 1) * dLon,
      });
    }
  }
  if (!points || !points.length) return cells;

  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const mLat = marginM / M_PER_DEG;
  const mLon = marginM / (M_PER_DEG * Math.cos(midLat * Math.PI / 180));
  const used = new Set();
  const mark = (lat, lon) => {
    // every cell whose margin-expanded rectangle contains the point
    const i0 = Math.max(0, Math.floor((lon - mLon - bbox.minLon) / dLon));
    const i1 = Math.min(nx - 1, Math.floor((lon + mLon - bbox.minLon) / dLon));
    const j0 = Math.max(0, Math.floor((lat - mLat - bbox.minLat) / dLat));
    const j1 = Math.min(ny - 1, Math.floor((lat + mLat - bbox.minLat) / dLat));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) used.add(j * nx + i);
  };
  // Densify long hops so a sparse track cannot skip over a cell.
  const step = Math.max(marginM / 2, 1) / M_PER_DEG;
  let prev = null;
  for (const p of points) {
    if (prev) {
      const k = Math.ceil(Math.max(Math.abs(p.lat - prev.lat), Math.abs(p.lon - prev.lon)) / step);
      for (let q = 1; q < k; q++) mark(prev.lat + (p.lat - prev.lat) * q / k, prev.lon + (p.lon - prev.lon) * q / k);
    }
    mark(p.lat, p.lon);
    prev = p;
  }
  return cells.filter((_, idx) => used.has(idx));
}
