// Network provider: cache -> Overpass mirrors -> OSM API fallback.
import { overpassQuery, osmApiUrl, parseOverpassJson, parseOsmXml } from './osm.js';

export const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
export const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

export function cacheKey(b) {
  const r = (v) => v.toFixed(4);
  return `ways1:${r(b.minLat)},${r(b.minLon)},${r(b.maxLat)},${r(b.maxLon)}`;
}

export function createMemoryStore() {
  const m = new Map();
  return { async get(k) { return m.get(k); }, async set(k, v) { m.set(k, v); } };
}

/** IndexedDB-backed store. Every operation degrades to a no-op if IndexedDB is unusable. */
export function createIdbStore(name = 'strava-tidy', storeName = 'ways') {
  let dbPromise = null;
  const open = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open(name, 1);
          req.onupgradeneeded = () => req.result.createObjectStore(storeName);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch { resolve(null); }
      });
    }
    return dbPromise;
  };
  const run = async (mode, fn) => {
    try {
      const db = await open();
      if (!db) return undefined;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, mode);
          const req = fn(tx.objectStore(storeName));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = tx.onabort = () => resolve(undefined);
        } catch { resolve(undefined); }
      });
    } catch { return undefined; }
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => { s.put(v, k); return null; }),
  };
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Body is read inside the timeout window too: slow bodies count as a timeout.
    return init.asJson ? await res.json() : await res.text();
  } catch (e) {
    if (timedOut) throw new Error(`timed out after ${timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * totalCells (optional) is only used to word the progress message.
 * Returns async (bbox) => ways.
 */
export function createWaysProvider({
  fetchImpl = (...a) => globalThis.fetch(...a),
  store = createMemoryStore(),
  endpoints = DEFAULT_ENDPOINTS,
  timeoutMs = 15000,
  onStage = () => {},
  totalCells = 0,
  now = () => Date.now(),
} = {}) {
  let n = 0;
  return async function waysProvider(bbox) {
    n++;
    const label = totalCells ? `${n}/${totalCells}` : `${n}`;
    const key = cacheKey(bbox);
    try {
      const hit = await store.get(key);
      if (hit && Array.isArray(hit.ways) && now() - hit.savedAt < CACHE_TTL_MS) {
        onStage(`Using saved map data ${label}…`);
        return hit.ways;
      }
    } catch { /* cache problems must never block the download */ }

    const save = async (ways) => {
      try { await store.set(key, { savedAt: now(), ways }); } catch { /* ignore */ }
      return ways;
    };
    const failures = [];

    for (const url of endpoints) {
      const host = new URL(url).host;
      onStage(`Downloading map data ${label}…`);
      try {
        const json = await fetchWithTimeout(fetchImpl, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: 'data=' + encodeURIComponent(overpassQuery(bbox)),
          asJson: true,
        }, timeoutMs);
        return await save(parseOverpassJson(json));
      } catch (e) {
        failures.push(`Overpass ${host}: ${e.message}`);
      }
    }

    onStage(`Downloading map data ${label} (backup server)…`);
    try {
      const xml = await fetchWithTimeout(fetchImpl, osmApiUrl(bbox), { method: 'GET' }, timeoutMs);
      return await save(parseOsmXml(xml));
    } catch (e) {
      failures.push(`OSM API api.openstreetmap.org: ${e.message}`);
    }
    throw new Error(
      'Could not download map data. Tried: ' + failures.join('; ') +
      '. Check your connection and try again; the map servers are sometimes overloaded.');
  };
}
