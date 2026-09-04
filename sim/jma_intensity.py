"""気象庁の計測震度算出.

「計測震度の算出方法」(気象庁告示) に定められた手順をそのまま実装する。

1. 3 成分 (南北・東西・上下) の加速度波形をフーリエ変換する
2. 周期の効果・ハイカット・ローカットの各フィルタを掛ける
3. 逆フーリエ変換して 3 成分の時刻歴に戻す
4. 各時刻で 3 成分をベクトル合成する
5. 合成加速度の絶対値が a0 以上となる時間の合計が 0.3 秒となる a0 を求める
6. I = 2 * log10(a0) + 0.94 を計算し、小数第 3 位を四捨五入して
   小数第 2 位を切り捨て、小数第 1 位までの値とする
"""

from __future__ import annotations

from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal

import numpy as np

# フィルタ定数
HIGH_CUT_FC = 10.0  # ハイカットフィルタの基準周波数 [Hz]
LOW_CUT_F0 = 0.5  # ローカットフィルタの基準周波数 [Hz]
DURATION_THRESHOLD = 0.3  # 積算時間のしきい値 [s]

# 震度階級の下限値 (計測震度)
SHINDO_BANDS: list[tuple[float, str]] = [
    (6.5, "7"),
    (6.0, "6強"),
    (5.5, "6弱"),
    (5.0, "5強"),
    (4.5, "5弱"),
    (3.5, "4"),
    (2.5, "3"),
    (1.5, "2"),
    (0.5, "1"),
    (-float("inf"), "0"),
]


def jma_filter(freq: np.ndarray) -> np.ndarray:
    """計測震度用のフィルタ特性 (周期効果 x ハイカット x ローカット)。

    freq: 周波数 [Hz] の配列 (0 を含んでよい)
    """
    f = np.abs(np.asarray(freq, dtype=float))
    out = np.zeros_like(f)
    nz = f > 0.0
    fz = f[nz]

    # 周期の効果 (加速度を実効的に速度寄りへ補正する)
    period_effect = np.sqrt(1.0 / fz)

    # ハイカットフィルタ
    y = fz / HIGH_CUT_FC
    high_cut = 1.0 / np.sqrt(
        1.0
        + 0.694 * y**2
        + 0.241 * y**4
        + 0.0557 * y**6
        + 0.009664 * y**8
        + 0.00134 * y**10
        + 0.000155 * y**12
    )

    # ローカットフィルタ
    low_cut = np.sqrt(1.0 - np.exp(-((fz / LOW_CUT_F0) ** 3)))

    out[nz] = period_effect * high_cut * low_cut
    return out


def apply_jma_filter(acc: np.ndarray, dt: float) -> np.ndarray:
    """加速度波形に計測震度用フィルタを適用する。

    acc: (n,) または (n_comp, n) の加速度波形 [gal]
    dt : サンプリング間隔 [s]
    """
    a = np.asarray(acc, dtype=float)
    single = a.ndim == 1
    if single:
        a = a[None, :]

    n = a.shape[-1]
    spec = np.fft.rfft(a, axis=-1)
    freq = np.fft.rfftfreq(n, d=dt)
    filtered = np.fft.irfft(spec * jma_filter(freq)[None, :], n=n, axis=-1)
    return filtered[0] if single else filtered


def composite_acceleration(acc3: np.ndarray, dt: float) -> np.ndarray:
    """3 成分加速度にフィルタを掛けてベクトル合成した波形 [gal] を返す。

    acc3: (3, n) の加速度波形 (南北・東西・上下の順、単位 gal)
    """
    a = np.asarray(acc3, dtype=float)
    if a.ndim != 2 or a.shape[0] != 3:
        raise ValueError("acc3 は (3, n) の配列である必要があります")
    filtered = apply_jma_filter(a, dt)
    return np.sqrt((filtered**2).sum(axis=0))


def a0_from_composite(composite: np.ndarray, dt: float) -> float:
    """合成加速度から a0 (総継続時間が 0.3 秒となる振幅) を求める [gal]。

    降順ソートした振幅列の、累積時間が 0.3 秒に達する位置の値を取る。
    """
    a = np.asarray(composite, dtype=float)
    if a.size == 0:
        return 0.0
    need = int(np.floor(DURATION_THRESHOLD / dt))
    if need < 1:
        need = 1
    if a.size < need:
        return 0.0
    # 上位 need 個目の値が、その値以上である時間が 0.3 秒となる振幅
    part = np.partition(a, a.size - need)
    return float(part[a.size - need])


def instrumental_intensity(acc3: np.ndarray, dt: float) -> float:
    """3 成分加速度波形 [gal] から計測震度を算出する。"""
    comp = composite_acceleration(acc3, dt)
    a0 = a0_from_composite(comp, dt)
    return intensity_from_a0(a0)


def intensity_from_a0(a0: float) -> float:
    """a0 [gal] から計測震度を算出する (丸め処理込み)。"""
    if a0 <= 0.0:
        return -3.0
    raw = 2.0 * np.log10(a0) + 0.94
    return round_intensity(raw)


def round_intensity(value: float) -> float:
    """小数第 3 位を四捨五入し、小数第 2 位を切り捨てて小数第 1 位までとする。"""
    d = Decimal(repr(float(value))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return float(d.quantize(Decimal("0.1"), rounding=ROUND_DOWN))


def shindo_class(intensity: float) -> str:
    """計測震度から震度階級 (0,1,2,3,4,5弱,5強,6弱,6強,7) を返す。"""
    for lower, name in SHINDO_BANDS:
        if intensity >= lower:
            return name
    return "0"


def shindo_index(intensity: float) -> int:
    """震度階級を 0..9 の整数インデックスで返す (5弱=5, 5強=6, ... 7=9)。"""
    order = ["0", "1", "2", "3", "4", "5弱", "5強", "6弱", "6強", "7"]
    return order.index(shindo_class(intensity))


def intensity_from_pgv(pgv_cm_s: np.ndarray | float) -> np.ndarray | float:
    """最大速度 PGV [cm/s] から計測震度への換算 (藤本・翠川, 2005)。

        I = 2.68 + 1.72 * log10(PGV)

    波形合成を行わない簡易評価や、合成結果の妥当性確認に用いる。
    """
    v = np.maximum(np.asarray(pgv_cm_s, dtype=float), 1e-6)
    return 2.68 + 1.72 * np.log10(v)


def pgv_from_intensity(intensity: np.ndarray | float) -> np.ndarray | float:
    """計測震度から PGV [cm/s] への逆換算 (藤本・翠川, 2005)。"""
    i = np.asarray(intensity, dtype=float)
    return 10.0 ** ((i - 2.68) / 1.72)
