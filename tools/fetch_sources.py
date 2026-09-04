#!/usr/bin/env python3
"""公開されている生データを取得する.

取得先:
  * 気象庁 震度観測点          stations.json (緯度経度つき)
  * 気象庁 電文コード表        震央地名・細分区域・津波予報区
  * 都道府県界 GeoJSON         dataofjapan/land

いずれも再取得可能なため、リポジトリには含めていない。
AVS30 (J-SHIS) は点数が多く時間がかかるため tools/fetch_avs30.py で別途取得する。
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"

SOURCES = [
    (
        "jma_stations.json",
        "https://www.jma.go.jp/jma/kishou/know/jishin/intens-st/stations.json",
        "気象庁 震度観測点",
    ),
    (
        "jmacode.zip",
        "https://xml.kishou.go.jp/jmaxml_20260826_Code.zip",
        "気象庁 電文コード表 (震央地名・津波予報区)",
    ),
    (
        "japan.geojson",
        "https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson",
        "都道府県界 GeoJSON",
    ),
]


def fetch(name: str, url: str, label: str) -> bool:
    dest = RAW / name
    if dest.exists():
        print(f"  済: {label} ({name}, {dest.stat().st_size / 1024:.0f} KB)")
        return True
    print(f"  取得中: {label} …", flush=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "seismic-sim/1.0"})
        with urllib.request.urlopen(req, timeout=180) as res:
            data = res.read()
    except Exception as e:  # noqa: BLE001 - 失敗理由をそのまま表示する
        print(f"  失敗: {label} — {e}")
        return False
    dest.write_bytes(data)
    print(f"  完了: {name} ({len(data) / 1024:.0f} KB)")
    return True


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    ok = True
    for name, url, label in SOURCES:
        ok &= fetch(name, url, label)
    print()
    if ok:
        print("生データが揃いました。次は tools/fetch_avs30.py、続いて tools/build_all.py を実行してください。")
    else:
        print("一部の取得に失敗しました。URL が変わっている可能性があります。")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
