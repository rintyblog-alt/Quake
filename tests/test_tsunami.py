"""津波予報の検証。"""

import pytest

from sim.landmask import LandMask
from sim.tsunami import TsunamiZones, grade_for, height_class, mechanism_factor


@pytest.fixture(scope="module")
def zones():
    return TsunamiZones()


@pytest.fixture(scope="module")
def mask():
    return LandMask()


def test_height_classes():
    assert height_class(12.0) == "10m超"
    assert height_class(6.0) == "5m"
    assert height_class(1.5) == "1m"
    assert height_class(0.1) == "0.2m未満"


def test_grade_thresholds():
    assert grade_for(5.0)[0] == "大津波警報"
    assert grade_for(2.0)[0] == "津波警報"
    assert grade_for(0.5)[0] == "津波注意報"
    assert grade_for(0.05)[0] == "津波予報"


def test_mechanism_factor_favours_dip_slip():
    assert mechanism_factor(90.0) > mechanism_factor(0.0)
    assert mechanism_factor(180.0) == pytest.approx(mechanism_factor(0.0), abs=1e-9)


def test_inland_event_has_no_tsunami(zones):
    assert zones.forecast(35.0, 138.0, 10.0, 7.5, 90.0, is_offshore=False) is None


def test_deep_event_has_no_tsunami(zones):
    assert zones.forecast(38.1, 143.5, 120.0, 8.0, 90.0, is_offshore=True) is None


def test_small_event_has_no_tsunami(zones):
    assert zones.forecast(38.1, 143.5, 20.0, 5.5, 90.0, is_offshore=True) is None


def test_tohoku_like_event_triggers_major_warning(zones):
    f = zones.forecast(38.10, 143.10, 24.0, 9.0, 90.0, is_offshore=True)
    assert f is not None
    assert f.max_grade == "大津波警報"
    by = {z.name: z for z in f.zones}
    assert "宮城県" in by and "岩手県" in by
    # 2011 年の実績 (宮城 17m 前後、岩手 16m 前後) に近い高さが出る
    assert 12.0 < by["宮城県"].height_m < 26.0
    assert 10.0 < by["岩手県"].height_m < 24.0
    # 太平洋側は遠くまで広く対象になる
    for nm in ("北海道太平洋沿岸東部", "千葉県九十九里・外房", "静岡県", "高知県", "宮崎県"):
        assert nm in by, nm
    # 日本海側へは海峡を回り込んで届くので、対象にはなるが桁違いに低い
    assert by["新潟県上中下越"].height_m < by["宮城県"].height_m / 8


def test_arrival_times_increase_with_distance(zones):
    f = zones.forecast(38.10, 143.10, 24.0, 9.0, 90.0, is_offshore=True)
    near = next(z for z in f.zones if z.name == "宮城県")
    far = next(z for z in f.zones if z.name == "千葉県九十九里・外房")
    assert near.arrival_s < far.arrival_s


def test_japan_sea_event_only_affects_japan_sea_side(zones):
    f = zones.forecast(37.90, 137.60, 12.0, 7.6, 90.0, is_offshore=True)
    assert f is not None
    by = {z.name: z for z in f.zones}
    assert "石川県能登" in by
    # 太平洋側へは本州を回り込むので、日本海側とは桁が違う
    assert by["石川県能登"].height_m > 1.5
    assert by.get("宮城県") is None or by["宮城県"].height_m < 0.3


def test_water_path_goes_around_land(zones):
    """水路距離は陸を突っ切らず、回り込むぶん直線より長くなる。"""
    import numpy as np

    from sim.geo import haversine_array

    g, dist = zones.water_distances(38.1, 143.1)
    # 三陸沖 -> 太平洋側 (石巻あたり) はほぼ直線
    near = zones._cell_of(g, 38.35, 141.45)
    straight = haversine_array(38.1, 143.1, np.array([38.35]), np.array([141.45]))[0]
    assert dist[near] < straight * 1.6
    # 三陸沖 -> 日本海側 (新潟沖) は津軽海峡などを回り込むぶん、はるかに長い
    far = zones._cell_of(g, 38.05, 138.95)
    straight2 = haversine_array(38.1, 143.1, np.array([38.05]), np.array([138.95]))[0]
    assert dist[far] > straight2 * 2.0
