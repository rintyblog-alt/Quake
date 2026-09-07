"""残差モデルのテスト."""

import numpy as np
import pytest

from sim import variability as var
from sim.geo import haversine_array


def test_site_terms_are_standard_normal():
    rng = np.random.default_rng(3)
    lat = 30.0 + rng.random(6000) * 15.0
    lon = 128.0 + rng.random(6000) * 16.0
    z = var.site_terms(lat, lon)
    assert abs(float(z.mean())) < 0.06
    assert 0.93 < float(z.std()) < 1.07


def test_site_terms_are_repeatable_and_order_independent():
    lat = np.array([35.1, 38.4, 43.0, 33.2])
    lon = np.array([139.7, 141.0, 141.3, 130.4])
    z = var.site_terms(lat, lon)
    # 呼び直しても、並べ替えても同じ観測点は同じ値になる
    assert np.array_equal(z, var.site_terms(lat, lon))
    order = [2, 0, 3, 1]
    assert np.allclose(var.site_terms(lat[order], lon[order]), z[order])


def test_path_field_is_unit_variance():
    rng = np.random.default_rng(5)
    lat = 33.0 + rng.random(3000) * 8.0
    lon = 132.0 + rng.random(3000) * 8.0
    z = var.path_field(lat, lon, seed=11)
    assert abs(float(z.mean())) < 0.15
    assert 0.85 < float(z.std()) < 1.15


def test_path_field_follows_the_target_correlation():
    """rho(h) = exp(-3h/b) を再現しているか (多数実現の平均で確認)."""
    n = 41
    lat = 35.0 + np.arange(n) * 5.0 / 111.32  # 5 km 刻みの直線
    lon = np.full(n, 135.0)
    acc = np.zeros(n)
    reps = 300
    for s in range(reps):
        p = var.path_field(lat, lon, seed=s)
        acc += p[0] * p
    acc /= reps
    h = haversine_array(lat[0], lon[0], lat, lon)
    target = np.exp(-3.0 * h / var.CORR_LEN_KM)
    # 相関が残る 25 km 以内で一致すること
    near = h <= var.CORR_LEN_KM
    assert np.max(np.abs(acc[near] - target[near])) < 0.15


def test_path_field_is_reproducible_from_the_seed():
    lat = np.array([35.0, 35.2, 35.4])
    lon = np.array([135.0, 135.2, 135.4])
    assert np.array_equal(var.path_field(lat, lon, 7), var.path_field(lat, lon, 7))
    assert not np.array_equal(var.path_field(lat, lon, 7), var.path_field(lat, lon, 8))


def test_residual_scatter_matches_the_declared_sigma():
    rng = np.random.default_rng(9)
    lat = 30.0 + rng.random(8000) * 15.0
    lon = 128.0 + rng.random(8000) * 16.0
    d = var.intensity_residual(lat, lon, seed=1)
    expect = np.hypot(var.PHI_SITE, var.PHI_PATH)
    assert abs(float(d.std()) - expect) < 0.06
    assert abs(float(d.mean())) < 0.05


@pytest.mark.parametrize("delta", [-0.8, 0.0, 0.5])
def test_gains_move_the_intensity_by_the_residual(delta):
    """加速度・PGV に掛ける倍率が、震度をちょうど残差ぶん動かすこと."""
    # 計測震度 I = 2*log10(a0) + 0.94
    assert np.isclose(2.0 * np.log10(var.acceleration_gain(delta)), delta)
    # 藤本・翠川 (2005) I = 2.68 + 1.72*log10(PGV)
    assert np.isclose(1.72 * np.log10(var.pgv_gain(delta)), delta)


def test_far_envelope_is_continuous_and_peaks_at_the_s_arrival():
    """遠方観測点を埋める包絡形が、段差なく立ち上がって減衰すること."""
    from sim.scenario import far_envelope

    times = np.arange(0, 400, 1.0)
    peak = np.array([2.5, 1.0])
    t_p = np.array([60.0, 120.0])
    t_s = np.array([105.0, 210.0])
    r = np.array([500.0, 950.0])
    env = far_envelope(times, peak, t_p, t_s, r, rupture_s=30.0)

    for k in range(2):
        e = env[k]
        # P 波の前は無反応
        assert np.all(e[times < t_p[k] - 1] == -3.0)
        # 最大値は与えた震度と一致し、S 波到達より後に出る
        assert np.isclose(e.max(), peak[k], atol=0.05)
        assert times[int(np.argmax(e))] >= t_s[k]
        # P 波の立ち上がりを除けば、隣り合う時刻で飛びが無い
        after = times[1:] > t_p[k] + 2.0
        assert np.max(np.abs(np.diff(e)[after])) < 0.5
        # 最後は下がっている
        assert e[-1] < peak[k]


def test_sigma_shrinks_where_the_shaking_is_strong():
    """振幅依存の σ が、弱い揺れでは全量・強い揺れでは頭打ちになること."""
    assert var.sigma_scale(1.0) == pytest.approx(1.0)
    assert var.sigma_scale(var.SIGMA_FULL) == pytest.approx(1.0)
    assert var.sigma_scale(var.SIGMA_FLOOR_AT) == pytest.approx(var.SIGMA_FLOOR)
    assert var.sigma_scale(7.5) == pytest.approx(var.SIGMA_FLOOR)
    mid = var.sigma_scale(0.5 * (var.SIGMA_FULL + var.SIGMA_FLOOR_AT))
    assert var.SIGMA_FLOOR < mid < 1.0
    # 単調に減ること
    x = np.linspace(0.0, 8.0, 60)
    assert np.all(np.diff(var.sigma_scale(x)) <= 1e-12)


def test_residual_uses_the_scale_when_a_median_is_given():
    lat = np.full(400, 35.0) + np.arange(400) * 0.01
    lon = np.full(400, 135.0)
    plain = var.intensity_residual(lat, lon, seed=4)
    strong = var.intensity_residual(lat, lon, seed=4, median_intensity=np.full(400, 7.0))
    assert np.allclose(strong, plain * var.SIGMA_FLOOR)
    weak = var.intensity_residual(lat, lon, seed=4, median_intensity=np.full(400, 2.0))
    assert np.allclose(weak, plain)
