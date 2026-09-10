"""シナリオの実行.

震源パラメータから全国の震度観測点における地震動を合成し、
リアルタイム震度の時系列・計測震度・緊急地震速報の発表シーケンス・
余震列・津波予報をまとめて生成する。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import aftershock as aftershock_mod
from . import variability
from .eew import TRIGGER_GAL, EEWSimulator
from .geo import haversine_array
from .gmpe import (
    arv_from_avs30,
    long_range_correction,
    magnitude_distance_correction,
    slab_path_bonus,
    si_midorikawa_pga,
    si_midorikawa_pgv,
)
from .jma_intensity import intensity_from_pgv, round_intensity, shindo_class
from .landmask import LandMask
from .metrics import final_intensity_batch, integrate, realtime_intensity_batch
from .regions import EpicenterRegions
from .source import CRUSTAL, FiniteFault
from .stochastic import PathParameters, StochasticSimulator
from .tsunami import TsunamiZones
from .velocity import VelocityModel

DATA_DIR = Path(__file__).resolve().parent.parent / "web" / "data"
JST = timezone(timedelta(hours=9))


@dataclass
class ScenarioConfig:
    """シナリオの入力パラメータ。"""

    name: str
    lat: float
    lon: float
    depth_km: float
    magnitude: float
    kind: str = CRUSTAL
    strike: float = 0.0
    dip: float = 45.0
    rake: float = 90.0
    origin_time: str = ""  # ISO8601 (JST)。空なら実行時刻
    timeline_seconds: float = 300.0
    timeline_dt: float = 1.0
    dt: float = 0.02
    seed: int = 20260101
    with_aftershocks: bool = True
    aftershock_days: float = 3.0
    aftershock_m_min: float = 3.5
    with_tsunami: bool = True
    max_distance_km: float = 900.0  # 波形合成を行う範囲。外側は距離減衰式で埋める

    def resolved_origin(self) -> datetime:
        if self.origin_time:
            return datetime.fromisoformat(self.origin_time)
        return datetime.now(JST).replace(microsecond=0)


class StationSet:
    """震度観測点データ。"""

    def __init__(self, data_dir: Path | None = None) -> None:
        d = data_dir or DATA_DIR
        s = json.loads((d / "stations.json").read_text(encoding="utf-8"))
        self.lat = np.array(s["lat"], dtype=float)
        self.lon = np.array(s["lon"], dtype=float)
        self.avs30 = np.array(s["avs30"], dtype=float)
        self.name = s["name"]
        self.region = np.array(s["region"], dtype=object)
        # 海底地震計 (S-net・DONET 相当)。気象庁は海底で震度を発表しないので、
        # 最大震度や地域の震度には数えない。
        self.seafloor = np.array(s.get("seafloor") or [0] * len(self.lat), dtype=bool)
        self.count = len(self.lat)


def gmpe_intensity(
    stations: StationSet,
    lat: float,
    lon: float,
    depth: float,
    mag: float,
    kind: str,
    residual: np.ndarray | None = None,
) -> np.ndarray:
    """距離減衰式による各観測点の計測震度 (余震など簡易評価用)。"""
    epi = haversine_array(lat, lon, stations.lat, stations.lon)
    r = np.sqrt(epi**2 + depth**2)
    pgv = si_midorikawa_pgv(mag, r, depth, kind) * arv_from_avs30(stations.avs30)
    out = np.asarray(intensity_from_pgv(pgv), dtype=float)
    out = out + magnitude_distance_correction(mag, r)
    out = out + slab_path_bonus(depth, r, stations.lat, stations.lon)
    if residual is not None:
        out = out + residual
    return out


def far_envelope(
    times: np.ndarray,
    peak: np.ndarray,
    t_p: np.ndarray,
    t_s: np.ndarray,
    r_km: np.ndarray,
    rupture_s: float,
) -> np.ndarray:
    """遠方観測点のリアルタイム震度の包絡形 (ns, nt)。

    P 波で本体より 2.5 ほど小さい値まで立ち上がり、S 波で最大に達し、
    震源継続時間と経路による伸びのぶんだけ保ってから減衰する。
    波形合成した観測点の時系列と見た目が揃うように形を合わせてある。
    """
    t = times[None, :]
    tp = t_p[:, None]
    ts = t_s[:, None]
    r = r_km[:, None]
    hold = rupture_s + 0.05 * r + 2.0
    rise = 1.5 + 0.01 * r
    decay = 0.08 + 2.0 / np.maximum(hold, 4.0)
    top = peak[:, None]
    p_level = top - 2.5

    out = np.full((peak.size, times.size), -3.0)
    up = np.clip((t - tp) / 1.2, 0.0, 1.0)
    out = np.where(t >= tp - 0.5, -3.0 + (p_level + 3.0) * up, out)
    out = np.where(t >= ts, p_level + (top - p_level) * np.clip((t - ts) / rise, 0.0, 1.0), out)
    held = t - ts - rise
    out = np.where(t >= ts + rise, top - 0.25 * np.clip(held, 0.0, None) / np.maximum(hold, 1.0), out)
    tail = t - ts - rise - hold
    out = np.where(t >= ts + rise + hold, top - 0.25 - decay * tail, out)
    return np.maximum(out, -3.0)


@dataclass
class ScenarioResult:
    """シナリオの計算結果。"""

    config: ScenarioConfig
    fault: FiniteFault
    region_name: str
    times: np.ndarray
    realtime: np.ndarray  # (ns, nt) リアルタイム震度
    final: np.ndarray  # (ns,) 計測震度
    pga: np.ndarray
    pgv: np.ndarray
    t_p: np.ndarray
    t_s: np.ndarray
    eew: list = field(default_factory=list)
    aftershocks: list = field(default_factory=list)
    tsunami: object | None = None
    seafloor: object | None = None   # 海底観測点の印 (震度の集計から外す)
    elapsed_s: float = 0.0


def run(config: ScenarioConfig, data_dir: Path | None = None, verbose: bool = True) -> ScenarioResult:
    """シナリオを実行する。"""
    t_start = time.time()
    d = data_dir or DATA_DIR
    stations = StationSet(d)
    regions = EpicenterRegions(d)
    landmask = LandMask(d)
    model = VelocityModel()

    fault = FiniteFault(
        lat=config.lat,
        lon=config.lon,
        depth_km=config.depth_km,
        magnitude=config.magnitude,
        strike=config.strike,
        dip=config.dip,
        rake=config.rake,
        kind=config.kind,
        seismogenic_depth_km=20.0 if config.kind == CRUSTAL else 60.0,
    )
    if verbose:
        print(f"  断層: {fault.length_km:.0f} x {fault.width_km:.0f} km, "
              f"小断層 {fault.n_sub} 個, 破壊継続 {fault.total_rupture_duration:.0f} s")

    # 波形合成は近距離に限り、遠方は距離減衰式で埋める (下の far を参照)
    epi_all = haversine_array(config.lat, config.lon, stations.lat, stations.lon)
    use = np.nonzero(epi_all <= config.max_distance_km)[0]
    far = np.nonzero(epi_all > config.max_distance_km)[0]
    if verbose:
        print(f"  波形合成: {use.size} / {stations.count} 点 "
              f"(震央距離 {config.max_distance_km:.0f} km 以内、残り {far.size} 点は距離減衰式)")

    sim = StochasticSimulator(
        fault, model=model, path=PathParameters(), dt=config.dt, seed=config.seed
    )
    arr = sim.arrivals(stations.lat, stations.lon)

    # 中央値の周りのばらつき。これが無いと震度分布が同心円の縞になる。
    # 強い揺れではばらつきを縮めるので、目安の震度を断層最短距離から出して渡す。
    # 深発地震の異常震域 (前弧側はスラブを通ってほとんど減衰しない)
    slab = slab_path_bonus(config.depth_km, arr["r_min"], stations.lat, stations.lon)
    if verbose and float(np.max(slab)) > 0.2:
        print(f"  異常震域: 前弧側で最大 {float(np.max(slab)):+.1f} 震度")

    median_est = np.asarray(
        intensity_from_pgv(
            si_midorikawa_pgv(config.magnitude, arr["r_min"], config.depth_km, config.kind)
            * arv_from_avs30(stations.avs30)
        ),
        dtype=float,
    ) + magnitude_distance_correction(config.magnitude, arr["r_min"]) + slab
    resid = variability.intensity_residual(
        stations.lat, stations.lon, seed=config.seed + 977, median_intensity=median_est
    )
    # 波形の振幅には、ばらつき・異常震域・遠方の補正をまとめて反映させる
    gain = variability.acceleration_gain(resid + slab + long_range_correction(arr["r_min"]))
    # 余震には経路の項を引き直さず、観測点固有の項だけを使う
    site_resid = variability.PHI_SITE * variability.site_terms(stations.lat, stations.lon)

    nt = int(round(config.timeline_seconds / config.timeline_dt))
    times = np.arange(nt) * config.timeline_dt
    realtime = np.full((stations.count, nt), -3.0)
    final = np.full(stations.count, -3.0)
    pga = np.zeros(stations.count)
    pgv = np.zeros(stations.count)
    trigger = np.full(stations.count, np.inf)
    # EEW 用: P 検知後 0.5 s 刻みの変位振幅の推移 (30 s 分)
    n_amp = 60
    amp_curve = np.zeros((stations.count, n_amp))

    def on_chunk(idx, acc, t_ref, dt):
        # 観測点ごとの残差を波形の振幅に反映させる
        acc64 = acc.astype(np.float64) * gain[idx][:, None, None]
        # リアルタイム震度 (局所時間軸) を全体タイムラインへ配置する
        t_local, rt = realtime_intensity_batch(acc64, dt, window_s=1.0, output_dt=config.timeline_dt)
        abs_t = t_local + t_ref
        for k, station in enumerate(idx):
            realtime[station] = np.interp(times, abs_t, rt[k], left=-3.0, right=rt[k][-1])
        final[idx] = final_intensity_batch(acc64, dt)

        horiz = np.sqrt(acc64[:, 0] ** 2 + acc64[:, 1] ** 2)
        pga[idx] = horiz.max(axis=1)
        vel = integrate(acc64, dt)
        pgv[idx] = np.sqrt(vel[:, 0] ** 2 + vel[:, 1] ** 2).max(axis=1)

        # P 波検知時刻と変位振幅の推移
        dis = integrate(vel, dt, fc=0.05)
        dis_h = np.sqrt(dis[:, 0] ** 2 + dis[:, 1] ** 2 + dis[:, 2] ** 2)
        env = np.abs(acc64).max(axis=1)  # (ns, n) 3 成分の絶対値の最大
        exceeded = env >= TRIGGER_GAL
        over = exceeded.any(axis=1)
        first = np.argmax(exceeded, axis=1)
        for k, station in enumerate(idx):
            if not bool(over[k]):
                continue
            j0 = int(first[k])
            trigger[station] = t_ref + j0 * dt
            run_max = np.maximum.accumulate(dis_h[k, j0:])
            step = max(int(round(0.5 / dt)), 1)
            sampled = run_max[::step][:n_amp]
            amp_curve[station, : sampled.size] = sampled
            if sampled.size < n_amp and sampled.size:
                amp_curve[station, sampled.size :] = sampled[-1]

    if verbose:
        print("  地震動を合成中...", flush=True)

    def progress(done, total):
        if verbose and (done % 1024 == 0 or done == total):
            print(f"    {done}/{total} 点", flush=True)

    sim.simulate(
        stations.lat[use], stations.lon[use], stations.avs30[use],
        on_chunk=lambda i, a, t, dt_: on_chunk(use[i], a, t, dt_),
        chunk=256, progress=progress,
    )

    # -- 波形合成の対象外だった遠方の観測点 --
    # 打ち切り距離でいきなり値が消えると、地図上に不自然な円の縁ができる。
    # 遠方は最大震度に効かないので、距離減衰式と包絡形で埋めておく。
    if far.size:
        r_far = np.sqrt(epi_all[far] ** 2 + config.depth_km**2)
        amp_far = arv_from_avs30(stations.avs30[far])
        pgv_far = si_midorikawa_pgv(config.magnitude, r_far, config.depth_km, config.kind) * amp_far
        pga_far = si_midorikawa_pga(config.magnitude, r_far, config.depth_km, config.kind) * amp_far
        i_far = (np.asarray(intensity_from_pgv(pgv_far), dtype=float)
                 + magnitude_distance_correction(config.magnitude, r_far)
                 + slab[far] + resid[far])
        # 打ち切り距離のところで値が飛ぶと、地図に不自然な円の縁ができる。
        # 内側の帯 (波形合成) と外側の帯 (距離減衰式) の中央値を合わせておく。
        inner = np.nonzero(epi_all[use] > config.max_distance_km - 120.0)[0]
        outer = np.nonzero(epi_all[far] < config.max_distance_km + 120.0)[0]
        if inner.size >= 20 and outer.size >= 20:
            step = float(np.median(final[use][inner]) - np.median(i_far[outer]))
            if abs(step) < 3.0:
                i_far = i_far + step
                if verbose:
                    print(f"  打ち切り距離のつなぎ目を {step:+.2f} ずらしました", flush=True)
        final[far] = i_far
        pgv[far] = pgv_far * variability.pgv_gain(resid[far] + slab[far])
        pga[far] = pga_far * gain[far]
        realtime[far] = far_envelope(
            times, i_far, arr["t_p"][far], arr["t_s"][far], arr["r_min"][far],
            fault.total_rupture_duration,
        )

    # -- 緊急地震速報 --
    if verbose:
        print("  緊急地震速報を推定中...", flush=True)
    eew_sim = EEWSimulator(
        stations.lat, stations.lon, stations.avs30, regions, model=model,
        seafloor=stations.seafloor,
    )

    def amp_at(station: int, elapsed: float) -> float:
        j = int(np.clip(round(elapsed / 0.5), 0, n_amp - 1))
        return float(amp_curve[station, j])

    reports = eew_sim.run(trigger, amp_at, true_kind=config.kind,
                          source=(config.lat, config.lon), seed=config.seed + 4231,
                          true_magnitude=config.magnitude,
                          rupture_seconds=fault.total_rupture_duration)

    # -- 余震 --
    shocks = []
    if config.with_aftershocks:
        if verbose:
            print("  余震列を生成中...", flush=True)
        shocks = aftershock_mod.generate(
            fault,
            duration_days=config.aftershock_days,
            m_min=config.aftershock_m_min,
            seed=config.seed + 1,
            regions=regions,
        )
        for a in shocks:
            inten = gmpe_intensity(
                stations, a.lat, a.lon, a.depth_km, a.magnitude, config.kind, residual=site_resid
            )
            a.max_intensity = round_intensity(float(inten.max()))

    # -- 津波 --
    tsu = None
    if config.with_tsunami:
        if verbose:
            print("  津波予報を評価中...", flush=True)
        zones = TsunamiZones(d)
        tsu = zones.forecast(
            config.lat, config.lon, config.depth_km, config.magnitude,
            config.rake, is_offshore=not bool(landmask.is_land(config.lat, config.lon)),
        )

    result = ScenarioResult(
        config=config,
        fault=fault,
        region_name=regions.name_at(config.lat, config.lon),
        times=times,
        realtime=realtime,
        final=final,
        pga=pga,
        pgv=pgv,
        t_p=arr["t_p"],
        t_s=arr["t_s"],
        eew=reports,
        aftershocks=shocks,
        tsunami=tsu,
        seafloor=stations.seafloor,
        elapsed_s=time.time() - t_start,
    )
    if verbose:
        top = int(np.argmax(np.where(stations.seafloor, -99.0, final)))
        print(f"  最大震度 {shindo_class(final[top])} ({final[top]:.1f}) "
              f"{stations.name[top]} / 計算 {result.elapsed_s:.0f} s")
    return result
