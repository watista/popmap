"""
Builds web/data/countries.json (name, ISO code, population estimate, bounding box)
from Natural Earth 1:50m Admin-0 (public domain).

Usage: python build_countries.py --out ../web/data/countries.json
"""
import argparse
import json
import os
import urllib.request

URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
       "geojson/ne_50m_admin_0_countries.geojson")


def bbox(geom):
    # largest polygon, so that e.g. France does not include French Guiana
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    def area(ring):
        return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])))
    main = max(polys, key=lambda p: area(p[0]))[0]
    main_box = [min(p[0] for p in main), min(p[1] for p in main),
                max(p[0] for p in main), max(p[1] for p in main)]
    return [round(v, 3) for v in main_box]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    with urllib.request.urlopen(URL, timeout=120) as r:
        fc = json.load(r)
    out = []
    for f in fc["features"]:
        p = f["properties"]
        out.append({
            "name": p["NAME"],
            "iso": p.get("ISO_A3") if p.get("ISO_A3") != "-99" else p.get("ADM0_A3"),
            "pop": p.get("POP_EST"),
            "popYear": p.get("POP_YEAR"),
            "bbox": bbox(f["geometry"]),
        })
    out.sort(key=lambda c: c["name"])
    tmp = args.out + ".tmp"  # write-then-rename, so a live site never sees a partial file
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(tmp, args.out)
    print(f"wrote {len(out)} countries to {args.out}")


if __name__ == "__main__":
    main()
