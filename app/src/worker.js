// Runs the whole tidy pipeline off the main thread (also imported directly as a fallback).
import { tidyGpx } from './pipeline.js';
import { parseGpx } from './gpx.js';
import { bboxForTrack, tileBbox } from './osm.js';
import { createWaysProvider, createIdbStore } from './osm-fetch.js';

export async function runTidy({ gpxText, rename }, post) {
  try {
    post({ type: 'stage', text: 'Reading file…' });
    const gpx = parseGpx(gpxText);
    const pts = gpx.tracks.flatMap((t) => t.segments.flatMap((s) => s.points));
    if (!pts.length) throw new Error('This file has no track points. Is it a GPX recording?');
    const totalCells = tileBbox(bboxForTrack(pts, 150), 0.02, pts, 150).length;
    const provider = createWaysProvider({
      store: createIdbStore(),
      totalCells,
      onStage: (text) => post({ type: 'stage', text }),
    });
    const result = await tidyGpx(gpxText, provider, {
      rename,
      onProgress: (fraction) => post({ type: 'progress', fraction }),
    });
    post({ type: 'result', outputText: result.outputText, summary: result.summary });
  } catch (e) {
    post({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (ev) => runTidy(ev.data, (m) => self.postMessage(m));
}
