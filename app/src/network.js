// Road network in a local metric frame: segments, spatial grid, bounded
// Dijkstra with caching. Used by the matcher.

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const { k, v } = this;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const { k, v } = this;
    const topK = k[0], topV = v[0];
    const lastK = k.pop(), lastV = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return [topK, topV];
  }
}

const KEY_STRIDE = 1048576;

export class Network {
  /** ways: parsed OSM ways; frame: geo.Frame; cfg: matcher constants. */
  constructor(ways, frame, cfg) {
    this.cfg = cfg;
    const index = new Map();
    const nx = [], ny = [];
    const nodeOf = (id, lat, lon) => {
      let i = index.get(id);
      if (i === undefined) {
        i = nx.length;
        index.set(id, i);
        const [x, y] = frame.fwd(lat, lon);
        nx.push(x); ny.push(y);
      }
      return i;
    };

    const sa = [], sb = [], sl = [];
    this.adj = [];
    for (const w of ways) {
      const ids = w.nodeIds.map((id, i) => nodeOf(id, w.coords[i][0], w.coords[i][1]));
      for (let i = 1; i < ids.length; i++) {
        const a = ids[i - 1], b = ids[i];
        if (a === b) continue;
        const L = Math.hypot(nx[b] - nx[a], ny[b] - ny[a]);
        if (L < 1e-6) continue;
        sa.push(a); sb.push(b); sl.push(L);
        (this.adj[a] ??= []).push(b, L);
        (this.adj[b] ??= []).push(a, L);
      }
    }
    this.nx = Float64Array.from(nx);
    this.ny = Float64Array.from(ny);
    this.sa = Int32Array.from(sa);
    this.sb = Int32Array.from(sb);
    this.sl = Float64Array.from(sl);

    // Grid cells are padded by the search radius so a point only needs its own cell.
    const G = cfg.GRID_CELL, pad = cfg.SEARCH_RADIUS;
    this.grid = new Map();
    for (let i = 0; i < sa.length; i++) {
      const ax = nx[sa[i]], ay = ny[sa[i]], bx = nx[sb[i]], by = ny[sb[i]];
      const cx1 = Math.floor((Math.max(ax, bx) + pad) / G);
      const cy1 = Math.floor((Math.max(ay, by) + pad) / G);
      for (let cx = Math.floor((Math.min(ax, bx) - pad) / G); cx <= cx1; cx++) {
        for (let cy = Math.floor((Math.min(ay, by) - pad) / G); cy <= cy1; cy++) {
          const key = cx * KEY_STRIDE + cy;
          const cell = this.grid.get(key);
          if (cell) cell.push(i); else this.grid.set(key, [i]);
        }
      }
    }
    this.dcache = new Map(); // node -> { dist: Map, pred: Map }
  }

  /** Up to MAX_CANDIDATES nearest segments within SEARCH_RADIUS: {d, seg, s}. */
  candidates(x, y) {
    const { cfg } = this;
    const cell = this.grid.get(Math.floor(x / cfg.GRID_CELL) * KEY_STRIDE + Math.floor(y / cfg.GRID_CELL));
    if (!cell) return [];
    const out = [];
    for (const i of cell) {
      const a = this.sa[i], b = this.sb[i], L = this.sl[i];
      const ax = this.nx[a], ay = this.ny[a];
      const dx = this.nx[b] - ax, dy = this.ny[b] - ay;
      const s = Math.max(0, Math.min(L, ((x - ax) * dx + (y - ay) * dy) / L));
      const d = Math.hypot(x - (ax + dx * s / L), y - (ay + dy * s / L));
      if (d <= cfg.SEARCH_RADIUS) out.push({ d, seg: i, s });
    }
    out.sort((p, q) => p.d - q.d || p.seg - q.seg);
    return out.length > cfg.MAX_CANDIDATES ? out.slice(0, cfg.MAX_CANDIDATES) : out;
  }

  /** Bounded Dijkstra (ROUTE_CAP) from a node; cached. */
  from(node) {
    let r = this.dcache.get(node);
    if (r) return r;
    const cap = this.cfg.ROUTE_CAP;
    const dist = new Map([[node, 0]]);
    const pred = new Map();
    const pq = new MinHeap();
    pq.push(0, node);
    while (pq.size) {
      const [d, u] = pq.pop();
      if (d > dist.get(u)) continue;
      const adj = this.adj[u];
      if (!adj) continue;
      for (let e = 0; e < adj.length; e += 2) {
        const v = adj[e], nd = d + adj[e + 1];
        if (nd <= cap && nd < (dist.get(v) ?? Infinity)) {
          dist.set(v, nd);
          pred.set(v, u);
          pq.push(nd, v);
        }
      }
    }
    r = { dist, pred };
    this.dcache.set(node, r);
    return r;
  }

  /** Best route between candidates on different segments: {len, u, v} or null. */
  routeEx(c1, c2) {
    const a1 = this.sa[c1.seg], b1 = this.sb[c1.seg], L1 = this.sl[c1.seg];
    const a2 = this.sa[c2.seg], b2 = this.sb[c2.seg], L2 = this.sl[c2.seg];
    let best = null;
    for (const [u, du] of [[a1, c1.s], [b1, L1 - c1.s]]) {
      const D = this.from(u).dist;
      for (const [v, dv] of [[a2, c2.s], [b2, L2 - c2.s]]) {
        const dd = D.get(v);
        if (dd !== undefined) {
          const t = du + dd + dv;
          if (best === null || t < best.len) best = { len: t, u, v };
        }
      }
    }
    return best;
  }

  /** Network distance between two candidate projections, or null. */
  route(c1, c2) {
    if (c1.seg === c2.seg) return Math.abs(c2.s - c1.s);
    const r = this.routeEx(c1, c2);
    return r === null ? null : r.len;
  }

  /** Node indices from u to v along the cached Dijkstra tree rooted at u. */
  nodePath(u, v) {
    const { pred } = this.dcache.get(u);
    const path = [v];
    while (path[path.length - 1] !== u) path.push(pred.get(path[path.length - 1]));
    return path.reverse();
  }

  posXY(c) {
    const a = this.sa[c.seg], b = this.sb[c.seg];
    const f = c.s / this.sl[c.seg];
    return [this.nx[a] + (this.nx[b] - this.nx[a]) * f, this.ny[a] + (this.ny[b] - this.ny[a]) * f];
  }

  nodeXY(n) { return [this.nx[n], this.ny[n]]; }
}
