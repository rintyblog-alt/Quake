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

# 第 1 報を出すまでの条件
#
# 気象庁の規則は 2 点検知だが、実際には震央が海のときほど「1 点目の検知から
# 揺れが広がって、震源とマグニチュードがある程度固まってから」第 1 報が出る。
# 震央の真下に観測点がある直下型はこれまでどおり 2 点で出し、それ以外は
# もう少し点数がそろうのを待つ。待つ点数と上乗せの遅れは報ごとに揺らがせる。
DIRECT_HIT_KM = 35.0              # 震央から最寄り観測点までがこれ以内なら直下とみなす
FIRST_MIN_STATIONS = 2            # 直下のときの検知点数
FIRST_SPREAD_STATIONS = (4, 10)   # 直下でないときに待つ検知点数の範囲
FIRST_EXTRA_DELAY_S = (0.8, 3.5)  # 直下でないときの上乗せの遅れ [s]
FIRST_JITTER_S = (0.1, 0.7)       # 直下でも入れるわずかな揺らぎ [s]

# EEW のマグニチュード推定式 M = log10(A[cm]) + B*log10(R[km]) + C
# 係数は本シミュレータの合成波形 (Mw 6.0-8.0、震源距離 25-200 km) に対して
# 較正した値。実際の EEW と同様、P 波到達直後は振幅が育っておらず M は
# 過小評価となり、報を重ねるごとに上方修正される。
EEW_M_B = 1.00
EEW_M_C = 4.85

# 推定できる規模の上限
#
# EEW はその時点までに届いた P 波しか見ていないので、断層の破壊が続いている
# あいだは規模を小さく見積もる。破壊継続時間は T ≒ 10^(0.5M - 2.9) 秒なので、
# τ 秒ぶんの波形で測れる上限は M ≒ 5.8 + 2*log10(τ) になる。さらに手法自体の
# 頭打ち (振幅が飽和して M8 あたりから伸びない) を重ねる。
# 2011 年三陸沖 (M9.0) は第 1 報 M4.3、最終報でも M8.1 だった。
EEW_WINDOW_C = 5.8
EEW_WINDOW_SLOPE = 2.0
EEW_SAT_M = 7.5
EEW_SAT_SLOPE = 0.30

# 最終報までの長さ。破壊が終わり、警戒した範囲に S 波が回りきるまで出し続ける。
FINAL_BASE_S = 20.0
FINAL_RUPTURE_K = 3.5
FINAL_MAG_K = 6.0
FINAL_MIN_S, FINAL_MAX_S = 25.0, 160.0


def window_magnitude(tau_s: float) -> float:
    """τ 秒ぶんの P 波で測れるマグニチュードの上限。"""
    return EEW_WINDOW_C + EEW_WINDOW_SLOPE * np.log10(max(tau_s, 0.6))


def saturated_magnitude(mw: float) -> float:
    """EEW の手法そのものの頭打ちを掛けた見かけのマグニチュード。"""
    if mw <= EEW_SAT_M:
        return mw
    return EEW_SAT_M + EEW_SAT_SLOPE * (mw - EEW_SAT_M)


def final_report_span(mw: float, rupture_s: float) -> float:
    """第 1 報から最終報までの長さ [s]。"""
    s = FINAL_BASE_S + FINAL_RUPTURE_K * rupture_s + FINAL_MAG_K * max(0.0, mw - 5.0)
    return float(np.clip(s, FINAL_MIN_S, FINAL_MAX_S))


# 警報の発表条件
WARNING_INTENSITY = 4.5  # 予測最大震度 5弱 以上で「警報」
# 予測最大震度が震度 3 に届かないうちは発表しない (気象庁と同じ)。
# 震度 0・1 しか出ない地震で緊急地震速報が鳴るのはおかしい。
FORECAST_MIN_INTENSITY = 2.5
FORECAST_MIN_MAGNITUDE = 3.5     # 震度が届かなくても、この規模なら発表する
FORECAST_GIVEUP_S = 45.0         # ここまでに条件を満たさなければ発表しない
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
        seafloor: np.ndarray | None = None,
    ) -> None:
        self.lat = np.asarray(station_lat, dtype=float)
        self.lon = np.asarray(station_lon, dtype=float)
        self.avs30 = np.asarray(station_avs30, dtype=float)
        self.regions = regions
        self.model = model or VelocityModel()
        self.processing_delay = processing_delay
        self.report_interval = report_interval
        # 直下かどうかは陸の観測点で測る (海底観測点は震央の真上にも並ぶ)
        self.land = None if seafloor is None else ~np.asarray(seafloor, dtype=bool)

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
        source: tuple[float, float] | None = None,
        seed: int = 0,
        true_magnitude: float | None = None,
        rupture_seconds: float = 4.0,
    ) -> list[EEWReport]:
        """検知時刻列から EEW の発表シーケンスを生成する。

        trigger_times : 各観測点の P 波検知時刻 [s] (未検知は inf)
        disp_amplitude: f(station_index, elapsed) -> 変位振幅 [cm] を返す関数
        source        : 震央 (緯度, 経度)。直下かどうかの判定に使う。
        seed          : 第 1 報の待ち方を揺らがせる種
        """
        trig = np.asarray(trigger_times, dtype=float)
        order = np.argsort(trig)
        finite = np.isfinite(trig[order])
        order = order[finite]
        if order.size < 2:
            return []

        reports: list[EEWReport] = []
        stable_count = 0

        # 震央の真下に観測点があるか (直下型かどうか)
        direct = True
        if source is not None:
            d0 = haversine_array(source[0], source[1], self.lat, self.lon)
            if self.land is not None:
                d0 = np.where(self.land, d0, np.inf)
            direct = bool(np.nanmin(d0) <= DIRECT_HIT_KM)

        rng = np.random.default_rng(seed)
        if direct:
            need = FIRST_MIN_STATIONS
            extra = float(rng.uniform(*FIRST_JITTER_S))
        else:
            # 揺れが広がって点数がそろうまで待つ
            need = int(rng.integers(FIRST_SPREAD_STATIONS[0], FIRST_SPREAD_STATIONS[1] + 1))
            extra = float(rng.uniform(*FIRST_EXTRA_DELAY_S))
        need = min(max(need, FIRST_MIN_STATIONS), int(order.size))

        t_first = float(trig[order[need - 1]]) + self.processing_delay + extra
        seed = int(order[0])
        first_arrival = float(trig[order[0]])
        # 見かけの規模の頭打ちと、最終報までの長さ
        sat_cap = saturated_magnitude(true_magnitude) if true_magnitude else 9.5
        span = final_report_span(true_magnitude or 6.0, rupture_seconds)
        final_at = 0.0

        next_t = t_first
        prev_mag = None
        number = 0
        while number < max_reports:
            if not reports and next_t > t_first + FORECAST_GIVEUP_S:
                break          # 小さい地震は結局発表しない
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
            # その時点までに見えている破壊の長さで測れる規模を超えない
            tau = max(next_t - first_arrival, 0.6)
            mag = min(mag, window_magnitude(tau), sat_cap)
            mag = float(np.clip(mag, 2.0, 9.5))
            if not reports and mag < FORECAST_MIN_MAGNITUDE:
                next_t += self.report_interval
                continue

            inten = self.predict_intensity(la, lo, dep, mag, true_kind)
            max_i = round_intensity(float(np.max(inten)))
            if not reports and max_i < FORECAST_MIN_INTENSITY:
                # 震度 3 に届かないうちは第 1 報を出さない。あとで推定が
                # 上がってくれば、そこから発表を始める。
                next_t += self.report_interval
                continue
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

            if len(reports) == 1:
                final_at = next_t + span
            # 破壊が終わり、警戒した範囲に S 波が回りきるまでは出し続ける
            if next_t >= final_at:
                break
            # 推定が動かなくなったら、ある程度の時間が過ぎたところで打ち切る
            if prev_mag is not None and abs(mag - prev_mag) < 0.05:
                stable_count += 1
            else:
                stable_count = 0
            enough = used.size >= min(60, max(12, order.size // 4))
            if (number >= 6 and stable_count >= 4 and enough
                    and next_t - reports[0].issued_at >= span * 0.45):
                break
            prev_mag = mag
            # 初期は 1 秒間隔、その後じわじわ広がる (実際の EEW の発表間隔に倣う)
            next_t += min(12.0, 1.0 + max(0, number - 4) * 1.1)

        if reports:
            reports[-1].is_final = True
        return reports
