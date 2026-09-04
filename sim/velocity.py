"""1 次元地震波速度構造と走時計算.

JMA2001 に準じた日本列島下の 1 次元速度構造を用い、レイパラメータ掃引による
走時計算で P 波 / S 波の初動走時曲線を構築する。

媒質を薄層に分割し、レイパラメータ p に対する水平距離増分・走時増分を
各層で解析的に積み上げる::

    eta = sqrt(1/v^2 - p^2)     鉛直スローネス
    dX  = p * dz / eta
    dT  = dz / (v^2 * eta)

レイは v(z) = 1/p となる深さで反転する。速度の不連続を制御点間の線形補間で
連続勾配に均すことで、head wave を turning ray として取り込む。

走時の枝は 2 つ:

* 上向き直達波 -- 震源から地表へ直接上昇する枝
* 下向き反転波 -- 震源から下降し反転深さで折り返して地表へ戻る枝

同一震央距離に複数の到達がある場合は最小走時 (初動) を採用する。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# JMA2001 に準じた 1 次元 P 波速度構造 (深さ km, Vp km/s)
JMA2001_VP: list[tuple[float, float]] = [
    (0.0, 5.50),
    (1.0, 5.60),
    (2.0, 5.80),
    (3.0, 6.00),
    (9.0, 6.20),
    (18.0, 6.70),
    (24.0, 7.10),
    (33.0, 7.80),
    (40.0, 8.00),
    (60.0, 8.05),
    (80.0, 8.10),
    (100.0, 8.15),
    (150.0, 8.30),
    (200.0, 8.50),
    (250.0, 8.75),
    (300.0, 9.00),
    (350.0, 9.30),
    (400.0, 9.60),
    (450.0, 9.95),
    (500.0, 10.20),
    (600.0, 10.50),
    (700.0, 10.80),
]

VP_VS_RATIO = 1.73

# 層分割 (深さ上限 km, 層厚 km) -- 浅部を細かく、深部を粗く取る
_LAYERING: list[tuple[float, float]] = [
    (5.0, 0.1),
    (40.0, 0.25),
    (150.0, 1.0),
    (700.0, 5.0),
]


@dataclass
class VelocityModel:
    """深さに対する P 波・S 波速度のプロファイル。"""

    control_points: list[tuple[float, float]] = field(
        default_factory=lambda: list(JMA2001_VP)
    )
    vp_vs: float = VP_VS_RATIO

    def __post_init__(self) -> None:
        pts = sorted(self.control_points)
        self._z_ctrl = np.array([p[0] for p in pts], dtype=float)
        self._vp_ctrl = np.array([p[1] for p in pts], dtype=float)
        self.max_depth = float(self._z_ctrl[-1])

        edges = [0.0]
        for top, dz in _LAYERING:
            top = min(top, self.max_depth)
            while edges[-1] < top - 1e-9:
                edges.append(min(edges[-1] + dz, top))
        self.edges = np.array(edges, dtype=float)
        self.thickness = np.diff(self.edges)
        self.z_mid = 0.5 * (self.edges[:-1] + self.edges[1:])
        self.vp_mid = np.interp(self.z_mid, self._z_ctrl, self._vp_ctrl)

    # -- プロファイル --------------------------------------------------
    def vp(self, depth):
        """深さ [km] における P 波速度 [km/s]。"""
        return np.interp(np.asarray(depth, dtype=float), self._z_ctrl, self._vp_ctrl)

    def vs(self, depth):
        """深さ [km] における S 波速度 [km/s]。"""
        return self.vp(depth) / self.vp_vs

    def density(self, depth):
        """Brocher (2005) の経験式による密度 [g/cm^3]。"""
        v = np.asarray(self.vp(depth), dtype=float)
        return (
            1.6612 * v - 0.4721 * v**2 + 0.0671 * v**3 - 0.0043 * v**4 + 0.000106 * v**5
        )

    def layer_velocity(self, phase: str) -> np.ndarray:
        """薄層ごとの速度 [km/s]。"""
        return self.vp_mid if phase.upper() == "P" else self.vp_mid / self.vp_vs

    def velocity(self, depth, phase: str):
        return self.vp(depth) if phase.upper() == "P" else self.vs(depth)


def _ray_parameters(v_layer: np.ndarray, n: int = 9000) -> np.ndarray:
    """反転深さを密に走査する形でレイパラメータ列を構成する。

    p = 1/v(z_t) と置くことで、反転深さ z_t が層全体を均等に覆うようにする。
    層数より十分多い点を取り、加えて臨界値直下を対数的に密に取る。
    """
    v_min, v_max = float(v_layer.min()), float(v_layer.max())
    # 反転深さ相当の速度を均等サンプリング
    v_turn = np.linspace(v_min, v_max, n)
    p_main = 1.0 / v_turn
    # 最大 p (地表反転) 近傍を対数的に密に
    p_top = 1.0 / v_min
    p_dense = p_top * (1.0 - np.logspace(-7, -0.05, n // 3))
    # 最小 p (最深部反転) 近傍を対数的に密に
    p_bot = 1.0 / v_max
    p_deep = p_bot * (1.0 + np.logspace(-7, -0.05, n // 3))
    p = np.unique(np.concatenate([[0.0], p_main, p_dense, p_deep]))
    return p[p <= p_top]


def _integrate(
    p: np.ndarray,
    v: np.ndarray,
    thickness: np.ndarray,
    stop_at_turn: bool,
    chunk: int = 4000,
) -> tuple[np.ndarray, np.ndarray]:
    """レイパラメータ配列に対する水平距離 [km] と走時 [s] の積分。

    stop_at_turn=True  : 先頭の層から反転層の直前までを積分する。層列の中で
                         反転しない (=モデル外へ抜ける) レイは NaN とする。
    stop_at_turn=False : 全層を通過する場合のみ有効。途中で反転するレイは NaN。
    """
    if v.size == 0:
        return np.zeros_like(p), np.zeros_like(p)

    x_out = np.empty(p.size, dtype=float)
    t_out = np.empty(p.size, dtype=float)
    inv_v2 = 1.0 / v**2

    for s in range(0, p.size, chunk):
        pc = p[s : s + chunk]
        pv2 = (pc[:, None] * v[None, :]) ** 2
        passable = pv2 < 1.0
        eta = np.sqrt(np.clip(inv_v2[None, :] - pc[:, None] ** 2, 1e-14, None))
        dx = pc[:, None] * thickness[None, :] / eta
        dt = thickness[None, :] * inv_v2[None, :] / eta

        if stop_at_turn:
            blocked = ~passable
            any_block = blocked.any(axis=1)
            first_block = np.where(any_block, blocked.argmax(axis=1), v.size)
            mask = np.arange(v.size)[None, :] < first_block[:, None]
            x = (dx * mask).sum(axis=1)
            t = (dt * mask).sum(axis=1)
            # 直上で反転 / モデル底を突き抜けるレイは無効
            bad = (first_block == 0) | (~any_block)
            x_out[s : s + chunk] = np.where(bad, np.nan, x)
            t_out[s : s + chunk] = np.where(bad, np.nan, t)
        else:
            ok = passable.all(axis=1)
            x_out[s : s + chunk] = np.where(ok, dx.sum(axis=1), np.nan)
            t_out[s : s + chunk] = np.where(ok, dt.sum(axis=1), np.nan)

    return x_out, t_out


class TravelTime:
    """指定震源深さ・相に対する初動走時曲線。"""

    def __init__(
        self,
        model: VelocityModel,
        depth_km: float,
        phase: str = "P",
        max_distance_km: float = 2200.0,
        n_bins: int = 4000,
    ) -> None:
        self.model = model
        self.depth_km = float(np.clip(depth_km, 0.0, model.max_depth - 1.0))
        self.phase = phase.upper()
        self.max_distance_km = float(max_distance_km)

        v = model.layer_velocity(self.phase)
        thick = model.thickness.copy()
        edges = model.edges

        p = _ray_parameters(v)

        # 震源が属する層の位置
        k = int(np.clip(np.searchsorted(edges, self.depth_km, side="right") - 1, 0, v.size - 1))

        # --- 枝 1: 上向き直達波 (震源 -> 地表) ---
        v_up = v[: k + 1]
        t_up = thick[: k + 1].copy()
        t_up[-1] = self.depth_km - edges[k]
        x1, t1 = _integrate(p, v_up, t_up, stop_at_turn=False)

        # --- 枝 2: 下向き反転波 (震源 -> 反転深さ -> 地表) ---
        v_dn = v[k:]
        t_dn = thick[k:].copy()
        t_dn[0] = edges[k + 1] - self.depth_km
        x2a, t2a = _integrate(p, v_dn, t_dn, stop_at_turn=True)
        # 反転点から地表までの上昇レグは、地表から反転深さまでの積分に等しい
        x2b, t2b = _surface_leg(model, self.phase, p)
        x2, t2 = x2a + x2b, t2a + t2b

        x = np.concatenate([x1, x2])
        t = np.concatenate([t1, t2])
        ok = np.isfinite(x) & np.isfinite(t)
        x, t = x[ok], t[ok]
        if x.size == 0:
            raise RuntimeError("走時曲線を構築できませんでした")

        # 震央距離ビンごとの最小走時 = 初動
        self._x_tab = np.linspace(0.0, self.max_distance_km, n_bins)
        tt = np.full(n_bins, np.inf)
        idx = np.clip(np.searchsorted(self._x_tab, x, side="right") - 1, 0, n_bins - 1)
        np.minimum.at(tt, idx, t)

        filled = np.isfinite(tt)
        if filled.sum() < 2:
            raise RuntimeError("走時表のサンプルが不足しています")
        tt = np.interp(self._x_tab, self._x_tab[filled], tt[filled])
        # 初動走時は震央距離に対して単調増加
        self._t_tab = np.maximum.accumulate(tt)

        tail = slice(-60, None)
        dx = self._x_tab[-1] - self._x_tab[tail][0]
        self._tail_slope = float((self._t_tab[-1] - self._t_tab[tail][0]) / max(dx, 1e-6))

    def time(self, epicentral_km):
        """震央距離 [km] に対する初動走時 [s]。"""
        x = np.asarray(epicentral_km, dtype=float)
        t = np.interp(x, self._x_tab, self._t_tab)
        far = x > self._x_tab[-1]
        if np.any(far):
            t = np.where(
                far, self._t_tab[-1] + (x - self._x_tab[-1]) * self._tail_slope, t
            )
        return t

    def apparent_velocity(self, epicentral_km):
        """見かけ速度 [km/s] (= 震源距離 / 走時)。"""
        x = np.asarray(epicentral_km, dtype=float)
        r = np.sqrt(x**2 + self.depth_km**2)
        return r / np.maximum(self.time(x), 1e-6)


_SURFACE_CACHE: dict[tuple[int, str, int], tuple[np.ndarray, np.ndarray]] = {}


def _surface_leg(model: VelocityModel, phase: str, p: np.ndarray):
    """地表から反転深さまでの積分 (震源深さに依存しないためキャッシュする)。"""
    key = (id(model), phase, p.size)
    hit = _SURFACE_CACHE.get(key)
    if hit is not None:
        return hit
    v = model.layer_velocity(phase)
    res = _integrate(p, v, model.thickness, stop_at_turn=True)
    _SURFACE_CACHE[key] = res
    return res


def travel_time(model: VelocityModel, depth_km: float, phase: str) -> TravelTime:
    """走時曲線を構築する (深さ 0.5 km 刻みでキャッシュ)。"""
    key = (id(model), round(float(depth_km) * 2) / 2, phase.upper())
    cache = travel_time._cache  # type: ignore[attr-defined]
    hit = cache.get(key)
    if hit is None:
        hit = TravelTime(model, key[1], phase)
        cache[key] = hit
    return hit


travel_time._cache = {}  # type: ignore[attr-defined]
