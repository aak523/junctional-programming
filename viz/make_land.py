"""Turn Natural Earth 110m land into the globe's dot matrix + coastlines (viz/data/land.json).

    curl -sSL -o /tmp/land.geojson \
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson
    python3 viz/make_land.py /tmp/land.geojson
"""
import json
import math
import os
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/land.geojson"
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "land.json")

polys = []   # (exterior ring, [hole rings]) in lon/lat
for f in json.load(open(src))["features"]:
    g = f["geometry"]
    parts = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    for p in parts:
        polys.append((p[0], p[1:]))


def inside(ring, x, y):
    n, c = len(ring), False
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def land(x, y):
    for ext, holes in polys:
        if inside(ext, x, y) and not any(inside(h, x, y) for h in holes):
            return True
    return False


STEP = 2.1                       # degrees between dots at the equator
dots = []
lat = -89.0
while lat <= 84.0:               # skip the poles: dots there crowd together
    span = math.cos(math.radians(lat))
    if span > 0.02:
        step = STEP / span
        n = max(1, int(round(360.0 / step)))
        for i in range(n):
            lon = -180.0 + i * (360.0 / n)
            if land(lon, lat):
                dots.append([round(lat, 1), round(lon, 1)])
    lat += STEP

rings = []
for ext, holes in polys:
    for r in [ext] + list(holes):
        flat = []
        for x, y in r:
            flat.append(round(x, 2))
            flat.append(round(y, 2))
        if len(flat) >= 6:
            rings.append(flat)

with open(out, "w") as fh:
    json.dump({"dots": dots, "rings": rings}, fh, separators=(",", ":"))
print(f"{out}: {len(dots)} dots, {len(rings)} rings, {os.path.getsize(out) // 1024} KB")
