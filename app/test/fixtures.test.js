import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tidyGpx } from '../src/pipeline.js';
import { parseGpx } from '../src/gpx.js';
import { parseOsmXml } from '../src/osm.js';
import { haversine } from '../src/geo.js';

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const stripLatLon = (t) => t.replace(/(<(?:\w+:)?trkpt\b)[^>]*>/g, '$1>');
const flat = (text) => parseGpx(text).tracks.flatMap((t) => t.segments.flatMap((s) => s.points));

// The real run fixtures contain personal GPS tracks, so they are git-ignored and these tests skip without them.
const hasFixture = (name) => existsSync(new URL(`./fixtures/${name}.gpx`, import.meta.url));

for (const [name, pyDistance] of [['evening', 3491], ['afternoon', 5104]]) {
  test(`${name} fixture matches the Python reference`, { skip: !hasFixture(name) && 'private fixture not present' }, async () => {
    const input = read(`${name}.gpx`);
    const ways = parseOsmXml(read(`${name}.osm.xml`));
    const { outputText, summary } = await tidyGpx(input, async () => ways);

    const inPts = flat(input);
    const outPts = flat(outputText);
    const pyPts = flat(read(`${name}.py-matched.gpx`));
    assert.equal(outPts.length, inPts.length);
    assert.equal(stripLatLon(outputText), stripLatLon(input), 'time/ele/hr must be byte-identical');

    assert.ok(Math.abs(summary.matchedDistanceM - pyDistance) / pyDistance < 0.005,
      `matched distance ${summary.matchedDistanceM} vs python ${pyDistance}`);

    const d = outPts.map((p, i) => haversine(p.lat, p.lon, pyPts[i].lat, pyPts[i].lon)).sort((a, b) => a - b);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const p95 = d[Math.floor(d.length * 0.95)];
    assert.ok(mean < 1.0, `mean JS-vs-Python distance ${mean}`);
    assert.ok(p95 < 3.0, `p95 JS-vs-Python distance ${p95}`);

    assert.ok(summary.maxStepSpeedMatched < 6, `max matched step speed ${summary.maxStepSpeedMatched}`);
    assert.equal(summary.snappedCount, inPts.length);
    assert.equal(summary.offNetworkCount, 0);
  });
}
