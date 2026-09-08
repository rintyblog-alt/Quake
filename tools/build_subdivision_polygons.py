#!/usr/bin/env python3
"""気象庁の細分区域のポリゴンを市区町村界から組み立てる.

震度速報は細分区域 (宮城県北部・宮城県南部など) の単位で発表される。
区域のポリゴンそのものは公開されていないが、区域がどの市区町村から
できているかは電文コード表に載っている。市区町村界を区域ごとに融合すれば、
海岸線も内陸の境も実際の縁どおりのポリゴンが得られる。

    細分区域 = その区域に属する市区町村の和

市区町村界は「歴史的行政区域データセットβ版」(CODH) の TopoJSON を使う。
もとは国土数値情報の行政区域データ。

TopoJSON の弧は隣り合う市区町村で共有されているため、弧の段階で間引けば
融合したあとも境界がずれない (ポリゴンごとに間引くと隙間ができる)。

電文コード表に載っていない市区町村 (市町村合併や区の再編でコードが変わった直後
など) は、代表点にいちばん近い震度観測点が属する区域に入れる。地図のほうは
対応表と関わりなく全市区町村から作るので、コード表の年次がずれても欠けない。

同じ市区町村界を都道府県ごとに融合して web/data/japan.geojson も書き出す。
地図の陸と震度の塗りつぶしを別々の出典から作ると海岸線がわずかにずれ、
塗りの縁に地の色がはみ出して見えるため、両方を同じ形から作る。
prepare_data.py も japan.geojson を書くので、このツールを後に実行すること
(tools/build_all.py がその順で並べている)。
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import openpyxl
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry import LineString
from scipy.spatial import cKDTree
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CITY_DIR = RAW / "city_topojson"
JMA_ZIP = RAW / "jmacode.zip"
OUT = ROOT / "web" / "data" / "subdivisions.json"
OUT_MAP = ROOT / "web" / "data" / "japan.geojson"

CITY_URL = "https://geoshape.ex.nii.ac.jp/city/topojson/{date}/{pref:02d}/{pref:02d}_city.i.topojson"
CITY_DATE = "20230101"

SIMPLIFY_DEG = 0.0006  # 弧の間引き (約 50 m)
QUANT = 100000.0  # 座標の量子化 (1e-5 度 = 約 1 m)
MIN_AREA_DEG2 = 8e-6  # これより小さい島は落とす (約 0.08 km^2)


def fetch_cities(pref: int, retries: int = 5) -> dict:
    """都道府県ごとの市区町村界を取る (取得済みなら使い回す)。"""
    CITY_DIR.mkdir(parents=True, exist_ok=True)
    path = CITY_DIR / f"{pref:02d}.topojson"
    if not path.exists():
        url = CITY_URL.format(date=CITY_DATE, pref=pref)
        req = urllib.request.Request(url, headers={"User-Agent": "seismic-sim/1.0"})
        for attempt in range(retries):
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    path.write_bytes(r.read())
                break
            except Exception as e:  # 接続断はよく起きるので待って繰り返す
                if attempt == retries - 1:
                    raise
                wait = 2 ** attempt
                print(f"  {pref:02d}: 取得失敗 ({e}) — {wait}s 後に再試行", flush=True)
                time.sleep(wait)
    return json.loads(path.read_text(encoding="utf-8"))


def decode_arcs(topo: dict, tolerance: float) -> list[list[tuple[float, float]]]:
    """量子化された弧を経度緯度に戻し、弧の単位で間引く。"""
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    out = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        if tolerance > 0 and len(pts) > 2:
            simp = LineString(pts).simplify(tolerance, preserve_topology=False)
            pts = list(simp.coords)
        out.append(pts)
    return out


def ring(arcs: list, idxs: list[int]) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for i in idxs:
        seg = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(seg if not pts else seg[1:])
    return pts


def to_polygon(arcs: list, geom: dict):
    def build(rings: list) -> Polygon | None:
        shell = ring(arcs, rings[0])
        if len(shell) < 4:
            return None
        holes = [h for h in (ring(arcs, r) for r in rings[1:]) if len(h) >= 4]
        try:
            return Polygon(shell, holes)
        except Exception:
            return None

    if geom["type"] == "Polygon":
        p = build(geom["arcs"])
        return p
    if geom["type"] == "MultiPolygon":
        parts = [p for p in (build(r) for r in geom["arcs"]) if p is not None]
        return MultiPolygon([p for p in parts if not p.is_empty]) if parts else None
    return None


def city_to_area() -> dict[str, str]:
    """市区町村コード (JIS 5 桁) -> 細分区域コード。"""
    with zipfile.ZipFile(JMA_ZIP) as z:
        name = next(n for n in z.namelist() if n.startswith("地震火山関連コード表"))
        wb = openpyxl.load_workbook(io.BytesIO(z.read(name)), read_only=True)
    ws = wb["24"]
    out: dict[str, str] = {}
    for row in ws.iter_rows(min_row=4, values_only=True):
        area, city = row[0], row[3]
        if area is None or city is None:
            continue
        out[str(city).zfill(7)[:5]] = str(area)
    return out


def encode_ring(coords) -> list[int]:
    """[x0,y0, dx1,dy1, ...] の整数列にする (量子化 + 差分)。"""
    out: list[int] = []
    px = py = 0
    for i, (lon, lat) in enumerate(coords):
        x = int(round(lon * QUANT))
        y = int(round(lat * QUANT))
        if i == 0:
            out.extend((x, y))
        else:
            if x == px and y == py:
                continue
            out.extend((x - px, y - py))
        px, py = x, y
    return out


def big_parts(geom, min_area: float):
    """小さすぎる島を落とす (地図と塗りつぶしで同じ基準を使う)。"""
    polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    kept = [p for p in polys if not p.is_empty and p.area >= min_area]
    return kept or polys[:1]


def rings_of(geom, min_area: float = MIN_AREA_DEG2) -> list[list]:
    polys = big_parts(geom, min_area)
    out = []
    for p in polys:
        if p.is_empty:
            continue
        out.append(encode_ring(p.exterior.coords))
        for h in p.interiors:
            out.append(encode_ring(h.coords))
    return out


PREF_NAME: dict[int, str] = {}


def write_prefectures(by_pref: dict[int, list]) -> None:
    """同じ市区町村界を都道府県ごとに融合して地図用の GeoJSON にする。"""
    feats = []
    total = 0
    for pref in sorted(by_pref):
        merged = unary_union(by_pref[pref])
        polys = big_parts(merged, MIN_AREA_DEG2)
        coords = []
        for poly in polys:
            if poly.is_empty:
                continue
            rings = [[[round(x, 5), round(y, 5)] for x, y in poly.exterior.coords]]
            for h in poly.interiors:
                rings.append([[round(x, 5), round(y, 5)] for x, y in h.coords])
            coords.append(rings)
            total += sum(len(r) for r in rings)
        feats.append({
            "type": "Feature",
            "properties": {"name": PREF_NAME.get(pref, ""), "id": pref},
            "geometry": {"type": "MultiPolygon", "coordinates": coords},
        })
    OUT_MAP.write_text(
        json.dumps({"type": "FeatureCollection", "features": feats},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"都道府県界 {len(feats)} 件、頂点 {total} 個 -> {OUT_MAP} "
          f"({OUT_MAP.stat().st_size / 1e6:.2f} MB)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--simplify", type=float, default=SIMPLIFY_DEG)
    args = ap.parse_args()

    stations = json.loads((OUT.parent / "stations.json").read_text(encoding="utf-8"))
    names: dict[str, str] = stations["subareaNames"]
    codes = sorted(names)
    index_of = {c: i for i, c in enumerate(codes)}
    mapping = city_to_area()
    print(f"細分区域 {len(codes)} 件 / 市区町村の対応 {len(mapping)} 件")

    # 対応表に無い市区町村を拾うための最近傍検索 (震度観測点 -> 細分区域)
    st_lat = np.array(stations["lat"], dtype=float)
    st_lon = np.array(stations["lon"], dtype=float)
    st_area = list(stations["subarea"])
    keep = [i for i, c in enumerate(st_area) if c in index_of]
    scale = float(np.cos(np.radians(np.median(st_lat))))
    tree = cKDTree(np.column_stack([st_lat[keep], st_lon[keep] * scale]))
    keep_area = [st_area[i] for i in keep]

    def nearest_area(poly) -> str:
        pt = poly.representative_point()
        _, j = tree.query([pt.y, pt.x * scale], k=1)
        return keep_area[int(j)]

    by_area: dict[str, list] = {}
    by_pref: dict[int, list] = {}
    guessed: list[str] = []
    n_city = 0
    for pref in range(1, 48):
        topo = fetch_cities(pref)
        arcs = decode_arcs(topo, args.simplify)
        for geom in topo["objects"]["city"]["geometries"]:
            PREF_NAME.setdefault(pref, geom["properties"].get("N03_001") or "")
            poly = to_polygon(arcs, geom)
            if poly is None or poly.is_empty:
                continue
            if not poly.is_valid:
                poly = poly.buffer(0)
                if poly.is_empty:
                    continue
            # 地図は対応表と関わりなく作る (コード表の年次がずれても欠けない)
            by_pref.setdefault(pref, []).append(poly)
            n_city += 1

            jis = str(geom["properties"].get("N03_007") or "")
            area = mapping.get(jis)
            if area not in index_of:
                area = nearest_area(poly)
                guessed.append(f"{geom['properties'].get('N03_001')}{geom['properties'].get('N03_004')}"
                               f" -> {names[area]}")
            by_area.setdefault(area, []).append(poly)
        print(f"  {pref:02d}: 市区町村 {len(topo['objects']['city']['geometries'])} 件", flush=True)

    print(f"取り込んだ市区町村 {n_city} 件 / 最近傍で補ったもの {len(guessed)} 件")
    for g in guessed:
        print(f"    {g}")

    polygons: dict[str, list] = {}
    centroids: list[list[float]] = []
    total_pts = 0
    merged_by_area = {}
    for area, parts in by_area.items():
        merged = unary_union(parts)
        if merged.is_empty:
            continue
        merged_by_area[area] = merged
        rings = rings_of(merged)
        polygons[area] = rings
        total_pts += sum(len(r) // 2 for r in rings)

    # 震度バッジを置く代表点。飛び地があるので最も広いまとまりの中に取る。
    for c in codes:
        g = merged_by_area.get(c)
        if g is None:
            centroids.append([0.0, 0.0])
            continue
        polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
        biggest = max(polys, key=lambda q: q.area)
        pt = biggest.representative_point()
        centroids.append([round(pt.y, 4), round(pt.x, 4)])

    write_prefectures(by_pref)

    have = [c for c in codes if c in polygons]
    print(f"ポリゴンができた区域 {len(have)} / {len(codes)} 件、頂点 {total_pts} 個")
    for c in codes:
        if c not in polygons:
            print(f"  [警告] ポリゴンなし: {c} {names[c]}")

    payload = {
        "codes": codes,
        "names": [names[c] for c in codes],
        "centroids": centroids,
        "quant": QUANT,
        "polygons": polygons,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"-> {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
