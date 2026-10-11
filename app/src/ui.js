// Main-thread UI: file intake, worker orchestration, result rendering.
import { parseGpx } from './gpx.js';
import { formatPace, formatKm, formatMeters, formatDelta, tidiedFileName } from './format.js';
import { showTracks, invalidateMap } from './map-view.js';

const $ = (id) => document.getElementById(id);
const panels = { start: $('start'), progress: $('progress'), error: $('error'), result: $('result') };
const focusTargets = { start: 'choose-btn', progress: 'progress-title', error: 'error-title', result: 'result-title' };

let worker = null;
let runToken = 0; // lets us ignore messages from a cancelled main-thread fallback run
let lastJob = null; // { name, gpxText, rename } for Retry
let current = null; // { fileName, outputText } for download/share

function show(name) {
  for (const [key, el] of Object.entries(panels)) el.hidden = key !== name;
  // Result stays hidden until now, so the map can only be sized after this point.
  if (name === 'result') invalidateMap();
  $(focusTargets[name]).focus({ preventScroll: false });
}

function showError(message) {
  stopWorker();
  $('error-text').textContent = message;
  show('error');
}

function stopWorker() {
  runToken++;
  if (worker) { worker.terminate(); worker = null; }
}

function setProgress(fraction) {
  $('bar').value = Math.round(fraction * 100);
}

function onStage(text) {
  $('stage').textContent = text;
}

async function handleFile(file) {
  if (!file) return;
  let gpxText;
  try {
    gpxText = await file.text();
  } catch {
    showError('That file could not be read. Please choose it again.');
    return;
  }
  startJob({ name: file.name, gpxText, rename: $('rename-opt').checked });
}

function startJob(job) {
  lastJob = job;
  stopWorker();
  const token = runToken;
  setProgress(0);
  onStage('Reading file…');
  show('progress');

  const handle = (msg) => {
    if (token !== runToken) return;
    if (msg.type === 'stage') {
      onStage(msg.text);
    } else if (msg.type === 'progress') {
      setProgress(msg.fraction);
      onStage(`Matching to roads… ${Math.round(msg.fraction * 100)}%`);
    } else if (msg.type === 'result') {
      finish(job, msg);
    } else if (msg.type === 'error') {
      showError(msg.message);
    }
  };

  const payload = { gpxText: job.gpxText, rename: job.rename };
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => handle(ev.data);
    worker.onerror = (ev) => {
      ev.preventDefault?.();
      showError('The tidy process crashed unexpectedly. ' + (ev.message || 'Please try again.'));
    };
    worker.postMessage(payload);
  } catch {
    worker = null;
    // No module-worker support: run on the main thread (UI may stutter while matching).
    import('./worker.js').then((m) => m.runTidy(payload, handle))
      .catch((e) => showError(e && e.message ? e.message : String(e)));
  }
}

function finish(job, { outputText, summary }) {
  if (worker) { worker.terminate(); worker = null; }
  try {
    current = { fileName: tidiedFileName(job.name), outputText };
    renderSummary(summary);
    renderSplits(summary.splits);
    show('result');
    renderMap(job.gpxText, outputText);
    setupShare();
  } catch (e) {
    showError('The result could not be displayed: ' + (e && e.message ? e.message : e));
  }
}

function row(dl, label, value) {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  wrap.append(dt, dd);
  dl.append(wrap);
}

function renderSummary(s) {
  const dl = $('summary');
  dl.replaceChildren();
  const diff = s.matchedDistanceM - s.rawDistanceM;
  row(dl, 'Distance', `${formatKm(s.rawDistanceM)} → ${formatKm(s.matchedDistanceM)} (${formatDelta(diff)})`);
  row(dl, 'Points', `${s.snappedCount} snapped / ${s.offNetworkCount} left as-is`);
  row(dl, 'Largest correction', formatMeters(s.maxDisplacementM));

  const note = $('off-note');
  note.hidden = s.offNetworkCount === 0;
  note.textContent = s.offNetworkCount === 0 ? '' :
    `${s.offNetworkCount} ${s.offNetworkCount === 1 ? 'point was' : 'points were'} not near any mapped road or path and ${s.offNetworkCount === 1 ? 'was' : 'were'} left unchanged.`;
}

function cell(tr, text, tag = 'td') {
  const c = document.createElement(tag);
  c.textContent = text;
  if (tag === 'th') c.scope = 'row';
  tr.append(c);
}

function renderSplits(splits) {
  const body = $('splits').tBodies[0];
  body.replaceChildren();
  for (const s of splits) {
    const tr = document.createElement('tr');
    cell(tr, s.partialMeters !== undefined ? `${formatKm(s.partialMeters)} (last)` : String(s.km), 'th');
    cell(tr, formatPace(s.rawSecPerKm));
    cell(tr, formatPace(s.matchedSecPerKm));
    body.append(tr);
  }
}

const flatPoints = (text) => parseGpx(text).tracks.flatMap((t) => t.segments.flatMap((s) => s.points))
  .sort((a, b) => a.index - b.index);

function renderMap(inputText, outputText) {
  const raw = flatPoints(inputText);
  const tidy = flatPoints(outputText);
  // The summary has no per-point flags; a point whose position did not move is one the matcher left alone.
  const off = [];
  tidy.forEach((p, i) => {
    if (Math.abs(p.lat - raw[i].lat) < 2e-7 && Math.abs(p.lon - raw[i].lon) < 2e-7) off.push([p.lat, p.lon]);
  });
  showTracks($('map'), raw.map((p) => [p.lat, p.lon]), tidy.map((p) => [p.lat, p.lon]), off);
}

function gpxFile() {
  return new File([current.outputText], current.fileName, { type: 'application/gpx+xml' });
}

function setupShare() {
  let ok = false;
  try { ok = !!(navigator.canShare && navigator.canShare({ files: [gpxFile()] })); } catch { ok = false; }
  $('share-btn').hidden = !ok;
}

function download() {
  const url = URL.createObjectURL(new Blob([current.outputText], { type: 'application/gpx+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = current.fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function share() {
  try {
    await navigator.share({ files: [gpxFile()], title: current.fileName });
  } catch (e) {
    if (e && e.name !== 'AbortError') showError('Sharing failed: ' + e.message);
  }
}

function reset() {
  stopWorker();
  current = null;
  lastJob = null;
  $('file-input').value = '';
  show('start');
}

function init() {
  const input = $('file-input');
  $('choose-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { handleFile(input.files[0]); input.value = ''; });
  $('cancel-btn').addEventListener('click', reset);
  $('retry-btn').addEventListener('click', () => (lastJob ? startJob(lastJob) : reset()));
  $('error-new-btn').addEventListener('click', reset);
  $('again-btn').addEventListener('click', reset);
  $('download-btn').addEventListener('click', download);
  $('share-btn').addEventListener('click', share);

  const card = panels.start;
  for (const t of ['dragenter', 'dragover']) {
    card.addEventListener(t, (e) => { e.preventDefault(); card.classList.add('dragover'); });
  }
  for (const t of ['dragleave', 'drop']) {
    card.addEventListener(t, (e) => { e.preventDefault(); card.classList.remove('dragover'); });
  }
  card.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  // Stop the browser navigating to a file dropped outside the card.
  for (const t of ['dragover', 'drop']) window.addEventListener(t, (e) => e.preventDefault());

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
