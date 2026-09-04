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
    names = [z.name for z in f.zones]
    assert "宮城県" in names and "岩手県" in names
    # 日本海側は陸に遮られるため対象外
    assert "新潟県上中下越" not in names
    assert "富山県" not in names


def test_arrival_times_increase_with_distance(zones):
    f = zones.forecast(38.10, 143.10, 24.0, 9.0, 90.0, is_offshore=True)
    near = next(z for z in f.zones if z.name == "宮城県")
    far = next(z for z in f.zones if z.name == "千葉県九十九里・外房")
    assert near.arrival_s < far.arrival_s


def test_japan_sea_event_only_affects_japan_sea_side(zones):
    f = zones.forecast(37.90, 137.60, 12.0, 7.6, 90.0, is_offshore=True)
    assert f is not None
    names = [z.name for z in f.zones]
    assert "石川県能登" in names
    assert "宮城県" not in names


def test_blocked_path_detection(zones):
    # 三陸沖から日本海側の沿岸へは陸に遮られる
    assert zones.is_blocked(38.1, 143.1, 37.9, 139.0)
    # 同じ太平洋側の沿岸へは遮られない
    assert not zones.is_blocked(38.1, 143.1, 38.3, 141.1)
