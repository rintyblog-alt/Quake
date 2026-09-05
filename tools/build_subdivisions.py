#!/usr/bin/env python3
"""気象庁の細分区域を陸域格子に割り当てる.

震度速報は都道府県ではなく細分区域 (宮城県北部・宮城県南部など) の単位で
発表される。区域のポリゴンは公開されていないため、陸域マスクの各セルを
最も近い震度観測点が属する細分区域に割り当てて区域図を作る。

出力は陸域セルの区域番号を並べた配列 (base64) で、陸域マスクと組にして使う。
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sim.landmask import LandMask

OUT = ROOT / "web" / "data"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.parse_args()

    stations = json.loads((OUT / "stations.json").read_text(encoding="utf-8"))
    names: dict[str, str] = stations["subareaNames"]
    codes = sorted(names)
    index_of = {c: i for i, c in enumerate(codes)}
    print(f"細分区域 {len(codes)} 件")
    if len(codes) > 255:
        raise SystemExit("区域数が 255 を超えています (uint8 に収まりません)")

    st_lat = np.array(stations["lat"], dtype=float)
    st_lon = np.array(stations["lon"], dtype=float)
    st_idx = np.array(
        [index_of.get(c, -1) for c in stations["subarea"]], dtype=np.int16
    )
    keep = st_idx >= 0
    st_lat, st_lon, st_idx = st_lat[keep], st_lon[keep], st_idx[keep]
    print(f"  区域が定まる観測点 {keep.sum()} / {keep.size} 点")

    mask = LandMask(OUT)
    rows, cols = np.nonzero(mask.mask)
    cell_lat = mask.lat_min + (rows + 0.5) * mask.step
    cell_lon = mask.lon_min + (cols + 0.5) * mask.step
    print(f"  陸域セル {rows.size} 個")

    # 緯度方向の縮尺を合わせた平面上で最近傍を引く
    scale = np.cos(np.radians(np.median(cell_lat)))
    tree = cKDTree(np.column_stack([st_lat, st_lon * scale]))
    _, nearest = tree.query(np.column_stack([cell_lat, cell_lon * scale]), k=1)
    cell_area = st_idx[nearest].astype(np.uint8)

    counts = np.bincount(cell_area, minlength=len(codes))
    empty = [codes[i] for i in np.nonzero(counts == 0)[0]]
    if empty:
        print(f"  [警告] 陸域セルを持たない区域: {empty}")

    # 区域ごとの代表点 (震度バッジを置く位置)。飛び地があるため、
    # 最も広いまとまりの重心に置けるよう、緯度経度の中央値を用いる。
    centroids = []
    for i in range(len(codes)):
        sel = cell_area == i
        if not sel.any():
            centroids.append([0.0, 0.0])
            continue
        centroids.append([
            round(float(np.median(cell_lat[sel])), 4),
            round(float(np.median(cell_lon[sel])), 4),
        ])

    payload = {
        "codes": codes,
        "names": [names[c] for c in codes],
        "centroids": centroids,
        "cells": base64.b64encode(cell_area.tobytes()).decode("ascii"),
    }
    path = OUT / "subdivisions.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    print(f"出力: {path.name}  {path.stat().st_size / 1024:.0f} KB")

    order = np.argsort(-counts)
    print("\n面積の大きい区域 / 小さい区域:")
    for i in list(order[:4]) + list(order[-4:]):
        print(f"  {names[codes[i]]:20s} {counts[i]:6d} セル")
    return 0


if __name__ == "__main__":
    sys.exit(main())
