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
from sim.source import CRUSTAL, FiniteFault
from sim.stochastic import PathParameters, StochasticSimulator

MAGNITUDES = (6.0, 6.5, 7.0, 7.5)
DISTANCES = (10.0, 20.0, 40.0, 70.0, 120.0, 200.0, 300.0)
DEPTH = 10.0


def misfit(q0: float, q_eta: float, kappa: float, spreading: str, seed: int = 11) -> float:
    stochastic.SPREADING_MODE = spreading
    resid = []
    for mw in MAGNITUDES:
        fault = FiniteFault(
            lat=35.0, lon=135.0, depth_km=DEPTH, magnitude=mw,
            strike=0.0, dip=90.0, kind=CRUSTAL,
        )
        path = PathParameters(q0=q0, q_eta=q_eta, kappa=kappa)
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quick", action="store_true", help="粗いグリッドで実行")
    args = ap.parse_args()

    if args.quick:
        q0s, etas, kappas = (200.0, 400.0), (0.4, 0.6), (0.035,)
        spreads = ("trilinear",)
    else:
        q0s = (180.0, 250.0, 320.0)
        etas = (0.7, 0.8, 0.9, 1.0)
        kappas = (0.015, 0.02, 0.025, 0.03)
        spreads = ("trilinear",)

    best = None
    for spreading, q0, eta, kappa in itertools.product(spreads, q0s, etas, kappas):
        rms = misfit(q0, eta, kappa, spreading)
        tag = f"{spreading:9s} Q0={q0:5.0f} eta={eta:4.2f} kappa={kappa:5.3f} -> RMS {rms:.3f}"
        if best is None or rms < best[0]:
            best = (rms, spreading, q0, eta, kappa)
            tag += "  *"
        print(tag, flush=True)

    assert best is not None
    print()
    print(
        f"最良: spreading={best[1]} Q0={best[2]:.0f} eta={best[3]:.2f} "
        f"kappa={best[4]:.3f} (震度 RMS 誤差 {best[0]:.3f})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
