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


# 距離減衰式の magnitude 依存の補正 (下の関数を参照)
_CORR_LENGTH_KM = 55.0
_CORR_FAR = (-0.80, 0.45, -1.20, 0.08)    # 切片, 傾き, 下限, 上限 (基準 M5.0)
_CORR_NEAR = (-0.50, 0.50, -0.50, 0.35)   # 同上 (基準 M4.5)


# 遠方での上ぶれを補正する項。
#
# 2011 年三陸沖 (東京 380km で 5強、大阪 770km で 3、札幌 560km で 3〜4)、
# 2024 年能登沖 (東京 305km で 3) と突き合わせると、300km より遠くで
# 0.3〜0.5 ほど高く出ていた。距離とともに効く一定の減衰として引く。
_LONG_REF_KM = 400.0
_LONG_AMP = 0.55

# 300km を越えたあたりからの減り方。
#
# 司・翠川の -0.002*X という減衰項は遠方で弱すぎる。遠方では Lg 波の
# 広がり方が変わり、地殻内の散乱でも失われるためで、そのままだと遠くが
# 軒並み高く出る。2011 年三陸沖 (M9.0) の都道府県別最大震度 47 件と
# 突き合わせると 450km より遠くで 0.9〜1.6 も高く、九州が震度3、
# 中国四国が震度4 になってしまっていた (実際は九州 1、中国四国 2)。
# 47 件を最小二乗であてはめて決めた。
_FAR_AMP = 1.75
_FAR_START_KM = 225.0
_FAR_LENGTH_KM = 250.0


def long_range_correction(distance_km) -> np.ndarray:
    """遠方の計測震度に足す補正 (負の値)。"""
    r = np.maximum(np.asarray(distance_km, dtype=float), 0.0)
    return -_LONG_AMP * (1.0 - np.exp(-r / _LONG_REF_KM))


def magnitude_distance_correction(mw: float, distance_km) -> np.ndarray:
    """司・翠川 (1999) を波形合成に合わせる補正 [計測震度]。

    司・翠川の式は遠方の減り方がマグニチュードによらない形をしている。
    しかし実際には、小さい地震ほどコーナー周波数が高くて高周波が卓越し、
    Q(f) による減衰が強く効くため、遠方では大きい地震より速く減る。

    確率論的波形合成 (sim/stochastic.py) と距離減衰式の差を M4.5〜8.0 ・
    10〜500 km で測り、次の形を当てはめた (残差 RMS 0.11 計測震度)。

        Δ(M, r) = N(M) + (A(M) - N(M)) * (1 - exp(-r / 55km))

    N は震源直上の差、A は遠方での差。どちらも M に対して直線で、
    M7 あたりで頭打ちになる。M4.5 では遠方で -1.0 震度に達する。
    """
    r = np.maximum(np.asarray(distance_km, dtype=float), 0.0)
    g = 1.0 - np.exp(-r / _CORR_LENGTH_KM)
    b0, b1, lo, hi = _CORR_FAR
    far = np.clip(b0 + b1 * (mw - 5.0), lo, hi)
    b0, b1, lo, hi = _CORR_NEAR
    near = np.clip(b0 + b1 * (mw - 4.5), lo, hi)
    return near + (far - near) * g + long_range_correction(r)


# 火山フロント (太平洋プレート側の島弧: 千島・東北・伊豆小笠原)。
# 緯度に対して経度が単調なので、緯度から前線の経度を内挿して使う。
VOLCANIC_FRONT = [
    (45.4, 142.4), (43.7, 142.7), (42.7, 141.2), (41.5, 140.9), (40.7, 140.9),
    (39.8, 141.0), (38.9, 140.7), (38.1, 140.4), (37.6, 140.3), (36.9, 139.5),
    (36.4, 138.5), (35.9, 138.5), (35.4, 138.7), (34.7, 139.4), (34.1, 139.5),
    (33.1, 139.8), (31.9, 139.9), (27.2, 140.9), (24.8, 141.3),
]
_VF_LAT = np.array([p[0] for p in VOLCANIC_FRONT][::-1])
_VF_LON = np.array([p[1] for p in VOLCANIC_FRONT][::-1])

SLAB_MIN_DEPTH_KM = 70.0    # ここから深いとスラブ内を伝わる成分が効き始める
SLAB_FULL_DEPTH_KM = 150.0  # ここより深いと完全に効く
SLAB_WIDTH_KM = 100.0       # 火山フロントをまたぐときの遷移の幅
SLAB_Q_RECOVERY = 0.45      # 非弾性減衰のうち、前弧側で効かなくなる割合
SLAB_MAX_BONUS = 2.5        # 効きすぎないよう頭打ちにする [計測震度]


def fore_arc_weight(lat, lon) -> np.ndarray:
    """前弧 (太平洋側) なら 1、背弧 (日本海側) なら 0 に近づく重み。"""
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    front_lon = np.interp(lat, _VF_LAT, _VF_LON)
    east_km = (lon - front_lon) * 111.32 * np.cos(np.radians(lat))
    return 0.5 + 0.5 * np.tanh(east_km / SLAB_WIDTH_KM)


def slab_path_bonus(depth_km: float, distance_km, lat, lon) -> np.ndarray:
    """深発地震の異常震域を表す項 [計測震度]。

    沈み込む海洋プレートは冷たく Q が高いため、スラブ内を伝わった波は
    ほとんど減衰しない。一方、背弧側へ向かう波は高温のマントルウェッジ
    (低 Q) を通るため強く減衰する。このため深い地震では、震央から遠い
    前弧側 (太平洋側) のほうが、近い背弧側より大きく揺れる。
    2015 年小笠原諸島西方沖の地震 (深さ 682 km) で全国が有感となり、
    最大震度が震央から 800 km 以上離れた関東で観測されたのがこれである。

    司・翠川 (1999) の非弾性減衰項 -0.002*X は浅い地震に合わせたものなので、
    前弧側の経路についてはその大部分を打ち消す。深さで滑らかに効かせる。
    """
    if depth_km <= SLAB_MIN_DEPTH_KM:
        return np.zeros_like(np.asarray(distance_km, dtype=float))
    deep = np.clip(
        (depth_km - SLAB_MIN_DEPTH_KM) / (SLAB_FULL_DEPTH_KM - SLAB_MIN_DEPTH_KM), 0.0, 1.0
    )
    x = np.maximum(np.asarray(distance_km, dtype=float), 1.0)
    # 0.002 は log10(PGV) に対する係数、1.72 は震度への換算係数
    bonus = 1.72 * 0.002 * x * SLAB_Q_RECOVERY * deep * fore_arc_weight(lat, lon)
    return np.minimum(bonus, SLAB_MAX_BONUS)


def far_field_correction(distance_km, depth_km: float = 0.0,
                        lat=None, lon=None) -> np.ndarray:
    """225km より遠くの計測震度に足す補正 (負の値)。

    これは浅い地震 (2011 年三陸沖) に合わせて決めたもので、地殻を通って
    きた波が散乱で失う分を表している。深発地震はスラブの中をほとんど
    減らずに伝わるので掛けない (異常震域を潰さないため)。
    """
    r = np.asarray(distance_km, dtype=float)
    over = np.maximum(r - _FAR_START_KM, 0.0)
    base = -_FAR_AMP * (1.0 - np.exp(-over / _FAR_LENGTH_KM))
    if depth_km > SLAB_MIN_DEPTH_KM:
        deep = np.clip(
            (depth_km - SLAB_MIN_DEPTH_KM) / (SLAB_FULL_DEPTH_KM - SLAB_MIN_DEPTH_KM), 0.0, 1.0
        )
        base = base * (1.0 - deep)
    return base


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
