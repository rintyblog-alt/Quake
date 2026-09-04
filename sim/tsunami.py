"""津波の発生判定と津波予報区ごとの予想.

震源が海域の浅い地震である場合に津波を発生させ、気象庁の津波予報区ごとに
予想高さと到達予想時刻を求めて、大津波警報・津波警報・津波注意報・
津波予報 (若干の海面変動) のいずれかを割り当てる。

予想高さは阿部 (1989) の津波マグニチュード関係

    log10 H = Mt - log10(delta) - 5.55

を用いる (H: 最大遡上高 [m]、delta: 震央から沿岸までの距離 [km])。
横ずれ断層は津波を生じにくいため、すべり角に応じた低減を掛ける。

さらに、震源から沿岸までの経路が陸域を横切る予報区は津波が遮蔽される
ものとして除外し、遠距離では球面拡散・分散による追加減衰を与える。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .geo import destination, haversine_array
from .landmask import LandMask

DATA_DIR = Path(__file__).resolve().parent.parent / "web" / "data"

# 津波を発生させる条件
MIN_MAGNITUDE = 6.0
MAX_DEPTH_KM = 60.0

# 津波の実効伝播速度 [km/s] と浅海での減速分 [s]
CELERITY_KM_S = 0.15
SHOALING_DELAY_S = 420.0

# 気象庁が津波警報等を発表するまでの時間 [s]
ISSUE_DELAY_S = 180.0

# 遠距離での追加減衰: H ∝ (delta / REF_DISTANCE_KM)^(-FAR_DECAY)
REF_DISTANCE_KM = 100.0
FAR_DECAY = 0.35

# 経路判定で沿岸側を陸と判定しないための除外区間 [km]
COAST_MARGIN_KM = 15.0

# 発表区分のしきい値 (予想高さ [m])
GRADES = [
    (3.0, "大津波警報", "巨大", 3),
    (1.0, "津波警報", "高い", 2),
    (0.2, "津波注意報", "", 1),
    (0.0, "津波予報", "若干の海面変動", 0),
]

# 発表される予想高さの区分値 [m]
HEIGHT_CLASSES = [(10.0, "10m超"), (10.0, "10m"), (5.0, "5m"), (3.0, "3m"), (1.0, "1m"), (0.2, "0.2m")]


@dataclass
class ZoneForecast:
    """1 つの津波予報区に対する予想。"""

    code: str
    name: str
    grade: str
    grade_level: int
    height_m: float
    height_class: str
    arrival_s: float
    lat: float
    lon: float

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "name": self.name,
            "grade": self.grade,
            "level": self.grade_level,
            "height": round(self.height_m, 2),
            "heightClass": self.height_class,
            "arrival": round(self.arrival_s, 0),
            "lat": self.lat,
            "lon": self.lon,
        }


@dataclass
class TsunamiForecast:
    """津波警報等の全体。"""

    issued_at: float
    max_grade: str
    max_level: int
    zones: list[ZoneForecast] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "issuedAt": round(self.issued_at, 0),
            "maxGrade": self.max_grade,
            "maxLevel": self.max_level,
            "zones": [z.to_dict() for z in self.zones],
        }


def height_class(height_m: float) -> str:
    """予想高さを気象庁の発表区分に丸める。"""
    if height_m > 10.0:
        return "10m超"
    for lo, label in HEIGHT_CLASSES[1:]:
        if height_m >= lo:
            return label
    return "0.2m未満"


def grade_for(height_m: float) -> tuple[str, str, int]:
    for lo, grade, note, level in GRADES:
        if height_m >= lo:
            return grade, note, level
    return "津波予報", "若干の海面変動", 0


def mechanism_factor(rake_deg: float) -> float:
    """すべり角による津波励起の効率 (横ずれで小さく、逆断層・正断層で大きい)。"""
    return 0.15 + 0.85 * abs(math.sin(math.radians(rake_deg)))


class TsunamiZones:
    """津波予報区の沿岸データ。"""

    def __init__(self, data_dir: Path | None = None) -> None:
        d = data_dir or DATA_DIR
        payload = json.loads((d / "tsunami_zones.json").read_text(encoding="utf-8"))
        self.zones = payload["zones"]
        try:
            self.landmask: LandMask | None = LandMask(d)
        except (FileNotFoundError, KeyError, ValueError):
            self.landmask = None

    def is_blocked(self, lat: float, lon: float, c_lat: float, c_lon: float) -> bool:
        """震源から沿岸点までの経路が陸域に遮られているか。"""
        if self.landmask is None:
            return False
        total = haversine_array(lat, lon, np.array([c_lat]), np.array([c_lon]))[0]
        if total <= COAST_MARGIN_KM:
            return False
        # 沿岸手前 COAST_MARGIN_KM を除いた区間を 5 km 刻みで走査する
        span = total - COAST_MARGIN_KM
        n = max(int(span / 5.0), 2)
        frac = np.linspace(0.0, span / total, n)
        lats = lat + (c_lat - lat) * frac
        lons = lon + (c_lon - lon) * frac
        return bool(np.any(self.landmask.is_land(lats, lons)))

    def forecast(
        self,
        lat: float,
        lon: float,
        depth_km: float,
        magnitude: float,
        rake_deg: float = 90.0,
        is_offshore: bool = True,
    ) -> TsunamiForecast | None:
        """震源から各予報区の予想高さ・到達時刻を求める。"""
        if not is_offshore or depth_km > MAX_DEPTH_KM or magnitude < MIN_MAGNITUDE:
            return None

        mt = magnitude  # 津波マグニチュードは Mw とほぼ等しいとみなす
        eff = mechanism_factor(rake_deg)

        out: list[ZoneForecast] = []
        for z in self.zones:
            coast = np.array(z["coast"], dtype=float)
            d = haversine_array(lat, lon, coast[:, 0], coast[:, 1])
            # 陸に遮られない沿岸点のうち最短のものを採る
            order = np.argsort(d)[:40]
            k = -1
            for cand in order:
                if not self.is_blocked(lat, lon, float(coast[cand, 0]), float(coast[cand, 1])):
                    k = int(cand)
                    break
            if k < 0:
                continue  # 全方位が陸に遮られている予報区
            delta = float(max(d[k], 10.0))

            h = eff * 10.0 ** (mt - math.log10(delta) - 5.55)
            if delta > REF_DISTANCE_KM:
                h *= (delta / REF_DISTANCE_KM) ** (-FAR_DECAY)
            if h < 0.05:
                continue
            grade, _note, level = grade_for(h)
            arrival = delta / CELERITY_KM_S + SHOALING_DELAY_S
            out.append(
                ZoneForecast(
                    code=z["code"],
                    name=z["name"],
                    grade=grade,
                    grade_level=level,
                    height_m=h,
                    height_class=height_class(h),
                    arrival_s=arrival,
                    lat=float(coast[k, 0]),
                    lon=float(coast[k, 1]),
                )
            )

        if not out:
            return None
        out.sort(key=lambda z: (-z.grade_level, z.arrival_s))
        top = out[0]
        return TsunamiForecast(
            issued_at=ISSUE_DELAY_S,
            max_grade=top.grade,
            max_level=top.grade_level,
            zones=out,
        )
