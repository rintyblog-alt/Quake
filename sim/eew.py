"""緊急地震速報 (EEW) の逐次推定.

観測点が P 波を検知した順に震源とマグニチュードを推定し直し、
第 1 報から最終報までの発表シーケンスを組み立てる。

* 震源決定 : 検知時刻の残差二乗和を最小にする (緯度, 経度, 深さ, 発震時) を
             グリッドサーチで求める (走時は 1 次元速度構造の走時表による)
* 規模推定 : P 波部分の最大変位振幅と震源距離から M を推定する。
             経過時間が短いほど振幅が育っておらず過小評価となるため、
             実際の EEW と同様に報を重ねるごとに M が上方修正される
* 予測震度 : 推定震源・推定 M から距離減衰式で各地の震度を予測する
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .geo import haversine_array
from .gmpe import arv_from_avs30, si_midorikawa_pgv
from .jma_intensity import intensity_from_pgv, round_intensity, shindo_class
from .velocity import VelocityModel, travel_time

# P 波検知のしきい値 [gal] (加速度の絶対値)
TRIGGER_GAL = 2.0

# EEW のマグニチュード推定式 M = log10(A[cm]) + B*log10(R[km]) + C
# 係数は本シミュレータの合成波形 (Mw 6.0-8.0、震源距離 25-200 km) に対して
# 較正した値。実際の EEW と同様、P 波到達直後は振幅が育っておらず M は
# 過小評価となり、報を重ねるごとに上方修正される。
EEW_M_B = 1.00
EEW_M_C = 4.85

# 警報の発表条件
WARNING_INTENSITY = 4.5  # 予測最大震度 5弱 以上で「警報」
FORECAST_INTENSITY = 2.5  # 予測最大震度 3 以上で「予報」


@dataclass
class EEWReport:
    """1 通の緊急地震速報。"""

    number: int
    issued_at: float  # 発震時からの経過秒
    lat: float
    lon: float
    depth_km: float
    magnitude: float
    max_intensity: float
    region_name: str
    kind: str  # "予報" / "警報"
    is_final: bool
    n_stations: int
    warning_regions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "number": self.number,
            "issuedAt": round(self.issued_at, 2),
            "lat": round(self.lat, 3),
            "lon": round(self.lon, 3),
            "depth": round(self.depth_km, 1),
            "magnitude": round(self.magnitude, 1),
            "maxIntensity": round(self.max_intensity, 1),
            "maxShindo": shindo_class(self.max_intensity),
            "region": self.region_name,
            "kind": self.kind,
            "isFinal": self.is_final,
            "stations": self.n_stations,
            "warningRegions": self.warning_regions,
        }


class EEWSimulator:
    """観測点の検知情報から EEW の発表シーケンスを組み立てる。"""

    def __init__(
        self,
        station_lat: np.ndarray,
        station_lon: np.ndarray,
        station_avs30: np.ndarray,
        regions,
        model: VelocityModel | None = None,
        processing_delay: float = 1.0,
        report_interval: float = 2.0,
    ) -> None:
        self.lat = np.asarray(station_lat, dtype=float)
        self.lon = np.asarray(station_lon, dtype=float)
        self.avs30 = np.asarray(station_avs30, dtype=float)
        self.regions = regions
        self.model = model or VelocityModel()
        self.processing_delay = processing_delay
        self.report_interval = report_interval

    # -- 震源決定 ------------------------------------------------------
    def locate(
        self,
        idx: np.ndarray,
        arrival: np.ndarray,
        seed_lat: float,
        seed_lon: float,
        span_deg: float = 1.6,
        depths: tuple[float, ...] = (5.0, 10.0, 20.0, 30.0, 50.0, 80.0, 120.0),
    ) -> tuple[float, float, float, float, float]:
        """到達時刻からグリッドサーチで震源と発震時を推定する。

        戻り値は (緯度, 経度, 深さ, 発震時, 残差 RMS)。
        """
        best = None
        for level, span in enumerate((span_deg, span_deg / 4.0, span_deg / 16.0)):
            n = 13 if level == 0 else 9
            lat_grid = np.linspace(seed_lat - span, seed_lat + span, n)
            lon_grid = np.linspace(seed_lon - span, seed_lon + span, n)
            for h in depths:
                tt = travel_time(self.model, h, "P")
                for la in lat_grid:
                    dist = haversine_array(la, 0.0, self.lat[idx], np.zeros(idx.size))
                    for lo in lon_grid:
                        epi = haversine_array(la, lo, self.lat[idx], self.lon[idx])
                        pred = tt.time(epi)
                        t0 = float(np.mean(arrival - pred))
                        rms = float(np.sqrt(np.mean((arrival - pred - t0) ** 2)))
                        if best is None or rms < best[4]:
                            best = (float(la), float(lo), float(h), t0, rms)
            if best is not None:
                seed_lat, seed_lon = best[0], best[1]
                depths = tuple(
                    float(np.clip(best[2] * f, 2.0, 600.0)) for f in (0.6, 0.8, 1.0, 1.25, 1.6)
                )
        assert best is not None
        return best

    # -- 規模推定 ------------------------------------------------------
    @staticmethod
    def estimate_magnitude(
        disp_amp_cm: np.ndarray, hypo_dist_km: np.ndarray
    ) -> float:
        """P 波の最大変位振幅と震源距離から M を推定する。"""
        a = np.maximum(np.asarray(disp_amp_cm, dtype=float), 1e-6)
        r = np.maximum(np.asarray(hypo_dist_km, dtype=float), 1.0)
        m = np.log10(a) + EEW_M_B * np.log10(r) + EEW_M_C
        return float(np.median(m))

    # -- 予測震度 ------------------------------------------------------
    def predict_intensity(
        self, lat: float, lon: float, depth: float, magnitude: float, kind: str
    ) -> np.ndarray:
        epi = haversine_array(lat, lon, self.lat, self.lon)
        r = np.sqrt(epi**2 + depth**2)
        pgv600 = si_midorikawa_pgv(magnitude, r, depth, kind)
        pgv = pgv600 * arv_from_avs30(self.avs30)
        return np.asarray(intensity_from_pgv(pgv))

    # -- 発表シーケンス ------------------------------------------------
    def run(
        self,
        trigger_times: np.ndarray,
        disp_amplitude,
        true_kind: str = "crustal",
        max_reports: int = 20,
    ) -> list[EEWReport]:
        """検知時刻列から EEW の発表シーケンスを生成する。

        trigger_times : 各観測点の P 波検知時刻 [s] (未検知は inf)
        disp_amplitude: f(station_index, elapsed) -> 変位振幅 [cm] を返す関数
        """
        trig = np.asarray(trigger_times, dtype=float)
        order = np.argsort(trig)
        finite = np.isfinite(trig[order])
        order = order[finite]
        if order.size < 2:
            return []

        reports: list[EEWReport] = []
        stable_count = 0
        # 第 1 報は 2 点目の検知 + 処理遅延
        t_first = float(trig[order[1]]) + self.processing_delay
        seed = int(order[0])

        next_t = t_first
        prev_mag = None
        number = 0
        while number < max_reports:
            used = order[trig[order] <= next_t - self.processing_delay]
            if used.size < 2:
                next_t += self.report_interval
                continue

            la, lo, dep, t0, _rms = self.locate(
                used, trig[used], self.lat[seed], self.lon[seed]
            )
            epi = haversine_array(la, lo, self.lat[used], self.lon[used])
            r = np.sqrt(epi**2 + dep**2)
            elapsed = np.maximum(next_t - trig[used], 0.0)
            amp = np.array(
                [disp_amplitude(int(i), float(e)) for i, e in zip(used, elapsed)]
            )
            mag = self.estimate_magnitude(amp, r)
            mag = float(np.clip(mag, 2.0, 9.5))

            inten = self.predict_intensity(la, lo, dep, mag, true_kind)
            max_i = round_intensity(float(np.max(inten)))
            kind = "警報" if max_i >= WARNING_INTENSITY else "予報"

            warn_regions: list[str] = []
            if kind == "警報":
                hot = np.where(inten >= WARNING_INTENSITY)[0]
                seen = []
                for i in hot[np.argsort(-inten[hot])]:
                    code = self.regions.station_region[i]
                    reg = self.regions.by_code.get(code)
                    if reg and reg.name not in seen:
                        seen.append(reg.name)
                    if len(seen) >= 12:
                        break
                warn_regions = seen

            number += 1
            reports.append(
                EEWReport(
                    number=number,
                    issued_at=next_t,
                    lat=la,
                    lon=lo,
                    depth_km=dep,
                    magnitude=round(mag, 1),
                    max_intensity=max_i,
                    region_name=self.regions.name_at(la, lo),
                    kind=kind,
                    is_final=False,
                    n_stations=int(used.size),
                    warning_regions=warn_regions,
                )
            )

            # 推定が安定し、十分な観測点が集まったら最終報
            if prev_mag is not None and abs(mag - prev_mag) < 0.15:
                stable_count += 1
            else:
                stable_count = 0
            enough = used.size >= min(60, max(12, order.size // 4))
            if number >= 6 and stable_count >= 2 and enough:
                break
            prev_mag = mag
            # 初期は 1 秒間隔、その後は間隔を広げる (実際の EEW の発表間隔に倣う)
            next_t += self.report_interval if number >= 5 else 1.0

        if reports:
            reports[-1].is_final = True
        return reports
