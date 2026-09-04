"""距離減衰式とサイト増幅の検証。"""

import numpy as np
import pytest

from sim.gmpe import (arv_from_avs30, boore_site_amplification,
                      si_midorikawa_pga, si_midorikawa_pgv)
from sim.jma_intensity import intensity_from_pgv, shindo_class
from sim.source import CRUSTAL, INTERPLATE


def test_amplitude_decreases_with_distance():
    d = np.array([10.0, 30.0, 100.0, 300.0])
    assert np.all(np.diff(si_midorikawa_pgv(7.0, d, 10.0)) < 0)
    assert np.all(np.diff(si_midorikawa_pga(7.0, d, 10.0)) < 0)


def test_amplitude_increases_with_magnitude():
    v = [float(si_midorikawa_pgv(m, 30.0, 10.0)) for m in (6.0, 7.0, 8.0)]
    assert v[0] < v[1] < v[2]


def test_interplate_term_is_larger_than_crustal():
    a = float(si_midorikawa_pgv(7.5, 60.0, 30.0, CRUSTAL))
    b = float(si_midorikawa_pgv(7.5, 60.0, 30.0, INTERPLATE))
    assert b > a


def test_arv_reference_values():
    """AVS30 = 600 m/s (工学的基盤) では増幅率が概ね 1 になる。"""
    assert arv_from_avs30(np.array([600.0]))[0] == pytest.approx(1.0, abs=0.05)
    assert arv_from_avs30(np.array([150.0]))[0] > 2.0
    assert arv_from_avs30(np.array([1500.0]))[0] < 0.6


def test_arv_clamped_outside_valid_range():
    assert arv_from_avs30(np.array([50.0]))[0] == arv_from_avs30(np.array([100.0]))[0]
    assert arv_from_avs30(np.array([5000.0]))[0] == arv_from_avs30(np.array([1500.0]))[0]


def test_site_amplification_is_frequency_dependent():
    f = np.array([0.05, 0.5, 2.0, 10.0])
    amp = boore_site_amplification(f, 200.0)
    assert amp[0] < amp[-1]          # 低周波では増幅しない
    assert np.all(np.diff(amp) > 0)  # 周波数とともに増幅が増える


def test_kobe_like_event_produces_severe_shaking():
    """内陸 M7.3 の至近距離では震度 6 弱以上になる。"""
    pgv = float(si_midorikawa_pgv(7.3, 10.0, 16.0)) * arv_from_avs30(np.array([300.0]))[0]
    assert shindo_class(float(intensity_from_pgv(pgv))) in ("6弱", "6強", "7")
