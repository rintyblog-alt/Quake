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


def test_geometric_spreading_power_law():
    """既定の "power" は 70 km まで 1/R、以遠は緩やかな冪で減る。"""
    r = np.array([10.0, 70.0, 140.0, 300.0])
    g = geometric_spreading(r)
    assert g[0] == pytest.approx(0.1)
    assert g[1] == pytest.approx(1.0 / 70.0)
    assert np.all(np.diff(g) < 0)                     # 単調に減る
    # 70 km 以遠は 1/R より緩やか、かつ減衰はする
    assert g[3] > geometric_spreading(np.array([300.0]), mode="inverse_r")[0]
    assert g[3] < g[2]


def test_geometric_spreading_modes():
    r = np.array([10.0, 70.0, 100.0, 300.0])
    tri = geometric_spreading(r, mode="trilinear")
    assert tri[1] == pytest.approx(tri[2], rel=1e-9)  # 70-130 km は一定
    inv = geometric_spreading(r, mode="inverse_r")
    assert inv == pytest.approx(1.0 / r)
    # 遠距離は 三折れ線 > power > 1/R の順に大きい
    pw = geometric_spreading(r, mode="power", far_exponent=0.65)
    assert tri[3] > pw[3] > inv[3]


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


def test_multiresolution_levels_conserve_moment():
    """どの解像度でも小断層のモーメントの合計は全体のモーメントに等しい。"""
    fault = FiniteFault(lat=35.0, lon=135.0, depth_km=DEPTH, magnitude=7.5)
    sim = StochasticSimulator(fault, dt=0.02, seed=2)
    assert len(sim.levels) >= 2
    total = fault.sub_moment.sum()
    for level in sim.levels:
        assert level["moment"].sum() == pytest.approx(total, rel=1e-9)
    # 粗い方が小断層は少ない
    counts = [level["n"] for level in sim.levels]
    assert counts == sorted(counts, reverse=True)
    assert counts[-1] == 1


def test_distant_chunks_use_coarser_levels():
    """遠方ほど粗い解像度が選ばれる。"""
    fault = FiniteFault(lat=33.1, lon=136.2, depth_km=20.0, magnitude=8.6,
                        strike=250.0, dip=12.0, kind="interplate",
                        seismogenic_depth_km=60.0)
    sim = StochasticSimulator(fault, dt=0.02, seed=2)
    near = sim._level_for_distance(40.0)
    mid = sim._level_for_distance(300.0)
    far = sim._level_for_distance(1500.0)
    assert near == 0
    assert sim.levels[mid]["n"] <= sim.levels[near]["n"]
    assert sim.levels[far]["n"] <= sim.levels[mid]["n"]
