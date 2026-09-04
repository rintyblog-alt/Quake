#!/usr/bin/env python3
"""Web アプリを単一の HTML ファイルにまとめる.

CSS・JavaScript・データファイルをすべて 1 枚の HTML に埋め込み、
サーバーを立てずにブラウザで開けるビルドを作る。

データが大きいため、既定では陸域マスクを間引き、シナリオは指定した
ものだけを含める。
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

BASE_DATA = [
    "data/stations.json",
    "data/japan.geojson",
    "data/regions.json",
    "data/traveltime.json",
    "data/tsunami_zones.json",
    "data/landmask.json",
]


def downsample_landmask(payload: dict, factor: int) -> dict:
    """陸域マスクを factor 倍に粗くする (どれかのセルが陸なら陸とみなす)。"""
    if factor <= 1:
        return payload
    n_lat, n_lon = payload["n_lat"], payload["n_lon"]
    bits = np.frombuffer(base64.b64decode(payload["bits"]), dtype=np.uint8)
    mask = np.unpackbits(bits)[: n_lat * n_lon].reshape(n_lat, n_lon).astype(bool)

    new_lat = n_lat // factor
    new_lon = n_lon // factor
    trimmed = mask[: new_lat * factor, : new_lon * factor]
    coarse = trimmed.reshape(new_lat, factor, new_lon, factor).any(axis=(1, 3))

    out = dict(payload)
    out["n_lat"] = new_lat
    out["n_lon"] = new_lon
    out["step"] = payload["step"] * factor
    out["lat_max"] = payload["lat_min"] + new_lat * out["step"]
    out["lon_max"] = payload["lon_min"] + new_lon * out["step"]
    out["bits"] = base64.b64encode(np.packbits(coarse.ravel()).tobytes()).decode("ascii")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(ROOT / "dist" / "seismic-sim.html"))
    ap.add_argument("--landmask-factor", type=int, default=2,
                    help="陸域マスクを何倍粗くするか (1 で原寸)")
    ap.add_argument("--scenarios", nargs="*", default=["tokyo_bay_north"],
                    help="埋め込むシナリオ名 (拡張子なし)。none で無し")
    ap.add_argument("--fragment", action="store_true",
                    help="html/head/body を外し、埋め込み用の断片として出力する")
    args = ap.parse_args()

    html = (WEB / "index.html").read_text(encoding="utf-8")

    # CSS を差し込む
    css = (WEB / "css" / "style.css").read_text(encoding="utf-8")
    html = html.replace('<link rel="stylesheet" href="css/style.css">',
                        "<style>\n" + css + "\n</style>")

    # データを埋め込む
    bundle: dict[str, object] = {}
    for rel in BASE_DATA:
        payload = json.loads((WEB / rel).read_text(encoding="utf-8"))
        if rel.endswith("landmask.json"):
            payload = downsample_landmask(payload, args.landmask_factor)
        bundle[rel] = payload

    names = [s for s in args.scenarios if s and s != "none"]
    index_path = WEB / "data" / "scenarios" / "index.json"
    entries = []
    if index_path.exists() and names:
        all_entries = json.loads(index_path.read_text(encoding="utf-8"))["scenarios"]
        for name in names:
            f = WEB / "data" / "scenarios" / f"{name}.json"
            if not f.exists():
                print(f"  [警告] シナリオが見つかりません: {name}")
                continue
            bundle[f"data/scenarios/{name}.json"] = json.loads(f.read_text(encoding="utf-8"))
            for e in all_entries:
                if e["file"] == f"{name}.json":
                    entries.append(e)
    # 一覧は規模の大きい順に揃える (run_scenario.py / rebuild_index.py と同じ)
    entries.sort(key=lambda e: -e["magnitude"])
    bundle["data/scenarios/index.json"] = {"scenarios": entries}

    data_js = "window.__BUNDLED_DATA = " + json.dumps(bundle, ensure_ascii=False, separators=(",", ":")) + ";"

    # JavaScript を順に差し込む
    scripts = re.findall(r'<script src="(js/[^"]+)"></script>', html)
    parts = ["<script>\n" + data_js + "\n</script>"]
    for rel in scripts:
        parts.append("<script>\n" + (WEB / rel).read_text(encoding="utf-8") + "\n</script>")
    for rel in scripts:
        html = html.replace(f'<script src="{rel}"></script>', "")
    html = html.replace("</body>", "\n".join(parts) + "\n</body>")

    if args.fragment:
        # <title> と <style> を残し、外側の html/head/body を取り除く
        title = re.search(r"<title>.*?</title>", html, re.S)
        style = re.search(r"<style>.*?</style>", html, re.S)
        body = re.search(r"<body>(.*)</body>", html, re.S)
        if not (title and style and body):
            raise RuntimeError("断片の切り出しに失敗しました")
        html = title.group(0) + "\n" + style.group(0) + "\n" + body.group(1)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    size = out.stat().st_size / 1024 / 1024
    print(f"出力: {out}  {size:.2f} MB")
    print(f"  データ {len(bundle)} 件 / シナリオ {len(entries)} 件 / "
          f"陸域マスク 1/{args.landmask_factor}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
