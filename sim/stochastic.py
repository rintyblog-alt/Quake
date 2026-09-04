"""確率論的地震動合成 (Boore の stochastic method).

各観測点の 3 成分加速度波形を、次の要素の積で表される振幅スペクトルと
ランダム位相から合成する::

    A(f) = C * S(f) * G(R) * exp(-pi*f*R/(Q(f)*v)) * Amp_site(f) * exp(-pi*kappa*f)

* S(f)  : omega^2 震源スペクトル
* G(R)  : 幾何減衰 (三折れ線)
* Q(f)  : 非弾性減衰 (Q = Q0 * f^eta)
* kappa : 高周波遮断

有限断層は小断層に分割し、各小断層の破壊時刻と走時による遅れを与えて
時間領域で重ね合わせる (EXSIM 系の手法)。P 波パケットと S 波パケットを
別々に合成するため、P 波初動が先行して到達する時刻歴が得られる。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .geo import haversine_array
from .gmpe import boore_site_amplification
from .source import FiniteFault
from .velocity import VelocityModel, travel_time

# 震源スペクトルの定数
RADIATION_S = 0.55  # S 波の平均輻射係数
RADIATION_P = 0.52  # P 波の平均輻射係数
FREE_SURFACE = 2.0  # 自由表面での増幅
PARTITION = 1.0 / np.sqrt(2.0)  # 水平 2 成分への分配

# 幾何減衰の折れ点 [km]
R1, R2 = 70.0, 130.0

# 幾何減衰の型: "trilinear" (三折れ線) または "inverse_r" (1/R 一様)
SPREADING_MODE = "trilinear"


@dataclass
class PathParameters:
    """伝播経路と観測点近傍のパラメータ。"""

    q0: float = 250.0  # Q = q0 * f^eta
    q_eta: float = 0.75
    kappa: float = 0.025  # 高周波遮断パラメータ [s]
    stress_drop_bar: float | None = None  # None なら震源種別の既定値
    duration_path_coeff: float = 0.05  # 経路による継続時間の伸び [s/km]
    max_source_duration: float = 22.0  # 震源継続時間の上限 [s]


def geometric_spreading(r_km: np.ndarray, mode: str | None = None) -> np.ndarray:
    """幾何減衰。

    mode="trilinear" は Atkinson & Boore (1995) の三折れ線、
    mode="inverse_r" は全距離で 1/R とする。
    """
    r = np.maximum(np.asarray(r_km, dtype=float), 1.0)
    if (mode or SPREADING_MODE) == "inverse_r":
        return 1.0 / r
    g = np.where(r <= R1, 1.0 / r, 0.0)
    mid = (r > R1) & (r <= R2)
    g = np.where(mid, 1.0 / R1, g)
    far = r > R2
    g = np.where(far, (1.0 / R1) * np.sqrt(R2 / np.maximum(r, 1e-6)), g)
    return g


def anelastic_attenuation(
    freq: np.ndarray, r_km: np.ndarray, velocity: float, q0: float, q_eta: float
) -> np.ndarray:
    """非弾性減衰 exp(-pi*f*R/(Q(f)*v))。freq: (nf,), r_km: (ns,1) を想定。"""
    f = np.maximum(np.asarray(freq, dtype=float), 1e-6)
    q = np.maximum(q0 * f**q_eta, 1.0)
    return np.exp(-np.pi * f * np.asarray(r_km) / (q * velocity))


def brune_spectrum(freq: np.ndarray, m0_dyne_cm: float, fc: float) -> np.ndarray:
    """omega^2 震源による加速度スペクトル形状 (定数 C を除く)。"""
    f = np.asarray(freq, dtype=float)
    return m0_dyne_cm * (2.0 * np.pi * f) ** 2 / (1.0 + (f / fc) ** 2)


def saragoni_hart_window(
    t: np.ndarray, duration: np.ndarray, eps: float = 0.2, eta: float = 0.05
) -> np.ndarray:
    """Saragoni & Hart (1974) 型の時間窓 (Boore 2003 のパラメータ化)。

    t: (ns, n) の相対時刻 [s] (到達時刻を 0 とする)
    duration: (ns, 1) の継続時間 [s]
    """
    tn = 2.0 * np.asarray(duration)
    b = -eps * np.log(eta) / (1.0 + eps * (np.log(eps) - 1.0))
    c = b / eps
    a = (np.exp(1.0) / eps) ** b
    x = np.clip(t / np.maximum(tn, 1e-6), 0.0, None)
    w = a * np.where(x > 0, x, 0.0) ** b * np.exp(-c * x)
    return np.where((t >= 0.0) & (t <= 3.0 * tn), w, 0.0)


class StochasticSimulator:
    """有限断層から観測点群の 3 成分加速度波形を合成する。"""

    def __init__(
        self,
        fault: FiniteFault,
        model: VelocityModel | None = None,
        path: PathParameters | None = None,
        dt: float = 0.01,
        max_subfaults: int = 120,
        far_field_factor: float = 4.0,
        seed: int = 20260101,
    ) -> None:
        self.fault = fault
        self.model = model or VelocityModel()
        self.path = path or PathParameters()
        self.dt = float(dt)
        self.far_field_factor = float(far_field_factor)
        self.rng = np.random.default_rng(seed)

        # 距離に応じて使い分ける多重解像度の小断層セット
        self.levels = []
        for target in (max_subfaults, max(4, max_subfaults // 4), 1):
            level = self._coarse_subfaults(target)
            if not self.levels or level["n"] < self.levels[-1]["n"]:
                self.levels.append(level)
        self._use_level(0)

        # 波形の裾: 震源継続時間 + 経路による伸び + 余裕
        self.stress_drop = self.path.stress_drop_bar or fault.stress_drop
        self.rupture_seconds = float(fault.total_rupture_duration)

    # -- 断層の粗視化 --------------------------------------------------
    def _coarse_subfaults(self, max_subfaults: int) -> dict:
        """波形合成用に小断層を粗視化する (モーメントと幾何は保存する)。

        粗視化しすぎると 1 個の小断層が大きくなり、その中心までの距離で
        近距離の振幅を評価することになって過小評価につながる。一方で遠方では
        断層の内部構造は分解できないため、粗い分割で十分になる。
        """
        f = self.fault
        n_l, n_w = f.n_along, f.n_down
        if n_l * n_w <= max_subfaults:
            idx_groups = [[i] for i in range(f.n_sub)]
        elif max_subfaults <= 1:
            idx_groups = [list(range(f.n_sub))]
        else:
            ratio = n_l / n_w
            c_w = max(1, int(round(np.sqrt(max_subfaults / max(ratio, 1e-6)))))
            c_w = min(c_w, n_w)
            c_l = max(1, min(n_l, max_subfaults // c_w))
            grid = np.arange(f.n_sub).reshape(n_l, n_w)
            l_edges = np.linspace(0, n_l, c_l + 1).astype(int)
            w_edges = np.linspace(0, n_w, c_w + 1).astype(int)
            idx_groups = []
            for a in range(c_l):
                for b in range(c_w):
                    block = grid[l_edges[a] : l_edges[a + 1], w_edges[b] : w_edges[b + 1]]
                    if block.size:
                        idx_groups.append(block.ravel().tolist())

        lat, lon, dep, delay, mom = [], [], [], [], []
        for g in idx_groups:
            g = np.asarray(g, dtype=int)
            w = f.sub_moment[g]
            wsum = float(w.sum())
            lat.append(float((f.sub_lat[g] * w).sum() / wsum))
            lon.append(float((f.sub_lon[g] * w).sum() / wsum))
            dep.append(float((f.sub_depth[g] * w).sum() / wsum))
            delay.append(float(f.sub_delay[g].min()))
            mom.append(wsum)

        return {
            "n": len(idx_groups),
            "lat": np.array(lat),
            "lon": np.array(lon),
            "depth": np.array(dep),
            "delay": np.array(delay),
            "moment": np.array(mom),
        }

    def _use_level(self, index: int) -> None:
        """指定した解像度の小断層セットを現在のものにする。"""
        level = self.levels[index]
        self.sub_lat = level["lat"]
        self.sub_lon = level["lon"]
        self.sub_depth = level["depth"]
        self.sub_delay = level["delay"]
        self.sub_moment = level["moment"]
        self.n_coarse = level["n"]

    def _level_for_distance(self, r_near: float) -> int:
        """観測点までの最短距離から、使う小断層の解像度を選ぶ。

        小断層 1 個の代表寸法 sqrt(S/n) が観測点までの距離の 1/3 以下に
        収まれば、その小断層を点震源とみなしても近距離の振幅を大きく
        取りこぼさない。この条件を満たす最も粗い解像度を選ぶことで、
        遠方の観測点の計算量を落とす。
        """
        r = max(float(r_near), 1.0)
        needed = 9.0 * self.fault.area_km2 / (r * r)
        for i, level in enumerate(self.levels):
            if level["n"] >= needed:
                # 条件を満たす中で最も粗いものを使う
                for j in range(len(self.levels) - 1, i - 1, -1):
                    if self.levels[j]["n"] >= needed:
                        return j
                return i
        return 0

    # -- 到達時刻 ------------------------------------------------------
    def arrivals(self, lat: np.ndarray, lon: np.ndarray) -> dict:
        """各観測点の P/S 初動到達時刻 [s] と最短震源距離 [km]。"""
        lat = np.asarray(lat, dtype=float)
        lon = np.asarray(lon, dtype=float)
        t_p = np.full(lat.size, np.inf)
        t_s = np.full(lat.size, np.inf)
        r_min = np.full(lat.size, np.inf)
        for i in range(self.n_coarse):
            epi = haversine_array(float(self.sub_lat[i]), float(self.sub_lon[i]), lat, lon)
            depth_i = float(self.sub_depth[i])
            r_min = np.minimum(r_min, np.sqrt(epi**2 + depth_i**2))
            t_p = np.minimum(t_p, self.sub_delay[i] + travel_time(self.model, depth_i, "P").time(epi))
            t_s = np.minimum(t_s, self.sub_delay[i] + travel_time(self.model, depth_i, "S").time(epi))
        return {"t_p": t_p, "t_s": t_s, "r_min": r_min}

    # -- スペクトル ----------------------------------------------------
    def _amplitude_spectrum(
        self, freq: np.ndarray, r_km: np.ndarray, m0_nm: float, site_amp: np.ndarray, phase: str
    ) -> tuple[np.ndarray, float]:
        """(ns, nf) の加速度振幅スペクトル [gal*s] とコーナー周波数を返す。"""
        depth_ref = float(np.median(self.sub_depth))
        if phase == "S":
            v = float(self.model.vs(depth_ref))
            rad = RADIATION_S
        else:
            v = float(self.model.vp(depth_ref))
            rad = RADIATION_P
        rho = float(self.model.density(depth_ref))

        m0_dyne_cm = m0_nm * 1e7
        fc = 4.9e6 * v * (self.stress_drop / m0_dyne_cm) ** (1.0 / 3.0)

        r = np.asarray(r_km, dtype=float)[:, None]
        const = rad * PARTITION * FREE_SURFACE / (4.0 * np.pi * rho * v**3) * 1e-20
        source = brune_spectrum(freq, m0_dyne_cm, fc)[None, :]
        geom = geometric_spreading(r)
        atten = anelastic_attenuation(freq, r, v, self.path.q0, self.path.q_eta)
        high_cut = np.exp(-np.pi * self.path.kappa * freq)[None, :]

        return const * source * geom * atten * high_cut * site_amp, float(fc)

    def _site_amplification(self, avs30: np.ndarray, freq: np.ndarray) -> np.ndarray:
        """観測点ごとの周波数依存サイト増幅 (ns, nf)。"""
        avs30 = np.asarray(avs30, dtype=float)
        site = np.empty((avs30.size, freq.size))
        for i, a in enumerate(avs30):
            site[i] = boore_site_amplification(freq, float(a))
        return site

    def _packet(
        self,
        arrival: np.ndarray,
        duration: np.ndarray,
        spectrum: np.ndarray,
        time_axis: np.ndarray,
        nfft: int,
    ) -> np.ndarray:
        """到達時刻・継続時間・振幅スペクトルから 3 成分の時刻歴 (3, ns, n) を作る。

        3 成分は独立なランダム位相を持つ (高周波の非干渉な重ね合わせ)。
        """
        ns = arrival.size
        n = time_axis.size
        t_rel = time_axis[None, :] - arrival[:, None]
        window = saragoni_hart_window(t_rel, duration[:, None])
        wnorm = np.sqrt(np.maximum((window**2).mean(axis=1, keepdims=True), 1e-30))
        window = window / wnorm

        padded = np.zeros((3 * ns, nfft))
        noise = self.rng.standard_normal((3 * ns, n))
        padded[:, :n] = noise * np.tile(window, (3, 1))
        spec = np.fft.rfft(padded, axis=-1)
        rms = np.sqrt(np.maximum((np.abs(spec) ** 2).mean(axis=-1, keepdims=True), 1e-30))
        # spectrum は物理フーリエ振幅スペクトル [gal*s]。numpy の DFT 係数へは
        # dt で割って変換する (FS(f) = dt * X_k)。
        spec = spec / rms * np.tile(spectrum, (3, 1)) / self.dt
        wave = np.fft.irfft(spec, n=nfft, axis=-1)[:, :n]
        return wave.reshape(3, ns, n)

    # -- 合成 ----------------------------------------------------------
    def simulate(
        self,
        lat: np.ndarray,
        lon: np.ndarray,
        avs30: np.ndarray,
        on_chunk,
        chunk: int = 256,
        tail_seconds: float = 45.0,
        progress=None,
    ) -> dict:
        """観測点群の 3 成分加速度波形を合成し、チャンクごとに処理を委ねる。

        観測点を震源距離順に並べてチャンク化し、各チャンクは自身の P 初動に
        揃えた局所時間軸で合成する。これにより遠方の観測点でも短い時間窓で
        済み、全国規模でも実用的な計算量になる。

        on_chunk(indices, acc, t_ref, dt) が各チャンクで呼ばれる。
        acc は (ns, 3, n) の加速度 [gal] (南北・東西・上下)、
        t_ref は局所時間軸の原点 (発震時からの秒)。
        """
        lat = np.asarray(lat, dtype=float)
        lon = np.asarray(lon, dtype=float)
        avs30 = np.asarray(avs30, dtype=float)

        self._use_level(0)
        arr = self.arrivals(lat, lon)
        order = np.argsort(arr["r_min"])

        # 解像度ごとに走時表を用意しておく
        tt_by_level = [
            [
                (travel_time(self.model, float(d), "P"), travel_time(self.model, float(d), "S"))
                for d in level["depth"]
            ]
            for level in self.levels
        ]

        for c0 in range(0, order.size, chunk):
            idx = order[c0 : c0 + chunk]
            clat, clon = lat[idx], lon[idx]

            t_ref = float(arr["t_p"][idx].min()) - 3.0
            r_max = float(arr["r_min"][idx].max())
            span = float(arr["t_s"][idx].max()) - t_ref
            local_seconds = span + self.rupture_seconds + tail_seconds + 0.06 * r_max
            n = int(np.ceil(local_seconds / self.dt))
            nfft = int(2 ** np.ceil(np.log2(max(n, 64))))
            time_axis = np.arange(n) * self.dt
            freq = np.fft.rfftfreq(nfft, d=self.dt)

            site = self._site_amplification(avs30[idx], freq)
            buf = np.zeros((3, idx.size, n))

            # 距離に応じて小断層の解像度を落とす (遠方ほど粗く)
            li = self._level_for_distance(float(arr["r_min"][idx].min()))
            level = self.levels[li]
            tt = tt_by_level[li]

            for i in range(level["n"]):
                s_lat, s_lon = float(level["lat"][i]), float(level["lon"][i])
                depth_i = float(level["depth"][i])
                delay_i = float(level["delay"][i])
                m0_i = float(level["moment"][i])
                tt_p, tt_s = tt[i]

                epi = haversine_array(s_lat, s_lon, clat, clon)
                r = np.sqrt(epi**2 + depth_i**2)
                arr_p = delay_i + tt_p.time(epi) - t_ref
                arr_s = delay_i + tt_s.time(epi) - t_ref
                spec_s, fc_s = self._amplitude_spectrum(freq, r, m0_i, site, "S")
                spec_p, fc_p = self._amplitude_spectrum(freq, r, m0_i, site, "P")

                cap = self.path.max_source_duration
                src_s = min(1.0 / fc_s, cap)
                src_p = min(0.5 / fc_p, cap * 0.5)
                dur_s = src_s + self.path.duration_path_coeff * r
                dur_p = src_p + 0.5 * self.path.duration_path_coeff * r

                # S 波は水平動が主、P 波は上下動が主
                pk_s = self._packet(arr_s, dur_s, spec_s, time_axis, nfft)
                buf[0] += pk_s[0]
                buf[1] += pk_s[1]
                buf[2] += 0.55 * pk_s[2]

                pk_p = self._packet(arr_p, dur_p, spec_p, time_axis, nfft)
                buf[0] += 0.5 * pk_p[0]
                buf[1] += 0.5 * pk_p[1]
                buf[2] += pk_p[2]

            on_chunk(idx, np.transpose(buf, (1, 0, 2)), t_ref, self.dt)
            if progress is not None:
                progress(min(c0 + chunk, order.size), order.size)

        return arr

    def synthesize(
        self, lat: np.ndarray, lon: np.ndarray, avs30: np.ndarray, chunk: int = 256
    ) -> tuple[np.ndarray, dict]:
        """全観測点の波形を共通の絶対時間軸に並べて返す (小規模な検証用)。

        観測点数が多い場合はメモリを大量に消費するため simulate() を使うこと。
        """
        arr = self.arrivals(lat, lon)
        total = float(arr["t_s"].max()) + self.rupture_seconds + 60.0 + 0.06 * float(
            arr["r_min"].max()
        )
        n = int(np.ceil(total / self.dt))
        out = np.zeros((np.size(lat), 3, n), dtype=np.float32)

        def place(idx, acc, t_ref, dt):
            off = int(round(t_ref / dt))
            a0 = max(off, 0)
            b0 = a0 - off
            length = min(acc.shape[-1] - b0, n - a0)
            if length > 0:
                out[idx, :, a0 : a0 + length] = acc[:, :, b0 : b0 + length]

        self.simulate(lat, lon, avs30, place, chunk=chunk)
        meta = dict(arr)
        meta.update({"dt": self.dt, "n_samples": n,
                     "n_coarse_subfaults": self.levels[0]["n"]})
        return out, meta
