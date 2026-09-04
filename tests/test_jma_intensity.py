"""気象庁の計測震度算出の検証。"""

import numpy as np
import pytest

from sim.jma_intensity import (composite_acceleration, instrumental_intensity,
                               intensity_from_a0, intensity_from_pgv, jma_filter,
                               pgv_from_intensity, round_intensity, shindo_class,
                               shindo_index)


def test_filter_peaks_near_one_hz():
    f = np.array([0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0])
    g = jma_filter(f)
    assert g[2] == pytest.approx(1.0, abs=0.05)   # 1 Hz でほぼ利得 1
    assert g[0] < g[1]                            # 低周波は落とす
    assert np.all(np.diff(g[2:]) < 0)             # 高周波は単調に落ちる
    assert jma_filter(np.array([0.0]))[0] == 0.0


def test_intensity_from_a0_matches_definition():
    # I = 2 log10(a0) + 0.94
    assert intensity_from_a0(100.0) == pytest.approx(4.9)
    assert intensity_from_a0(10.0) == pytest.approx(2.9)


def test_rounding_follows_notification_rule():
    # 小数第 3 位を四捨五入し、小数第 2 位を切り捨てる
    assert round_intensity(5.449) == 5.4
    assert round_intensity(5.999) == 6.0
    assert round_intensity(4.4999) == 4.5
    assert round_intensity(3.0501) == 3.0


def test_shindo_class_boundaries():
    assert shindo_class(0.4) == "0"
    assert shindo_class(0.5) == "1"
    assert shindo_class(4.4) == "4"
    assert shindo_class(4.5) == "5弱"
    assert shindo_class(5.0) == "5強"
    assert shindo_class(5.5) == "6弱"
    assert shindo_class(6.0) == "6強"
    assert shindo_class(6.5) == "7"
    assert shindo_index(6.5) == 9


def test_single_frequency_three_components():
    """1 Hz・100 gal の 3 成分同振幅では a0 = sqrt(3) * 100 となる。"""
    dt, n = 0.01, 6000
    t = np.arange(n) * dt
    acc = np.tile(100.0 * np.sin(2 * np.pi * 1.0 * t), (3, 1))
    comp = composite_acceleration(acc, dt)
    assert comp.max() == pytest.approx(np.sqrt(3) * 100.0, rel=0.02)
    assert instrumental_intensity(acc, dt) == pytest.approx(5.4, abs=0.1)


def test_zero_input_gives_minimum():
    dt, n = 0.01, 2000
    assert instrumental_intensity(np.zeros((3, n)), dt) <= 0.0


def test_pgv_intensity_roundtrip():
    for pgv in (1.0, 10.0, 50.0):
        assert float(pgv_from_intensity(intensity_from_pgv(pgv))) == pytest.approx(pgv, rel=1e-6)


def test_bad_shape_raises():
    with pytest.raises(ValueError):
        composite_acceleration(np.zeros((2, 100)), 0.01)
