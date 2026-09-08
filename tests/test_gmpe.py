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


def test_magnitude_correction_is_stronger_for_small_events():
    """小さい地震ほど遠方で速く減ること (波形合成に合わせた補正)."""
    from sim.gmpe import magnitude_distance_correction as corr

    far = 300.0
    assert corr(4.5, far) < corr(5.0, far) < corr(6.0, far) < corr(7.0, far)
    # M7 以上では頭打ちになる
    assert corr(7.0, far) == pytest.approx(corr(9.0, far))
    # 震源直上ではほとんど効かず、遠方で効く
    assert abs(corr(5.0, 0.0)) < abs(corr(5.0, 300.0))
    # M5 の遠方は 0.8 震度ほど下げる (加えて遠方の一律補正が乗る)
    from sim.gmpe import long_range_correction

    assert corr(5.0, 300.0) - long_range_correction(300.0) == pytest.approx(-0.80, abs=0.05)


def test_long_range_correction_grows_with_distance():
    """遠方の上ぶれを引く項。近くでは効かず、遠くで頭打ちになる。"""
    from sim.gmpe import long_range_correction as lrc

    assert lrc(0.0) == pytest.approx(0.0, abs=1e-6)
    assert lrc(10.0) > lrc(300.0) > lrc(800.0) > lrc(2000.0)
    assert lrc(400.0) == pytest.approx(-0.35, abs=0.03)
    assert lrc(5000.0) == pytest.approx(-0.55, abs=0.02)


def test_fore_arc_weight_separates_pacific_and_japan_sea_sides():
    from sim.gmpe import fore_arc_weight

    assert fore_arc_weight(35.69, 139.75) > 0.8   # 東京 (前弧)
    assert fore_arc_weight(42.98, 144.38) > 0.9   # 釧路 (前弧)
    assert fore_arc_weight(37.92, 139.06) < 0.2   # 新潟 (背弧)
    assert fore_arc_weight(34.69, 135.50) < 0.1   # 大阪 (背弧)


def test_slab_bonus_only_applies_to_deep_events():
    from sim.gmpe import SLAB_MAX_BONUS, slab_path_bonus

    tokyo = (35.69, 139.75)
    osaka = (34.69, 135.50)
    # 浅い地震では効かない
    assert float(slab_path_bonus(30.0, 500.0, *tokyo)) == 0.0
    assert float(slab_path_bonus(70.0, 500.0, *tokyo)) == 0.0
    # 深い地震では前弧側だけが持ち上がる
    deep_fore = float(slab_path_bonus(682.0, 900.0, *tokyo))
    deep_back = float(slab_path_bonus(682.0, 900.0, *osaka))
    assert deep_fore > 1.0
    assert deep_back < 0.1
    # 頭打ちを超えない
    assert float(slab_path_bonus(682.0, 5000.0, *tokyo)) == pytest.approx(SLAB_MAX_BONUS)
