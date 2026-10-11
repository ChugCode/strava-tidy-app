// Main-thread UI: file intake, worker orchestration, result rendering.
import { formatPace, formatKm, formatMeters, formatDelta } from './format.js';
import { outputFileName, parseSharedFlag } from './share.js';
import { showTracks, invalidateMap } from './map-view.js';

const $ = (id) => document.getElementById(id);
const panels = { start: $('start'), progress: $('progress'), error: $('error'), result: $('result') };
const focusTargets = { start: 'choose-btn', progress: 'progress-title', error: 'error-title', result: 'result-title' };

let worker = null;
let runToken = 0; // lets us ignore messages from a cancelled main-thread fallback run
let lastJob = null; // { name, text, rename } for Retry
let current = null; // { fileName, outputText, mimeType } for download

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
  let text;
  try {
    text = await file.text();
  } catch {
    showError('That file could not be read. Please choose it again.');
    return;
  }
  startJob({ name: file.name, text, rename: $('rename-opt').checked });
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

  const payload = { text: job.text, rename: job.rename };
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

function finish(job, msg) {
  if (worker) { worker.terminate(); worker = null; }
  const { outputText, summary, format, extension, mimeType, rawPoints, tidiedPoints } = msg;
  try {
    current = { fileName: outputFileName(job.name, extension), outputText, mimeType };
    $('tcx-note').hidden = format !== 'tcx';
    renderSummary(summary);
    renderSplits(summary.splits);
    show('result');
    renderMap(rawPoints, tidiedPoints);
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

function renderMap(rawPoints, tidiedPoints) {
  const off = tidiedPoints.filter((p) => !p.onNetwork).map((p) => [p.lat, p.lon]);
  showTracks($('map'), rawPoints.map((p) => [p.lat, p.lon]), tidiedPoints.map((p) => [p.lat, p.lon]), off);
}

function download() {
  const url = URL.createObjectURL(new Blob([current.outputText], { type: current.mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = current.fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const SHARED_CACHE = 'strava-tidy-shared';
const TIP_KEY = 'strava-tidy-tip-dismissed';

/** Picks up the file the service worker stored from a Web Share Target POST, then starts the job. */
async function loadSharedFile() {
  history.replaceState(null, '', location.pathname + location.hash);
  const missing = "The shared file didn't arrive. Try again or choose it manually.";
  let file = null;
  try {
    const cache = await caches.open(SHARED_CACHE);
    const key = new URL('shared-file', document.baseURI).href;
    const res = await cache.match(key);
    if (res) {
      let name = 'activity';
      try { name = decodeURIComponent(res.headers.get('X-Filename') || '') || name; } catch { /* keep default */ }
      file = { name, text: await res.text() };
      await cache.delete(key);
    }
  } catch { file = null; }
  if (!file || !file.text) { showError(missing); return; }
  startJob({ name: file.name, text: file.text, rename: $('rename-opt').checked });
}

function setupTip() {
  let dismissed = false;
  try { dismissed = localStorage.getItem(TIP_KEY) === '1'; } catch { /* storage unavailable */ }
  $('install-tip').hidden = dismissed;
  $('tip-dismiss').addEventListener('click', () => {
    $('install-tip').hidden = true;
    try { localStorage.setItem(TIP_KEY, '1'); } catch { /* storage unavailable */ }
  });
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

  setupTip();

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

  if (parseSharedFlag(location.search)) loadSharedFile();
}

init();
