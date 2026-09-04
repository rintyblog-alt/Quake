#!/usr/bin/env python3
"""シナリオを実行して Web 用のデータを書き出す.

使い方::

    python scripts/run_scenario.py scenarios/tokyo_bay_north.json
    python scripts/run_scenario.py --all
    python scripts/run_scenario.py --lat 35.6 --lon 139.7 --depth 20 --magnitude 7.3
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sim import export
from sim.scenario import ScenarioConfig, run

SCENARIO_DIR = ROOT / "scenarios"
OUT_DIR = ROOT / "web" / "data" / "scenarios"


def load_config(path: Path) -> ScenarioConfig:
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw.pop("_comment", None)
    return ScenarioConfig(**raw)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("scenario", nargs="?", help="シナリオ定義 JSON")
    ap.add_argument("--all", action="store_true", help="scenarios/ の全定義を実行")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--name", default="任意地震")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--depth", type=float, default=10.0)
    ap.add_argument("--magnitude", type=float, default=7.0)
    ap.add_argument("--kind", default="crustal")
    ap.add_argument("--strike", type=float, default=0.0)
    ap.add_argument("--dip", type=float, default=45.0)
    ap.add_argument("--rake", type=float, default=90.0)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    out_dir = Path(args.out)
    configs: list[tuple[str, ScenarioConfig]] = []

    if args.all:
        for f in sorted(SCENARIO_DIR.glob("*.json")):
            configs.append((f.stem, load_config(f)))
    elif args.scenario:
        f = Path(args.scenario)
        if not f.exists():
            f = SCENARIO_DIR / f"{args.scenario}.json"
        configs.append((f.stem, load_config(f)))
    elif args.lat is not None and args.lon is not None:
        configs.append(
            (
                "custom",
                ScenarioConfig(
                    name=args.name, lat=args.lat, lon=args.lon, depth_km=args.depth,
                    magnitude=args.magnitude, kind=args.kind, strike=args.strike,
                    dip=args.dip, rake=args.rake,
                ),
            )
        )
    else:
        ap.error("シナリオ定義か --lat/--lon を指定してください")

    index = []
    for stem, cfg in configs:
        print(f"[{cfg.name}] M{cfg.magnitude} 深さ{cfg.depth_km}km ({cfg.lat}, {cfg.lon})")
        result = run(cfg, verbose=not args.quiet)
        path = export.write(result, out_dir / f"{stem}.json")
        print(f"  -> {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB\n")
        index.append(export.index_entry(result, f"{stem}.json"))

    index_path = out_dir / "index.json"
    existing = []
    if index_path.exists():
        existing = json.loads(index_path.read_text(encoding="utf-8")).get("scenarios", [])
    by_file = {e["file"]: e for e in existing}
    for e in index:
        by_file[e["file"]] = e
    index_path.write_text(
        json.dumps({"scenarios": list(by_file.values())}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"一覧を更新: {index_path.relative_to(ROOT)} ({len(by_file)} 件)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
