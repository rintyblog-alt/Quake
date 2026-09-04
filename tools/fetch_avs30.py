#!/usr/bin/env python3
"""J-SHIS 表層地盤データから各観測点の AVS30・微地形区分を取得する.

防災科学技術研究所 J-SHIS の表層地盤 Web API (250m メッシュ) に問い合わせ、
気象庁震度観測点それぞれの

* AVS30  : 地表 30m の平均 S 波速度 [m/s]
* ARV    : 工学的基盤 (Vs=400m/s) に対する速度増幅率
* JNAME  : 微地形区分名 (例: 干拓地、扇状地、ローム台地)

を収集して JSON に保存する。取得済みの結果はキャッシュされ、再実行時は
未取得の地点のみを取りに行く。
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = "https://www.j-shis.bosai.go.jp/map/api/sstrct/V3/meshinfo.geojson"
ROOT = Path(__file__).resolve().parent.parent

_lock = threading.Lock()
_done = 0


def fetch_one(lat: float, lon: float, retries: int = 3) -> dict | None:
    url = f"{API}?position={lon:.5f},{lat:.5f}&epsg=4326"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "seismic-sim/1.0"})
            with urllib.request.urlopen(req, timeout=30) as res:
                data = json.loads(res.read().decode("utf-8"))
            feats = data.get("features") or []
            if not feats:
                return None
            props = feats[0].get("properties", {})
            return {
                "avs30": float(props["AVS"]),
                "arv": float(props["ARV"]),
                "geomorph": props.get("JNAME", ""),
                "geomorph_code": props.get("JCODE", ""),
                "meshcode": props.get("meshcode", ""),
            }
        except (urllib.error.URLError, TimeoutError, KeyError, ValueError, json.JSONDecodeError):
            if attempt == retries - 1:
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stations", default=str(ROOT / "data/raw/jma_stations.json"))
    ap.add_argument("--out", default=str(ROOT / "data/raw/avs30_cache.json"))
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0, help="先頭 N 点のみ (試験用)")
    args = ap.parse_args()

    stations = json.loads(Path(args.stations).read_text(encoding="utf-8"))
    if args.limit:
        stations = stations[: args.limit]

    out_path = Path(args.out)
    cache: dict[str, dict] = {}
    if out_path.exists():
        cache = json.loads(out_path.read_text(encoding="utf-8"))

    todo = []
    for st in stations:
        key = f"{float(st['lat']):.4f},{float(st['lon']):.4f}"
        if key not in cache:
            todo.append((key, float(st["lat"]), float(st["lon"])))

    print(f"観測点 {len(stations)} 点 / 取得済み {len(cache)} 点 / 今回取得 {len(todo)} 点", flush=True)
    if not todo:
        return 0

    total = len(todo)
    global _done

    def work(item):
        global _done
        key, lat, lon = item
        res = fetch_one(lat, lon)
        with _lock:
            if res is not None:
                cache[key] = res
            _done += 1
            if _done % 100 == 0 or _done == total:
                print(f"  {_done}/{total} 取得 ({len(cache)} 件保持)", flush=True)
                out_path.write_text(
                    json.dumps(cache, ensure_ascii=False), encoding="utf-8"
                )

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(work, todo))

    out_path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    print(f"完了: {len(cache)} 点を {out_path} に保存", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
