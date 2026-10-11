// HMM (Newson-Krumm style) map matcher with an off-network escape state.
// Port of prototype/match.py; see that file for the reference behaviour.
import { Frame } from './geo.js';
import { Network } from './network.js';

export const DEFAULTS = {
  SIGMA: 9.0,              // m, GPS noise for road candidates (cost=(d/sigma)^2/2)
  SEARCH_RADIUS: 35.0,     // m, candidate search radius
  MAX_CANDIDATES: 8,       // nearest segments considered per point
  OFF_DEVIATION: 30.0,     // m, off-network emission equals a road candidate this far away
  BETA: 3.0,               // m, route-vs-straight-line transition scale
  ROUTE_CAP: 150.0,        // m, Dijkstra search cap
  UNREACHABLE_COST: 40.0,  // finite penalty for road->road not reachable within cap
  SWITCH_COST: 5.0,        // on<->off network switching penalty
  GAP_SECONDS: 5.0,        // time step above this: straight-line comparison is meaningless
  GRID_CELL: 50.0,         // m, spatial grid cell size
  SMOOTH_SECONDS: 4.0,     // s, Gaussian sigma for smoothing along-route distance s(t)
};

/**
 * points: [{lat, lon, time(ms)}], ways: parsed OSM ways.
 * options: constant overrides plus optional onProgress(fraction).
 */
export function matchTrack(points, ways, options = {}) {
  const { onProgress, ...overrides } = options;
  const cfg = { ...DEFAULTS, ...overrides };
  const n = points.length;
  if (n === 0) return { positions: [], stats: { snapped: 0, offNetwork: 0, runs: 0, monotone: true } };
  const progress = (f) => { if (onProgress) onProgress(Math.min(1, f)); };

  const frame = new Frame(
    points.reduce((a, p) => a + p.lat, 0) / n,
    points.reduce((a, p) => a + p.lon, 0) / n);
  const net = new Network(ways, frame, cfg);
  const xy = points.map((p) => frame.fwd(p.lat, p.lon));
  const ts = points.map((p) => p.time / 1000);
  progress(0.05);

  const chosen = viterbi(net, xy, ts, cfg, (f) => progress(0.05 + 0.85 * f));
  const runs = buildRuns(net, chosen, ts, cfg);
  const positions = points.map((p, k) => ({ lat: p.lat, lon: p.lon, onNetwork: chosen[k] !== null }));
  const monotone = placeRuns(runs, ts, frame, positions, cfg);
  progress(1);

  const snapped = chosen.filter((c) => c !== null).length;
  return { positions, stats: { snapped, offNetwork: n - snapped, runs: runs.length, monotone } };
}

/** Per-point chosen candidate: null (off-network) or a road candidate. */
function viterbi(net, xy, ts, cfg, progress) {
  const offCost = (cfg.OFF_DEVIATION / cfg.SIGMA) ** 2 / 2;
  const n = xy.length;
  const layers = new Array(n);
  const emis = new Array(n);
  for (let k = 0; k < n; k++) {
    const cs = net.candidates(xy[k][0], xy[k][1]);
    layers[k] = [null, ...cs];
    emis[k] = [offCost, ...cs.map((c) => (c.d / cfg.SIGMA) ** 2 / 2)];
  }
  const cost = [emis[0].slice()];
  const back = [new Array(layers[0].length).fill(-1)];
  for (let k = 1; k < n; k++) {
    const straight = Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]);
    const gap = ts[k] - ts[k - 1] > cfg.GAP_SECONDS;
    const cur = [], bk = [];
    for (let ci = 0; ci < layers[k].length; ci++) {
      const c = layers[k][ci];
      let best = 1e18, bi = 0;
      for (let pi = 0; pi < layers[k - 1].length; pi++) {
        const p = layers[k - 1][pi];
        let t;
        if (p === null && c === null) t = 0;
        else if (p === null || c === null) t = cfg.SWITCH_COST;
        else if (gap) t = 0;
        else {
          const r = net.route(p, c);
          t = r === null ? cfg.UNREACHABLE_COST : Math.abs(r - straight) / cfg.BETA;
        }
        const v = cost[k - 1][pi] + t;
        if (v < best) { best = v; bi = pi; }
      }
      cur.push(best + emis[k][ci]);
      bk.push(bi);
    }
    cost.push(cur);
    back.push(bk);
    if (k % 50 === 0) progress(k / n);
  }
  let i = 0;
  const last = cost[n - 1];
  for (let j = 1; j < last.length; j++) if (last[j] < last[i]) i = j;
  const chosen = new Array(n);
  for (let k = n - 1; k >= 0; k--) {
    chosen[k] = layers[k][i];
    i = back[k][i];
  }
  return chosen;
}

/**
 * Chain network paths between consecutive matched positions into one
 * continuous polyline per run. Runs split at off-network points, time gaps and
 * unreachable hops. Backward jitter on one segment is clamped so s never decreases.
 */
function buildRuns(net, chosen, ts, cfg) {
  const runs = [];
  let run = null;
  for (let k = 0; k < chosen.length; k++) {
    const c = chosen[k];
    if (c === null) { run = null; continue; }
    const p0 = net.posXY(c);
    let ext = null; // vertices to append for this hop (null = cannot connect)
    if (run !== null && ts[k] - ts[k - 1] <= cfg.GAP_SECONDS) {
      const prev = chosen[k - 1];
      if (prev.seg === c.seg) {
        const m = run.poly.length;
        const [px, py] = run.poly[run.vi[run.vi.length - 1]];
        let backward = false;
        if (m >= 2) {
          const dx = run.poly[m - 1][0] - run.poly[m - 2][0];
          const dy = run.poly[m - 1][1] - run.poly[m - 2][1];
          backward = dx * (p0[0] - px) + dy * (p0[1] - py) < 0;
        }
        ext = backward ? [] : [p0]; // backward jitter: hold position
      } else {
        const r = net.routeEx(prev, c);
        if (r !== null) ext = [...net.nodePath(r.u, r.v).map((nd) => net.nodeXY(nd)), p0];
      }
    }
    if (run === null || ext === null) {
      run = { idx: [], poly: [p0], cum: [0], vi: [] };
      runs.push(run);
    } else {
      for (const v of ext) {
        const l = run.poly[run.poly.length - 1];
        run.cum.push(run.cum[run.cum.length - 1] + Math.hypot(v[0] - l[0], v[1] - l[1]));
        run.poly.push(v);
      }
    }
    run.idx.push(k);
    run.vi.push(run.poly.length - 1);
  }
  return runs;
}

/**
 * Gaussian smoothing of s(t) (window +-2.5 sigma). Run edges use odd
 * reflection so the edge value is preserved without biasing neighbours;
 * endpoints are pinned exactly and a running max guarantees monotonicity.
 */
function smoothSeries(t, s, sigma) {
  const n = s.length;
  if (n < 3) return s.slice();
  const win = 2.5 * sigma;
  // Extended series in ascending time order: reflected head, original, reflected tail.
  const tt = [], ss = [];
  for (let j = n - 1; j >= 1; j--) {
    if (t[j] - t[0] <= win) { tt.push(2 * t[0] - t[j]); ss.push(2 * s[0] - s[j]); }
  }
  for (let j = 0; j < n; j++) { tt.push(t[j]); ss.push(s[j]); }
  for (let j = n - 2; j >= 0; j--) {
    if (t[n - 1] - t[j] <= win) { tt.push(2 * t[n - 1] - t[j]); ss.push(2 * s[n - 1] - s[j]); }
  }
  const out = new Array(n);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const ti = t[i];
    while (tt[lo] < ti - win) lo++;
    let num = 0, den = 0;
    for (let j = lo; j < tt.length && tt[j] <= ti + win; j++) {
      const w = Math.exp(-0.5 * ((tt[j] - ti) / sigma) ** 2);
      num += w * ss[j];
      den += w;
    }
    out[i] = num / den;
  }
  out[0] = s[0];
  out[n - 1] = s[n - 1];
  let m = out[0];
  for (let i = 0; i < n; i++) {
    m = Math.max(m, out[i]);
    out[i] = Math.min(m, s[n - 1]);
  }
  return out;
}

function placeOnPolyline(poly, cum, s) {
  if (poly.length === 1) return poly[0];
  // bisect_right(cum, s) - 1, clamped to a valid segment
  let lo = 0, hi = cum.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s < cum[mid]) hi = mid; else lo = mid + 1;
  }
  const j = Math.max(0, Math.min(lo - 1, poly.length - 2));
  const seg = cum[j + 1] - cum[j];
  const f = seg <= 0 ? 0 : Math.min(1, Math.max(0, (s - cum[j]) / seg));
  return [poly[j][0] + (poly[j + 1][0] - poly[j][0]) * f, poly[j][1] + (poly[j + 1][1] - poly[j][1]) * f];
}

/** Smooth along-route distance per run and write lat/lon into positions. */
function placeRuns(runs, ts, frame, positions, cfg) {
  let monotone = true;
  for (const run of runs) {
    const raw = run.vi.map((v) => run.cum[v]);
    const sm = smoothSeries(run.idx.map((k) => ts[k]), raw, cfg.SMOOTH_SECONDS);
    for (let i = 1; i < raw.length; i++) {
      if (raw[i] < raw[i - 1] - 1e-9 || sm[i] < sm[i - 1] - 1e-9) monotone = false;
    }
    run.idx.forEach((k, i) => {
      const [lat, lon] = frame.inv(...placeOnPolyline(run.poly, run.cum, sm[i]));
      positions[k].lat = lat;
      positions[k].lon = lon;
    });
  }
  return monotone;
}
