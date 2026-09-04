"""震央地名の判定と陸域マスクの検証。"""

import pytest

from sim.landmask import LandMask
from sim.regions import EpicenterRegions


@pytest.fixture(scope="module")
def regions():
    return EpicenterRegions()


@pytest.fixture(scope="module")
def mask():
    return LandMask()


def test_dataset_size(regions):
    assert len(regions.regions) > 250
    assert any(r.type == "land" for r in regions.regions)
    assert any(r.type == "sea" for r in regions.regions)


@pytest.mark.parametrize("lat,lon,expected", [
    (35.68, 139.76, "東京都２３区"),
    (34.69, 135.50, "大阪府北部"),
    (43.06, 141.35, "石狩地方中部"),
    (32.75, 130.76, "熊本県熊本地方"),
    (37.20, 138.60, "新潟県中越地方"),
])
def test_land_regions(regions, lat, lon, expected):
    assert regions.name_at(lat, lon) == expected


@pytest.mark.parametrize("lat,lon,expected", [
    (36.40, 141.20, "茨城県沖"),
    (41.50, 140.80, "津軽海峡"),
    (34.75, 136.80, "伊勢湾"),
    (31.60, 131.90, "日向灘"),
    (34.60, 138.60, "駿河湾"),
    (24.40, 123.00, "与那国島近海"),
    (33.60, 132.30, "伊予灘"),
])
def test_sea_regions(regions, lat, lon, expected):
    assert regions.name_at(lat, lon) == expected


def test_lookup_returns_region_object(regions):
    r = regions.lookup(35.68, 139.76)
    assert r.code and r.name and r.type in ("land", "sea")


def test_find_by_name(regions):
    assert regions.find("東京湾") is not None
    assert regions.find("存在しない地名") is None


def test_landmask_basic(mask):
    assert mask.is_land(35.68, 139.76)      # 東京
    assert mask.is_land(43.06, 141.35)      # 札幌
    assert not mask.is_land(38.10, 143.50)  # 三陸沖
    assert not mask.is_land(0.0, 0.0)       # 範囲外は海とみなす


def test_distance_to_coast(mask):
    assert mask.distance_to_coast_km(35.68, 139.76) == 0.0
    d = mask.distance_to_coast_km(38.10, 143.50)
    assert 50.0 < d < 250.0
