import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWaysProvider, createMemoryStore, DEFAULT_ENDPOINTS } from '../src/osm-fetch.js';
import { parseOsmXml } from '../src/osm.js';

const BBOX = { minLat: 51.5, minLon: -0.12, maxLat: 51.51, maxLon: -0.1 };
const xml = `<?xml version="1.0"?><osm version="0.6">
<node id="1" lat="51.5000000" lon="-0.1000000"/><node id="2" lat="51.5000000" lon="-0.0990000"/><node id="3" lat="51.5010000" lon="-0.0990000"/>
<way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/></way>
<way id="11"><nd ref="1"/><nd ref="3"/><tag k="highway" v="footway"/></way>
</osm>`;
const OVERPASS = {
  elements: [{
    type: 'way', id: 42, tags: { highway: 'footway' },
    geometry: [{ lat: 51.5, lon: -0.12 }, { lat: 51.501, lon: -0.119 }, { lat: 51.502, lon: -0.118 }],
  }],
};
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => body });
const bad = (status) => ({ ok: false, status });

/** Mock fetch routed by URL; handler gets (url, init) and may return a response or throw. */
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push(url); return handler(url, init, calls.length); };
  fn.calls = calls;
  return fn;
}
const isOverpass = (u) => u.includes('interpreter');

test('Overpass success parses ways and posts form-encoded query', async () => {
  let init0;
  const f = mockFetch((u, init) => { init0 ??= init; return ok(OVERPASS); });
  const ways = await createWaysProvider({ fetchImpl: f, store: createMemoryStore() })(BBOX);
  assert.equal(ways.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0], DEFAULT_ENDPOINTS[0]);
  assert.equal(init0.method, 'POST');
  assert.match(init0.body, /^data=/);
  assert.match(decodeURIComponent(init0.body), /way\["highway"\]/);
});

test('falls through to the second Overpass endpoint', async () => {
  const f = mockFetch((u) => (u === DEFAULT_ENDPOINTS[0] ? bad(504) : ok(OVERPASS)));
  const ways = await createWaysProvider({ fetchImpl: f, store: createMemoryStore() })(BBOX);
  assert.equal(ways.length, 1);
  assert.deepEqual(f.calls, DEFAULT_ENDPOINTS.slice(0, 2));
});

test('falls back to the OSM API when every Overpass endpoint fails', async () => {
  const f = mockFetch((u) => {
    if (isOverpass(u)) throw new Error('network down');
    return ok(xml);
  });
  const ways = await createWaysProvider({ fetchImpl: f, store: createMemoryStore() })(BBOX);
  assert.equal(f.calls.length, DEFAULT_ENDPOINTS.length + 1);
  assert.match(f.calls.at(-1), /api\.openstreetmap\.org\/api\/0\.6\/map\?bbox=/);
  assert.equal(ways.length, parseOsmXml(xml).length);
  assert.ok(ways.length > 0);
});

test('total failure names every attempt', async () => {
  const f = mockFetch((u) => (isOverpass(u) ? bad(429) : bad(509)));
  const p = createWaysProvider({ fetchImpl: f, store: createMemoryStore() });
  await assert.rejects(p(BBOX), (e) => {
    for (const host of ['overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee', 'api.openstreetmap.org']) {
      assert.ok(e.message.includes(host), `missing ${host} in: ${e.message}`);
    }
    assert.ok(e.message.includes('HTTP 429') && e.message.includes('HTTP 509'));
    return true;
  });
});

test('cache hit avoids the network, and survives a rounded-equal bbox', async () => {
  const store = createMemoryStore();
  const f = mockFetch(() => ok(OVERPASS));
  const p = createWaysProvider({ fetchImpl: f, store });
  await p(BBOX);
  assert.equal(f.calls.length, 1);
  const again = await p({ ...BBOX, minLat: BBOX.minLat + 0.00001 });
  assert.equal(f.calls.length, 1);
  assert.equal(again.length, 1);
});

test('expired cache entries are refetched', async () => {
  const store = createMemoryStore();
  const f = mockFetch(() => ok(OVERPASS));
  let t = 0;
  const p = createWaysProvider({ fetchImpl: f, store, now: () => t });
  await p(BBOX);
  t = 31 * 24 * 3600 * 1000;
  await p(BBOX);
  assert.equal(f.calls.length, 2);
});

test('a broken store never blocks downloading', async () => {
  const store = { get: async () => { throw new Error('idb gone'); }, set: async () => { throw new Error('idb gone'); } };
  const ways = await createWaysProvider({ fetchImpl: mockFetch(() => ok(OVERPASS)), store })(BBOX);
  assert.equal(ways.length, 1);
});

test('hanging servers time out via AbortSignal and the next one is tried', async () => {
  const f = mockFetch((u, init) => {
    if (u === DEFAULT_ENDPOINTS[2]) return ok(OVERPASS);
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  const ways = await createWaysProvider({ fetchImpl: f, store: createMemoryStore(), timeoutMs: 30 })(BBOX);
  assert.equal(ways.length, 1);
  assert.equal(f.calls.length, 3);
});

test('timeouts are reported as such when everything hangs', async () => {
  const f = mockFetch((u, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  await assert.rejects(
    createWaysProvider({ fetchImpl: f, store: createMemoryStore(), timeoutMs: 20 })(BBOX),
    /timed out after 20 ms/);
});

test('stage messages report cell progress', async () => {
  const stages = [];
  const p = createWaysProvider({
    fetchImpl: mockFetch(() => ok(OVERPASS)), store: createMemoryStore(), totalCells: 2, onStage: (s) => stages.push(s),
  });
  await p(BBOX);
  await p({ ...BBOX, minLat: 52, maxLat: 52.01 });
  assert.deepEqual(stages, ['Downloading map data 1/2…', 'Downloading map data 2/2…']);
});
