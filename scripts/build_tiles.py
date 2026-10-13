"""
Builds population tiles for the web app from the Kontur Population GeoPackage.

Input : Kontur Population (H3 resolution 8, ~400 m hexagons), CC BY 4.0
Output: <out>/tiles/<variant>/{z}/{x}/{y}.bin  -- Float32 interleaved [lng, lat, pop, density]
        <out>/tiles/meta.json                  -- statistics per resolution; per variant
                                                  zoom->resolution and tile index (bitsets)

Variants ("number of spikes") use a coarser H3 resolution per zoom: fewer, fuller spikes.

Each web-mercator zoom gets an H3 resolution so that a tile holds at most ~50k hexagons.
Hexagons are assigned to a tile by their centre point.

Usage (in WSL):
  python build_tiles.py --gpkg ~/popmap-work/kontur_population_20231101.gpkg --out ../web
  (the dataset date is read from the file name; pass --version YYYYMMDD otherwise)
"""
import argparse
import base64
import json
import math
import os
import re
import sqlite3
import time
from multiprocessing import Pool

import h3.api.basic_int as h3
import numpy as np

# web-mercator zoom -> H3 resolution
ZOOM_RES = {0: 3, 1: 4, 2: 4, 3: 5, 4: 5, 5: 6, 6: 6, 7: 7, 8: 8}
# variant -> number of resolution steps coarser than ZOOM_RES (negative = finer, capped at 8)
VARIANTS = {"most": -1, "many": 0, "medium": 1, "few": 2, "fewest": 3}
MIN_RES, MAX_RES = 0, 8
MAX_LAT = 85.0511287798


def variant_res(base_res, coarser):
    return min(MAX_RES, max(MIN_RES, base_res - coarser))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def read_kontur(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    tables = [r[0] for r in con.execute(
        "SELECT table_name FROM gpkg_contents WHERE data_type='features'")]
    table = tables[0]
    count = con.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    log(f"table {table}: {count:,} hexagons")
    cells = np.empty(count, dtype=np.uint64)
    pops = np.empty(count, dtype=np.float64)
    cur = con.execute(f'SELECT h3, population FROM "{table}"')
    i = 0
    while True:
        rows = cur.fetchmany(1_000_000)
        if not rows:
            break
        n = len(rows)
        cells[i:i + n] = [int(r[0], 16) for r in rows]
        pops[i:i + n] = [r[1] for r in rows]
        i += n
        log(f"  read {i:,}")
    con.close()
    return cells[:i], pops[:i]


def parent(cells, res):
    """H3 parent via bit manipulation (vectorised)."""
    tail = np.uint64((1 << ((15 - res) * 3)) - 1)
    res_mask = np.uint64(0xF << 52)
    return (cells & ~res_mask & ~tail) | np.uint64(res << 52) | tail


def aggregate(cells, pops, res):
    p = parent(cells, res)
    uniq, inv = np.unique(p, return_inverse=True)
    return uniq, np.bincount(inv, weights=pops)


def _geo_chunk(chunk):
    out = np.empty((len(chunk), 3), dtype=np.float64)
    for i, c in enumerate(chunk.tolist()):
        lat, lng = h3.cell_to_latlng(c)
        out[i] = (lng, lat, h3.cell_area(c, unit="km^2"))
    return out


def cell_geo(cells, pool):
    chunks = np.array_split(cells, max(1, len(cells) // 200_000))
    return np.concatenate(pool.map(_geo_chunk, chunks))


def tile_xy(lng, lat, z):
    n = 2 ** z
    lat = np.clip(lat, -MAX_LAT, MAX_LAT)
    x = np.floor((lng + 180.0) / 360.0 * n)
    lr = np.radians(lat)
    y = np.floor((1.0 - np.log(np.tan(lr) + 1.0 / np.cos(lr)) / math.pi) / 2.0 * n)
    return np.clip(x, 0, n - 1).astype(np.int64), np.clip(y, 0, n - 1).astype(np.int64)


def write_zoom(out_dir, z, lng, lat, pop, dens):
    n = 2 ** z
    x, y = tile_xy(lng, lat, z)
    key = x * n + y
    order = np.argsort(key, kind="stable")
    key = key[order]
    rec = np.stack([lng[order], lat[order], pop[order], dens[order]], axis=1).astype(np.float32)
    keys, starts = np.unique(key, return_index=True)
    ends = np.append(starts[1:], len(key))
    bits = np.zeros(n * n, dtype=np.uint8)  # index = y * n + x
    biggest = 0
    for k, s, e in zip(keys.tolist(), starts.tolist(), ends.tolist()):
        tx, ty = divmod(k, n)
        d = os.path.join(out_dir, str(z), str(tx))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{ty}.bin"), "wb") as f:
            f.write(rec[s:e].tobytes())
        bits[ty * n + tx] = 1
        biggest = max(biggest, e - s)
    packed = np.packbits(bits, bitorder="little")
    return len(keys), biggest, base64.b64encode(packed.tobytes()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gpkg", required=True)
    ap.add_argument("--out", required=True, help="web folder; tiles go to <out>/tiles")
    ap.add_argument("--tiles-dir", help="write tiles here instead of <out>/tiles")
    ap.add_argument("--version", help="dataset date YYYYMMDD (default: taken from the gpkg file name)")
    args = ap.parse_args()
    tiles_dir = args.tiles_dir or os.path.join(args.out, "tiles")
    version = args.version
    if not version:
        m = re.search(r"(\d{8})", os.path.basename(args.gpkg))
        version = m.group(1) if m else "unknown"
    date = f"{version[:4]}-{version[4:6]}-{version[6:]}" if re.fullmatch(r"\d{8}", version) else version
    os.makedirs(tiles_dir, exist_ok=True)

    cells8, pops8 = read_kontur(args.gpkg)
    log(f"total population: {pops8.sum():,.0f}")

    meta = {"source": f"Kontur Population {date} (CC BY 4.0)",
            "version": version, "date": date,
            "format": "float32 [lng, lat, population, density_per_km2]",
            "variants": {}, "resolutions": {}}
    by_res = {}
    with Pool(os.cpu_count()) as pool:
        for res in sorted({variant_res(r, c) for r in ZOOM_RES.values() for c in VARIANTS.values()}):
            if res == 8:
                cells, pops = cells8, pops8
            else:
                cells, pops = aggregate(cells8, pops8, res)
            log(f"res {res}: {len(cells):,} cells, computing geometry")
            geo = cell_geo(cells, pool)
            dens = pops / geo[:, 2]
            by_res[res] = (geo[:, 0], geo[:, 1], pops, dens)
            q = np.percentile(dens, [50, 90, 99, 99.9])
            meta["resolutions"][res] = {
                "cells": int(len(cells)),
                "edge_m": h3.average_hexagon_edge_length(res, unit="m"),
                "p50": float(q[0]), "p90": float(q[1]), "p99": float(q[2]),
                "p999": float(q[3]), "max": float(dens.max())}

    for name, coarser in VARIANTS.items():
        zooms = meta["variants"][name] = {}
        for z, base_res in ZOOM_RES.items():
            res = variant_res(base_res, coarser)
            lng, lat, pop, dens = by_res[res]
            ntiles, biggest, bitset = write_zoom(os.path.join(tiles_dir, name), z, lng, lat, pop, dens)
            zooms[z] = {"res": res, "tiles": ntiles, "maxPerTile": biggest, "index": bitset}
            log(f"{name} zoom {z} (res {res}): {ntiles:,} tiles, max {biggest:,} per tile")

    with open(os.path.join(tiles_dir, "meta.json"), "w") as f:
        json.dump(meta, f)
    log("done")


if __name__ == "__main__":
    main()
