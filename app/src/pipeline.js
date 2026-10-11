// End-to-end: GPX/TCX text + ways provider -> tidied text + summary.
import { parseGpx, rewriteGpxPositions, renameTrack } from './gpx.js';
import { parseTcx, applyTidiedPositionsToTcx } from './tcx.js';
import { bboxForTrack, tileBbox, mergeWays } from './osm.js';
import { matchTrack, DEFAULTS } from './matcher.js';
import { summarize } from './report.js';

const MARGIN_M = 150;
const MIN_COVERAGE = 0.98;

/** Fraction of points inside the extent of the ways (padded by the search radius). */
function coverage(points, ways) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const w of ways) {
    for (const [la, lo] of w.coords) {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
    }
  }
  const padLat = DEFAULTS.SEARCH_RADIUS / 111320;
  const padLon = padLat / Math.cos((points[0].lat * Math.PI) / 180);
  const inside = points.filter((p) =>
    p.lat >= minLat - padLat && p.lat <= maxLat + padLat && p.lon >= minLon - padLon && p.lon <= maxLon + padLon);
  return inside.length / points.length;
}

const FORMATS = {
  gpx: { extension: '.gpx', mimeType: 'application/gpx+xml' },
  tcx: { extension: '.tcx', mimeType: 'application/vnd.garmin.tcx+xml' },
};

/** Returns 'tcx' or 'gpx', or throws if the text is neither. */
export function sniffFormat(text) {
  if (/<(?:[\w.-]+:)?TrainingCenterDatabase\b/.test(text)) return 'tcx';
  if (/<(?:[\w.-]+:)?gpx\b/.test(text)) return 'gpx';
  throw new Error('Unrecognised file. Expected a .gpx or .tcx activity.');
}

/** GPX-only entry point kept for compatibility; same result shape as tidyActivity. */
export function tidyGpx(gpxText, waysProvider, options = {}) {
  return tidyActivity(gpxText, waysProvider, options);
}

/**
 * waysProvider: async (bbox) => ways, called once per tile cell.
 * options: { onProgress(fraction), rename (GPX only: append " (tidied)" to the track name) }
 * Returns { outputText, summary, format, extension, mimeType, rawPoints, tidiedPoints }; the point
 * arrays cover the positioned points in file order.
 */
export async function tidyActivity(text, waysProvider, options = {}) {
  const { onProgress, rename = false } = options;
  const report = (f) => { if (onProgress) onProgress(Math.min(1, f)); };
  const format = sniffFormat(text);
  const parsed = format === 'tcx' ? parseTcx(text) : parseGpx(text);
  const segments = parsed.tracks.flatMap((t) => t.segments).filter((s) => s.points.length > 0);
  const allPoints = segments.flatMap((s) => s.points);

  const cells = tileBbox(bboxForTrack(allPoints, MARGIN_M), 0.02, allPoints, MARGIN_M);
  const lists = [];
  for (let i = 0; i < cells.length; i++) {
    lists.push(await waysProvider(cells[i]));
    report(0.2 * ((i + 1) / cells.length));
  }
  const ways = mergeWays(lists);
  if (ways.length === 0) {
    throw new Error('No usable roads or paths were found in the OSM data for this track area.');
  }
  const cov = coverage(allPoints, ways);
  if (cov < MIN_COVERAGE) {
    throw new Error(
      `The OSM data does not cover the track: only ${(cov * 100).toFixed(0)}% of points fall inside the downloaded area.`);
  }

  const positions = [];
  let done = 0;
  for (const seg of segments) {
    const base = done;
    const res = matchTrack(seg.points, ways, {
      onProgress: (f) => report(0.2 + 0.8 * ((base + f * seg.points.length) / allPoints.length)),
    });
    positions.push(...res.positions);
    done += seg.points.length;
  }

  // Positions follow document order, which is the order the parsers numbered points.
  const rawPoints = new Array(parsed.pointCount);
  const tidiedPoints = new Array(parsed.pointCount);
  allPoints.forEach((p, i) => {
    rawPoints[p.index] = { lat: p.lat, lon: p.lon };
    tidiedPoints[p.index] = { lat: positions[i].lat, lon: positions[i].lon, onNetwork: positions[i].onNetwork };
  });
  const flatLatLons = tidiedPoints.map((p) => [p.lat, p.lon]);

  let outputText;
  if (format === 'tcx') {
    outputText = applyTidiedPositionsToTcx(text, flatLatLons);
  } else {
    outputText = rewriteGpxPositions(text, flatLatLons);
    if (rename) outputText = renameTrack(outputText);
  }
  report(1);
  return {
    outputText, summary: summarize(allPoints, positions), format, ...FORMATS[format], rawPoints, tidiedPoints,
  };
}
