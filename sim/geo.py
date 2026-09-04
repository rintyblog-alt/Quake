"""測地計算ユーティリティ.

WGS84 楕円体上の距離・方位角、局所平面直交座標への変換、
震源距離・断層最短距離 (Rrup / Rjb) を提供する。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

# WGS84
A_WGS84 = 6378137.0
F_WGS84 = 1.0 / 298.257223563
B_WGS84 = A_WGS84 * (1.0 - F_WGS84)
E2_WGS84 = F_WGS84 * (2.0 - F_WGS84)


def vincenty(lat1: float, lon1: float, lat2: float, lon2: float) -> tuple[float, float]:
    """Vincenty 法で 2 点間の測地線距離 [km] と始点における方位角 [deg] を返す。

    収束しない (対蹠点近傍) 場合は球面近似にフォールバックする。
    """
    if lat1 == lat2 and lon1 == lon2:
        return 0.0, 0.0

    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    lam_diff = math.radians(lon2 - lon1)

    u1 = math.atan((1 - F_WGS84) * math.tan(phi1))
    u2 = math.atan((1 - F_WGS84) * math.tan(phi2))
    sin_u1, cos_u1 = math.sin(u1), math.cos(u1)
    sin_u2, cos_u2 = math.sin(u2), math.cos(u2)

    lam = lam_diff
    sin_sigma = cos_sigma = sigma = sin_alpha = cos2_alpha = cos_2sigma_m = 0.0
    for _ in range(200):
        sin_lam, cos_lam = math.sin(lam), math.cos(lam)
        sin_sigma = math.hypot(
            cos_u2 * sin_lam,
            cos_u1 * sin_u2 - sin_u1 * cos_u2 * cos_lam,
        )
        if sin_sigma == 0.0:
            return 0.0, 0.0
        cos_sigma = sin_u1 * sin_u2 + cos_u1 * cos_u2 * cos_lam
        sigma = math.atan2(sin_sigma, cos_sigma)
        sin_alpha = cos_u1 * cos_u2 * sin_lam / sin_sigma
        cos2_alpha = 1.0 - sin_alpha * sin_alpha
        cos_2sigma_m = 0.0 if cos2_alpha == 0.0 else cos_sigma - 2 * sin_u1 * sin_u2 / cos2_alpha
        c = F_WGS84 / 16 * cos2_alpha * (4 + F_WGS84 * (4 - 3 * cos2_alpha))
        lam_prev = lam
        lam = lam_diff + (1 - c) * F_WGS84 * sin_alpha * (
            sigma
            + c * sin_sigma * (cos_2sigma_m + c * cos_sigma * (-1 + 2 * cos_2sigma_m**2))
        )
        if abs(lam - lam_prev) < 1e-12:
            break
    else:
        return haversine(lat1, lon1, lat2, lon2), initial_bearing(lat1, lon1, lat2, lon2)

    u2_ = cos2_alpha * (A_WGS84**2 - B_WGS84**2) / (B_WGS84**2)
    a_ = 1 + u2_ / 16384 * (4096 + u2_ * (-768 + u2_ * (320 - 175 * u2_)))
    b_ = u2_ / 1024 * (256 + u2_ * (-128 + u2_ * (74 - 47 * u2_)))
    d_sigma = (
        b_
        * sin_sigma
        * (
            cos_2sigma_m
            + b_
            / 4
            * (
                cos_sigma * (-1 + 2 * cos_2sigma_m**2)
                - b_ / 6 * cos_2sigma_m * (-3 + 4 * sin_sigma**2) * (-3 + 4 * cos_2sigma_m**2)
            )
        )
    )
    dist_m = B_WGS84 * a_ * (sigma - d_sigma)

    sin_lam, cos_lam = math.sin(lam), math.cos(lam)
    bearing = math.degrees(
        math.atan2(cos_u2 * sin_lam, cos_u1 * sin_u2 - sin_u1 * cos_u2 * cos_lam)
    )
    return dist_m / 1000.0, bearing % 360.0


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """球面近似の大円距離 [km]。ベクトル化しない単点版。"""
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def haversine_array(
    lat1: float, lon1: float, lat2: np.ndarray, lon2: np.ndarray
) -> np.ndarray:
    """1 点対多点の大円距離 [km]。観測点 4000 点規模の一括計算用。"""
    r = 6371.0088
    p1 = math.radians(lat1)
    p2 = np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    h = np.sin(dp / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.minimum(1.0, np.sqrt(h)))


def initial_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """始点から終点への方位角 [deg] (真北 0、時計回り)。"""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360.0


def destination(lat: float, lon: float, bearing_deg: float, distance_km: float) -> tuple[float, float]:
    """始点から方位角・距離を進んだ地点の緯度経度。"""
    r = 6371.0088
    d = distance_km / r
    br = math.radians(bearing_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(br))
    l2 = l1 + math.atan2(
        math.sin(br) * math.sin(d) * math.cos(p1),
        math.cos(d) - math.sin(p1) * math.sin(p2),
    )
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


@dataclass(frozen=True)
class LocalFrame:
    """原点まわりの局所 ENU 平面 (km)。断層面の座標計算に使う。"""

    lat0: float
    lon0: float

    def to_xy(self, lat, lon):
        """緯度経度 -> (東 [km], 北 [km])。スカラ・配列の双方に対応。"""
        lat = np.asarray(lat, dtype=float)
        lon = np.asarray(lon, dtype=float)
        p0 = math.radians(self.lat0)
        # 子午線・卯酉線曲率半径による局所スケール
        m = A_WGS84 * (1 - E2_WGS84) / (1 - E2_WGS84 * math.sin(p0) ** 2) ** 1.5
        n = A_WGS84 / math.sqrt(1 - E2_WGS84 * math.sin(p0) ** 2)
        north = np.radians(lat - self.lat0) * m / 1000.0
        east = np.radians(lon - self.lon0) * n * math.cos(p0) / 1000.0
        return east, north

    def to_latlon(self, east_km, north_km):
        """(東 [km], 北 [km]) -> 緯度経度。"""
        p0 = math.radians(self.lat0)
        m = A_WGS84 * (1 - E2_WGS84) / (1 - E2_WGS84 * math.sin(p0) ** 2) ** 1.5
        n = A_WGS84 / math.sqrt(1 - E2_WGS84 * math.sin(p0) ** 2)
        lat = self.lat0 + np.degrees(np.asarray(north_km) * 1000.0 / m)
        lon = self.lon0 + np.degrees(np.asarray(east_km) * 1000.0 / (n * math.cos(p0)))
        return lat, lon


def hypocentral_distance(
    lat: np.ndarray, lon: np.ndarray, hypo_lat: float, hypo_lon: float, depth_km: float
) -> np.ndarray:
    """震源距離 [km] (震央距離と深さの三平方)。"""
    epi = haversine_array(hypo_lat, hypo_lon, np.asarray(lat), np.asarray(lon))
    return np.sqrt(epi**2 + depth_km**2)
