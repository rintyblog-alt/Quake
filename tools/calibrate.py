#!/usr/bin/env python3
"""確率論的合成のパラメータ較正.

伝播経路パラメータ (Q0, Q の周波数依存指数、幾何減衰の型、kappa) を
グリッドサーチし、合成波形から求めた計測震度が司・翠川 (1999) +
藤本・翠川 (2005) による震度と最もよく一致する組合せを選ぶ。
"""

from __future__ import annotations

import argparse
import itertools
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sim import stochastic
from sim.geo import destination
from sim.gmpe import si_midorikawa_pgv
from sim.jma_intensity import intensity_from_pgv
from sim.metrics import final_intensity_batch
from sim.source import CRUSTAL, INTERPLATE, INTRASLAB, FiniteFault
from sim.stochastic import PathParameters, StochasticSimulator

MAGNITUDES = (6.0, 6.5, 7.0, 7.5, 8.0, 8.6)
DISTANCES = (10.0, 20.0, 40.0, 70.0, 120.0, 200.0, 300.0, 450.0)
DEPTH = 10.0


def misfit(q0: float, q_eta: float, kappa: float, spreading: str,
           max_dur: float = 22.0, seed: int = 11) -> float:
    stochastic.SPREADING_MODE = spreading
    resid = []
    for mw in MAGNITUDES:
        fault = FiniteFault(
            lat=35.0, lon=135.0, depth_km=DEPTH, magnitude=mw,
            strike=0.0, dip=90.0, kind=CRUSTAL,
        )
        path = PathParameters(q0=q0, q_eta=q_eta, kappa=kappa,
                              max_source_duration=max_dur)
        sim = StochasticSimulator(fault, path=path, seed=seed)
        pts = [destination(35.0, 135.0, 90.0, d) for d in DISTANCES]
        lat = np.array([p[0] for p in pts])
        lon = np.array([p[1] for p in pts])
        acc, meta = sim.synthesize(lat, lon, np.full(len(DISTANCES), 600.0))
        got = final_intensity_batch(acc, meta["dt"])
        r = np.sqrt(np.array(DISTANCES) ** 2 + DEPTH**2)
        want = np.asarray(intensity_from_pgv(si_midorikawa_pgv(mw, r, DEPTH)))
        resid.append(got - want)
    return float(np.sqrt(np.mean(np.concatenate(resid) ** 2)))


def stress_misfit(kind: str, stress: float, spreading: str = "power",
                  far_exponent: float | None = None,
                  seed: int = 13) -> tuple[float, float]:
    """指定した条件での、震度の距離減衰式との食い違い。

    戻り値は (全距離の RMS 誤差, 200 km 以遠の平均の偏り)。
    偏りが正なら遠距離で過大に出ていることを示す。
    """
    stochastic.SPREADING_MODE = spreading
    depth = 10.0 if kind == CRUSTAL else 30.0
    dip = 90.0 if kind == CRUSTAL else 25.0
    resid = []
    for mw in MAGNITUDES:
        fault = FiniteFault(
            lat=35.0, lon=135.0, depth_km=depth, magnitude=mw,
            strike=0.0, dip=dip, kind=kind,
            seismogenic_depth_km=20.0 if kind == CRUSTAL else 60.0,
        )
        sim = StochasticSimulator(
            fault,
            path=PathParameters(stress_drop_bar=stress, far_exponent=far_exponent),
            dt=0.02, seed=seed,
        )
        pts = [destination(35.0, 135.0, 90.0, d) for d in DISTANCES]
        lat = np.array([p[0] for p in pts])
        lon = np.array([p[1] for p in pts])
        acc, meta = sim.synthesize(lat, lon, np.full(len(DISTANCES), 600.0))
        got = final_intensity_batch(acc, meta["dt"])
        r = np.sqrt(np.array(DISTANCES) ** 2 + depth**2)
        want = np.asarray(intensity_from_pgv(si_midorikawa_pgv(mw, r, depth, kind)))
        resid.append(got - want)
    res = np.concatenate(resid)
    far = np.tile(np.array(DISTANCES) >= 200.0, len(MAGNITUDES))
    return float(np.sqrt(np.mean(res**2))), float(np.mean(res[far]))


def calibrate_stress() -> int:
    """震源種別ごとに応力降下量を較正する。"""
    candidates_by_kind = {
        CRUSTAL: (90.0, 120.0, 160.0, 220.0),
        INTERPLATE: (480.0, 700.0, 1000.0, 1400.0),
        INTRASLAB: (340.0, 480.0, 700.0, 1000.0),
    }
    result = {}
    for far in (0.45, 0.65, 0.85):
        for kind in (CRUSTAL, INTERPLATE, INTRASLAB):
            print(f"--- 遠距離の減衰指数 {far} / {kind} ---", flush=True)
            best = None
            for stress in candidates_by_kind[kind]:
                rms, bias = stress_misfit(kind, stress, "power", far)
                tag = (f"  応力降下量 {stress:5.0f} bar -> RMS {rms:.3f}  "
                       f"遠距離の偏り {bias:+.2f}")
                if best is None or rms < best[0]:
                    best = (rms, stress, bias)
                    tag += "  *"
                print(tag, flush=True)
            result[(far, kind)] = best
    print()
    for (far, kind), (rms, stress, bias) in sorted(result.items()):
        print(f"最良: 指数 {far} {kind:11s} {stress:5.0f} bar "
              f"RMS {rms:.3f} 遠距離の偏り {bias:+.2f}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quick", action="store_true", help="粗いグリッドで実行")
    ap.add_argument("--stress", action="store_true",
                    help="震源種別ごとの応力降下量だけを較正する")
    args = ap.parse_args()

    if args.stress:
        return calibrate_stress()

    if args.quick:
        q0s, etas, kappas = (250.0,), (0.75,), (0.025,)
        durs = (10.0, 16.0, 22.0, 30.0, 45.0)
        spreads = ("trilinear",)
    else:
        q0s = (180.0, 250.0, 320.0)
        etas = (0.65, 0.75, 0.85)
        kappas = (0.02, 0.025, 0.03)
        durs = (12.0, 18.0, 24.0, 30.0)
        spreads = ("trilinear",)

    best = None
    for spreading, q0, eta, kappa, dur in itertools.product(spreads, q0s, etas, kappas, durs):
        rms = misfit(q0, eta, kappa, spreading, dur)
        tag = (f"{spreading:9s} Q0={q0:5.0f} eta={eta:4.2f} kappa={kappa:5.3f} "
               f"Tmax={dur:4.0f}s -> RMS {rms:.3f}")
        if best is None or rms < best[0]:
            best = (rms, spreading, q0, eta, kappa, dur)
            tag += "  *"
        print(tag, flush=True)

    assert best is not None
    print()
    print(
        f"最良: spreading={best[1]} Q0={best[2]:.0f} eta={best[3]:.2f} "
        f"kappa={best[4]:.3f} Tmax={best[5]:.0f}s (震度 RMS 誤差 {best[0]:.3f})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
