"""確率論的地震動合成の検証。

合成波形から求めた計測震度が距離減衰式による震度と整合することを確認する。
"""

import numpy as np
import pytest

from sim.geo import destination
from sim.gmpe import si_midorikawa_pgv
from sim.jma_intensity import intensity_from_pgv
from sim.metrics import final_intensity_batch, peak_ground_motion
from sim.source import CRUSTAL, FiniteFault
from sim.stochastic import (StochasticSimulator, anelastic_attenuation,
                            geometric_spreading, saragoni_hart_window)

DISTANCES = (10.0, 30.0, 80.0, 200.0)
DEPTH = 10.0


def run(mw, seed=3):
    fault = FiniteFault(lat=35.0, lon=135.0, depth_km=DEPTH, magnitude=mw,
                        strike=0.0, dip=90.0, kind=CRUSTAL)
    sim = StochasticSimulator(fault, dt=0.02, seed=seed)
    pts = [destination(35.0, 135.0, 90.0, d) for d in DISTANCES]
    lat = np.array([p[0] for p in pts])
    lon = np.array([p[1] for p in pts])
    acc, meta = sim.synthesize(lat, lon, np.full(len(DISTANCES), 600.0), chunk=4)
    return acc, meta


def test_geometric_spreading_is_trilinear():
    r = np.array([10.0, 70.0, 100.0, 300.0])
    g = geometric_spreading(r)
    assert g[0] == pytest.approx(0.1)
    assert g[1] == pytest.approx(g[2], rel=1e-9)   # 70-130 km は一定
    assert g[3] < g[2]


def test_anelastic_attenuation_bounds():
    f = np.array([0.5, 5.0])
    a = anelastic_attenuation(f, np.array([[100.0]]), 3.4, 250.0, 0.75)
    assert np.all((0 < a) & (a <= 1))
    assert a[0, 1] < a[0, 0]      # 高周波ほど強く減衰する


def test_window_is_causal_and_normalised():
    t = np.linspace(-5, 60, 1300)[None, :]
    w = saragoni_hart_window(t, np.array([[10.0]]))
    assert np.all(w[t < 0] == 0.0)
    assert w.max() > 0


def test_arrivals_are_ordered():
    fault = FiniteFault(lat=35.0, lon=135.0, depth_km=DEPTH, magnitude=6.5)
    sim = StochasticSimulator(fault, dt=0.02, seed=1)
    pts = [destination(35.0, 135.0, 90.0, d) for d in DISTANCES]
    lat = np.array([p[0] for p in pts])
    lon = np.array([p[1] for p in pts])
    arr = sim.arrivals(lat, lon)
    assert np.all(arr["t_s"] > arr["t_p"])
    assert np.all(np.diff(arr["t_p"]) > 0)
    assert np.all(np.diff(arr["r_min"]) > 0)


@pytest.mark.parametrize("mw", [6.0, 7.0])
def test_synthesised_intensity_matches_gmpe(mw):
    """合成震度が距離減衰式による震度と 0.6 以内で一致する。"""
    acc, meta = run(mw)
    got = final_intensity_batch(acc.astype(float), meta["dt"])
    r = np.sqrt(np.array(DISTANCES) ** 2 + DEPTH**2)
    want = np.asarray(intensity_from_pgv(si_midorikawa_pgv(mw, r, DEPTH)))
    assert np.abs(got - want).max() < 0.6


def test_amplitude_decreases_with_distance():
    acc, meta = run(6.5)
    pga = [peak_ground_motion(acc[i].astype(float), meta["dt"])["pga"]
           for i in range(len(DISTANCES))]
    assert pga[0] > pga[1] > pga[2] > pga[3]


def test_far_field_uses_equivalent_point_source():
    """断層長に比べ十分遠いチャンクでは等価点震源に縮約される。"""
    fault = FiniteFault(lat=35.0, lon=135.0, depth_km=DEPTH, magnitude=7.5)
    sim = StochasticSimulator(fault, dt=0.02, seed=2)
    assert sim.n_coarse > 1
    assert sim.eq_moment == pytest.approx(sim.sub_moment.sum())
