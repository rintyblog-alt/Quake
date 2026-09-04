"""震央地名の判定.

気象庁「地震情報で用いる震央地名」(電文コード表 AreaEpicenter) の区分に従い、
緯度経度から震央地名を決定する。

陸域は震度観測点が高密度に分布しているため、最近傍の観測点が属する震央地名を
採用する。海域は代表座標との最近傍で判定し、陸域の観測点から一定距離以上
離れている場合に海域名を用いる。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import numpy as np

from .geo import haversine_array
from .landmask import LandMask

DATA_DIR = Path(__file__).resolve().parent.parent / "web" / "data"

# 陸域マスクが使えない場合に、最近傍観測点までの距離で陸域とみなすしきい値 [km]
LAND_THRESHOLD_KM = 15.0


@dataclass
class Region:
    code: str
    name: str
    lat: float
    lon: float
    type: str


class EpicenterRegions:
    """震央地名データベース。"""

    def __init__(self, data_dir: Path | None = None) -> None:
        d = data_dir or DATA_DIR
        regions = json.loads((d / "regions.json").read_text(encoding="utf-8"))["regions"]
        self.regions = [
            Region(r["code"], r["name"], r["lat"], r["lon"], r["type"]) for r in regions
        ]
        self.by_code = {r.code: r for r in self.regions}
        self.by_name = {r.name: r for r in self.regions}

        stations = json.loads((d / "stations.json").read_text(encoding="utf-8"))
        self.station_lat = np.array(stations["lat"], dtype=float)
        self.station_lon = np.array(stations["lon"], dtype=float)
        self.station_region = np.array(stations["region"], dtype=object)

        # 海域は 1 区分あたり複数のアンカー点を持ちうる
        self.sea_regions: list[Region] = []
        sea_lat, sea_lon = [], []
        for src, reg in zip(regions, self.regions):
            if reg.type != "sea":
                continue
            for a_lat, a_lon in src.get("anchors") or [[reg.lat, reg.lon]]:
                self.sea_regions.append(reg)
                sea_lat.append(float(a_lat))
                sea_lon.append(float(a_lon))
        self.sea_lat = np.array(sea_lat, dtype=float)
        self.sea_lon = np.array(sea_lon, dtype=float)

        try:
            self.landmask: LandMask | None = LandMask(d)
        except (FileNotFoundError, KeyError, ValueError):
            self.landmask = None

    @cached_property
    def land_regions(self) -> list[Region]:
        return [r for r in self.regions if r.type == "land"]

    def lookup(self, lat: float, lon: float) -> Region:
        """緯度経度に対応する震央地名を返す。

        陸域マスクで陸と判定される地点は最近傍の震度観測点が属する区分、
        海域は最近傍の海域アンカーが属する区分を採用する。
        """
        d_st = haversine_array(lat, lon, self.station_lat, self.station_lon)
        i = int(np.argmin(d_st))
        land_code = self.station_region[i]

        if self.landmask is not None:
            on_land = bool(self.landmask.is_land(lat, lon))
        else:
            on_land = d_st[i] <= LAND_THRESHOLD_KM

        if on_land and land_code and land_code in self.by_code:
            return self.by_code[land_code]

        d_sea = haversine_array(lat, lon, self.sea_lat, self.sea_lon)
        j = int(np.argmin(d_sea))
        # 海域アンカーが遠く、陸の観測点がごく近い場合は陸域名を採る
        if d_st[i] < 3.0 and d_st[i] < d_sea[j] and land_code in self.by_code:
            return self.by_code[land_code]
        return self.sea_regions[j]

    def name_at(self, lat: float, lon: float) -> str:
        return self.lookup(lat, lon).name

    def find(self, name: str) -> Region | None:
        """名称から震央地名を引く (部分一致も許す)。"""
        if name in self.by_name:
            return self.by_name[name]
        hits = [r for r in self.regions if name in r.name]
        return hits[0] if hits else None
