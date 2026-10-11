// Runs the whole tidy pipeline off the main thread (also imported directly as a fallback).
import { tidyActivity, sniffFormat } from './pipeline.js';
import { parseGpx } from './gpx.js';
import { parseTcx } from './tcx.js';
import { bboxForTrack, tileBbox } from './osm.js';
import { createWaysProvider, createIdbStore } from './osm-fetch.js';

export async function runTidy({ text, rename }, post) {
  try {
    post({ type: 'stage', text: 'Reading file…' });
    let format;
    try {
      format = sniffFormat(text);
    } catch {
      throw new Error('Unsupported file. Please choose a GPX or TCX activity file.');
    }
    const parsed = format === 'tcx' ? parseTcx(text) : parseGpx(text);
    const pts = parsed.tracks.flatMap((t) => t.segments.flatMap((s) => s.points));
    if (!pts.length) throw new Error(`This file has no track points. Is it a GPX or TCX recording?`);
    const totalCells = tileBbox(bboxForTrack(pts, 150), 0.02, pts, 150).length;
    const provider = createWaysProvider({
      store: createIdbStore(),
      totalCells,
      onStage: (t) => post({ type: 'stage', text: t }),
    });
    const r = await tidyActivity(text, provider, {
      rename,
      onProgress: (fraction) => post({ type: 'progress', fraction }),
    });
    post({
      type: 'result',
      outputText: r.outputText, summary: r.summary, format: r.format, extension: r.extension,
      mimeType: r.mimeType, rawPoints: r.rawPoints, tidiedPoints: r.tidiedPoints,
    });
  } catch (e) {
    post({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (ev) => runTidy(ev.data, (m) => self.postMessage(m));
}
