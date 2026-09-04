"""波形から地震動指標を計算する.

加速度波形から速度・変位への積分、最大値 (PGA/PGV/PGD)、
そしてリアルタイム震度 (時々刻々の計測震度相当値) を求める。
"""

from __future__ import annotations

import numpy as np

from .jma_intensity import DURATION_THRESHOLD, apply_jma_filter, round_intensity


def highpass(x: np.ndarray, dt: float, fc: float = 0.05) -> np.ndarray:
    """FFT による高域通過フィルタ (積分時のドリフト除去用)。"""
    a = np.asarray(x, dtype=float)
    n = a.shape[-1]
    spec = np.fft.rfft(a, axis=-1)
    f = np.fft.rfftfreq(n, d=dt)
    # 遷移を滑らかにした Butterworth 型の振幅特性
    resp = 1.0 / np.sqrt(1.0 + (np.maximum(f, 1e-9) / fc) ** -8.0)
    return np.fft.irfft(spec * resp, n=n, axis=-1)


def integrate(acc: np.ndarray, dt: float, fc: float = 0.05) -> np.ndarray:
    """加速度 [gal] -> 速度 [cm/s]。台形則で積分し高域通過で基線を補正する。"""
    a = np.asarray(acc, dtype=float)
    v = np.cumsum((a[..., :-1] + a[..., 1:]) * 0.5, axis=-1) * dt
    v = np.concatenate([np.zeros(a.shape[:-1] + (1,)), v], axis=-1)
    return highpass(v, dt, fc)


def peak_ground_motion(acc3: np.ndarray, dt: float) -> dict:
    """3 成分加速度 [gal] から PGA / PGV / PGD を求める。

    水平成分は 2 成分のベクトル合成の最大値を取る。
    """
    a = np.asarray(acc3, dtype=float)
    vel = integrate(a, dt)
    dis = integrate(vel, dt, fc=0.08)
    h_acc = np.sqrt(a[0] ** 2 + a[1] ** 2)
    h_vel = np.sqrt(vel[0] ** 2 + vel[1] ** 2)
    h_dis = np.sqrt(dis[0] ** 2 + dis[1] ** 2)
    return {
        "pga": float(h_acc.max()),
        "pgv": float(h_vel.max()),
        "pgd": float(h_dis.max()),
        "pga_ud": float(np.abs(a[2]).max()),
    }


def realtime_intensity(
    acc3: np.ndarray, dt: float, window_s: float = 1.0, output_dt: float = 1.0
) -> tuple[np.ndarray, np.ndarray]:
    """リアルタイム震度の時系列を求める。

    計測震度と同じフィルタ・ベクトル合成を行い、直近 window_s 秒の中で
    合計 0.3 秒間だけ超える振幅 a0 を各時刻について求めて
    I(t) = 2*log10(a0) + 0.94 とする。

    戻り値は (出力時刻 [s], リアルタイム震度) の組。
    """
    a = np.asarray(acc3, dtype=float)
    filtered = apply_jma_filter(a, dt)
    comp = np.sqrt((filtered**2).sum(axis=0))

    n = comp.size
    win = max(int(round(window_s / dt)), 1)
    need = max(int(np.floor(DURATION_THRESHOLD / dt)), 1)
    step = max(int(round(output_dt / dt)), 1)

    idx = np.arange(win - 1, n, step)
    if idx.size == 0:
        return np.zeros(0), np.zeros(0)

    # 各出力時刻の直近ウィンドウを取り出し、上位 need 番目の値を a0 とする
    starts = idx - win + 1
    windows = comp[starts[:, None] + np.arange(win)[None, :]]
    part = np.partition(windows, win - need, axis=1)
    a0 = part[:, win - need]

    with np.errstate(divide="ignore"):
        inten = 2.0 * np.log10(np.maximum(a0, 1e-6)) + 0.94
    return idx * dt, np.maximum(inten, -3.0)


def realtime_intensity_batch(
    acc: np.ndarray, dt: float, window_s: float = 1.0, output_dt: float = 1.0
) -> tuple[np.ndarray, np.ndarray]:
    """観測点群 (ns, 3, n) に対するリアルタイム震度 (ns, nt)。"""
    a = np.asarray(acc, dtype=float)
    ns = a.shape[0]
    filtered = apply_jma_filter(a.reshape(ns * 3, -1), dt).reshape(ns, 3, -1)
    comp = np.sqrt((filtered**2).sum(axis=1))

    n = comp.shape[-1]
    win = max(int(round(window_s / dt)), 1)
    need = max(int(np.floor(DURATION_THRESHOLD / dt)), 1)
    step = max(int(round(output_dt / dt)), 1)
    idx = np.arange(win - 1, n, step)
    starts = idx - win + 1

    out = np.empty((ns, idx.size))
    # 観測点をまとめてスライスするとメモリを食うため時刻方向に分割する
    block = max(1, int(4_000_000 / max(ns * win, 1)))
    for b0 in range(0, idx.size, block):
        b1 = min(b0 + block, idx.size)
        w = comp[:, starts[b0:b1, None] + np.arange(win)[None, :]]
        part = np.partition(w, win - need, axis=-1)
        a0 = part[..., win - need]
        with np.errstate(divide="ignore"):
            out[:, b0:b1] = 2.0 * np.log10(np.maximum(a0, 1e-6)) + 0.94
    return idx * dt, np.maximum(out, -3.0)


def final_intensity(acc3: np.ndarray, dt: float) -> float:
    """計測震度 (告示どおりの丸め込み済み)。"""
    from .jma_intensity import instrumental_intensity

    return instrumental_intensity(acc3, dt)


def final_intensity_batch(acc: np.ndarray, dt: float) -> np.ndarray:
    """観測点群 (ns, 3, n) の計測震度 (ns,)。"""
    a = np.asarray(acc, dtype=float)
    ns = a.shape[0]
    filtered = apply_jma_filter(a.reshape(ns * 3, -1), dt).reshape(ns, 3, -1)
    comp = np.sqrt((filtered**2).sum(axis=1))
    need = max(int(np.floor(DURATION_THRESHOLD / dt)), 1)
    if comp.shape[-1] < need:
        return np.full(ns, -3.0)
    part = np.partition(comp, comp.shape[-1] - need, axis=-1)
    a0 = part[:, comp.shape[-1] - need]
    with np.errstate(divide="ignore"):
        raw = 2.0 * np.log10(np.maximum(a0, 1e-9)) + 0.94
    return np.array([round_intensity(v) if v > -3.0 else -3.0 for v in raw])
