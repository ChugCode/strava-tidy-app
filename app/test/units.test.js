import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpx, rewriteGpxPositions, renameTrack } from '../src/gpx.js';
import {
  parseOsmXml, parseOverpassJson, mergeWays, bboxForTrack, tileBbox, osmApiUrl, overpassQuery,
} from '../src/osm.js';
import { matchTrack } from '../src/matcher.js';
import { summarize, formatPace } from '../src/report.js';
import { haversine } from '../src/geo.js';

// ------------------------------------------------------------------- GPX
const pt = (lat, lon, time, extra = '') =>
  `<trkpt lat="${lat}" lon="${lon}">${extra}${time ? `<time>${time}</time>` : ''}</trkpt>`;

test('parseGpx rejects trackpoints without time', () => {
  const gpx = `<gpx><trk><trkseg>${pt(1, 2, '2026-01-01T00:00:00Z')}${pt(1, 2.1, null)}</trkseg></trk></gpx>`;
  assert.throws(() => parseGpx(gpx), /<time>/);
});

test('parseGpx rejects files without trkpt', () => {
  assert.throws(() => parseGpx('<gpx></gpx>'), /No track points/);
});

test('parseGpx handles multiple trk/trkseg, namespace prefixes and missing ele', () => {
  const gpx = `<g:gpx xmlns:g="x"><g:trk><g:trkseg>
    <g:trkpt lat="1" lon="2"><g:ele>5</g:ele><g:time>2026-01-01T00:00:00Z</g:time></g:trkpt>
    <g:trkpt lat='1.5' lon='2.5'><g:time>2026-01-01T00:00:01.500Z</g:time></g:trkpt></g:trkseg>
    <g:trkseg><g:trkpt lat="3" lon="4"><g:time>2026-01-01T00:00:10Z</g:time></g:trkpt></g:trkseg></g:trk>
    <g:trk><g:trkseg><g:trkpt lat="5" lon="6"><g:time>2026-01-01T00:00:20Z</g:time></g:trkpt></g:trkseg></g:trk></g:gpx>`;
  const r = parseGpx(gpx);
  assert.equal(r.pointCount, 4);
  assert.equal(r.tracks.length, 2);
  assert.equal(r.tracks[0].segments.length, 2);
  assert.equal(r.tracks[0].segments[0].points.length, 2);
  assert.equal(r.tracks[0].segments[0].points[1].lat, 1.5);
  assert.equal(r.tracks[0].segments[0].points[1].time - r.tracks[0].segments[0].points[0].time, 1500);
  assert.deepEqual(r.tracks[1].segments[0].points.map((p) => p.index), [3]);
});

test('rewriteGpxPositions replaces only lat/lon values', () => {
  const gpx = `<?xml?>\n<gpx>\n <trk><name>Run</name><trkseg>\n` +
    `  <trkpt lat="1.0000000" lon="2.0000000">\n   <ele>3</ele>\n   <time>2026-01-01T00:00:00Z</time>\n  </trkpt>\n` +
    `  <trkpt lat="1.1" lon="2.1"><time>2026-01-01T00:00:01Z</time></trkpt>\n </trkseg></trk>\n</gpx>\n`;
  const out = rewriteGpxPositions(gpx, [[10.123456789, 20.5], [11, 21]]);
  assert.match(out, /<trkpt lat="10\.1234568" lon="20\.5000000">/);
  assert.match(out, /<trkpt lat="11\.0000000" lon="21\.0000000">/);
  const strip = (t) => t.replace(/ lat="[^"]*" lon="[^"]*"/g, '');
  assert.equal(strip(out), strip(gpx));
  assert.throws(() => rewriteGpxPositions(gpx, [[1, 2]]));
});

test('renameTrack appends suffix to the first track name only', () => {
  const gpx = '<gpx><metadata><name>meta</name></metadata><trk><name>Run</name><trkseg></trkseg></trk></gpx>';
  assert.equal(renameTrack(gpx), gpx.replace('<name>Run', '<name>Run (tidied)'));
  const noName = '<gpx><trk><trkseg></trkseg></trk></gpx>';
  assert.equal(renameTrack(noName), noName);
});

// -------------------------------------------------------------------- OSM
const OSM_XML = `<osm>
 <node id="1" lat="51.0" lon="0.0"/><node id="2" lat="51.001" lon="0.0"/><node id="3" lat="51.002" lon="0.0"/>
 <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="A &amp; B"/></way>
 <way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="service"/><tag k="service" v="driveway"/></way>
 <way id="12"><nd ref="2"/><nd ref="3"/><tag k="highway" v="motorway"/></way>
 <way id="13"><nd ref="2"/><nd ref="3"/><tag k="highway" v="footway"/><tag k="access" v="private"/></way>
 <way id="14"><nd ref="2"/><nd ref="3"/><tag k="highway" v="footway"/></way>
 <way id="15"><nd ref="2"/><nd ref="3"/><tag k="building" v="yes"/></way>
</osm>`;

test('parseOsmXml filters excluded ways and decodes entities', () => {
  const ways = parseOsmXml(OSM_XML);
  assert.deepEqual(ways.map((w) => w.id), ['10', '14']);
  assert.equal(ways[0].tags.name, 'A & B');
  assert.equal(ways[0].nodeIds[1], '51.0010000,0.0000000');
  assert.equal(ways[0].coords.length, 2);
});

test('parseOverpassJson applies the same filtering and node ids', () => {
  const g = (a, b) => [{ lat: a, lon: b }, { lat: a + 0.001, lon: b }];
  const way = (id, tags) => ({ type: 'way', id, tags, geometry: g(51, 0) });
  const ways = parseOverpassJson({
    elements: [
      way(10, { highway: 'residential' }),
      way(11, { highway: 'service', service: 'driveway' }),
      way(12, { highway: 'service', service: 'parking_aisle' }),
      way(13, { highway: 'motorway' }),
      way(14, { highway: 'path', access: 'no' }),
      way(15, { highway: 'path' }),
      { type: 'node', id: 99, lat: 1, lon: 1 },
    ],
  });
  assert.deepEqual(ways.map((w) => w.id), ['10', '15']);
  assert.equal(ways[0].nodeIds[0], '51.0000000,0.0000000');
});

test('mergeWays dedupes by id, keeping first occurrence order', () => {
  const w = (id) => ({ id, coords: [], nodeIds: [] });
  assert.deepEqual(mergeWays([[w('1'), w('2')], [w('2'), w('3')]]).map((x) => x.id), ['1', '2', '3']);
});

test('bbox helpers and URLs', () => {
  const b = bboxForTrack([{ lat: 51, lon: 0 }, { lat: 51.01, lon: 0.02 }], 150);
  assert.ok(b.minLat < 51 && b.maxLat > 51.01 && b.minLon < 0 && b.maxLon > 0.02);
  assert.match(osmApiUrl(b), /^https:\/\/api\.openstreetmap\.org\/api\/0\.6\/map\?bbox=-?\d/);
  assert.match(overpassQuery(b), /out geom tags;$/);
});

test('tileBbox skips cells the track does not pass near (L-shaped track)', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push({ lat: 51 + 0.06 * (i / 100), lon: 0 }); // north leg
  for (let i = 1; i <= 100; i++) pts.push({ lat: 51.06, lon: 0.06 * (i / 100) }); // east leg
  const bbox = bboxForTrack(pts, 150);
  const all = tileBbox(bbox, 0.02);
  const used = tileBbox(bbox, 0.02, pts, 150);
  assert.ok(all.length >= 16);
  assert.ok(used.length < all.length, `${used.length} < ${all.length}`);
  for (const p of pts) {
    assert.ok(used.some((c) => p.lat >= c.minLat && p.lat <= c.maxLat && p.lon >= c.minLon && p.lon <= c.maxLon));
  }
});

// ---------------------------------------------------------------- matcher
const LAT0 = 51.0, LON0 = 0.0;
const M_LAT = 111194.9; // metres per degree latitude (R=6371000)
const M_LON = M_LAT * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x, y) => [LAT0 + y / M_LAT, LON0 + x / M_LON];

function wayFrom(id, xy, highway = 'residential') {
  const coords = xy.map(([x, y]) => ll(x, y));
  return { id, highway, tags: { highway }, coords, nodeIds: coords.map(([a, b]) => `${a.toFixed(7)},${b.toFixed(7)}`) };
}

// Deterministic pseudo-random noise in [-1, 1).
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 2 ** 31) - 1;
  };
}

function walk(path, speed, noise, rand) {
  // path: function t(seconds) -> [x, y]; returns 1 Hz points
  const pts = [];
  for (let t = 0; t < 120; t++) {
    const [x, y] = path(t * speed);
    const [lat, lon] = ll(x + noise.x * rand(), y + noise.y * rand());
    pts.push({ lat, lon, time: Date.UTC(2026, 0, 1) + t * 1000, index: t });
  }
  return pts;
}

test('track far from any road stays off-network and unchanged', () => {
  const road = wayFrom('r', [[0, 0], [400, 0]]);
  const rand = rng(1);
  const pts = walk((d) => [d, 60], 3, { x: 1, y: 2 }, rand);
  const { positions, stats } = matchTrack(pts, [road]);
  const off = positions.filter((p) => !p.onNetwork).length;
  assert.ok(off >= pts.length * 0.95, `off-network ${off}/${pts.length}`);
  positions.forEach((p, i) => {
    if (!p.onNetwork) {
      assert.equal(p.lat, pts[i].lat);
      assert.equal(p.lon, pts[i].lon);
    }
  });
  assert.equal(stats.snapped + stats.offNetwork, pts.length);
});

test('noisy track hugging a road snaps to it', () => {
  const road = wayFrom('r', [[0, 0], [200, 0], [400, 0]]);
  const rand = rng(7);
  const pts = walk((d) => [d, 0], 3, { x: 0, y: 6 }, rand);
  const { positions } = matchTrack(pts, [road]);
  assert.ok(positions.every((p) => p.onNetwork));
  const lateral = positions.map((p) => Math.abs((p.lat - LAT0) * M_LAT));
  const mean = lateral.reduce((a, b) => a + b, 0) / lateral.length;
  assert.ok(mean < 3, `mean lateral error ${mean}`);
});

test('ways that cross without a shared node are not connected (bridge)', () => {
  // A runs west-east. B is a footbridge running north-south over A with no node at the crossing.
  const A = wayFrom('A', [[0, 0], [100, 0], [200, 0], [300, 0]]);
  const B = wayFrom('B', [[150, -100], [150, -50], [150, 50], [150, 100]], 'footway');
  B.tags.bridge = 'yes';
  const pts = walk((d) => [d, 3], 2.4, { x: 0, y: 0 }, () => 0); // runs along A, 3 m north of it
  const { positions } = matchTrack(pts, [A, B]);
  assert.ok(positions.every((p) => p.onNetwork));
  for (const p of positions) {
    const x = (p.lon - LON0) * M_LON;
    const y = (p.lat - LAT0) * M_LAT;
    assert.ok(Math.abs(y) < 0.5, `left road A: y=${y} at x=${x}`);
  }
});

// ----------------------------------------------------------------- report
test('summarize computes splits, distances and off-network runs', () => {
  // 1 Hz, 4 m/s straight line east for 600 s = 2400 m
  const pts = [];
  for (let t = 0; t <= 600; t++) {
    const [lat, lon] = ll(4 * t, 0);
    pts.push({ lat, lon, time: Date.UTC(2026, 0, 1) + t * 1000 });
  }
  const positions = pts.map((p, i) => ({ lat: p.lat, lon: p.lon, onNetwork: i < 100 || i > 130 }));
  const s = summarize(pts, positions);
  assert.ok(Math.abs(s.rawDistanceM - 2400) < 5);
  assert.equal(s.matchedDistanceM, s.rawDistanceM);
  assert.equal(s.splits.length, 3);
  assert.ok(Math.abs(s.splits[0].rawSecPerKm - 250) < 1);
  assert.equal(s.splits[2].partialMeters > 390 && s.splits[2].partialMeters < 410, true);
  assert.equal(s.offNetworkCount, 31);
  assert.equal(s.offNetworkRuns.length, 1);
  assert.equal(s.offNetworkRuns[0].durationS, 30);
  assert.equal(s.maxDisplacementM, 0);
  assert.ok(haversine(pts[0].lat, pts[0].lon, pts[1].lat, pts[1].lon) > 3.9);
});

test('formatPace', () => {
  assert.equal(formatPace(439.6), '7:20');
  assert.equal(formatPace(425), '7:05');
  assert.equal(formatPace(NaN), '--:--');
});
