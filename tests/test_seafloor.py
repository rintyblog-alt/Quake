"""海底地震計 (S-net・DONET 相当) の配置を確かめる.

配置そのものは近似だが、点数・海の上にあること・実行のたびに変わらないこと
だけは守られていないと、シナリオを計算し直すたびに観測点がずれてしまう。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import build_seafloor as bs  # noqa: E402

DATA = ROOT / "web" / "data"


@pytest.fixture(scope="module")
def points():
    return bs.snet_points() + bs.donet_points()


@pytest.fixture(scope="module")
def land():
    shapely = pytest.importorskip("shapely")
    from shapely.geometry import shape
    from shapely.ops import unary_union
    geo = json.loads((DATA / "japan.geojson").read_text(encoding="utf-8"))
    return unary_union([shape(f["geometry"]) for f in geo["features"]])


def test_点数が実物に合っている(points):
    assert len(bs.snet_points()) == 150      # 日本海溝海底地震津波観測網 S-net
    assert len(bs.donet_points()) == 51      # 南海トラフ海底地震津波観測網 DONET
    assert len(points) == 201


def test_名前が重ならない(points):
    names = [n for n, _, _ in points]
    assert len(set(names)) == len(names)


def test_実行のたびに同じ位置になる(points):
    assert bs.snet_points() + bs.donet_points() == points


def test_すべて海の上にある(points, land):
    from shapely.geometry import Point
    on_land = [n for n, la, lo in points if land.contains(Point(lo, la))]
    assert not on_land, f"陸に乗っている: {on_land}"
    # いちばん陸に近いものでも数 km は離れている
    nearest = min(land.distance(Point(lo, la)) * 111.0 for _, la, lo in points)
    assert nearest > 3.0, f"陸に近すぎる ({nearest:.1f} km)"


def test_太平洋側に広がっている(points):
    lats = [la for _, la, _ in points]
    lons = [lo for _, _, lo in points]
    assert 32.0 < min(lats) and max(lats) < 43.0
    assert 133.5 < min(lons) and max(lons) < 146.0
    # S-net は日本海溝沿い、DONET は南海トラフ沿い
    snet = bs.snet_points()
    assert min(la for _, la, _ in snet) > 33.5
    assert min(lo for _, _, lo in snet) > 140.5


def test_観測点一覧に取り込まれている():
    s = json.loads((DATA / "stations.json").read_text(encoding="utf-8"))
    assert "seafloor" in s, "build_seafloor.py を実行していない"
    flags = s["seafloor"]
    assert len(flags) == s["count"]
    assert sum(flags) == 201
    for key in ("lat", "lon", "avs30", "arv", "region", "name", "pref",
                "geomorph", "subarea"):
        assert len(s[key]) == s["count"], key
    # 海底観測点は細分区域に属さない (震度速報・地域の塗り分けに出さない)
    sea = [i for i in range(s["count"]) if flags[i]]
    assert all(s["subarea"][i] == "" for i in sea)
    assert all(s["geomorph"][i] == "海底" for i in sea)
    # 震央地名は海のものが割り当たっている
    regions = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))["regions"]
    kind = {r["code"]: r["type"] for r in regions}
    assert all(kind.get(s["region"][i]) == "sea" for i in sea)
