// End-to-end: GPX text + ways provider -> tidied GPX text + summary.
import { parseGpx, rewriteGpxPositions, renameTrack } from './gpx.js';
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

/**
 * waysProvider: async (bbox) => ways, called once per tile cell.
 * options: { onProgress(fraction), rename (append " (tidied)" to the track name) }
 */
export async function tidyGpx(gpxText, waysProvider, options = {}) {
  const { onProgress, rename = false } = options;
  const report = (f) => { if (onProgress) onProgress(Math.min(1, f)); };
  const gpx = parseGpx(gpxText);
  const segments = gpx.tracks.flatMap((t) => t.segments).filter((s) => s.points.length > 0);
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

  // Positions follow document order, which is the order parseGpx numbered points.
  const flatLatLons = [];
  const byIndex = new Array(gpx.pointCount);
  allPoints.forEach((p, i) => { byIndex[p.index] = positions[i]; });
  for (const p of byIndex) flatLatLons.push([p.lat, p.lon]);

  let outputText = rewriteGpxPositions(gpxText, flatLatLons);
  if (rename) outputText = renameTrack(outputText);
  report(1);
  return { outputText, summary: summarize(allPoints, positions) };
}
