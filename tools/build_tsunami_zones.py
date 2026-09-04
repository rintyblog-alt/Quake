#!/usr/bin/env python3
"""津波予報区ごとの沿岸線データを生成する.

陸域マスクから海岸線セル (海に接する陸セル) を抽出し、
所属都道府県と気象庁 津波予報区の代表座標をもとに各セルを予報区へ割り当てる。
出力は予報区ごとの沿岸点列で、津波警報・注意報の対象沿岸の描画に用いる。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from matplotlib.path import Path as MplPath

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sim.geo import haversine_array
from sim.landmask import LandMask

OUT = ROOT / "web" / "data"


def coastal_cells(mask: LandMask) -> tuple[np.ndarray, np.ndarray]:
    """海に接する陸セルの緯度経度を返す。"""
    m = mask.mask
    sea = ~m
    neighbour_sea = np.zeros_like(m)
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        shifted = np.roll(np.roll(sea, di, axis=0), dj, axis=1)
        neighbour_sea |= shifted
    coast = m & neighbour_sea
    i, j = np.nonzero(coast)
    lat = mask.lat_min + (i + 0.5) * mask.step
    lon = mask.lon_min + (j + 0.5) * mask.step
    return lat, lon


def prefecture_of(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """各点が属する都道府県名を求める (どこにも属さない点は空文字)。"""
    gj = json.loads((OUT / "japan.geojson").read_text(encoding="utf-8"))
    out = np.full(lat.size, "", dtype=object)
    pts = np.column_stack([lon, lat])
    for feat in gj["features"]:
        name = feat["properties"]["name"]
        for poly in feat["geometry"]["coordinates"]:
            outer = np.array(poly[0], dtype=float)
            lo0, la0 = outer.min(axis=0)
            lo1, la1 = outer.max(axis=0)
            cand = np.nonzero(
                (lon >= lo0 - 0.02) & (lon <= lo1 + 0.02)
                & (lat >= la0 - 0.02) & (lat <= la1 + 0.02)
                & (out == "")
            )[0]
            if cand.size == 0:
                continue
            inside = MplPath(outer).contains_points(pts[cand])
            out[cand[inside]] = name
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--subsample", type=int, default=3, help="沿岸点の間引き間隔")
    ap.add_argument("--max-orphan-km", type=float, default=120.0)
    args = ap.parse_args()

    anchors = json.loads(
        (ROOT / "data" / "tsunami_zone_anchors.json").read_text(encoding="utf-8")
    )
    anchors = {k: v for k, v in anchors.items() if not k.startswith("_")}
    zone_list = ROOT / "data" / "tsunami_zone_list.json"
    zones = {
        z["code"]: z
        for z in json.loads(zone_list.read_text(encoding="utf-8"))["zones"]
    }

    mask = LandMask(OUT)
    lat, lon = coastal_cells(mask)
    print(f"海岸線セル {lat.size} 点")

    pref = prefecture_of(lat, lon)
    n_known = int((pref != "").sum())
    print(f"  都道府県が特定できた点 {n_known} ({100 * n_known / lat.size:.1f}%)")

    codes = list(anchors)
    a_lat = np.array([anchors[c]["p"][0] for c in codes])
    a_lon = np.array([anchors[c]["p"][1] for c in codes])
    a_pref = [set(anchors[c]["pref"]) for c in codes]

    assigned: dict[str, list[list[float]]] = {c: [] for c in codes}
    orphan = 0
    for k in range(lat.size):
        d = haversine_array(float(lat[k]), float(lon[k]), a_lat, a_lon)
        p = pref[k]
        allowed = [i for i, s in enumerate(a_pref) if p in s] if p else []
        if allowed:
            i = min(allowed, key=lambda i: d[i])
        else:
            i = int(np.argmin(d))
            if d[i] > args.max_orphan_km:
                orphan += 1
                continue
        assigned[codes[i]].append([round(float(lat[k]), 3), round(float(lon[k]), 3)])

    out_zones = []
    for c in codes:
        pts = assigned[c][:: args.subsample]
        if not pts:
            print(f"  [警告] 沿岸点なし: {c} {zones.get(c, {}).get('name', '')}")
            pts = [anchors[c]["p"]]
        arr = np.array(pts, dtype=float)
        out_zones.append(
            {
                "code": c,
                "name": zones.get(c, {}).get("name", ""),
                "kana": zones.get(c, {}).get("kana", ""),
                "lat": round(float(arr[:, 0].mean()), 4),
                "lon": round(float(arr[:, 1].mean()), 4),
                "anchor": anchors[c]["p"],
                "coast": pts,
            }
        )

    total = sum(len(z["coast"]) for z in out_zones)
    print(f"  予報区 {len(out_zones)} 区 / 沿岸点 {total} / 未割当 {orphan}")
    path = OUT / "tsunami_zones.json"
    path.write_text(
        json.dumps({"zones": out_zones}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"出力: {path.name}  {path.stat().st_size / 1024:.1f} KB")

    print("\n沿岸点数 上位/下位:")
    order = sorted(out_zones, key=lambda z: -len(z["coast"]))
    for z in order[:5] + order[-5:]:
        print(f"  {z['code']} {z['name']:20s} {len(z['coast']):5d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
