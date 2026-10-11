import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { outputFileName, parseSharedFlag } from '../src/share.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('outputFileName keeps the base name and uses the output extension', () => {
  assert.equal(outputFileName('exercise_tcx_file.tcx', '.tcx'), 'exercise_tcx_file-tidied.tcx');
  assert.equal(outputFileName('Morning Run.gpx', '.gpx'), 'Morning Run-tidied.gpx');
  assert.equal(outputFileName('a.b.tcx', '.tcx'), 'a.b-tidied.tcx');
  assert.equal(outputFileName('', '.gpx'), 'activity-tidied.gpx');
  assert.equal(outputFileName(undefined, '.tcx'), 'activity-tidied.tcx');
});

test('parseSharedFlag', () => {
  assert.equal(parseSharedFlag('?shared=1'), true);
  assert.equal(parseSharedFlag('?a=b&shared=1'), true);
  assert.equal(parseSharedFlag('?shared=0'), false);
  assert.equal(parseSharedFlag(''), false);
  assert.equal(parseSharedFlag(undefined), false);
});

test('manifest declares a valid relative share_target', () => {
  const m = JSON.parse(readFileSync(root + 'manifest.webmanifest', 'utf8'));
  const st = m.share_target;
  assert.ok(st);
  assert.equal(st.method, 'POST');
  assert.equal(st.enctype, 'multipart/form-data');
  assert.ok(st.action.startsWith('./') && !/^[a-z]+:/i.test(st.action));
  const f = st.params.files[0];
  assert.equal(f.name, 'activity');
  assert.ok(f.accept.includes('.tcx') && f.accept.includes('.gpx'));
});

function loadSw() {
  const listeners = {};
  const store = new Map();
  const caches = {
    async open(name) {
      return { async put(k, v) { store.set(`${name}|${k}`, v); } };
    },
    async keys() { return []; },
    async match() { return undefined; },
  };
  const self = {
    location: new URL('https://chugcode.github.io/strava-tidy-app/sw.js'),
    addEventListener: (t, fn) => { listeners[t] = fn; },
  };
  const ctx = vm.createContext({ self, caches, Response, Request, FormData, File, URL, fetch: async () => { throw new Error('net'); } });
  vm.runInContext(readFileSync(root + 'sw.js', 'utf8'), ctx);
  const fire = (request) => {
    let promise = null;
    listeners.fetch({ request, respondWith: (p) => { promise = Promise.resolve(p); } });
    return promise;
  };
  return { fire, store };
}

test('sw handles a share-target POST: stores the file and redirects 303', async () => {
  const { fire, store } = loadSw();
  const form = new FormData();
  form.append('activity', new File(['<TrainingCenterDatabase/>'], 'exercise_tcx_file.tcx', { type: 'application/octet-stream' }));
  const p = fire(new Request('https://chugcode.github.io/strava-tidy-app/share-target', { method: 'POST', body: form }));
  assert.ok(p, 'request was intercepted');
  const res = await p;
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://chugcode.github.io/strava-tidy-app/?shared=1');
  const stored = store.get('strava-tidy-shared|https://chugcode.github.io/strava-tidy-app/shared-file');
  assert.ok(stored);
  assert.equal(decodeURIComponent(stored.headers.get('X-Filename')), 'exercise_tcx_file.tcx');
  assert.equal(await stored.text(), '<TrainingCenterDatabase/>');
});

test('sw still redirects (nothing stored) when the POST carries no file', async () => {
  const { fire, store } = loadSw();
  const form = new FormData();
  form.append('other', 'text');
  const res = await fire(new Request('https://chugcode.github.io/strava-tidy-app/share-target', { method: 'POST', body: form }));
  assert.equal(res.status, 303);
  assert.equal(store.size, 0);
});

test('sw leaves other requests alone', () => {
  const { fire } = loadSw();
  assert.equal(fire(new Request('https://chugcode.github.io/strava-tidy-app/other', { method: 'POST', body: 'x' })), null);
  assert.equal(fire(new Request('https://tile.openstreetmap.org/1/2/3.png')), null);
  assert.equal(fire(new Request('https://evil.example/strava-tidy-app/share-target', { method: 'POST', body: 'x' })), null);
});
