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
    "data/bathymetry.json",
]

# 画像はそのままでは JSON に入らないので data URI にして埋め込む
BASE_IMAGES = [("data/bathymetry.jpg", "image/jpeg")]


def thin_timeline(payload: dict, stride: int) -> None:
    """リアルタイム震度の時系列を間引く.

    観測点数 x 時刻数の配列がバンドルの大半を占める。表示側は時刻を指定して
    前後のコマを線形に補間して読むので、間引いても動きは滑らかなまま軽くできる。
    """
    if stride <= 1:
        return
    st = payload["stations"]
    ns, nt = st["count"], payload["timeline"]["count"]
    rt = np.frombuffer(base64.b64decode(st["realtime"]), dtype=np.int8).reshape(ns, nt)
    keep = list(range(0, nt, stride))
    if keep[-1] != nt - 1:
        keep.append(nt - 1)          # 最後のコマは必ず残す
    thinned = np.ascontiguousarray(rt[:, keep])
    st["realtime"] = base64.b64encode(thinned.tobytes()).decode("ascii")
    payload["timeline"]["count"] = len(keep)
    payload["timeline"]["dt"] = payload["timeline"]["dt"] * stride


def embed_sounds(bundle: dict) -> None:
    """差し替え音源を data URI で埋め込む.

    音源は権利の都合でリポジトリに入れていない (web/sounds/README.md)。
    手元で単一 HTML として持ち歩きたいときだけ --sounds を付けて埋める。
    """
    manifest_path = WEB / "sounds" / "manifest.json"
    if not manifest_path.exists():
        print("  [警告] web/sounds/manifest.json が無いので音源は埋め込みません")
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    bundle["sounds/manifest.json"] = manifest
    n = 0
    for slot, name in manifest.items():
        path = WEB / "sounds" / name
        if not path.exists():
            print(f"  [警告] {slot}: {name} が見つかりません")
            continue
        mime = MIME.get(path.suffix.lower(), "audio/mpeg")
        raw = path.read_bytes()
        bundle["sounds/" + name] = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")
        n += 1
    print(f"  音源 {n} 件を埋め込みました")


MIME = {".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4"}


def embed_voice(bundle: dict) -> None:
    """読み上げ音声 (tools/generate_voice.py) を data URI で埋め込む.

    同じ読み上げ文は 1 ファイルを共有しているので、対応表に出てくる
    ファイル名を重複なく拾う。
    """
    voice_dir = WEB / "sounds" / "voice"
    index_path = voice_dir / "index.json"
    if not index_path.exists():
        print("  [警告] web/sounds/voice/index.json が無いので読み上げ音声は埋め込みません")
        return
    index = json.loads(index_path.read_text(encoding="utf-8"))
    bundle["sounds/voice/index.json"] = index

    total = 0
    for name in sorted({c["file"] for c in index.get("clips", {}).values()}):
        path = voice_dir / name
        if not path.exists():
            print(f"  [警告] 読み上げ音声が見つかりません: {name}")
            continue
        raw = path.read_bytes()
        mime = MIME.get(path.suffix.lower(), "audio/mpeg")
        bundle["sounds/voice/" + name] = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")
        total += len(raw)
    print(f"  読み上げ音声 {len(index.get('clips', {}))} 語 "
          f"/ {len(set(c['file'] for c in index.get('clips', {}).values()))} ファイル "
          f"({total / 1024 / 1024:.2f} MB) を埋め込みました")


def downsample(mask_payload: dict, factor: int) -> dict:
    """陸域マスクを粗くする.

    粗いセルは、含まれる細かいセルのいずれかが陸なら陸とする。
    陸域マスクは震央地名の判定と津波の遮蔽判定に使うだけなので、
    多少粗くても実用上は差し支えない。
    """
    if factor <= 1:
        return mask_payload

    n_lat, n_lon = mask_payload["n_lat"], mask_payload["n_lon"]
    bits = np.frombuffer(base64.b64decode(mask_payload["bits"]), dtype=np.uint8)
    mask = np.unpackbits(bits)[: n_lat * n_lon].reshape(n_lat, n_lon).astype(bool)

    new_lat, new_lon = n_lat // factor, n_lon // factor
    trimmed = mask[: new_lat * factor, : new_lon * factor]
    coarse = trimmed.reshape(new_lat, factor, new_lon, factor).any(axis=(1, 3))

    out = dict(mask_payload)
    out["n_lat"] = new_lat
    out["n_lon"] = new_lon
    out["step"] = mask_payload["step"] * factor
    out["lat_max"] = mask_payload["lat_min"] + new_lat * out["step"]
    out["lon_max"] = mask_payload["lon_min"] + new_lon * out["step"]
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
    ap.add_argument("--timeline-stride", type=int, default=1,
                    help="リアルタイム震度の時系列を何コマに 1 つへ間引くか "
                         "(表示は補間するので滑らかなまま。バンドルを軽くするため)")
    ap.add_argument("--sounds", action="store_true",
                    help="web/sounds/ の差し替え音源も埋め込む (手元で使う分だけ)")
    ap.add_argument("--voice", action="store_true",
                    help="web/sounds/voice/ の読み上げ音声も埋め込む")
    args = ap.parse_args()

    html = (WEB / "index.html").read_text(encoding="utf-8")

    # CSS を差し込む（テロップの書体も中に持たせる）
    for name in ("telop-font.css", "style.css"):
        css = (WEB / "css" / name).read_text(encoding="utf-8")
        tag = '<link rel="stylesheet" href="css/%s">' % name
        if tag not in html:
            raise SystemExit("index.html に %s の読み込みがありません" % name)
        html = html.replace(tag, "<style>\n" + css + "\n</style>")

    # データを埋め込む
    bundle: dict[str, object] = {}
    for rel in BASE_DATA:
        bundle[rel] = json.loads((WEB / rel).read_text(encoding="utf-8"))
    for rel, mime in BASE_IMAGES:
        raw = (WEB / rel).read_bytes()
        bundle[rel] = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")
    bundle["data/landmask.json"] = downsample(
        bundle["data/landmask.json"], args.landmask_factor
    )

    if args.sounds:
        embed_sounds(bundle)
    if args.voice:
        embed_voice(bundle)

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
            payload = json.loads(f.read_text(encoding="utf-8"))
            thin_timeline(payload, args.timeline_stride)
            bundle[f"data/scenarios/{name}.json"] = payload
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
