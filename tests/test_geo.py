"""測地計算の検証。"""

import numpy as np
import pytest

from sim.geo import (LocalFrame, destination, haversine, haversine_array,
                     initial_bearing, vincenty)


def test_vincenty_known_distance():
    # 東京駅 - 大阪駅 は約 403 km
    d, _ = vincenty(35.6812, 139.7671, 34.7025, 135.4959)
    assert 400.0 < d < 407.0


def test_vincenty_matches_haversine_within_1pct():
    d1, _ = vincenty(43.06, 141.35, 26.21, 127.68)
    d2 = haversine(43.06, 141.35, 26.21, 127.68)
    assert abs(d1 - d2) / d1 < 0.01


def test_zero_distance():
    assert vincenty(35.0, 135.0, 35.0, 135.0) == (0.0, 0.0)
    assert haversine(35.0, 135.0, 35.0, 135.0) == pytest.approx(0.0)


def test_haversine_array_matches_scalar():
    lat = np.array([35.0, 36.0, 40.0])
    lon = np.array([135.0, 136.0, 140.0])
    got = haversine_array(38.0, 138.0, lat, lon)
    want = [haversine(38.0, 138.0, a, b) for a, b in zip(lat, lon)]
    assert got == pytest.approx(want, rel=1e-9)


def test_bearing_cardinal_directions():
    assert initial_bearing(35.0, 135.0, 36.0, 135.0) == pytest.approx(0.0, abs=0.1)
    assert initial_bearing(35.0, 135.0, 35.0, 136.0) == pytest.approx(90.0, abs=0.5)


def test_destination_roundtrip():
    lat, lon = destination(35.0, 135.0, 42.0, 250.0)
    d, b = vincenty(35.0, 135.0, lat, lon)
    assert d == pytest.approx(250.0, rel=2e-3)
    assert b == pytest.approx(42.0, abs=0.5)


def test_local_frame_roundtrip():
    frame = LocalFrame(36.0, 138.0)
    lat = np.array([35.5, 36.0, 36.7])
    lon = np.array([137.4, 138.0, 138.9])
    east, north = frame.to_xy(lat, lon)
    back_lat, back_lon = frame.to_latlon(east, north)
    assert back_lat == pytest.approx(lat, abs=1e-9)
    assert back_lon == pytest.approx(lon, abs=1e-9)
