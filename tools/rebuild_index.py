#!/usr/bin/env python3
"""シナリオ一覧 (index.json) を実ファイルから作り直す.

run_scenario.py は実行の最後に一覧を書き出すため、途中で止めたり
個別に実行したりすると一覧と実ファイルがずれる。このスクリプトは
web/data/scenarios/ にある JSON を読み直して一覧を作り直す。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCEN = ROOT / "web" / "data" / "scenarios"


def main() -> int:
    entries = []
    for f in sorted(SCEN.glob("*.json")):
        if f.name == "index.json":
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"  [警告] 壊れているか書き込み中: {f.name}")
            continue
        src = d.get("source")
        if not src:
            print(f"  [警告] シナリオ形式ではありません: {f.name}")
            continue
        entries.append(
            {
                "file": f.name,
                "name": d["meta"]["name"],
                "region": src["region"],
                "magnitude": src["magnitude"],
                "depth": src["depth"],
                "kind": src["kind"],
                "maxIntensity": src["maxIntensity"],
                "maxShindo": src["maxShindo"],
                "originTime": d["meta"]["originTime"],
                "tsunami": (d.get("tsunami") or {}).get("maxGrade"),
                "aftershocks": len(d.get("aftershocks") or []),
                "reports": len(d.get("eew") or []),
            }
        )

    entries.sort(key=lambda e: -e["magnitude"])
    (SCEN / "index.json").write_text(
        json.dumps({"scenarios": entries}, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"一覧を再構築しました: {len(entries)} 件")
    for e in entries:
        print(f"  {e['name'][:30]:32s} M{e['magnitude']:.1f} 最大震度{e['maxShindo']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
