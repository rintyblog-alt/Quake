#!/usr/bin/env python3
"""日本の陸域マスクを生成する.

都道府県界ポリゴンをラスタ化し、緯度経度格子上の陸/海の判定ビットマップを作る。
震央地名の判定 (陸域なら最近傍観測点の区分、海域なら最近傍の海域区分) と、
津波の発生判定・伝播の起点決定に用いる。

出力は 1 セル 1 ビットのパック配列を base64 で埋め込んだ JSON。
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np
from matplotlib.path import Path as MplPath

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data"

# 日本周辺の範囲
LAT_MIN, LAT_MAX = 20.0, 46.5
LON_MIN, LON_MAX = 122.0, 154.5


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--step", type=float, default=0.01, help="格子間隔 [度]")
    args = ap.parse_args()

    gj = json.loads((OUT / "japan.geojson").read_text(encoding="utf-8"))

    n_lat = int(round((LAT_MAX - LAT_MIN) / args.step))
    n_lon = int(round((LON_MAX - LON_MIN) / args.step))
    print(f"格子 {n_lat} x {n_lon} = {n_lat * n_lon / 1e6:.2f} M セル")

    mask = np.zeros((n_lat, n_lon), dtype=bool)
    lat_c = LAT_MIN + (np.arange(n_lat) + 0.5) * args.step
    lon_c = LON_MIN + (np.arange(n_lon) + 0.5) * args.step

    n_rings = 0
    for feat in gj["features"]:
        for poly in feat["geometry"]["coordinates"]:
            outer = np.array(poly[0], dtype=float)
            holes = [np.array(h, dtype=float) for h in poly[1:]]
            lo0, la0 = outer.min(axis=0)
            lo1, la1 = outer.max(axis=0)
            i0 = max(0, int((la0 - LAT_MIN) / args.step) - 1)
            i1 = min(n_lat, int((la1 - LAT_MIN) / args.step) + 2)
            j0 = max(0, int((lo0 - LON_MIN) / args.step) - 1)
            j1 = min(n_lon, int((lo1 - LON_MIN) / args.step) + 2)
            if i1 <= i0 or j1 <= j0:
                continue
            gj_lon, gj_lat = np.meshgrid(lon_c[j0:j1], lat_c[i0:i1])
            pts = np.column_stack([gj_lon.ravel(), gj_lat.ravel()])
            inside = MplPath(outer).contains_points(pts)
            for h in holes:
                if h.shape[0] >= 4:
                    inside &= ~MplPath(h).contains_points(pts)
            mask[i0:i1, j0:j1] |= inside.reshape(i1 - i0, j1 - j0)
            n_rings += 1

    land = int(mask.sum())
    print(f"ポリゴン {n_rings} 個 / 陸セル {land} ({100 * land / mask.size:.2f}%)")

    packed = np.packbits(mask.ravel())
    payload = {
        "lat_min": LAT_MIN,
        "lat_max": LAT_MAX,
        "lon_min": LON_MIN,
        "lon_max": LON_MAX,
        "step": args.step,
        "n_lat": n_lat,
        "n_lon": n_lon,
        "bits": base64.b64encode(packed.tobytes()).decode("ascii"),
    }
    path = OUT / "landmask.json"
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"出力: {path.name}  {path.stat().st_size / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
