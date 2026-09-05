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
    "data/subdivisions.json",
]


def downsample(mask_payload: dict, subdiv_payload: dict, factor: int) -> tuple[dict, dict]:
    """陸域マスクと細分区域を同じ倍率で粗くする.

    細分区域の配列は陸域セルの並びに対応しているため、マスクだけを粗くすると
    対応がずれて塗り分けが壊れる。両方をまとめて粗くする。
    粗いセルは、含まれる細かいセルのいずれかが陸なら陸とし、区域は
    その中で最も多いものを採る。
    """
    if factor <= 1:
        return mask_payload, subdiv_payload

    n_lat, n_lon = mask_payload["n_lat"], mask_payload["n_lon"]
    bits = np.frombuffer(base64.b64decode(mask_payload["bits"]), dtype=np.uint8)
    mask = np.unpackbits(bits)[: n_lat * n_lon].reshape(n_lat, n_lon).astype(bool)

    cells = np.frombuffer(base64.b64decode(subdiv_payload["cells"]), dtype=np.uint8)
    n_area = len(subdiv_payload["codes"])

    # 陸域セルの並びを、格子全体の区域番号 (255 = 海) に戻す
    grid = np.full(n_lat * n_lon, 255, dtype=np.uint8)
    grid[mask.ravel()] = cells
    grid = grid.reshape(n_lat, n_lon)

    new_lat, new_lon = n_lat // factor, n_lon // factor
    trimmed = grid[: new_lat * factor, : new_lon * factor]
    blocks = trimmed.reshape(new_lat, factor, new_lon, factor).transpose(0, 2, 1, 3)
    blocks = blocks.reshape(new_lat, new_lon, factor * factor)

    coarse_mask = (blocks != 255).any(axis=2)
    # 各粗いセルで最も多く現れる区域番号を採る
    counts = np.zeros((new_lat, new_lon, n_area + 1), dtype=np.uint8)
    for k in range(blocks.shape[2]):
        v = blocks[:, :, k].astype(np.int16)
        idx = np.where(v == 255, n_area, v)
        np.add.at(counts, (np.arange(new_lat)[:, None], np.arange(new_lon)[None, :], idx), 1)
    counts[:, :, n_area] = 0            # 海は候補から外す
    coarse_area = counts.argmax(axis=2).astype(np.uint8)

    out_mask = dict(mask_payload)
    out_mask["n_lat"] = new_lat
    out_mask["n_lon"] = new_lon
    out_mask["step"] = mask_payload["step"] * factor
    out_mask["lat_max"] = mask_payload["lat_min"] + new_lat * out_mask["step"]
    out_mask["lon_max"] = mask_payload["lon_min"] + new_lon * out_mask["step"]
    out_mask["bits"] = base64.b64encode(np.packbits(coarse_mask.ravel()).tobytes()).decode("ascii")

    out_sub = dict(subdiv_payload)
    out_sub["cells"] = base64.b64encode(
        coarse_area[coarse_mask].tobytes()
    ).decode("ascii")
    return out_mask, out_sub


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
        bundle[rel] = json.loads((WEB / rel).read_text(encoding="utf-8"))
    bundle["data/landmask.json"], bundle["data/subdivisions.json"] = downsample(
        bundle["data/landmask.json"], bundle["data/subdivisions.json"], args.landmask_factor
    )

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
