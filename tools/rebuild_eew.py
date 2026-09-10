#!/usr/bin/env python3
"""保存済みシナリオの緊急地震速報を、新しい収束モデルで作り直す.

波形合成そのものはやり直さず、書き出し済みの P 波到達時刻と確定震度から
発表列だけを組み立て直す。ブラウザ内エンジン (web/js/engine.js) と同じ
式を使うので、設定モードと保存済みシナリオで速報の出方がそろう。

使い方::

    python tools/rebuild_eew.py                 # 全シナリオ
    python tools/rebuild_eew.py tohoku_offshore
"""

from __future__ import annotations

import base64
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
SCEN = WEB / "data" / "scenarios"

# --- web/js/engine.js と同じ定数 ---
EEW_WINDOW_C = 5.8
EEW_WINDOW_SLOPE = 2.0
EEW_SAT_M = 7.5
EEW_SAT_SLOPE = 0.30
DIRECT_HIT_KM = 35.0
WARNING_INTENSITY = 4.5
FORECAST_MIN_INTENSITY = 2.5
FORECAST_MIN_MAGNITUDE = 3.5
GIVEUP_S = 45.0
MAX_REPORTS = 20


def window_mag(tau: float) -> float:
    return EEW_WINDOW_C + EEW_WINDOW_SLOPE * math.log10(max(tau, 0.6))


def saturation(mag: float) -> float:
    return mag if mag <= EEW_SAT_M else EEW_SAT_M + EEW_SAT_SLOPE * (mag - EEW_SAT_M)


def final_span(mag: float, rupture_s: float) -> float:
    return min(160.0, max(25.0, 20 + 3.5 * rupture_s + 6 * max(0.0, mag - 5)))


def pseudo_random(a: float, b: float, c: float):
    """engine.js の pseudoRandom と同じ数列 (震源が同じなら毎回同じ)。"""
    x = math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453

    def nxt() -> float:
        nonlocal x
        x = math.sin(x * 91.7 + 4.13) * 43758.5453
        return x - math.floor(x)

    return nxt


def haversine(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2) - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def round_intensity(v: float) -> float:
    return math.floor(v * 10 + 0.5) / 10


SHINDO = [(0.5, "0"), (1.5, "1"), (2.5, "2"), (3.5, "3"), (4.5, "4"),
          (5.0, "5弱"), (5.5, "5強"), (6.0, "6弱"), (6.5, "6強")]


def shindo_class(v: float) -> str:
    for lim, name in SHINDO:
        if v < lim:
            return name
    return "7"


class Regions:
    def __init__(self, payload, stations):
        self.items = payload["regions"] if isinstance(payload, dict) else payload
        self.lat = np.array([r["lat"] for r in self.items])
        self.lon = np.array([r["lon"] for r in self.items])
        self.name = [r["name"] for r in self.items]
        self.by_code = {r["code"]: r["name"] for r in self.items}
        self.station_region = stations["region"]

    def name_at(self, la, lo) -> str:
        return self.name[int(np.argmin(haversine(la, lo, self.lat, self.lon)))]


def rebuild(path: Path, stations: dict, regions: Regions) -> int:
    payload = json.loads(path.read_text(encoding="utf-8"))
    src = payload["source"]
    st = payload["stations"]
    scale = st["scale"]
    final = np.frombuffer(base64.b64decode(st["final"]), dtype=np.int8) / scale
    t_p = np.frombuffer(base64.b64decode(st["tp"]), dtype="<i2") / 10.0
    sea = np.asarray(stations["seafloor"], dtype=bool)
    lat = np.asarray(stations["lat"])
    lon = np.asarray(stations["lon"])

    # 検知順 (揺れが届く観測点だけ)
    live = np.nonzero(final > -1.0)[0]
    if live.size < 2:
        payload["eew"] = []
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
        return 0
    order = live[np.argsort(t_p[live])]
    tp_sorted = t_p[order]

    d0 = np.where(sea, np.inf, haversine(src["lat"], src["lon"], lat, lon))
    direct = bool(np.nanmin(d0) <= DIRECT_HIT_KM)
    rnd = pseudo_random(src["lat"], src["lon"], src["depth"])
    need = 2 if direct else 4 + int(rnd() * 7)
    extra = (0.1 + rnd() * 0.6) if direct else (0.8 + rnd() * 2.7)
    need = min(max(need, 2), int(order.size))

    true_max = float(np.max(np.where(sea, -3.0, final)))
    first_arrival = float(tp_sorted[0])
    rupture = float(src.get("fault", {}).get("rupture_duration_s", 4.0))
    sat_cap = saturation(src["magnitude"])
    err_km = (5 + rnd() * 9) if direct else (15 + rnd() * 20)
    err_dir = rnd() * math.pi * 2
    depth_guess = 10.0

    reports = []
    t = float(tp_sorted[need - 1]) + 1.0 + extra
    give_up = t + GIVEUP_S
    span = final_span(src["magnitude"], rupture)
    final_at = 0.0
    prev_mag, prev_shindo, stable = None, "", 0
    num = 0

    while num < MAX_REPORTS:
        if not reports and t > give_up:
            break
        used = int(np.searchsorted(tp_sorted, t - 1.0, side="right"))
        if used < 2:
            t += 1.0
            continue

        tau = max(t - first_arrival, 0.6)
        mag = min(src["magnitude"], sat_cap, window_mag(tau))
        conv = 1 - math.exp(-used / 10)
        mag -= (1 - conv) * 0.55
        mag += (1 - conv) * 0.30 * math.sin(num * 2.399 + 1.1)
        mag = max(2.5, min(9.5, mag))
        if not reports and mag < FORECAST_MIN_MAGNITUDE:
            t += 1.0
            continue

        shrink = 1 / (1 + num * 0.55)
        off = err_km * shrink
        wobble = 0.35 * shrink * math.sin(num * 1.7 + 0.6)
        la = src["lat"] + off * math.cos(err_dir) / 111.32 + wobble * 0.4
        lo = (src["lon"] + off * math.sin(err_dir)
              / (111.32 * math.cos(math.radians(src["lat"]))) + wobble * 0.4)
        dep = depth_guess + (src["depth"] - depth_guess) * conv
        dep = max(2.0, dep * (1 + 0.25 * shrink * math.sin(num * 3.1)))

        predicted = round_intensity(true_max + 1.72 * 0.58 * (mag - src["magnitude"]))
        if not reports and predicted < FORECAST_MIN_INTENSITY:
            t += 1.0
            continue
        kind = "警報" if predicted >= WARNING_INTENSITY else "予報"
        if not reports:
            final_at = t + span

        warn = []
        if kind == "警報":
            shift = 1.72 * 0.58 * (mag - src["magnitude"])
            hot = np.nonzero((final + shift >= WARNING_INTENSITY) & ~sea)[0]
            for i in hot[np.argsort(-final[hot])]:
                nm = regions.by_code.get(regions.station_region[int(i)])
                if nm and nm not in warn:
                    warn.append(nm)
                if len(warn) >= 12:
                    break

        num += 1
        reports.append({
            "number": num,
            "issuedAt": round(t, 1),
            "lat": round(la, 3),
            "lon": round(lo, 3),
            "depth": int(round(dep)),
            "magnitude": round(mag, 1),
            "maxIntensity": predicted,
            "maxShindo": shindo_class(predicted),
            "region": regions.name_at(la, lo),
            "kind": kind,
            "isFinal": False,
            "stations": used,
            "warningRegions": warn,
        })

        if t >= final_at:
            break
        m = reports[-1]
        if prev_mag is not None and abs(m["magnitude"] - prev_mag) < 0.05 \
                and m["maxShindo"] == prev_shindo:
            stable += 1
        else:
            stable = 0
        prev_mag, prev_shindo = m["magnitude"], m["maxShindo"]
        if stable >= 4 and num >= 6 and t - reports[0]["issuedAt"] >= span * 0.45:
            break
        t += min(12.0, 1.0 + max(0, num - 4) * 1.1)

    if reports:
        reports[-1]["isFinal"] = True
    payload["eew"] = reports
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    return len(reports)


def main() -> int:
    stations = json.loads((WEB / "data" / "stations.json").read_text(encoding="utf-8"))
    regions = Regions(json.loads((WEB / "data" / "regions.json").read_text(encoding="utf-8")),
                      stations)
    names = sys.argv[1:]
    files = [SCEN / f"{n}.json" for n in names] if names else sorted(SCEN.glob("*.json"))
    for f in files:
        if f.name == "index.json":
            continue
        n = rebuild(f, stations, regions)
        print(f"{f.stem:20s} {n:2d} 報")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
