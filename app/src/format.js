// Display formatting helpers shared by the UI.
export { formatPace } from './report.js';

export function formatKm(m) {
  return `${(m / 1000).toFixed(2)} km`;
}

export function formatMeters(m) {
  return `${Math.round(m)} m`;
}

/** Signed difference, e.g. "+12 m" / "-8 m" (metres, rounded). */
export function formatDelta(m) {
  const r = Math.round(m);
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r)} m`;
}
