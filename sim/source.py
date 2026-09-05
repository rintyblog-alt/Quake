"""震源モデル.

点震源および有限断層 (矩形すべり面) を表現し、地震モーメント・断層寸法・
コーナー周波数などの震源パラメータを与える。断層は小断層に分割され、
確率論的地震動合成 (EXSIM 系の手法) の入力となる。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .geo import LocalFrame, haversine_array

# 震源種別
CRUSTAL = "crustal"  # 地殻内
INTERPLATE = "interplate"  # プレート間
INTRASLAB = "intraslab"  # 沈み込むプレート内

# 司・翠川 (1999) の震源種別補正項
DEPTH_TERM = {CRUSTAL: 0.00, INTERPLATE: 0.28, INTRASLAB: 0.30}

# 震源種別ごとの実効応力降下量 [bar]
#
# omega^2 モデルではコーナー周波数だけがこの値に依存する
# (fc = 4.9e6 * beta * (delta_sigma / M0)^(1/3))。したがってここでの値は
# 観測から求まる静的応力降下量そのものではなく、合成波形から求めた計測震度が
# 司・翠川 (1999) の距離減衰式に最も近くなるよう tools/calibrate.py で
# 較正した実効パラメータである。
#
# 海溝型・スラブ内で値が大きいのは、これらの断層面が同じ規模の地殻内地震より
# 広く、一様すべりを仮定すると観測点近傍のすべりが薄まって過小評価となるため。
# 実際の大地震では高周波はアスペリティから放射されるが、本モデルはそれを
# 明示的に置かず、この実効値で吸収している。
STRESS_DROP = {CRUSTAL: 160.0, INTERPLATE: 1000.0, INTRASLAB: 700.0}


def moment_from_magnitude(mw: float) -> float:
    """モーメントマグニチュード -> 地震モーメント M0 [N*m] (Hanks & Kanamori)。"""
    return 10.0 ** (1.5 * mw + 9.1)


def magnitude_from_moment(m0_nm: float) -> float:
    """地震モーメント M0 [N*m] -> モーメントマグニチュード。"""
    return (math.log10(m0_nm) - 9.1) / 1.5


def fault_area(mw: float, kind: str = CRUSTAL) -> float:
    """スケーリング則による断層面積 [km^2]。

    地殻内・スラブ内地震は入倉・三宅 (2001)、プレート間地震は
    Murotani et al. (2008) 系の関係を用いる。

    M0 は dyne*cm 単位で用いる (1 N*m = 1e7 dyne*cm)。
    """
    m0_dyne_cm = moment_from_magnitude(mw) * 1e7
    if kind == INTERPLATE:
        # 海溝型 (プレート間) は同規模でも面積が大きい (Murotani et al. 2008)
        return 1.48e-10 * math.sqrt(m0_dyne_cm)
    # 地殻内・スラブ内は応力降下量が大きく面積は小さい (入倉・三宅 2001)
    if m0_dyne_cm <= 7.5e25:
        return 2.23e-15 * m0_dyne_cm ** (2.0 / 3.0)
    return 4.24e-11 * math.sqrt(m0_dyne_cm)


def corner_frequency(mw: float, beta_km_s: float, stress_drop_bar: float) -> float:
    """omega^2 モデルのコーナー周波数 [Hz] (Brune)。

        fc = 4.9e6 * beta[km/s] * (delta_sigma[bar] / M0[dyne*cm])^(1/3)
    """
    m0_dyne_cm = moment_from_magnitude(mw) * 1e7
    return 4.9e6 * beta_km_s * (stress_drop_bar / m0_dyne_cm) ** (1.0 / 3.0)


@dataclass
class FiniteFault:
    """矩形すべり面。

    lat/lon/depth_km は破壊開始点 (震源) を表す。断層面は走向 strike・
    傾斜 dip の矩形で、破壊開始点の断層面上の位置を hypo_along/hypo_down
    (それぞれ長さ方向・幅方向の比率 0..1) で与える。
    """

    lat: float
    lon: float
    depth_km: float
    magnitude: float
    strike: float = 0.0
    dip: float = 90.0
    rake: float = 0.0
    kind: str = CRUSTAL
    length_km: float | None = None
    width_km: float | None = None
    hypo_along: float = 0.5
    hypo_down: float = 0.6
    rupture_velocity_ratio: float = 0.72  # Vr / Vs
    seismogenic_depth_km: float = 20.0
    n_along: int = 0
    n_down: int = 0

    # 派生量
    subfaults: np.ndarray = field(init=False, repr=False)
    sub_lat: np.ndarray = field(init=False, repr=False)
    sub_lon: np.ndarray = field(init=False, repr=False)
    sub_depth: np.ndarray = field(init=False, repr=False)
    sub_delay: np.ndarray = field(init=False, repr=False)
    sub_moment: np.ndarray = field(init=False, repr=False)

    def __post_init__(self) -> None:
        area = fault_area(self.magnitude, self.kind)
        if self.length_km is None or self.width_km is None:
            # 地震発生層の厚さで幅を頭打ちにし、余りを長さに回す
            w = math.sqrt(area / 2.0)
            max_w = self.seismogenic_depth_km / max(math.sin(math.radians(self.dip)), 0.2)
            w = min(w, max_w)
            self.width_km = w
            self.length_km = area / w
        self.area_km2 = self.length_km * self.width_km

        # 小断層分割 (概ね 1 辺 3-8 km、規模に応じて調整)
        target = max(2.0, min(8.0, self.length_km / 12.0))
        if not self.n_along:
            self.n_along = int(max(1, round(self.length_km / target)))
        if not self.n_down:
            self.n_down = int(max(1, round(self.width_km / target)))

        self._build_subfaults()

    # -- 幾何 ----------------------------------------------------------
    def _build_subfaults(self) -> None:
        n_l, n_w = self.n_along, self.n_down
        dl = self.length_km / n_l
        dw = self.width_km / n_w

        # 断層面上の局所座標 (l: 走向方向、w: 傾斜下方向)、破壊開始点を原点に
        l_c = (np.arange(n_l) + 0.5) * dl - self.hypo_along * self.length_km
        w_c = (np.arange(n_w) + 0.5) * dw - self.hypo_down * self.width_km
        L, W = np.meshgrid(l_c, w_c, indexing="ij")
        L, W = L.ravel(), W.ravel()

        strike = math.radians(self.strike)
        dip = math.radians(self.dip)

        # 走向方向の単位ベクトル (東, 北)、傾斜下方向の水平投影は走向の右手直交
        east = L * math.sin(strike) + W * math.cos(dip) * math.cos(strike)
        north = L * math.cos(strike) - W * math.cos(dip) * math.sin(strike)
        depth = self.depth_km + W * math.sin(dip)
        depth = np.maximum(depth, 0.3)

        frame = LocalFrame(self.lat, self.lon)
        lat, lon = frame.to_latlon(east, north)
        self.sub_lat, self.sub_lon, self.sub_depth = lat, lon, depth
        self.subfaults = np.column_stack([east, north, depth])

        # 破壊伝播遅れ (破壊開始点からの断層面上距離 / 破壊伝播速度)
        vs = 3.4  # 震源域の S 波速度 [km/s]
        vr = self.rupture_velocity_ratio * vs
        self.sub_delay = np.sqrt(L**2 + W**2) / vr

        # 各小断層のモーメント (一様すべりを仮定)
        self.n_sub = L.size
        self.sub_moment = np.full(self.n_sub, moment_from_magnitude(self.magnitude) / self.n_sub)
        self.sub_magnitude = float(magnitude_from_moment(self.sub_moment[0]))

    # -- 距離指標 ------------------------------------------------------
    def rupture_distance(self, lat, lon) -> np.ndarray:
        """断層最短距離 Rrup [km] (小断層中心までの最短距離で近似)。"""
        lat = np.asarray(lat, dtype=float)
        lon = np.asarray(lon, dtype=float)
        out = np.empty(lat.shape, dtype=float)
        best = np.full(lat.shape, np.inf)
        for i in range(self.n_sub):
            epi = haversine_array(
                float(self.sub_lat[i]), float(self.sub_lon[i]), lat, lon
            )
            r = np.sqrt(epi**2 + float(self.sub_depth[i]) ** 2)
            best = np.minimum(best, r)
        out[...] = best
        return out

    def joyner_boore_distance(self, lat, lon) -> np.ndarray:
        """断層面の地表投影までの最短水平距離 Rjb [km]。"""
        lat = np.asarray(lat, dtype=float)
        lon = np.asarray(lon, dtype=float)
        best = np.full(lat.shape, np.inf)
        for i in range(self.n_sub):
            epi = haversine_array(
                float(self.sub_lat[i]), float(self.sub_lon[i]), lat, lon
            )
            best = np.minimum(best, epi)
        return best

    def hypocentral_distance(self, lat, lon) -> np.ndarray:
        epi = haversine_array(self.lat, self.lon, np.asarray(lat), np.asarray(lon))
        return np.sqrt(epi**2 + self.depth_km**2)

    @property
    def stress_drop(self) -> float:
        return STRESS_DROP.get(self.kind, 100.0)

    @property
    def total_rupture_duration(self) -> float:
        """破壊継続時間 [s]。"""
        return float(self.sub_delay.max()) + self.length_km / 30.0

    def summary(self) -> dict:
        return {
            "magnitude": self.magnitude,
            "kind": self.kind,
            "depth_km": self.depth_km,
            "length_km": round(self.length_km, 1),
            "width_km": round(self.width_km, 1),
            "area_km2": round(self.area_km2, 1),
            "n_subfaults": int(self.n_sub),
            "strike": self.strike,
            "dip": self.dip,
            "rake": self.rake,
            "moment_Nm": moment_from_magnitude(self.magnitude),
            "rupture_duration_s": round(self.total_rupture_duration, 1),
        }


def point_source(lat: float, lon: float, depth_km: float, magnitude: float, kind: str = CRUSTAL) -> FiniteFault:
    """1 小断層のみの有限断層として点震源を作る。"""
    f = FiniteFault(
        lat=lat, lon=lon, depth_km=depth_km, magnitude=magnitude, kind=kind,
        n_along=1, n_down=1,
    )
    return f
