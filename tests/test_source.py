"""震源モデルの検証。"""

import numpy as np
import pytest

from sim.source import (CRUSTAL, INTERPLATE, INTRASLAB, FiniteFault,
                        corner_frequency, fault_area, magnitude_from_moment,
                        moment_from_magnitude, point_source)


def test_moment_magnitude_roundtrip():
    for mw in (5.0, 6.5, 7.3, 9.0):
        assert magnitude_from_moment(moment_from_magnitude(mw)) == pytest.approx(mw)


def test_moment_matches_hanks_kanamori():
    # Mw 7.0 -> M0 = 10^(1.5*7 + 9.1) N*m
    assert moment_from_magnitude(7.0) == pytest.approx(10 ** (1.5 * 7.0 + 9.1))


def test_fault_area_grows_with_magnitude():
    areas = [fault_area(m) for m in (6.0, 7.0, 8.0)]
    assert areas[0] < areas[1] < areas[2]


def test_interplate_area_exceeds_crustal():
    assert fault_area(8.0, INTERPLATE) > fault_area(8.0, CRUSTAL)


def test_intraslab_uses_crustal_scaling():
    assert fault_area(7.0, INTRASLAB) == pytest.approx(fault_area(7.0, CRUSTAL))


def test_corner_frequency_decreases_with_magnitude():
    fcs = [corner_frequency(m, 3.4, 100.0) for m in (5.0, 6.0, 7.0, 8.0)]
    assert all(a > b for a, b in zip(fcs, fcs[1:]))


def test_kobe_like_fault_dimensions():
    """M7.3 の内陸地震はおよそ 50-80 km x 20-30 km になる。"""
    f = FiniteFault(lat=34.6, lon=135.0, depth_km=16.0, magnitude=7.3,
                    strike=233.0, dip=85.0, rake=170.0, kind=CRUSTAL)
    assert 40.0 < f.length_km < 90.0
    assert 15.0 < f.width_km < 32.0
    assert f.n_sub > 1


def test_seismogenic_depth_caps_width():
    f = FiniteFault(lat=35.0, lon=135.0, depth_km=10.0, magnitude=8.0,
                    dip=90.0, kind=CRUSTAL, seismogenic_depth_km=20.0)
    assert f.width_km <= 20.0 + 1e-6


def test_subfault_moments_sum_to_total():
    f = FiniteFault(lat=35.0, lon=135.0, depth_km=10.0, magnitude=7.0)
    assert f.sub_moment.sum() == pytest.approx(moment_from_magnitude(7.0), rel=1e-9)


def test_rupture_delay_starts_at_hypocenter():
    f = FiniteFault(lat=35.0, lon=135.0, depth_km=10.0, magnitude=7.0)
    assert f.sub_delay.min() >= 0.0
    assert f.sub_delay.min() < 3.0
    assert f.total_rupture_duration > 0


def test_rrup_never_exceeds_hypocentral_distance():
    f = FiniteFault(lat=35.0, lon=135.0, depth_km=10.0, magnitude=7.5, strike=0.0, dip=90.0)
    lat = np.array([35.5, 34.2, 36.0])
    lon = np.array([135.4, 134.6, 136.2])
    assert np.all(f.rupture_distance(lat, lon) <= f.hypocentral_distance(lat, lon) + 1e-6)
    assert np.all(f.joyner_boore_distance(lat, lon) <= f.rupture_distance(lat, lon) + 1e-6)


def test_point_source_has_single_subfault():
    p = point_source(35.0, 135.0, 10.0, 6.0)
    assert p.n_sub == 1
