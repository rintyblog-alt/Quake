"""シナリオの実行.

震源パラメータから全国の震度観測点における地震動を合成し、
リアルタイム震度の時系列・計測震度・緊急地震速報の発表シーケンス・
余震列・津波予報をまとめて生成する。
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import aftershock as aftershock_mod
from .eew import TRIGGER_GAL, EEWSimulator
from .geo import haversine_array
from .gmpe import arv_from_avs30, si_midorikawa_pgv
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
    max_distance_km: float = 900.0

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
        self.count = len(self.lat)


def gmpe_intensity(
    stations: StationSet, lat: float, lon: float, depth: float, mag: float, kind: str
) -> np.ndarray:
    """距離減衰式による各観測点の計測震度 (余震など簡易評価用)。"""
    epi = haversine_array(lat, lon, stations.lat, stations.lon)
    r = np.sqrt(epi**2 + depth**2)
    pgv = si_midorikawa_pgv(mag, r, depth, kind) * arv_from_avs30(stations.avs30)
    return np.asarray(intensity_from_pgv(pgv))


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

    # 遠方の観測点は震度に寄与しないため除外する
    epi_all = haversine_array(config.lat, config.lon, stations.lat, stations.lon)
    use = np.nonzero(epi_all <= config.max_distance_km)[0]
    if verbose:
        print(f"  対象観測点: {use.size} / {stations.count} 点 (震央距離 {config.max_distance_km:.0f} km 以内)")

    sim = StochasticSimulator(
        fault, model=model, path=PathParameters(), dt=config.dt, seed=config.seed
    )

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
        acc64 = acc.astype(np.float64)
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

    arr = sim.arrivals(stations.lat, stations.lon)

    # -- 緊急地震速報 --
    if verbose:
        print("  緊急地震速報を推定中...", flush=True)
    eew_sim = EEWSimulator(
        stations.lat, stations.lon, stations.avs30, regions, model=model
    )

    def amp_at(station: int, elapsed: float) -> float:
        j = int(np.clip(round(elapsed / 0.5), 0, n_amp - 1))
        return float(amp_curve[station, j])

    reports = eew_sim.run(trigger, amp_at, true_kind=config.kind)

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
            inten = gmpe_intensity(stations, a.lat, a.lon, a.depth_km, a.magnitude, config.kind)
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
        elapsed_s=time.time() - t_start,
    )
    if verbose:
        top = int(np.argmax(final))
        print(f"  最大震度 {shindo_class(final[top])} ({final[top]:.1f}) "
              f"{stations.name[top]} / 計算 {result.elapsed_s:.0f} s")
    return result
