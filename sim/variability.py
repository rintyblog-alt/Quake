"""地震動のばらつき (残差モデル).

距離減衰式やスペクトルモデルが与えるのは中央値であって、実際の観測値は
その周りに大きくばらつく。ばらつきを与えないと震度分布は震源からの
距離だけで決まる同心円の縞になり、隣り合う観測点が必ず同じ震度になる。
実際の強震観測ではすぐ隣の観測点でも 1 階級ずれることが珍しくない。

残差を Al Atik et al. (2010) にならって成分に分ける:

    delta = phi_S2S * zeta(x) + phi_path * psi(x)

  phi_S2S * zeta : 観測点固有の項。AVS30 だけでは説明しきれない表層の
                   特性で、同じ観測点では毎回同じ向きに出る (繰り返し性)。
                   観測点の座標から決まる固定値として与える。
  phi_path * psi : 地震ごとの経路の項。空間相関を持ち、
                   Jayaram & Baker (2009) の rho(h) = exp(-3h/b) に従う。

地震間 (event term) は入れていない。本モデルは単純な距離減衰式ではなく
断層寸法・応力降下量・破壊継続時間まで与える震源モデルなので、
地震ごとの違いはそちらで表現されるとみなす。

標準偏差は計測震度の単位で与える。司・翠川 (1999) の log10(PGV) に対する
ばらつき 0.23 前後を藤本・翠川 (2005) の係数 1.72 で震度に換算すると
0.40 程度になり、観測との比較で報告されている値と整合する。

ただし、ばらつきは揺れが強いほど小さくなる。地盤が非線形化して軟弱地盤の
増幅が頭打ちになるためで、Youngs et al. (1995) 以降、多くの距離減衰式が
振幅依存の σ として採り入れている。sigma_scale() で中央値の震度に応じて
残差を縮める。

縮め方 (震度 6.5 以上で 0.4 倍) は、報告されている振幅依存性 (弱震から
強震で 15〜30% 程度の減少) より強い。本モデルの中央値側に地盤の非線形性が
入っておらず、強震域の増幅が頭打ちにならないぶんをここで代わりに抑えている
ためで、非線形性を中央値に入れるまでの当面の措置である。これを入れないと
最大震度の出る場所で残差が積み上がり、計測震度が観測記録の上限
(2016 年熊本地震・益城町の 6.7) を大きく超えてしまう。
"""

from __future__ import annotations

import numpy as np

PHI_SITE = 0.30  # 観測点固有 (震度単位)
PHI_PATH = 0.24  # 経路 (震度単位)
CORR_LEN_KM = 25.0  # Jayaram & Baker (2009) の b: rho(h) = exp(-3h/b)
N_MODES = 256  # ランダムフーリエ級数の項数

# 振幅依存の σ: 震度 SIGMA_FULL 以下では全量、SIGMA_FLOOR_AT 以上では SIGMA_FLOOR 倍
SIGMA_FULL = 4.0
SIGMA_FLOOR_AT = 6.5
SIGMA_FLOOR = 0.40

_U32 = np.uint32
_TWO32 = 4294967296.0


def _fmix32(x: np.ndarray) -> np.ndarray:
    """MurmurHash3 の finalizer。JavaScript の Math.imul 版と同じ値になる。"""
    x = np.asarray(x, dtype=np.uint32)
    x = x ^ (x >> _U32(16))
    x = x * _U32(0x85EBCA6B)
    x = x ^ (x >> _U32(13))
    x = x * _U32(0xC2B2AE35)
    return x ^ (x >> _U32(16))


def _coord_key(lat, lon) -> np.ndarray:
    """観測点座標から 32 bit のキーを作る (並び順に依存しない)。"""
    a = np.rint(np.asarray(lat, dtype=float) * 1000.0).astype(np.int64).astype(np.uint32)
    b = np.rint(np.asarray(lon, dtype=float) * 1000.0).astype(np.int64).astype(np.uint32)
    return (a * _U32(0x8DA6B343)) ^ (b * _U32(0xD8163841))


def site_terms(lat, lon) -> np.ndarray:
    """観測点ごとに固定の標準正規乱数 (Box-Muller)。"""
    key = _coord_key(lat, lon)
    u1 = _fmix32(key).astype(np.float64) / _TWO32
    u2 = _fmix32(key ^ _U32(0x9E3779B1)).astype(np.float64) / _TWO32
    u1 = np.maximum(u1, 1.0 / _TWO32)
    return np.sqrt(-2.0 * np.log(u1)) * np.cos(2.0 * np.pi * u2)


def path_field(lat, lon, seed: int, corr_km: float = CORR_LEN_KM, n_modes: int = N_MODES) -> np.ndarray:
    """空間相関 exp(-3h/b) を持つ平均 0・分散 1 のガウス場。

    指数型の相関は Matern (nu=1/2) にあたり、その波数スペクトルは 2 次元の
    コーシー分布になる。ランダムフーリエ級数

        psi(x) = sqrt(2/M) * sum_j cos(k_j . x + phi_j)

    の波数 k_j をそこから引けば、E[psi(x)psi(x+h)] が k の特性関数、
    すなわち exp(-|h|/l) そのものになる。
    """
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    rng = np.random.default_rng(seed)

    lat0 = float(lat.mean())
    lon0 = float(lon.mean())
    x = (lon - lon0) * 111.32 * np.cos(np.radians(lat0))
    y = (lat - lat0) * 111.32

    ell = corr_km / 3.0  # rho(h) = exp(-h/ell)
    z = rng.standard_normal((n_modes, 2))
    g = np.maximum(np.abs(rng.standard_normal(n_modes)), 1e-3)
    k = z / (g[:, None] * ell)
    phase = rng.uniform(0.0, 2.0 * np.pi, n_modes)

    out = np.zeros(lat.size)
    step = 64  # 一度に扱う項数 (メモリを抑えるため分割する)
    for j0 in range(0, n_modes, step):
        kk = k[j0 : j0 + step]
        proj = np.outer(x, kk[:, 0]) + np.outer(y, kk[:, 1])
        out += np.cos(proj + phase[j0 : j0 + step]).sum(axis=1)
    return np.sqrt(2.0 / n_modes) * out


def sigma_scale(intensity) -> np.ndarray:
    """中央値の震度に応じてばらつきを縮める倍率。

    強い揺れでは地盤が非線形化して増幅が頭打ちになり、観測点ごとの差が
    縮まる。震度 4 までは全量、震度 6.5 以上では 0.4 倍とし、その間を直線で結ぶ。
    """
    x = np.asarray(intensity, dtype=float)
    t = (x - SIGMA_FULL) / (SIGMA_FLOOR_AT - SIGMA_FULL)
    return np.clip(1.0 - (1.0 - SIGMA_FLOOR) * t, SIGMA_FLOOR, 1.0)


def intensity_residual(
    lat,
    lon,
    seed: int,
    phi_site: float = PHI_SITE,
    phi_path: float = PHI_PATH,
    corr_km: float = CORR_LEN_KM,
    median_intensity=None,
) -> np.ndarray:
    """計測震度に加える残差 [震度単位]。

    median_intensity を渡すと、その震度に応じて振幅依存の σ を掛ける。
    """
    site = site_terms(lat, lon)
    path = path_field(lat, lon, seed, corr_km=corr_km) if phi_path > 0 else 0.0
    out = phi_site * site + phi_path * path
    if median_intensity is not None:
        out = out * sigma_scale(median_intensity)
    return out


def acceleration_gain(residual) -> np.ndarray:
    """震度残差を加速度波形に掛ける倍率へ直す。

    計測震度は I = 2*log10(a0) + 0.94 なので、加速度を f 倍すると
    震度は 2*log10(f) だけ動く。
    """
    return 10.0 ** (np.asarray(residual, dtype=float) / 2.0)


def pgv_gain(residual) -> np.ndarray:
    """震度残差を PGV に掛ける倍率へ直す (I = 2.68 + 1.72*log10(PGV))。"""
    return 10.0 ** (np.asarray(residual, dtype=float) / 1.72)
