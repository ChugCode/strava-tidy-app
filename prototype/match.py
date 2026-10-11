#!/usr/bin/env python3
"""HMM (Newson-Krumm style) map matcher for noisy GPX running tracks.

Snaps trackpoints to OSM ways where the runner is clearly on them, keeps raw
positions where they are clearly off-network, and never touches time / hr / cad.
Only the lat/lon attributes of each <trkpt> are rewritten (text substitution on
the original file, so everything else stays byte-identical).

Usage: python match.py in.gpx osm.xml out.gpx [--report report.txt] [--html compare.html]
"""
import argparse
import bisect
import heapq
import sys
import json
import math
import re
import xml.etree.ElementTree as ET
from datetime import datetime

# ----------------------------------------------------------------- constants
SIGMA = 9.0              # m, GPS noise for road candidates (cost=(d/sigma)^2/2)
SEARCH_RADIUS = 35.0     # m, candidate search radius
MAX_CANDIDATES = 8       # nearest segments considered per point
OFF_DEVIATION = 30.0     # m, off-network emission equals a road candidate this far away
OFF_COST = (OFF_DEVIATION / SIGMA) ** 2 / 2
BETA = 3.0               # m, route-vs-straight-line transition scale
ROUTE_CAP = 150.0        # m, Dijkstra search cap
UNREACHABLE_COST = 40.0  # finite penalty for road->road not reachable within cap
SWITCH_COST = 5.0        # on<->off network switching penalty
GAP_SECONDS = 5.0        # time step above this: straight-line comparison is meaningless
GRID_CELL = 50.0         # m, spatial grid cell size
SMOOTH_SECONDS = 4.0     # s, Gaussian sigma for smoothing along-route distance s(t)
LONG_OFF_RUN_S = 10      # report off-network runs longer than this

ALLOWED_HIGHWAYS = {
    "residential", "service", "footway", "path", "cycleway", "pedestrian",
    "living_street", "unclassified", "tertiary", "secondary", "primary",
    "trunk", "track", "steps", "bridleway",
    "primary_link", "secondary_link", "tertiary_link", "trunk_link",
}
# Excluded "through the houses" traps (checked after the allowed set):
EXCLUDED_HIGHWAYS = {"motorway", "motorway_link"}
EXCLUDED_SERVICE = {"driveway", "parking_aisle"}
EXCLUDED_ACCESS = {"private", "no"}

R_EARTH = 6371000.0


# ------------------------------------------------------------------- helpers
def haversine(lat1, lon1, lat2, lon2):
    f1, f2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((f2 - f1) / 2) ** 2
         + math.cos(f1) * math.cos(f2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * R_EARTH * math.asin(math.sqrt(a))


class Frame:
    """Local equirectangular projection around a centre."""

    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = math.radians(1) * R_EARTH * math.cos(math.radians(lat0))
        self.ky = math.radians(1) * R_EARTH

    def fwd(self, lat, lon):
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky

    def inv(self, x, y):
        return self.lat0 + y / self.ky, self.lon0 + x / self.kx


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def fmt_pace(sec_per_km):
    if sec_per_km is None or not math.isfinite(sec_per_km):
        return "--:--"
    s = int(round(sec_per_km))
    return f"{s // 60}:{s % 60:02d}"


# ----------------------------------------------------------------- GPX input
TRKPT_RE = re.compile(r'(<trkpt lat=")([^"]+)(" lon=")([^"]+)(">)(.*?)(</trkpt>)', re.S)


def read_gpx(path):
    text = open(path, encoding="utf8", newline="").read()
    pts = []
    for m in TRKPT_RE.finditer(text):
        body = m.group(6)
        t = re.search(r"<time>([^<]*)</time>", body).group(1)
        hr = re.search(r"<gpxtpx:hr>([^<]*)</gpxtpx:hr>", body)
        cad = re.search(r"<gpxtpx:cad>([^<]*)</gpxtpx:cad>", body)
        pts.append({"lat": float(m.group(2)), "lon": float(m.group(4)),
                    "time": t, "ts": parse_ts(t),
                    "hr": hr.group(1) if hr else None,
                    "cad": cad.group(1) if cad else None})
    return text, pts


def write_gpx(text, out_path, new_ll):
    it = iter(new_ll)

    def sub(m):
        lat, lon = next(it)
        return f"{m.group(1)}{lat:.7f}{m.group(3)}{lon:.7f}{m.group(5)}{m.group(6)}{m.group(7)}"
    out = TRKPT_RE.sub(sub, text)
    with open(out_path, "w", encoding="utf8", newline="") as f:
        f.write(out)


# ------------------------------------------------------------------ OSM data
def way_allowed(tags):
    hw = tags.get("highway")
    if hw is None or hw in EXCLUDED_HIGHWAYS or hw not in ALLOWED_HIGHWAYS:
        return False
    if tags.get("service") in EXCLUDED_SERVICE:
        return False
    if tags.get("access") in EXCLUDED_ACCESS:
        return False
    return True


def read_osm(path):
    root = ET.parse(path).getroot()
    b = root.find("bounds")
    bounds = None
    if b is not None:
        bounds = tuple(float(b.get(k)) for k in ("minlat", "minlon", "maxlat", "maxlon"))
    nodes = {n.get("id"): (float(n.get("lat")), float(n.get("lon"))) for n in root.iter("node")}
    ways = []
    for w in root.iter("way"):
        tags = {t.get("k"): t.get("v") for t in w.findall("tag")}
        if not way_allowed(tags):
            continue
        refs = [nd.get("ref") for nd in w.findall("nd") if nd.get("ref") in nodes]
        if len(refs) >= 2:
            ways.append({"id": w.get("id"), "name": tags.get("name", ""),
                         "highway": tags["highway"], "refs": refs})
    return nodes, ways, bounds


class Network:
    def __init__(self, nodes, ways, frame):
        self.xy = {nid: frame.fwd(*ll) for nid, ll in nodes.items()}
        self.segs = []   # (node_a, node_b, ax, ay, bx, by, length, way_index)
        self.adj = {}
        for wi, w in enumerate(ways):
            for a, b in zip(w["refs"], w["refs"][1:]):
                if a == b:
                    continue
                ax, ay = self.xy[a]
                bx, by = self.xy[b]
                L = math.hypot(bx - ax, by - ay)
                if L < 1e-6:
                    continue
                self.segs.append((a, b, ax, ay, bx, by, L, wi))
                self.adj.setdefault(a, []).append((b, L))
                self.adj.setdefault(b, []).append((a, L))
        self.grid = {}
        for i, s in enumerate(self.segs):
            x0, x1 = sorted((s[2], s[4]))
            y0, y1 = sorted((s[3], s[5]))
            pad = SEARCH_RADIUS
            for cx in range(int((x0 - pad) // GRID_CELL), int((x1 + pad) // GRID_CELL) + 1):
                for cy in range(int((y0 - pad) // GRID_CELL), int((y1 + pad) // GRID_CELL) + 1):
                    self.grid.setdefault((cx, cy), []).append(i)
        self._dcache = {}
        self._pcache = {}

    def candidates(self, x, y):
        """Up to MAX_CANDIDATES (dist, seg, s, px, py) within SEARCH_RADIUS."""
        out = []
        for i in self.grid.get((int(x // GRID_CELL), int(y // GRID_CELL)), ()):
            _, _, ax, ay, bx, by, L, _ = self.segs[i]
            dx, dy = bx - ax, by - ay
            s = ((x - ax) * dx + (y - ay) * dy) / L
            s = max(0.0, min(L, s))
            px, py = ax + dx * s / L, ay + dy * s / L
            d = math.hypot(x - px, y - py)
            if d <= SEARCH_RADIUS:
                out.append((d, i, s, px, py))
        out.sort()
        return out[:MAX_CANDIDATES]

    def dists_from(self, node):
        """Bounded Dijkstra (ROUTE_CAP) from a node; cached."""
        r = self._dcache.get(node)
        if r is not None:
            return r
        dist = {node: 0.0}
        pred = {}
        pq = [(0.0, node)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, 1e18):
                continue
            for v, w in self.adj.get(u, ()):
                nd = d + w
                if nd <= ROUTE_CAP and nd < dist.get(v, 1e18):
                    dist[v] = nd
                    pred[v] = u
                    heapq.heappush(pq, (nd, v))
        self._dcache[node] = dist
        self._pcache[node] = pred
        return dist

    def route_ex(self, c1, c2):
        """(length, start_node, end_node) of the best route, or None.
        Only meaningful for different segments."""
        (_, i, s1, _, _), (_, j, s2, _, _) = c1, c2
        a1, b1, *_r1, L1, _ = self.segs[i]
        a2, b2, *_r2, L2, _ = self.segs[j]
        best = None
        for u, du in ((a1, s1), (b1, L1 - s1)):
            D = self.dists_from(u)
            for v, dv in ((a2, s2), (b2, L2 - s2)):
                if v in D:
                    t = du + D[v] + dv
                    if best is None or t < best[0]:
                        best = (t, u, v)
        return best

    def route(self, c1, c2):
        """Network distance between two candidate projections, or None."""
        if c1[1] == c2[1]:
            return abs(c2[2] - c1[2])
        r = self.route_ex(c1, c2)
        return None if r is None else r[0]

    def node_path(self, u, v):
        """Node ids from u to v along the cached Dijkstra tree rooted at u."""
        pred = self._pcache[u]
        path = [v]
        while path[-1] != u:
            path.append(pred[path[-1]])
        return path[::-1]

    def pos_xy(self, c):
        seg = self.segs[c[1]]
        f = c[2] / seg[6]
        return seg[2] + (seg[4] - seg[2]) * f, seg[3] + (seg[5] - seg[3]) * f


# ------------------------------------------------------------------- Viterbi
def viterbi(net, xy, ts):
    """Return per-point chosen candidate: None (off-network) or a road tuple."""
    layers = []  # each: list of candidates; index 0 = OFF (None), then roads
    emis = []
    for (x, y) in xy:
        cs = [None] + net.candidates(x, y)
        layers.append(cs)
        emis.append([OFF_COST] + [(c[0] / SIGMA) ** 2 / 2 for c in cs[1:]])
    cost = [emis[0][:]]
    back = [[-1] * len(layers[0])]
    for k in range(1, len(xy)):
        straight = math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1])
        gap = ts[k] - ts[k - 1] > GAP_SECONDS
        cur, bk = [], []
        for ci, c in enumerate(layers[k]):
            best, bi = 1e18, 0
            for pi, p in enumerate(layers[k - 1]):
                if p is None and c is None:
                    t = 0.0
                elif p is None or c is None:
                    t = SWITCH_COST
                elif gap:
                    t = 0.0
                else:
                    r = net.route(p, c)
                    t = UNREACHABLE_COST if r is None else abs(r - straight) / BETA
                v = cost[k - 1][pi] + t
                if v < best:
                    best, bi = v, pi
            cur.append(best + emis[k][ci])
            bk.append(bi)
        cost.append(cur)
        back.append(bk)
    i = min(range(len(cost[-1])), key=cost[-1].__getitem__)
    chosen = [None] * len(xy)
    for k in range(len(xy) - 1, -1, -1):
        chosen[k] = layers[k][i]
        i = back[k][i]
    return chosen


def build_runs(net, chosen, ts):
    """Chain network paths between consecutive matched positions into one
    continuous polyline per run. Runs split at off-network points, time gaps
    > GAP_SECONDS, and unreachable hops. Backward jitter on the same segment is
    clamped (the point stays where the previous one was), so s never decreases.
    Returns runs: dict(idx=[point indices], poly=[(x,y)], cum=[...], vi=[poly
    vertex index per point])."""
    runs, run = [], None
    for k, c in enumerate(chosen):
        if c is None:
            run = None
            continue
        p0 = net.pos_xy(c)
        ext = None  # vertices to append for this hop (None = cannot connect)
        if run is not None and ts[k] - ts[k - 1] <= GAP_SECONDS:
            prev = chosen[k - 1]
            if prev[1] == c[1]:
                last_dir = None
                if len(run["poly"]) >= 2:
                    (x0, y0), (x1, y1) = run["poly"][-2], run["poly"][-1]
                    last_dir = (x1 - x0, y1 - y0)
                px, py = run["poly"][run["vi"][-1]]
                step = (p0[0] - px, p0[1] - py)
                if last_dir and last_dir[0] * step[0] + last_dir[1] * step[1] < 0:
                    ext = []   # backward jitter: hold position
                else:
                    ext = [p0]
            else:
                r = net.route_ex(prev, c)
                if r is not None:
                    ext = [net.xy[n] for n in net.node_path(r[1], r[2])] + [p0]
        if run is None or ext is None:
            run = {"idx": [], "poly": [p0], "cum": [0.0], "vi": []}
            runs.append(run)
        else:
            for v in ext:
                run["cum"].append(run["cum"][-1] + math.hypot(v[0] - run["poly"][-1][0], v[1] - run["poly"][-1][1]))
                run["poly"].append(v)
        run["idx"].append(k)
        run["vi"].append(len(run["poly"]) - 1)
    return runs


def smooth_series(t, s):
    """Gaussian smoothing of s(t) (window +-2.5 sigma, sigma=SMOOTH_SECONDS).
    Run edges use odd reflection (s' = 2*s_edge - s) so the edge value is
    preserved without biasing neighbours; endpoints are pinned exactly and a
    running max guarantees monotonicity."""
    n = len(s)
    if n < 3:
        return list(s)
    win = 2.5 * SMOOTH_SECONDS
    pts = list(zip(t, s))
    pts += [(2 * t[0] - tj, 2 * s[0] - sj) for tj, sj in zip(t[1:], s[1:]) if tj - t[0] <= win]
    pts += [(2 * t[-1] - tj, 2 * s[-1] - sj) for tj, sj in zip(t[:-1], s[:-1]) if t[-1] - tj <= win]
    out = []
    for ti in t:
        num = den = 0.0
        for tj, sj in pts:
            dt = tj - ti
            if abs(dt) <= win:
                w = math.exp(-0.5 * (dt / SMOOTH_SECONDS) ** 2)
                num += w * sj
                den += w
        out.append(num / den)
    out[0], out[-1] = s[0], s[-1]
    m = out[0]
    for i in range(n):
        m = max(m, out[i])
        out[i] = min(m, s[-1])
    return out


def place_on_polyline(poly, cum, s):
    if len(poly) == 1:
        return poly[0]
    j = max(0, min(bisect.bisect_right(cum, s) - 1, len(poly) - 2))
    seg = cum[j + 1] - cum[j]
    f = 0.0 if seg <= 0 else min(1.0, max(0.0, (s - cum[j]) / seg))
    return (poly[j][0] + (poly[j + 1][0] - poly[j][0]) * f,
            poly[j][1] + (poly[j + 1][1] - poly[j][1]) * f)


def place_runs(runs, ts, frame, matched):
    """Smooth along-route distance per run and write lat/lon into matched.
    Returns a list of per-run monotonicity results."""
    mono = []
    for run in runs:
        raw_s = [run["cum"][v] for v in run["vi"]]
        sm = smooth_series([ts[k] for k in run["idx"]], raw_s)
        mono.append(all(b >= a - 1e-9 for a, b in zip(raw_s, raw_s[1:]))
                    and all(b >= a - 1e-9 for a, b in zip(sm, sm[1:])))
        for k, v in zip(run["idx"], sm):
            matched[k] = frame.inv(*place_on_polyline(run["poly"], run["cum"], v))
    return mono


# ------------------------------------------------------------------- metrics
def total_dist(ll):
    return sum(haversine(*ll[i - 1], *ll[i]) for i in range(1, len(ll)))


def splits(ll, ts):
    res, cum, km, last_t, prev_cum = [], 0.0, 1, ts[0], 0.0
    for i in range(1, len(ll)):
        d = haversine(*ll[i - 1], *ll[i])
        prev_cum, cum = cum, cum + d
        while cum >= km * 1000 and d > 0:
            f = (km * 1000 - prev_cum) / d
            t = ts[i - 1] + f * (ts[i] - ts[i - 1])
            res.append((f"{km}", t - last_t, 1000.0, t - last_t))
            last_t, km = t, km + 1
    rem = cum - (km - 1) * 1000
    if rem > 1:
        t = ts[-1] - last_t
        res.append((f"{km} (partial {rem:.0f} m)", t * 1000 / rem, rem, t))
    return res


def step_speeds(ll, ts):
    return [haversine(*ll[i - 1], *ll[i]) / max(ts[i] - ts[i - 1], 1e-9) for i in range(1, len(ll))]


# -------------------------------------------------------------------- report
def build_report(pts, matched, is_snapped, raw_ll, inv):
    ts = [p["ts"] for p in pts]
    n = len(pts)
    L = []
    nsn = sum(is_snapped)
    L.append(f"Points total: {n}   snapped: {nsn}   off-network: {n - nsn}")
    dr, dm = total_dist(raw_ll), total_dist(matched)
    L.append(f"Distance raw: {dr:.0f} m   matched: {dm:.0f} m   diff: {dm - dr:+.0f} m ({(dm - dr) / dr * 100:+.1f}%)")
    L.append("")
    L.append("Km splits (pace mm:ss per km; elapsed time incl. pauses)")
    sr, sm = splits(raw_ll, ts), splits(matched, ts)
    L.append(f"{'split':<24}{'raw':>8}{'matched':>10}")
    for i in range(max(len(sr), len(sm))):
        a = fmt_pace(sr[i][1]) if i < len(sr) else "--"
        b = fmt_pace(sm[i][1]) if i < len(sm) else "--"
        nm = sr[i][0] if i < len(sr) else sm[i][0]
        L.append(f"{nm:<24}{a:>8}{b:>10}")
    disp = [haversine(*raw_ll[i], *matched[i]) for i in range(n)]
    mi = max(range(n), key=disp.__getitem__)
    L.append("")
    L.append(f"Largest displacement: {disp[mi]:.1f} m at {pts[mi]['time']} (point {mi})")
    L.append(f"Mean displacement of snapped points: {sum(d for d, s in zip(disp, is_snapped) if s) / max(nsn, 1):.1f} m")
    runs = off_runs(pts, is_snapped)
    L.append("")
    L.append(f"Off-network runs longer than {LONG_OFF_RUN_S} s: {len(runs)}")
    for st, dur, k in runs:
        L.append(f"  {st}  {dur:.0f} s  ({k} pts)")
    L.append("")
    L.append("10 largest single-step speeds (m/s)  raw | matched")
    sp_r, sp_m = step_speeds(raw_ll, ts), step_speeds(matched, ts)
    top_r = sorted(sp_r, reverse=True)[:10]
    top_m = sorted(sp_m, reverse=True)[:10]
    for a, b in zip(top_r, top_m):
        L.append(f"  {a:6.2f} | {b:6.2f}")
    L.append("")
    L.append("Invariant checks")
    for name, ok, extra in inv:
        L.append(f"  {'PASS' if ok else 'FAIL'}  {name}{('  ' + extra) if extra else ''}")
    L.append(f"  INFO  distance raw {dr:.0f} m -> matched {dm:.0f} m")
    L.append(f"  INFO  max step speed raw {max(sp_r):.2f} m/s, matched {max(sp_m):.2f} m/s")
    L.append(f"  INFO  matched distance <= raw distance: {dm <= dr}")
    return "\n".join(L), sr, sm


def off_runs(pts, is_snapped):
    runs, k, n = [], 0, len(pts)
    while k < n:
        if is_snapped[k]:
            k += 1
            continue
        j = k
        while j + 1 < n and not is_snapped[j + 1]:
            j += 1
        dur = pts[j]["ts"] - pts[k]["ts"]
        if dur > LONG_OFF_RUN_S:
            runs.append((pts[k]["time"], dur, j - k + 1))
        k = j + 1
    return runs


def check_invariants(pts, out_path, matched, raw_ll):
    text, opts = read_gpx(out_path)
    inv = [("point count equal", len(opts) == len(pts), f"{len(opts)} vs {len(pts)}"),
           ("all <time> strings identical in order", all(a["time"] == b["time"] for a, b in zip(pts, opts)), ""),
           ("all hr values identical", all(a["hr"] == b["hr"] for a, b in zip(pts, opts)), ""),
           ("all cad values identical", all(a["cad"] == b["cad"] for a, b in zip(pts, opts)), "")]
    return inv


# ---------------------------------------------------------------------- HTML
HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GPX map-match comparison</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
body{margin:0;font:14px system-ui,sans-serif;background:#fff;color:#111}
#map{height:62vh;min-height:320px}
#info{padding:8px 12px;max-width:640px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:right}
th:first-child,td:first-child{text-align:left}
.legend{background:#fff;padding:6px 8px;border-radius:4px;line-height:1.5;font-size:12px}
.sw{display:inline-block;width:18px;height:4px;margin-right:6px;vertical-align:middle}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:orange;margin-right:9px}
</style></head><body>
<div id="map"></div>
<div id="info"><h3 style="margin:4px 0">Before / after</h3><div id="summary"></div><table id="tbl"></table></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
const D = __DATA__;
const map = L.map('map');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
D.ways.forEach(w=>L.polyline(w,{color:'#888',weight:2,opacity:.5}).addTo(map));
const raw=L.polyline(D.raw,{color:'red',weight:1.5}).addTo(map);
L.polyline(D.matched,{color:'blue',weight:3,opacity:.85}).addTo(map);
D.off.forEach(p=>L.circleMarker(p,{radius:3,color:'orange',fillColor:'orange',fillOpacity:1,weight:1}).addTo(map));
const fit=()=>{map.invalidateSize();map.fitBounds(raw.getBounds(),{padding:[10,10]});};fit();window.addEventListener('load',fit);window.addEventListener('resize',fit);
const lg=L.control({position:'bottomright'});
lg.onAdd=()=>{const d=L.DomUtil.create('div','legend');
d.innerHTML='<div><span class="sw" style="background:red"></span>raw</div><div><span class="sw" style="background:blue"></span>matched</div><div><span class="dot"></span>off-network</div><div><span class="sw" style="background:#888"></span>OSM ways</div>';return d;};
lg.addTo(map);
document.getElementById('summary').innerHTML=D.summary;
let h='<tr><th>Split</th><th>Raw</th><th>Matched</th></tr>';
D.splits.forEach(r=>h+=`<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`);
document.getElementById('tbl').innerHTML=h;
</script></body></html>
"""


def write_html(path, raw_ll, matched, is_snapped, net, nodes, ways, sr, sm, pts):
    wl = [[[round(c, 6) for c in nodes[r]] for r in w["refs"]] for w in ways]
    rows = []
    for i in range(max(len(sr), len(sm))):
        nm = sr[i][0] if i < len(sr) else sm[i][0]
        rows.append([nm, fmt_pace(sr[i][1]) if i < len(sr) else "--",
                     fmt_pace(sm[i][1]) if i < len(sm) else "--"])
    dr, dm = total_dist(raw_ll), total_dist(matched)
    data = {"raw": [[round(a, 7), round(b, 7)] for a, b in raw_ll],
            "matched": [[round(a, 7), round(b, 7)] for a, b in matched],
            "off": [[round(a, 7), round(b, 7)] for (a, b), s in zip(matched, is_snapped) if not s],
            "ways": wl, "splits": rows,
            "summary": f"Distance: raw {dr:.0f} m, matched {dm:.0f} m. Snapped {sum(is_snapped)} / {len(pts)} points."}
    with open(path, "w", encoding="utf8") as f:
        f.write(HTML.replace("__DATA__", json.dumps(data, separators=(",", ":"))))


# ---------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inp")
    ap.add_argument("osm")
    ap.add_argument("out")
    ap.add_argument("--report", default="report.txt")
    ap.add_argument("--html", default="compare.html")
    a = ap.parse_args()

    text, pts = read_gpx(a.inp)
    nodes, ways, bounds = read_osm(a.osm)
    raw_ll = [(p["lat"], p["lon"]) for p in pts]
    if bounds is None:
        la = [v[0] for v in nodes.values()]
        lo = [v[1] for v in nodes.values()]
        bounds = (min(la), min(lo), max(la), max(lo))
    outside = sum(not (bounds[0] <= la_ <= bounds[2] and bounds[1] <= lo_ <= bounds[3]) for la_, lo_ in raw_ll)
    if outside > 0.02 * len(raw_ll):
        sys.exit(f"ERROR: OSM file {a.osm} bbox (lat {bounds[0]}..{bounds[2]}, lon {bounds[1]}..{bounds[3]}) "
                 f"does not cover the track: {outside}/{len(raw_ll)} points outside. "
                 f"Run fetch_osm.py on the GPX to download matching OSM data.")
    if outside:
        print(f"WARNING: {outside} track points lie outside the OSM bbox; they will tend to stay off-network.")
    frame = Frame(sum(p[0] for p in raw_ll) / len(pts), sum(p[1] for p in raw_ll) / len(pts))
    net = Network(nodes, ways, frame)
    xy = [frame.fwd(*ll) for ll in raw_ll]
    ts = [p["ts"] for p in pts]

    chosen = viterbi(net, xy, ts)
    matched = list(raw_ll)
    is_snapped = [c is not None for c in chosen]
    runs = build_runs(net, chosen, ts)
    mono = place_runs(runs, ts, frame, matched)

    write_gpx(text, a.out, matched)
    inv = check_invariants(pts, a.out, matched, raw_ll)
    inv.append(("matched along-route s monotone non-decreasing within runs", all(mono), f"{len(runs)} runs"))
    report, sr, sm = build_report(pts, matched, is_snapped, raw_ll, inv)
    print(report)
    with open(a.report, "w", encoding="utf8") as f:
        f.write(report + "\n")
    write_html(a.html, raw_ll, matched, is_snapped, net, nodes, ways, sr, sm, pts)


if __name__ == "__main__":
    main()
