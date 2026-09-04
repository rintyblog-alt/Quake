"""距離減衰式 (GMPE) とサイト増幅.

司・翠川 (1999) による最大加速度・最大速度の距離減衰式と、
藤本・翠川 (2006) による AVS30 に基づく速度増幅率を実装する。
確率論的波形合成の結果を検証する基準として用いるほか、
簡易モードでの震度推定にも使う。
"""

from __future__ import annotations

import numpy as np

from .source import CRUSTAL, DEPTH_TERM

# 藤本・翠川 (2006) の適用範囲
AVS30_MIN, AVS30_MAX = 100.0, 1500.0


def si_midorikawa_pgv(
    mw: float, distance_km, depth_km: float, kind: str = CRUSTAL
) -> np.ndarray:
    """司・翠川 (1999) による工学的基盤 (Vs=600m/s) の最大速度 PGV [cm/s]。

        log10(PGV600) = 0.58*Mw + 0.0038*D + d - 1.29
                        - log10(X + 0.0028*10^(0.50*Mw)) - 0.002*X
    """
    x = np.maximum(np.asarray(distance_km, dtype=float), 1.0)
    d = DEPTH_TERM.get(kind, 0.0)
    depth = min(float(depth_km), 120.0)
    log_pgv = (
        0.58 * mw
        + 0.0038 * depth
        + d
        - 1.29
        - np.log10(x + 0.0028 * 10.0 ** (0.50 * mw))
        - 0.002 * x
    )
    return 10.0**log_pgv


def si_midorikawa_pga(
    mw: float, distance_km, depth_km: float, kind: str = CRUSTAL
) -> np.ndarray:
    """司・翠川 (1999) による最大加速度 PGA [gal]。

        log10(PGA) = 0.50*Mw + 0.0043*D + d + 0.61
                     - log10(X + 0.0055*10^(0.50*Mw)) - 0.003*X
    """
    x = np.maximum(np.asarray(distance_km, dtype=float), 1.0)
    d = DEPTH_TERM.get(kind, 0.0)
    depth = min(float(depth_km), 120.0)
    log_pga = (
        0.50 * mw
        + 0.0043 * depth
        + d
        + 0.61
        - np.log10(x + 0.0055 * 10.0 ** (0.50 * mw))
        - 0.003 * x
    )
    return 10.0**log_pga


def arv_from_avs30(avs30) -> np.ndarray:
    """藤本・翠川 (2006) による Vs=600m/s 基準の速度増幅率。

        log10(ARV) = 1.83 - 0.66 * log10(AVS30)
    """
    v = np.clip(np.asarray(avs30, dtype=float), AVS30_MIN, AVS30_MAX)
    return 10.0 ** (1.83 - 0.66 * np.log10(v))


def amplification_factor(avs30, reference_vs: float = 600.0) -> np.ndarray:
    """任意の基準速度に対する相対増幅率。"""
    return arv_from_avs30(avs30) / arv_from_avs30(np.full_like(np.asarray(avs30, dtype=float), reference_vs))


def boore_site_amplification(freq: np.ndarray, avs30: float, reference_vs: float = 600.0) -> np.ndarray:
    """周波数依存のサイト増幅 (四分の一波長法による近似)。

    低周波では増幅が小さく、卓越周波数付近で最大となる特性を、
    AVS30 から求めた増幅率と地盤の卓越周波数で表現する。
    """
    f = np.asarray(freq, dtype=float)
    amp_max = float(amplification_factor(np.array([avs30]), reference_vs)[0])
    # 表層 30m を代表層とみなした 1/4 波長則の卓越周波数
    f0 = max(avs30 / (4.0 * 30.0), 0.3)
    # 低周波で 1、卓越周波数以上で amp_max に漸近する遷移関数
    trans = 1.0 / (1.0 + (np.maximum(f, 1e-6) / f0) ** -2.0)
    return 1.0 + (amp_max - 1.0) * trans
