"""速度構造と走時計算の検証。"""

import numpy as np
import pytest

from sim.velocity import VelocityModel, travel_time


@pytest.fixture(scope="module")
def model():
    return VelocityModel()


def test_velocity_increases_with_depth(model):
    depths = np.array([0, 5, 20, 40, 100, 400])
    vp = model.vp(depths)
    assert np.all(np.diff(vp) > 0)
    assert model.vs(0.0) == pytest.approx(model.vp(0.0) / 1.73)


def test_density_is_physical(model):
    rho = model.density(np.array([0.0, 20.0, 100.0]))
    assert np.all((2.0 < rho) & (rho < 3.6))


def test_p_arrives_before_s(model):
    tp = travel_time(model, 10.0, "P")
    ts = travel_time(model, 10.0, "S")
    dist = np.array([0.0, 50.0, 200.0, 800.0])
    assert np.all(ts.time(dist) > tp.time(dist))


def test_travel_time_is_monotonic(model):
    tp = travel_time(model, 10.0, "P")
    dist = np.linspace(0, 1500, 400)
    t = tp.time(dist)
    assert np.all(np.diff(t) >= -1e-9)


def test_crustal_apparent_velocity_is_reasonable(model):
    """浅い地震の近距離では見かけ速度が地殻の P 波速度程度になる。"""
    tp = travel_time(model, 10.0, "P")
    v = tp.apparent_velocity(np.array([50.0, 100.0]))
    assert np.all((5.5 < v) & (v < 7.0))


def test_s_minus_p_rule_of_thumb(model):
    """震源距離 [km] は概ね S-P 時間 [s] の 8 倍になる。"""
    tp = travel_time(model, 10.0, "P")
    ts = travel_time(model, 10.0, "S")
    for x in (60.0, 120.0, 200.0):
        r = np.sqrt(x**2 + 10.0**2)
        sp = float(ts.time(x) - tp.time(x))
        assert 6.5 < r / sp < 9.5


def test_deep_event_direct_arrival(model):
    """深さ 400 km 直上の走時は 400 / Vp 程度になる。"""
    tp = travel_time(model, 400.0, "P")
    t0 = float(tp.time(0.0))
    assert 44.0 < t0 < 52.0


def test_travel_time_cache_returns_same_object(model):
    a = travel_time(model, 30.0, "P")
    b = travel_time(model, 30.0, "P")
    assert a is b
