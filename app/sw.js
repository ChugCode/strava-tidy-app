// App-shell cache only. Map tiles and Overpass/OSM API responses are deliberately never cached here.
const CACHE = 'strava-tidy-v4';
const SHARED_CACHE = 'strava-tidy-shared'; // holds one file handed over by the Web Share Target POST
const PRECACHE = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'src/ui.js',
  'src/worker.js',
  'src/pipeline.js',
  'src/gpx.js',
  'src/osm.js',
  'src/osm-fetch.js',
  'src/matcher.js',
  'src/network.js',
  'src/geo.js',
  'src/report.js',
  'src/format.js',
  'src/share.js',
  'src/tcx.js',
  'src/map-view.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARED_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

const SHARE_TARGET_URL = new URL('./share-target', self.location.href).href;
const SHARED_FILE_URL = new URL('./shared-file', self.location.href).href;
const APP_URL = new URL('./', self.location.href).href;

// Web Share Target: stash the shared file, then redirect to the app, which picks it up from the cache.
async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    let file = form.get('activity');
    if (!(file instanceof File)) {
      file = null;
      for (const [, v] of form.entries()) if (v instanceof File) { file = v; break; }
    }
    if (file) {
      const cache = await caches.open(SHARED_CACHE);
      await cache.put(SHARED_FILE_URL, new Response(file, {
        headers: { 'X-Filename': encodeURIComponent(file.name || ''), 'Content-Type': 'application/octet-stream' },
      }));
    }
  } catch { /* the app shows "the shared file didn't arrive" */ }
  return Response.redirect(APP_URL + '?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.href === SHARE_TARGET_URL) {
    event.respondWith(handleShareTarget(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // tiles, Overpass, OSM API: network only

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html')));
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req)));
});
