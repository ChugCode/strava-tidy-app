import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  parseTcx, rewriteTcxPositions, updateTcxDistances, applyTidiedPositionsToTcx,
} from '../src/tcx.js';
import { parseGpx } from '../src/gpx.js';
import { tidyActivity, tidyGpx, sniffFormat } from '../src/pipeline.js';
import { parseOsmXml } from '../src/osm.js';
import { haversine } from '../src/geo.js';

const stripValues = (t) =>
  t.replace(/(<(?:\w+:)?(?:LatitudeDegrees|LongitudeDegrees|DistanceMeters)>)[^<]*/g, '$1');
const stripLatLon = (t) => t.replace(/(<(?:\w+:)?(?:LatitudeDegrees|LongitudeDegrees)>)[^<]*/g, '$1');

// ---------------------------------------------------------- parse / rewrite
const HAND = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
 <Activities><Activity Sport="Running"><Id>2026-01-01T10:00:00.000Z</Id>
  <Lap StartTime="2026-01-01T10:00:00.000Z">
   <TotalTimeSeconds>3</TotalTimeSeconds><DistanceMeters>20.5</DistanceMeters><Calories>1</Calories>
   <Track>
    <Trackpoint><Time>2026-01-01T10:00:00.000Z</Time><DistanceMeters>0</DistanceMeters></Trackpoint>
    <Trackpoint><Time>2026-01-01T10:00:01.250Z</Time>
     <Position><LatitudeDegrees>51.0000000</LatitudeDegrees><LongitudeDegrees>0.0000000</LongitudeDegrees></Position>
     <AltitudeMeters>5.0</AltitudeMeters><DistanceMeters>10.0</DistanceMeters>
     <HeartRateBpm><Value>120</Value></HeartRateBpm>
     <Extensions><ns3:TPX><ns3:Speed>3.1</ns3:Speed></ns3:TPX></Extensions></Trackpoint>
    <Trackpoint><Time>2026-01-01T10:00:02+01:00</Time>
     <Position><LatitudeDegrees>51.0001</LatitudeDegrees><LongitudeDegrees>0.0001</LongitudeDegrees></Position>
     <DistanceMeters>20.5</DistanceMeters></Trackpoint>
   </Track>
  </Lap>
  <Lap StartTime="2026-01-01T10:00:03.000Z"><DistanceMeters>5</DistanceMeters>
   <Track><Trackpoint/><Trackpoint><Time>2026-01-01T10:00:03Z</Time>
     <Position><LatitudeDegrees>51.0002</LatitudeDegrees><LongitudeDegrees>0.0002</LongitudeDegrees></Position>
     <DistanceMeters>25</DistanceMeters></Trackpoint></Track>
  </Lap>
 </Activity></Activities>
</TrainingCenterDatabase>`;

test('parseTcx handles laps, missing Position, prefixes and millisecond times', () => {
  const r = parseTcx(HAND);
  assert.equal(r.pointCount, 3);
  const segs = r.tracks.flatMap((t) => t.segments);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((s) => s.points.length), [2, 1]);
  const [a, b] = segs[0].points;
  assert.deepEqual([a.lat, a.lon, a.index], [51, 0, 0]);
  assert.equal(a.time, Date.UTC(2026, 0, 1, 10, 0, 1, 250));
  assert.equal(b.time, Date.UTC(2026, 0, 1, 9, 0, 2)); // +01:00 offset
  assert.equal(segs[1].points[0].index, 2);

  const prefixed = HAND.replace(/<(\/?)(Time|Position|LatitudeDegrees|LongitudeDegrees|Trackpoint|Track|Lap)\b/g, '<$1t:$2');
  assert.equal(parseTcx(prefixed).pointCount, 3);
});

test('parseTcx errors', () => {
  const wrap = (tp) => `<TrainingCenterDatabase><Activities><Activity><Lap><Track>${tp}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  assert.throws(() => parseTcx(wrap('<Trackpoint><Time>2026-01-01T00:00:00Z</Time></Trackpoint>')), /no GPS positions/);
  assert.throws(() => parseTcx('<TrainingCenterDatabase></TrainingCenterDatabase>'), /no GPS positions/);
  const pos = '<Position><LatitudeDegrees>1</LatitudeDegrees><LongitudeDegrees>2</LongitudeDegrees></Position>';
  assert.throws(() => parseTcx(wrap(`<Trackpoint>${pos}</Trackpoint>`)), /<Time>/);
  assert.throws(() => parseTcx(wrap(`<Trackpoint><Time>garbage</Time>${pos}</Trackpoint>`)), /<Time>/);
});

test('rewriteTcxPositions replaces only lat/lon text', () => {
  const out = rewriteTcxPositions(HAND, [[10.123456789, 20.5], [11, 21], [12, 22]]);
  assert.match(out, /<LatitudeDegrees>10\.1234568<\/LatitudeDegrees><LongitudeDegrees>20\.5000000</);
  assert.match(out, /<LatitudeDegrees>12\.0000000</);
  assert.equal(stripLatLon(out), stripLatLon(HAND));
  assert.throws(() => rewriteTcxPositions(HAND, [[1, 2]]), /Fewer/);
  assert.throws(() => rewriteTcxPositions(HAND, [[1, 2], [1, 2], [1, 2], [1, 2]]), /More/);
});

test('updateTcxDistances anchors on the original offset and carries deltas', () => {
  // Move 2nd and 3rd points so the step lengths are known (~11.1 m north each).
  const ll = [[51, 0], [51.0001, 0], [51.0002, 0]];
  const out = updateTcxDistances(HAND, ll);
  const step = haversine(51, 0, 51.0001, 0);
  const dists = [...out.matchAll(/<DistanceMeters>([^<]*)</g)].map((m) => m[1]);
  // lap1, tp0 (unpositioned), tp1, tp2, lap2, tp3 (no Position, empty), tp4
  assert.equal(dists[0], (20.5 + (step - 10.5)).toFixed(1)); // lap = old + change in first..last span
  assert.equal(dists[1], '0.0'); // unpositioned, before any positioned: delta 0; integer text gets 1 decimal
  assert.equal(dists[2], '10.0');
  assert.equal(dists[3], (10 + step).toFixed(1));
  assert.equal(dists[5], (10 + 2 * step).toFixed(1));
  assert.equal(stripValues(out), stripValues(HAND));
});

// ----------------------------------------------------------- synthetic run
const LAT0 = 51.0, LON0 = 0.0;
const M_LAT = 111194.9;
const M_LON = M_LAT * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x, y) => [LAT0 + y / M_LAT, LON0 + x / M_LON];
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 2 ** 31) - 1; };
}
function road() {
  const coords = [[0, 0], [200, 0], [400, 0]].map(([x, y]) => ll(x, y));
  return {
    id: 'r', highway: 'residential', tags: { highway: 'residential' }, coords,
    nodeIds: coords.map(([a, b]) => `${a.toFixed(7)},${b.toFixed(7)}`),
  };
}
const T0 = Date.UTC(2026, 0, 1, 10);
const isoAt = (s) => new Date(T0 + s * 1000).toISOString();

/** Noisy 1 Hz run along the road as TCX: 2 laps, 2 decimals on trackpoints, one position-less trackpoint. */
function syntheticTcx({ offset = 12.34, prefix = '' } = {}) {
  const rand = rng(7);
  const pts = [];
  for (let t = 0; t < 120; t++) pts.push(ll(t * 3, 6 * rand()));
  let cum = offset;
  const tps = pts.map(([lat, lon], i) => {
    if (i > 0) cum += haversine(pts[i - 1][0], pts[i - 1][1], lat, lon);
    return { lat, lon, i, d: cum };
  });
  const tp = (p) => `<Trackpoint><Time>${isoAt(p.i)}</Time>` +
    `<Position><LatitudeDegrees>${p.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${p.lon.toFixed(7)}</LongitudeDegrees></Position>` +
    `<AltitudeMeters>${(5 + p.i * 0.1).toFixed(1)}</AltitudeMeters><DistanceMeters>${p.d.toFixed(2)}</DistanceMeters>` +
    `<HeartRateBpm><Value>${120 + p.i}</Value></HeartRateBpm>` +
    `<Extensions><ns3:TPX><ns3:Speed>3.0</ns3:Speed></ns3:TPX></Extensions></Trackpoint>`;
  const gap = `<Trackpoint><Time>${isoAt(59.5)}</Time><DistanceMeters>${(tps[59].d + 1).toFixed(2)}</DistanceMeters></Trackpoint>`;
  const lap = (from, to, extra = '') => {
    const span = tps[to - 1].d - tps[from].d;
    return `<Lap StartTime="${isoAt(from)}"><TotalTimeSeconds>${to - from}</TotalTimeSeconds>` +
      `<DistanceMeters>${span.toFixed(1)}</DistanceMeters><MaximumSpeed>4.2</MaximumSpeed><Calories>10</Calories>` +
      `<AverageHeartRateBpm><Value>130</Value></AverageHeartRateBpm><Intensity>Active</Intensity>` +
      `<Track>${tps.slice(from, to).map(tp).join('')}${extra}</Track></Lap>`;
  };
  const xml = `<?xml version="1.0"?>\n<TrainingCenterDatabase xmlns="x" xmlns:ns3="y"><Activities><Activity Sport="Running">` +
    `<Id>${isoAt(0)}</Id>\n${lap(0, 60, gap)}\n${lap(60, 120)}\n</Activity></Activities></TrainingCenterDatabase>`;
  return { xml, tps };
}
const dists = (text, scope) =>
  [...text.matchAll(scope)].map((m) => parseFloat(m[1]));

test('tidyActivity on TCX: only Lat/Lon/DistanceMeters change; distances stay consistent', async () => {
  const { xml, tps } = syntheticTcx();
  const res = await tidyActivity(xml, async () => [road()]);
  assert.equal(res.format, 'tcx');
  assert.equal(res.extension, '.tcx');
  assert.equal(res.mimeType, 'application/vnd.garmin.tcx+xml');
  assert.equal(res.rawPoints.length, 120);
  assert.equal(res.tidiedPoints.length, 120);
  assert.ok(res.tidiedPoints.every((p) => p.onNetwork));
  assert.ok(res.summary.matchedDistanceM < res.summary.rawDistanceM);

  const out = res.outputText;
  // (a) only the three value kinds differ
  assert.equal(stripValues(out), stripValues(xml));
  assert.notEqual(out, xml);

  // The output positions are the tidied ones.
  const outPts = parseTcx(out).tracks.flatMap((t) => t.segments.flatMap((s) => s.points));
  outPts.forEach((p, i) => {
    assert.ok(Math.abs(p.lat - res.tidiedPoints[i].lat) < 1e-7);
    assert.ok(Math.abs(p.lon - res.tidiedPoints[i].lon) < 1e-7);
  });

  // Trackpoint distances only (skip lap-level values, which come before <Track>).
  const tpDists = [...out.matchAll(/<Trackpoint>[\s\S]*?<\/Trackpoint>/g)]
    .map((m) => /<DistanceMeters>([^<]*)</.exec(m[0])[1]);
  const tpNums = tpDists.map(parseFloat);
  // (c) non-decreasing
  for (let i = 1; i < tpNums.length; i++) assert.ok(tpNums[i] >= tpNums[i - 1], `decreasing at ${i}`);
  // (b) final distance equals offset + tidied path length
  let path = 0;
  const rounded = outPts;
  for (let i = 1; i < rounded.length; i++) {
    path += haversine(rounded[i - 1].lat, rounded[i - 1].lon, rounded[i].lat, rounded[i].lon);
  }
  assert.ok(Math.abs(tpNums.at(-1) - (tps[0].d + path)) < 0.5, `${tpNums.at(-1)} vs ${tps[0].d + path}`);
  // (e) decimals preserved
  assert.ok(tpDists.every((s) => /^\d+\.\d{2}$/.test(s)), 'trackpoint decimals');
  const lapDists = [...out.matchAll(/<Lap\b[^>]*>\s*<TotalTimeSeconds>[^<]*<\/TotalTimeSeconds>\s*<DistanceMeters>([^<]*)</g)].map((m) => m[1]);
  assert.equal(lapDists.length, 2);
  assert.ok(lapDists.every((s) => /^\d+\.\d$/.test(s)), 'lap decimals');

  // (d) lap distance changed by the same delta as its trackpoint span
  const origLap = dists(xml, /<Lap\b[^>]*>\s*<TotalTimeSeconds>[^<]*<\/TotalTimeSeconds>\s*<DistanceMeters>([^<]*)</g);
  const bodies = (t) => [...t.matchAll(/<Lap\b[\s\S]*?<\/Lap>/g)].map((m) =>
    [...m[0].matchAll(/<Trackpoint>[\s\S]*?<\/Trackpoint>/g)].map((x) => parseFloat(/<DistanceMeters>([^<]*)</.exec(x[0])[1])));
  const before = bodies(xml), after = bodies(out);
  for (let k = 0; k < 2; k++) {
    const span = (a) => a.at(-1) - a[0];
    const expected = span(after[k]) - span(before[k]);
    const actual = parseFloat(lapDists[k]) - origLap[k];
    assert.ok(Math.abs(actual - expected) < 0.06, `lap ${k}: ${actual} vs ${expected}`);
  }
});

test('TCX with a different namespace prefix tidies identically', async () => {
  const { xml } = syntheticTcx();
  const prefixed = xml.replace(/<(\/?)(TrainingCenterDatabase|Activities|Activity|Lap|Track|Trackpoint|Time|Position|LatitudeDegrees|LongitudeDegrees|DistanceMeters)\b/g, '<$1g:$2');
  const a = await tidyActivity(xml, async () => [road()]);
  const b = await tidyActivity(prefixed, async () => [road()]);
  assert.equal(b.format, 'tcx');
  assert.deepEqual(b.tidiedPoints, a.tidiedPoints);
});

test('applyTidiedPositionsToTcx matches rewrite then distance update', () => {
  const { xml } = syntheticTcx();
  const pts = parseTcx(xml).tracks.flatMap((t) => t.segments.flatMap((s) => s.points));
  const moved = pts.map((p) => [p.lat + 1e-5, p.lon]);
  const out = applyTidiedPositionsToTcx(xml, moved);
  assert.equal(stripValues(out), stripValues(xml));
  assert.match(out, /<LatitudeDegrees>51\.0000\d+/);
});

test('tidyGpx keeps working and gains the new fields; rename is GPX only', async () => {
  const rand = rng(3);
  const body = [];
  for (let t = 0; t < 60; t++) {
    const [lat, lon] = ll(t * 3, 5 * rand());
    body.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><time>${isoAt(t)}</time></trkpt>`);
  }
  const gpx = `<gpx><trk><name>Run</name><trkseg>${body.join('')}</trkseg></trk></gpx>`;
  const res = await tidyGpx(gpx, async () => [road()], { rename: true });
  assert.equal(res.format, 'gpx');
  assert.equal(res.extension, '.gpx');
  assert.equal(res.mimeType, 'application/gpx+xml');
  assert.match(res.outputText, /<name>Run \(tidied\)<\/name>/);
  assert.equal(res.rawPoints.length, 60);
  assert.equal(parseGpx(res.outputText).pointCount, 60);

  const { xml } = syntheticTcx();
  const t = await tidyActivity(xml, async () => [road()], { rename: true });
  assert.ok(!t.outputText.includes('(tidied)'));
});

test('format sniffing rejects unknown XML', async () => {
  assert.equal(sniffFormat('<foo:TrainingCenterDatabase/>'), 'tcx');
  assert.equal(sniffFormat('<gpx></gpx>'), 'gpx');
  assert.throws(() => sniffFormat('<?xml version="1.0"?><kml><Document/></kml>'), /Unrecognised file/);
  await assert.rejects(tidyActivity('<html></html>', async () => []), /Expected a \.gpx or \.tcx/);
});

test('TCX with no GPS positions is rejected by tidyActivity', async () => {
  const xml = '<TrainingCenterDatabase><Activities><Activity><Lap><Track>' +
    '<Trackpoint><Time>2026-01-01T00:00:00Z</Time></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>';
  await assert.rejects(tidyActivity(xml, async () => []), /no GPS positions/);
});

// ------------------------------------------------ private fixture cross-check
const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const hasFixture = existsSync(new URL('./fixtures/evening.gpx', import.meta.url)) &&
  existsSync(new URL('./fixtures/evening.osm.xml', import.meta.url));

test('evening fixture as TCX tidies to the same positions as the GPX path', { skip: !hasFixture && 'private fixture not present' }, async () => {
  const gpxText = read('evening.gpx');
  const ways = parseOsmXml(read('evening.osm.xml'));
  const gpxPts = parseGpx(gpxText).tracks.flatMap((t) => t.segments.flatMap((s) => s.points));
  const hrs = [...gpxText.matchAll(/<(?:\w+:)?hr>\s*([\d.]+)/g)].map((m) => m[1]);
  let cum = 0;
  const tps = gpxPts.map((p, i) => {
    if (i > 0) cum += haversine(gpxPts[i - 1].lat, gpxPts[i - 1].lon, p.lat, p.lon);
    const hr = hrs.length === gpxPts.length ? `<HeartRateBpm><Value>${hrs[i]}</Value></HeartRateBpm>` : '';
    return `<Trackpoint><Time>${new Date(p.time).toISOString()}</Time><Position><LatitudeDegrees>${p.lat}</LatitudeDegrees>` +
      `<LongitudeDegrees>${p.lon}</LongitudeDegrees></Position><DistanceMeters>${cum.toFixed(1)}</DistanceMeters>${hr}</Trackpoint>`;
  });
  const tcx = `<TrainingCenterDatabase><Activities><Activity Sport="Running"><Lap><DistanceMeters>${cum.toFixed(1)}</DistanceMeters>` +
    `<Track>${tps.join('')}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;

  const g = await tidyActivity(gpxText, async () => ways);
  const t = await tidyActivity(tcx, async () => ways);
  assert.equal(t.tidiedPoints.length, g.tidiedPoints.length);
  t.tidiedPoints.forEach((p, i) => {
    assert.ok(haversine(p.lat, p.lon, g.tidiedPoints[i].lat, g.tidiedPoints[i].lon) < 0.01, `point ${i}`);
  });
  assert.ok(Math.abs(t.summary.matchedDistanceM - g.summary.matchedDistanceM) < 1);
  const last = parseFloat(/<DistanceMeters>([^<]*)<\/DistanceMeters>(?:(?!<DistanceMeters>)[\s\S])*$/.exec(t.outputText)[1]);
  assert.ok(Math.abs(last - t.summary.matchedDistanceM) < 1);
});
