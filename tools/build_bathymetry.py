#!/usr/bin/env python3
"""海底地形の陰影図を作る.

地図の海をのっぺりした一色にせず、海溝や海盆が見えるようにするための背景。
GMRT (Global Multi-Resolution Topography) の標高・水深グリッドを取得し、
Web メルカトルに投影し直して 1 枚の PNG に焼く。

ブラウザ側は経度と mercY について線形な投影を使っているので、
メルカトルで焼いておけば drawImage で貼るだけで位置が合う。

日本の陸は GeoJSON のポリゴンで上から塗るため、この画像の陸は
朝鮮半島・沿海州・中国大陸のような周辺の陸地を出すために使う。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "gmrt_japan.asc"
OUT_IMG = ROOT / "web" / "data" / "bathymetry.jpg"
OUT_META = ROOT / "web" / "data" / "bathymetry.json"

# 取得範囲。ブラウザ側のパン可能範囲 (緯度 15-50・経度 115-160) を
# ズームアウト時の見切れぶんまで含めて覆う。
BBOX = dict(west=108.0, east=168.0, south=8.0, north=58.0)
URL = (
    "https://www.gmrt.org/services/GridServer"
    "?minlongitude={west}&maxlongitude={east}"
    "&minlatitude={south}&maxlatitude={north}"
    "&format=esriascii&resolution=med"
)

# 焼き出す範囲。ブラウザ側のパン範囲 (緯度 15-50・経度 115-160) より少し広く取る。
RENDER = dict(west=112.0, east=164.0, south=12.0, north=54.0)
OUT_WIDTH = 1792
SMOOTH_PX = 1.0  # 陰影を作る前にかける平滑化 (細かすぎる起伏を落とす)

# -- 配色 ------------------------------------------------------------------
# 海: 浅いほど明るい青灰、深いほど紺。
SEA_SHALLOW = (44, 62, 92)
SEA_DEEP = (12, 19, 33)
SEA_DEPTH_SCALE = 3600.0  # この深さで SEA_DEEP に漸近する
# 周辺の陸 (朝鮮半島・沿海州・中国大陸): 日本の塗りに近い落ち着いたオリーブ灰
LAND_LOW = (56, 60, 52)
LAND_HIGH = (74, 78, 68)
LAND_ELEV_SCALE = 2200.0
# 陰影の強さ (1 を中心に上下)。陸は主役ではないので海の半分に抑える。
SHADE_STRENGTH = 0.21
LAND_SHADE_RATIO = 0.45
# 海岸線 (日本以外の陸を縁取る。日本はポリゴンで上から描くので見えない)
COAST_RGB = (198, 205, 188)
COAST_ALPHA = 0.5
JPEG_QUALITY = 88
MAX_LAT = 85.05112878


def merc_y(lat: np.ndarray | float) -> np.ndarray | float:
    r = np.radians(np.clip(lat, -MAX_LAT, MAX_LAT))
    return np.log(np.tan(np.pi / 4 + r / 2))


def inv_merc_y(y: np.ndarray) -> np.ndarray:
    return np.degrees(2.0 * np.arctan(np.exp(y)) - np.pi / 2)


def fetch(dest: Path) -> None:
    url = URL.format(**BBOX)
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"取得中: {url}")
    with urllib.request.urlopen(url, timeout=600) as r, dest.open("wb") as f:
        f.write(r.read())
    print(f"  -> {dest} ({dest.stat().st_size / 1e6:.1f} MB)")


def read_esri_ascii(path: Path) -> tuple[np.ndarray, dict]:
    """ESRI ASCII グリッドを (値, ヘッダ) で返す。行は北から南の順。"""
    head: dict[str, float] = {}
    with path.open("r", encoding="ascii") as f:
        for _ in range(6):
            key, val = f.readline().split()
            head[key.lower()] = float(val)
        z = np.loadtxt(f, dtype=np.float32)
    n_rows, n_cols = int(head["nrows"]), int(head["ncols"])
    z = z.reshape(n_rows, n_cols)
    z[z == head["nodata_value"]] = np.nan
    return z, head


def to_mercator(z: np.ndarray, head: dict, width: int) -> tuple[np.ndarray, dict]:
    """緯度経度等間隔のグリッドを Web メルカトルに貼り直す。"""
    n_rows, n_cols = z.shape
    cell = head["cellsize"]
    src_lon0 = head["xllcorner"]
    src_lat0 = head["yllcorner"]
    src_lat1 = src_lat0 + n_rows * cell

    lon0, lon1 = RENDER["west"], RENDER["east"]
    lat0, lat1 = RENDER["south"], RENDER["north"]
    y0, y1 = merc_y(lat0), merc_y(lat1)
    height = int(round(width * (y1 - y0) / math.radians(lon1 - lon0)))

    # 出力画素の中心が指す緯度を求め、元グリッドの行を線形補間で拾う
    ys = y1 - (np.arange(height) + 0.5) * (y1 - y0) / height
    lats = inv_merc_y(ys)
    src_row = (src_lat1 - lats) / cell - 0.5  # 0 が最北の行の中心
    r0 = np.clip(np.floor(src_row).astype(int), 0, n_rows - 1)
    r1 = np.clip(r0 + 1, 0, n_rows - 1)
    wr = (src_row - r0)[:, None]

    lons = lon0 + (np.arange(width) + 0.5) * (lon1 - lon0) / width
    src_col = (lons - src_lon0) / cell - 0.5
    c0 = np.clip(np.floor(src_col).astype(int), 0, n_cols - 1)
    c1 = np.clip(c0 + 1, 0, n_cols - 1)
    wc = src_col - c0

    top = z[r0][:, c0] * (1 - wc) + z[r0][:, c1] * wc
    bot = z[r1][:, c0] * (1 - wc) + z[r1][:, c1] * wc
    out = top * (1 - wr) + bot * wr
    meta = {
        "west": lon0, "east": lon1, "south": lat0, "north": lat1,
        "width": width, "height": height,
    }
    return out.astype(np.float32), meta


def smooth(z: np.ndarray, sigma: float) -> np.ndarray:
    """分離型ガウシアンで軽くぼかす (細かい起伏を落とし、圧縮も効かせる)。"""
    if sigma <= 0:
        return z
    n = max(int(sigma * 3), 1)
    k = np.exp(-0.5 * (np.arange(-n, n + 1) / sigma) ** 2)
    k /= k.sum()
    out = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 1, np.nan_to_num(z))
    return np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 0, out)


def hillshade(z: np.ndarray, exaggeration: float = 1.0) -> np.ndarray:
    """北西からの光による陰影 (0-1 の係数、平坦で 0.5)。"""
    gy, gx = np.gradient(np.nan_to_num(z))
    slope = (gx - gy) * exaggeration
    # 傾きを穏やかに 0-1 に押し込める
    return 0.5 + 0.5 * np.tanh(slope / 60.0)


def colourise(z: np.ndarray) -> np.ndarray:
    h, w = z.shape
    rgb = np.zeros((h, w, 3), dtype=np.float32)
    zz = np.nan_to_num(z, nan=-4000.0)

    sea = zz <= 0
    # 深さ方向は指数で潰し、大陸棚の細かい起伏も見えるようにする
    t = 1.0 - np.exp(zz[sea] / SEA_DEPTH_SCALE)  # 0 (岸) -> 1 (深海)
    for k in range(3):
        rgb[..., k][sea] = SEA_SHALLOW[k] + (SEA_DEEP[k] - SEA_SHALLOW[k]) * t

    land = ~sea
    u = np.clip(zz[land] / LAND_ELEV_SCALE, 0.0, 1.0) ** 0.6
    for k in range(3):
        rgb[..., k][land] = LAND_LOW[k] + (LAND_HIGH[k] - LAND_LOW[k]) * u

    rel = 2.0 * hillshade(z) - 1.0
    strength = np.where(sea, SHADE_STRENGTH, SHADE_STRENGTH * LAND_SHADE_RATIO)
    rgb *= (1.0 + strength * rel)[..., None]

    # 陸と海の境目を明るい線でなぞる
    edge = np.zeros(sea.shape, dtype=bool)
    edge[:, :-1] |= sea[:, :-1] != sea[:, 1:]
    edge[:-1, :] |= sea[:-1, :] != sea[1:, :]
    for k in range(3):
        ch = rgb[..., k]
        ch[edge] = ch[edge] * (1.0 - COAST_ALPHA) + COAST_RGB[k] * COAST_ALPHA
    return np.clip(rgb, 0, 255).astype(np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fetch", action="store_true", help="GMRT から取得し直す")
    ap.add_argument("--width", type=int, default=OUT_WIDTH)
    args = ap.parse_args()

    if args.fetch or not RAW.exists():
        fetch(RAW)

    print(f"読み込み: {RAW}")
    z, head = read_esri_ascii(RAW)
    print(f"  {int(head['nrows'])} x {int(head['ncols'])} 点, {head['cellsize']:.4f} deg")

    merc, meta = to_mercator(z, head, args.width)
    print(f"メルカトルへ投影: {meta['width']} x {meta['height']}")

    merc = smooth(merc, SMOOTH_PX)
    rgb = colourise(merc)
    img = Image.fromarray(rgb, "RGB")
    OUT_IMG.parent.mkdir(parents=True, exist_ok=True)
    # なだらかな画像なので JPEG がよく効く (PNG の 1/5 の大きさで見た目は変わらない)
    img.save(OUT_IMG, quality=JPEG_QUALITY, subsampling=0, optimize=True)
    OUT_META.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    print(f"  -> {OUT_IMG} ({OUT_IMG.stat().st_size / 1e6:.2f} MB)")
    print(f"  -> {OUT_META}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
