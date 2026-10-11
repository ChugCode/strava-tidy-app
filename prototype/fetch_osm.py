#!/usr/bin/env python3
"""Download OSM data covering a GPX track (bbox + margin) from the OSM API 0.6.

Usage: python fetch_osm.py <track.gpx> <out.xml> [--margin 150]

The /map call is limited to 50,000 nodes (HTTP 400) and ~0.25 deg^2. Bbox
splitting is not implemented: for such tracks the error is reported clearly.
"""
import argparse
import math
import re
import sys
import urllib.error
import urllib.request

API = "https://api.openstreetmap.org/api/0.6/map"
USER_AGENT = "gpxfix-prototype/0.1 (personal GPX map-matching script)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gpx")
    ap.add_argument("out")
    ap.add_argument("--margin", type=float, default=150.0, help="metres around the track")
    a = ap.parse_args()

    text = open(a.gpx, encoding="utf8").read()
    pts = [(float(la), float(lo)) for la, lo in re.findall(r'<trkpt lat="([^"]+)" lon="([^"]+)"', text)]
    if not pts:
        sys.exit("ERROR: no <trkpt> found in " + a.gpx)
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    mlat = a.margin / 111320.0
    mlon = a.margin / (111320.0 * math.cos(math.radians(sum(lats) / len(lats))))
    bbox = (min(lons) - mlon, min(lats) - mlat, max(lons) + mlon, max(lats) + mlat)
    url = API + "?bbox=%.6f,%.6f,%.6f,%.6f" % bbox
    print("GET", url)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf8", "replace")[:300]
        if e.code == 400:
            sys.exit(f"ERROR: HTTP 400 from OSM API (bbox likely too large / more than 50000 nodes; "
                     f"bbox splitting is not implemented): {body}")
        sys.exit(f"ERROR: HTTP {e.code} {e.reason}: {body}")
    except urllib.error.URLError as e:
        sys.exit(f"ERROR: could not reach OSM API: {e.reason}")
    with open(a.out, "wb") as f:
        f.write(data)
    print(f"wrote {len(data)} bytes to {a.out}")


if __name__ == "__main__":
    main()
