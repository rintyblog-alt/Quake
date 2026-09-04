"""余震活動の生成.

* 改良大森公式 (宇津) : n(t) = K / (t + c)^p  で時間減衰を与える
* Gutenberg-Richter 則 : log10 N(>=M) = a - b*M  で規模分布を与える
* Bath の法則         : 最大余震の規模は本震より約 1.2 小さい

震源は本震の断層面近傍に分布させる。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .geo import LocalFrame

OMORI_P = 1.08
OMORI_C = 0.02  # [day]
GR_B = 0.90
BATH_DELTA = 1.2


@dataclass
class Aftershock:
    """1 個の余震。"""

    time_s: float  # 本震からの経過秒
    lat: float
    lon: float
    depth_km: float
    magnitude: float
    region_name: str = ""
    max_intensity: float = 0.0

    def to_dict(self) -> dict:
        return {
            "time": round(self.time_s, 1),
            "lat": round(self.lat, 3),
            "lon": round(self.lon, 3),
            "depth": round(self.depth_km, 1),
            "magnitude": round(self.magnitude, 1),
            "region": self.region_name,
            "maxIntensity": round(self.max_intensity, 1),
        }


def productivity(mainshock_m: float, m_min: float) -> float:
    """本震規模から、M >= m_min の余震の総数を見積もる。

    余震の総数は本震のモーメントに比例するとし、Bath の法則で規格化する。
    """
    m_max = mainshock_m - BATH_DELTA
    if m_max <= m_min:
        return 0.0
    # 最大余震が 1 個程度となるよう a 値を定める
    a = GR_B * m_max
    return 10.0 ** (a - GR_B * m_min)


def sample_times(n: int, duration_days: float, rng: np.random.Generator) -> np.ndarray:
    """改良大森公式に従う発生時刻 [day] を n 個サンプリングする。"""
    if n <= 0:
        return np.zeros(0)
    p, c = OMORI_P, OMORI_C
    # 累積分布 F(t) ∝ ((t+c)^(1-p) - c^(1-p)) を逆変換する
    lo = c ** (1.0 - p)
    hi = (duration_days + c) ** (1.0 - p)
    u = rng.random(n)
    return (lo + u * (hi - lo)) ** (1.0 / (1.0 - p)) - c


def sample_magnitudes(
    n: int, m_min: float, m_max: float, rng: np.random.Generator
) -> np.ndarray:
    """上限付き Gutenberg-Richter 分布から規模をサンプリングする。"""
    if n <= 0:
        return np.zeros(0)
    beta = GR_B * np.log(10.0)
    u = rng.random(n)
    denom = 1.0 - np.exp(-beta * (m_max - m_min))
    return m_min - np.log(1.0 - u * denom) / beta


def generate(
    fault,
    duration_days: float = 7.0,
    m_min: float = 3.5,
    max_count: int = 400,
    seed: int = 0,
    regions=None,
) -> list[Aftershock]:
    """本震の断層モデルから余震列を生成する。"""
    rng = np.random.default_rng(seed)
    m_max = fault.magnitude - BATH_DELTA
    if m_max <= m_min:
        return []

    expected = productivity(fault.magnitude, m_min)
    n = int(min(rng.poisson(expected), max_count))
    if n <= 0:
        return []

    times = np.sort(sample_times(n, duration_days, rng)) * 86400.0
    mags = sample_magnitudes(n, m_min, m_max, rng)
    # 最大余震を 1 個は確実に含める
    mags[int(np.argmax(mags))] = m_max - abs(rng.normal(0.0, 0.15))

    # 震源は断層面の周囲に分布させる
    frame = LocalFrame(fault.lat, fault.lon)
    east, north = frame.to_xy(fault.sub_lat, fault.sub_lon)
    pick = rng.integers(0, east.size, n)
    scatter = max(fault.width_km * 0.35, 4.0)
    e = east[pick] + rng.normal(0.0, scatter, n)
    nn = north[pick] + rng.normal(0.0, scatter, n)
    dep = np.clip(fault.sub_depth[pick] + rng.normal(0.0, scatter * 0.6, n), 2.0, 700.0)
    lat, lon = frame.to_latlon(e, nn)

    out = []
    for i in range(n):
        name = regions.name_at(float(lat[i]), float(lon[i])) if regions else ""
        out.append(
            Aftershock(
                time_s=float(times[i]),
                lat=float(lat[i]),
                lon=float(lon[i]),
                depth_km=float(dep[i]),
                magnitude=float(round(mags[i], 1)),
                region_name=name,
            )
        )
    return out
