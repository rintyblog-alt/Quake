#!/usr/bin/env python3
"""海底地震計 (S-net・DONET 相当) を観測点一覧に足す.

太平洋側の海底には、日本海溝海底地震津波観測網 S-net (150 点) と、
南海トラフ海底地震津波観測網 DONET (51 点) が敷かれている。地震情報の
地図でも、陸の観測点と同じように海の上に反応が出る。

実際のケーブル配置の座標は公開されていないため、ここでは海溝軸と陸棚の
外縁を結ぶ線の上に、各観測網の担当区間と点数を合わせて並べたものを作る。
配置は近似だが、点数・広がり・海溝に平行な並び方は実物に合わせてある。

    python tools/build_seafloor.py            # stations.json に足す
    python tools/build_seafloor.py --dry-run  # 並びだけ確かめる

prepare_data.py は陸の観測点だけを書き出すので、その後に実行する
(tools/build_all.py の並びもそうなっている)。何度実行しても、前回足した
海底観測点は取り除いてから足し直す。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"

# 日本海溝の軸 (緯度, 経度)。北は襟裳岬沖から南は房総沖まで。
TRENCH = [
    (42.2, 145.20), (41.2, 144.70), (40.2, 144.30), (39.2, 144.10),
    (38.2, 143.90), (37.2, 143.60), (36.2, 143.30), (35.2, 142.80),
    (34.2, 142.20), (33.4, 141.60),
]

# 陸棚の外縁。海溝との間を按分して観測点を置く。陸には掛からない。
SHELF = [
    (42.2, 143.90), (41.2, 142.50), (40.2, 142.30), (39.2, 142.40),
    (38.2, 142.30), (37.2, 141.80), (36.2, 141.50), (35.2, 141.30),
    (34.2, 141.00), (33.4, 140.90),
]

# S-net の 6 系。実際は 1 系がケーブルの往復で 2 本の並びになるので、
# 海溝に向かう距離の按分 (frac) を 2 通り取る。S6 は海溝の海側。
SNET = [
    # 名前,            緯度の範囲,      1 本あたりの点数, 按分
    ("S1 房総沖",        (34.25, 36.15), 13, (0.30, 0.76)),
    ("S2 茨城・福島沖",  (36.25, 37.85), 13, (0.32, 0.78)),
    ("S3 宮城・岩手沖",  (37.95, 39.55), 13, (0.32, 0.78)),
    ("S4 三陸沖北部",    (39.65, 41.15), 13, (0.34, 0.80)),
    ("S5 釧路・青森沖",  (41.25, 42.15),  9, (0.36, 0.82)),
    ("S6 海溝外側",      (36.50, 41.50), 28, (1.22,)),
]

# DONET。熊野灘 (DONET1) と潮岬〜室戸沖 (DONET2)。
# 中心・半径・角度の範囲 (度) で円弧に並べる。
DONET = [
    ("DONET1 熊野灘", (33.60, 136.35), (0.32, 0.62), (200.0, 340.0), (10, 12)),
    ("DONET2 室戸沖", (33.45, 134.95), (0.40, 0.72), (215.0, 330.0), (14, 15)),
]

SEAFLOOR_AVS30 = 400.0     # 海底の堆積層。陸の軟弱地盤ほどではない。
SEAFLOOR_PREF = 0


def interp(line: list[tuple[float, float]], lat: float) -> float:
    """緯度から経度を線形に補間する (line は緯度の降順)。"""
    if lat >= line[0][0]:
        return line[0][1]
    if lat <= line[-1][0]:
        return line[-1][1]
    for i in range(len(line) - 1):
        a, b = line[i], line[i + 1]
        if b[0] <= lat <= a[0]:
            t = (a[0] - lat) / (a[0] - b[0])
            return a[1] + (b[1] - a[1]) * t
    return line[-1][1]


def seed_of(*parts) -> int:
    """実行のたびに変わらない種 (Python の hash() は文字列で毎回変わる)。"""
    return zlib.crc32("|".join(str(x) for x in parts).encode("utf-8")) & 0xFFFFFF


def jitter(seed: int, scale: float) -> float:
    """並びが機械的に見えないように、決まった値でわずかにずらす。"""
    x = math.sin(seed * 12.9898) * 43758.5453
    return (x - math.floor(x) - 0.5) * 2.0 * scale


def snet_points() -> list[tuple[str, float, float]]:
    out = []
    for name, (lat0, lat1), per_line, fracs in SNET:
        for li, frac in enumerate(fracs):
            for k in range(per_line):
                t = k / (per_line - 1) if per_line > 1 else 0.5
                lat = lat0 + (lat1 - lat0) * t
                lo_shelf, lo_trench = interp(SHELF, lat), interp(TRENCH, lat)
                lon = lo_shelf + (lo_trench - lo_shelf) * frac
                seed = seed_of(name, li, k)
                lat += jitter(seed, 0.05)
                lon += jitter(seed + 977, 0.07)
                out.append((f"{name.split()[0]}-{li + 1}{k + 1:02d}", round(lat, 4), round(lon, 4)))
    return out


def donet_points() -> list[tuple[str, float, float]]:
    out = []
    for name, (clat, clon), radii, (a0, a1), counts in DONET:
        tag = name.split()[0]
        for ri, (radius, count) in enumerate(zip(radii, counts)):
            for k in range(count):
                t = k / (count - 1) if count > 1 else 0.5
                ang = math.radians(a0 + (a1 - a0) * t)
                seed = seed_of(name, ri, k)
                lat = clat + radius * math.sin(ang) + jitter(seed, 0.03)
                lon = clon + radius * math.cos(ang) / math.cos(math.radians(clat)) \
                    + jitter(seed + 613, 0.04)
                out.append((f"{tag}-{ri + 1}{k + 1:02d}", round(lat, 4), round(lon, 4)))
    return out


def nearest_region(regions: list[dict], lat: float, lon: float) -> str:
    """いちばん近い海の震央地名を割り当てる (緊急地震速報の地名に使う)。

    海底の観測点なので、陸の震央地名 (「和歌山県南部」など) には寄せない。
    """
    best, best_d = "", 1e18
    for r in regions:
        if r.get("type") != "sea":
            continue
        for a in r.get("anchors") or [[r["lat"], r["lon"]]]:
            d = (a[0] - lat) ** 2 + ((a[1] - lon) * math.cos(math.radians(lat))) ** 2
            if d < best_d:
                best_d, best = d, r["code"]
    return best


def arv_from_avs30(v: float) -> float:
    return round(10 ** (1.83 - 0.66 * math.log10(min(1500.0, max(100.0, v)))), 2)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="書き込まずに並びだけ出す")
    ap.add_argument("--stations", default=str(DATA / "stations.json"))
    args = ap.parse_args()

    points = snet_points() + donet_points()
    print(f"海底観測点 {len(points)} 点 "
          f"(S-net {len(snet_points())} / DONET {len(donet_points())})")

    if args.dry_run:
        for name, lat, lon in points[:12]:
            print(f"  {name:12s} {lat:7.3f} {lon:8.3f}")
        print(f"  … 他 {len(points) - 12} 点")
        print(f"  緯度 {min(p[1] for p in points):.2f}〜{max(p[1] for p in points):.2f}"
              f" / 経度 {min(p[2] for p in points):.2f}〜{max(p[2] for p in points):.2f}")
        return 0

    path = Path(args.stations)
    s = json.loads(path.read_text(encoding="utf-8"))
    regions = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))["regions"]

    # 前回足した分を取り除いてから足し直す
    flags = s.get("seafloor") or [0] * s["count"]
    keep = [i for i in range(s["count"]) if not flags[i]]
    arrays = ["subarea", "lat", "lon", "avs30", "arv", "region", "name", "pref", "geomorph"]
    for key in arrays:
        s[key] = [s[key][i] for i in keep]
    land = len(keep)

    arv = arv_from_avs30(SEAFLOOR_AVS30)
    for name, lat, lon in points:
        s["subarea"].append("")            # 細分区域には属さない (震度速報に出さない)
        s["lat"].append(lat)
        s["lon"].append(lon)
        s["avs30"].append(SEAFLOOR_AVS30)
        s["arv"].append(arv)
        s["region"].append(nearest_region(regions, lat, lon))
        s["name"].append(name)
        s["pref"].append(SEAFLOOR_PREF)
        s["geomorph"].append("海底")
    s["count"] = land + len(points)
    s["seafloor"] = [0] * land + [1] * len(points)

    path.write_text(json.dumps(s, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  {path.name}: 陸 {land} 点 + 海底 {len(points)} 点 = {s['count']} 点")
    return 0


if __name__ == "__main__":
    sys.exit(main())
