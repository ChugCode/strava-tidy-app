// Leaflet map of the raw vs tidied track. Leaflet is a classic script exposing window.L.
let map = null;
let layer = null;
let bounds = null;
let fitted = false; // true once fitBounds ran while the container had a real size

function ensureMap(el) {
  if (map) return map;
  map = L.map(el, { zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);
  // Container size can change after first layout (panel reveal, rotation, address-bar resize).
  new ResizeObserver(() => refit(false)).observe(el);
  window.addEventListener('resize', () => refit(true));
  return map;
}

/** rawPts / tidyPts / offPts: arrays of [lat, lon]. offPts are positions left unchanged. */
export function showTracks(el, rawPts, tidyPts, offPts) {
  ensureMap(el);
  if (layer) layer.remove();
  layer = L.layerGroup().addTo(map);
  L.polyline(rawPts, { color: '#e11d48', weight: 2, opacity: 0.85 }).addTo(layer);
  L.polyline(tidyPts, { color: '#2563eb', weight: 5, opacity: 0.85 }).addTo(layer);
  for (const p of offPts) {
    L.circleMarker(p, { radius: 3, color: '#f97316', fillColor: '#f97316', fillOpacity: 1, weight: 1 }).addTo(layer);
  }
  bounds = L.latLngBounds(rawPts.concat(tidyPts));
  fitted = false;
  refit(true);
  // Fit again once the browser has laid out the now-visible panel.
  requestAnimationFrame(() => refit(true));
  setTimeout(() => refit(true), 250);
}

function refit(fit) {
  if (!map || !bounds) return;
  map.invalidateSize();
  const size = map.getSize();
  if (size.x === 0 || size.y === 0) return;
  if (fit || !fitted) {
    map.fitBounds(bounds, { padding: [16, 16] });
    fitted = true;
  }
}

export function invalidateMap() {
  refit(true);
}
