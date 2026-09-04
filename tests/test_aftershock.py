"""余震生成の検証。"""

import numpy as np
import pytest

from sim import aftershock
from sim.source import CRUSTAL, FiniteFault


@pytest.fixture(scope="module")
def fault():
    return FiniteFault(lat=34.6, lon=135.03, depth_km=16.0, magnitude=7.3,
                       strike=233.0, dip=85.0, rake=170.0, kind=CRUSTAL)


def test_bath_law_caps_largest_aftershock(fault):
    shocks = aftershock.generate(fault, duration_days=7, m_min=3.5, seed=3)
    assert shocks
    assert max(s.magnitude for s in shocks) <= fault.magnitude - aftershock.BATH_DELTA + 0.05


def test_omori_decay_front_loads_events(fault):
    shocks = aftershock.generate(fault, duration_days=7, m_min=3.5, seed=3)
    day1 = sum(1 for s in shocks if s.time_s < 86400)
    assert day1 / len(shocks) > 0.5     # 大森則により初日に集中する


def test_gutenberg_richter_ratio(fault):
    """規模が 1 大きくなるごとに個数はおよそ 1/10 になる。"""
    shocks = aftershock.generate(fault, duration_days=30, m_min=3.5, seed=11)
    n4 = sum(1 for s in shocks if 4.0 <= s.magnitude < 5.0)
    n5 = sum(1 for s in shocks if 5.0 <= s.magnitude < 6.0)
    assert n5 >= 1
    assert 3 < n4 / n5 < 30


def test_events_are_time_ordered_and_near_fault(fault):
    shocks = aftershock.generate(fault, duration_days=3, m_min=3.5, seed=5)
    times = [s.time_s for s in shocks]
    assert times == sorted(times)
    for s in shocks[:40]:
        assert abs(s.lat - fault.lat) < 2.0
        assert abs(s.lon - fault.lon) < 2.0
        assert 0 < s.depth_km < 700


def test_small_mainshock_produces_no_aftershocks():
    small = FiniteFault(lat=35.0, lon=135.0, depth_km=10.0, magnitude=4.0)
    assert aftershock.generate(small, m_min=3.5, seed=1) == []


def test_reproducible_with_seed(fault):
    a = aftershock.generate(fault, duration_days=3, m_min=3.5, seed=42)
    b = aftershock.generate(fault, duration_days=3, m_min=3.5, seed=42)
    assert [x.to_dict() for x in a] == [x.to_dict() for x in b]


def test_sample_helpers():
    rng = np.random.default_rng(0)
    t = aftershock.sample_times(500, 7.0, rng)
    assert np.all((t >= 0) & (t <= 7.0))
    m = aftershock.sample_magnitudes(500, 3.5, 6.0, rng)
    assert np.all((m >= 3.5) & (m <= 6.0))
    assert aftershock.sample_times(0, 7.0, rng).size == 0
