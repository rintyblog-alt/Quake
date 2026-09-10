#!/usr/bin/env python3
"""書き出し済みシナリオに遠方の補正を掛け直す.

sim/gmpe.far_field_correction を足したので、波形合成をやり直せば遠方は
そのぶん下がる。ただ 1 本あたり 20 分以上かかるので、既に書き出してある
シナリオには同じ量を後から引いて合わせる。

引く量は観測点ごとに far_field_correction(r) [計測震度]。r は断層面まで
の最短距離と深さから求める (シナリオに入っている小断層の位置を使う)。
加速度・速度も同じ地震動の倍率で動くので 10^(c/1.72) 倍する。

使い方::

    python tools/apply_far_correction.py            # 全シナリオ
    python tools/apply_far_correction.py tohoku_offshore
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from sim.gmpe import far_field_correction  # noqa: E402
from sim.jma_intensity import shindo_class  # noqa: E402


def _haversine(lat1, lon1, lat2, lon2):
    """どちらの側も配列で渡せる大円距離 [km]。"""
    r = 6371.0
    p1 = np.radians(np.asarray(lat1, dtype=float))
    p2 = np.radians(np.asarray(lat2, dtype=float))
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2, dtype=float) - np.asarray(lon1, dtype=float))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))

WEB = ROOT / "web"
SCEN = WEB / "data" / "scenarios"
PGV_SLOPE = 1.72          # 計測震度 = 2.68 + 1.72*log10(PGV)


def fault_distance(src: dict, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """断層面までの最短距離と深さから求めた距離 [km]。"""
    rup = src.get("rupture")
    depth = float(src["depth"])
    if rup and rup.get("lat"):
        rlat = np.asarray(rup["lat"], dtype=float)
        rlon = np.asarray(rup["lon"], dtype=float)
        # 小断層が多いので、station x subfault を一度に持たずに分けて回す
        best = np.full(lat.size, np.inf)
        step = 256
        for a in range(0, rlat.size, step):
            d = _haversine(lat[:, None], lon[:, None],
                           rlat[None, a:a + step], rlon[None, a:a + step])
            best = np.minimum(best, d.min(axis=1))
        rjb = best
    else:
        rjb = _haversine(src["lat"], src["lon"], lat, lon)
    return np.maximum(np.sqrt(rjb**2 + depth**2), 3.0)


def apply(path: Path, stations: dict) -> tuple[float, float]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("farCorrected"):
        return 0.0, 0.0
    src = payload["source"]
    st = payload["stations"]
    scale = st["scale"]
    lat = np.asarray(stations["lat"], dtype=float)
    lon = np.asarray(stations["lon"], dtype=float)
    sea = np.asarray(stations["seafloor"], dtype=bool)

    r = fault_distance(src, lat, lon)
    # 深発地震には掛からない (異常震域を潰さないため)
    c = far_field_correction(r, float(src["depth"]))   # 引く量 [計測震度]
    factor = 10.0 ** (c / PGV_SLOPE)                # 加速度・速度の倍率

    ns = st["count"]
    final = np.frombuffer(base64.b64decode(st["final"]), dtype=np.int8).astype(float) / scale
    nt = payload["timeline"]["count"]
    rt = (np.frombuffer(base64.b64decode(st["realtime"]), dtype=np.int8)
          .astype(float).reshape(ns, nt) / scale)

    before = float(np.max(np.where(sea, -3.0, final)))
    felt = final > -2.9
    final = np.where(felt, np.maximum(final + c, -3.0), final)
    live = rt > -2.9
    rt = np.where(live, np.maximum(rt + c[:, None], -3.0), rt)

    pga = np.frombuffer(base64.b64decode(st["pga"]), dtype="<i2").astype(float) / 10.0
    pgv = np.frombuffer(base64.b64decode(st["pgv"]), dtype="<i2").astype(float) / 100.0
    pga *= factor
    pgv *= factor

    st["final"] = base64.b64encode(
        np.clip(np.round(final * scale), -128, 127).astype(np.int8).tobytes()).decode("ascii")
    st["realtime"] = base64.b64encode(
        np.clip(np.round(rt * scale), -128, 127).astype(np.int8).ravel().tobytes()).decode("ascii")
    st["pga"] = base64.b64encode(
        np.clip(np.round(pga * 10.0), -32768, 32767).astype("<i2").tobytes()).decode("ascii")
    st["pgv"] = base64.b64encode(
        np.clip(np.round(pgv * 100.0), -32768, 32767).astype("<i2").tobytes()).decode("ascii")

    after = float(np.max(np.where(sea, -3.0, final)))
    src["maxIntensity"] = round(after, 1)
    src["maxShindo"] = shindo_class(after)
    payload["farCorrected"] = True
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    return before, after


def main() -> int:
    stations = json.loads((WEB / "data" / "stations.json").read_text(encoding="utf-8"))
    names = sys.argv[1:]
    files = [SCEN / f"{n}.json" for n in names] if names else sorted(SCEN.glob("*.json"))
    for f in files:
        if f.name == "index.json":
            continue
        before, after = apply(f, stations)
        if before == after == 0.0:
            print(f"{f.stem:20s} 補正済みなので飛ばす")
        else:
            print(f"{f.stem:20s} 最大震度 {before:.2f} -> {after:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
