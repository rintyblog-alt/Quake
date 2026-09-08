#!/usr/bin/env python3
"""遠地地震の震央地名を web/data/regions.json に足す.

国内の震央地名は 294 区と細かいが、日本から遠い地震について気象庁が使う
呼び方は「南米西部」「フィリピン諸島」のように大まかで、震度の区分ほどの
粒度しかない。data/world_regions.json の区分をそのまま足す。

    python tools/build_world_regions.py

prepare_data.py は国内の震央地名だけを書き出すので、その後に実行する。
何度実行しても、前に足した分は取り除いてから足し直す。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"


def main() -> int:
    src = json.loads((ROOT / "data" / "world_regions.json").read_text(encoding="utf-8"))
    path = DATA / "regions.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    kept = [r for r in payload["regions"] if r.get("type") != "world"]

    for r in src["regions"]:
        kept.append({
            "code": r["code"],
            "name": r["name"],
            "lat": r["p"][0],
            "lon": r["p"][1],
            "type": "world",
            "stations": 0,
            "anchors": [r["p"]],
        })
    payload["regions"] = kept
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    print(f"  遠地の震央地名 {len(src['regions'])} 区を足しました "
          f"(合計 {len(kept)} 区)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
