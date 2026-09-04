#!/usr/bin/env python3
"""データ生成の全工程をまとめて実行する.

    1. prepare_data      観測点・震央地名・地図・走時表・津波予報区一覧
    2. build_landmask    陸域マスク (1 の地図を使う)
    3. build_tsunami_zones  津波予報区の沿岸線 (1 と 2 を使う)

生データ (data/raw/) が揃っていることが前提。揃っていない場合は
tools/fetch_sources.py と tools/fetch_avs30.py を先に実行する。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

STEPS = [
    ("観測点・震央地名・地図・走時表", ["prepare_data.py", "--map-tolerance", "0.0012",
                                        "--map-min-area", "8e-6"]),
    ("陸域マスク", ["build_landmask.py"]),
    ("津波予報区の沿岸線", ["build_tsunami_zones.py"]),
]


def main() -> int:
    for label, args in STEPS:
        print(f"\n=== {label} ===", flush=True)
        r = subprocess.run([sys.executable, str(ROOT / "tools" / args[0])] + args[1:])
        if r.returncode != 0:
            print(f"失敗: {args[0]}", file=sys.stderr)
            return r.returncode
    print("\n完了")
    return 0


if __name__ == "__main__":
    sys.exit(main())
