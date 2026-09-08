"""津波の発生判定と津波予報区ごとの予想.

震源が海域の浅い地震である場合に津波を発生させ、気象庁の津波予報区ごとに
予想高さと到達予想時刻を求めて、大津波警報・津波警報・津波注意報・
津波予報 (若干の海面変動) のいずれかを割り当てる。

予想高さは阿部 (1989) の津波マグニチュード関係

    log10 H = Mt - log10(delta) - 5.55

を用いる (H: 最大遡上高 [m]、delta: 震央から沿岸までの距離 [km])。
横ずれ断層は津波を生じにくいため、すべり角に応じた低減を掛ける。

さらに、震源から沿岸までの経路が陸域を横切る予報区は津波が遮蔽される
ものとして除外し、遠距離では球面拡散・分散による追加減衰を与える。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .geo import haversine_array
from .landmask import LandMask

DATA_DIR = Path(__file__).resolve().parent.parent / "web" / "data"

# 津波を発生させる条件
MIN_MAGNITUDE = 6.0
MAX_DEPTH_KM = 60.0

# 津波の実効伝播速度 [km/s] と浅海での減速分 [s]
CELERITY_KM_S = 0.15
SHOALING_DELAY_S = 420.0

# 気象庁が津波警報等を発表するまでの時間 [s]
ISSUE_DELAY_S = 180.0

# 遠距離での追加減衰: H ∝ (delta / REF_DISTANCE_KM)^(-FAR_DECAY)
#
# 2011 年の三陸沖 M9.0 の実績 (宮城 130km で 15〜20m、千葉九十九里 400km で 7m、
# 高知 1100km で 2〜3m、沖縄 1900km で 0.6m) は 1/Δ にほぼ乗る。追加の減衰は
# ごく小さくしないと、遠くの予報区が軒並み過小評価になる。
REF_DISTANCE_KM = 100.0
FAR_DECAY = 0.06

# 回り込みによる減衰: H ∝ (水路の道のり / 直線距離)^(-DETOUR_PENALTY)
#
# 湾の奥や日本海側へは、海峡を抜けたり岬を回り込んだりして届く。そのぶん
# エネルギーが散るので、道のりが直線よりどれだけ長いかで減らす。
DETOUR_PENALTY = 1.2

# 水路探索の粗さ (陸域マスクの格子を何倍にまとめるか)。0.01° x 8 = 0.08° ≒ 9km。
WATER_COARSE = 8

# 発表区分のしきい値 (予想高さ [m])
GRADES = [
    (3.0, "大津波警報", "巨大", 3),
    (1.0, "津波警報", "高い", 2),
    (0.2, "津波注意報", "", 1),
    (0.0, "津波予報", "若干の海面変動", 0),
]

# 発表される予想高さの区分値 [m]
HEIGHT_CLASSES = [(10.0, "10m超"), (10.0, "10m"), (5.0, "5m"), (3.0, "3m"), (1.0, "1m"), (0.2, "0.2m")]


@dataclass
class ZoneForecast:
    """1 つの津波予報区に対する予想。"""

    code: str
    name: str
    grade: str
    grade_level: int
    height_m: float
    height_class: str
    arrival_s: float
    lat: float
    lon: float

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "name": self.name,
            "grade": self.grade,
            "level": self.grade_level,
            "height": round(self.height_m, 2),
            "heightClass": self.height_class,
            "arrival": round(self.arrival_s, 0),
            "lat": self.lat,
            "lon": self.lon,
        }


@dataclass
class TsunamiForecast:
    """津波警報等の全体。"""

    issued_at: float
    max_grade: str
    max_level: int
    zones: list[ZoneForecast] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "issuedAt": round(self.issued_at, 0),
            "maxGrade": self.max_grade,
            "maxLevel": self.max_level,
            "zones": [z.to_dict() for z in self.zones],
        }


def height_class(height_m: float) -> str:
    """予想高さを気象庁の発表区分に丸める。"""
    if height_m > 10.0:
        return "10m超"
    for lo, label in HEIGHT_CLASSES[1:]:
        if height_m >= lo:
            return label
    return "0.2m未満"


def grade_for(height_m: float) -> tuple[str, str, int]:
    for lo, grade, note, level in GRADES:
        if height_m >= lo:
            return grade, note, level
    return "津波予報", "若干の海面変動", 0


def mechanism_factor(rake_deg: float) -> float:
    """すべり角による津波励起の効率。

    海底の上下変位はすべりの傾斜方向成分で決まるため、横ずれ断層 (rake が
    0 度・180 度付近) はほとんど津波を生じない。sin^2 で効かせることで、
    逆断層・正断層との差を実際に近づける。
    """
    return 0.08 + 0.92 * math.sin(math.radians(rake_deg)) ** 2


class TsunamiZones:
    """津波予報区の沿岸データ。"""

    def __init__(self, data_dir: Path | None = None) -> None:
        d = data_dir or DATA_DIR
        payload = json.loads((d / "tsunami_zones.json").read_text(encoding="utf-8"))
        self.zones = payload["zones"]
        try:
            self.landmask: LandMask | None = LandMask(d)
        except (FileNotFoundError, KeyError, ValueError):
            self.landmask = None
        self._grid = None

    # ---------------- 水路距離 ----------------
    #
    # 津波は陸を通り抜けず、岬や島を回り込んで伝わる。直線距離で測ると、
    # 房総をまわって届く静岡や高知が「陸に遮られている」ことになってしまう。
    # 陸域マスクを粗くした海の格子の上で最短経路を解き、その道のりを使う。

    def _water_grid(self):
        """海の粗格子と、格子どうしのつながり (一度だけ作って使い回す)。"""
        if self._grid is not None:
            return self._grid
        if self.landmask is None:
            return None
        from scipy.sparse import coo_matrix

        m = self.landmask
        c = WATER_COARSE
        ni, nj = m.n_lat // c, m.n_lon // c
        land = m.mask[: ni * c, : nj * c].reshape(ni, c, nj, c).mean(axis=(1, 3))
        sea = land <= 0.5                      # 半分以上が海の升目を海とみなす

        # 湖や川、マスクの穴は「陸ではない」だけで外洋につながっていない。
        # そのままだと陸を突っ切る近道ができるので、外周から届くところだけ残す。
        from scipy.ndimage import label

        lab, _ = label(sea)
        edge = np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])
        keep = set(int(v) for v in np.unique(edge) if v)
        sea = np.isin(lab, list(keep))
        step = m.step * c
        lat0 = m.lat_min + step / 2
        lon0 = m.lon_min + step / 2

        idx = -np.ones((ni, nj), dtype=np.int64)
        ii, jj = np.nonzero(sea)
        idx[ii, jj] = np.arange(ii.size)
        lat = lat0 + ii * step
        lon = lon0 + jj * step

        # 8 近傍をつなぐ。1 升の大きさは緯度によって変わる。
        rows, cols, vals = [], [], []
        dy = step * 111.32
        for di, dj in ((0, 1), (1, 0), (1, 1), (1, -1)):
            a = idx[max(0, -di):ni - max(0, di), max(0, -dj):nj - max(0, dj)]
            b = idx[max(0, di):ni - max(0, -di), max(0, dj):nj - max(0, -dj)]
            ok = (a >= 0) & (b >= 0)
            if not ok.any():
                continue
            ai, bi = a[ok], b[ok]
            dx = step * 111.32 * np.cos(np.radians(lat[ai]))
            w = np.hypot(dy * di, dx * dj)
            rows.append(ai); cols.append(bi); vals.append(w)
        rows = np.concatenate(rows); cols = np.concatenate(cols); vals = np.concatenate(vals)
        n = ii.size
        graph = coo_matrix(
            (np.concatenate([vals, vals]),
             (np.concatenate([rows, cols]), np.concatenate([cols, rows]))),
            shape=(n, n),
        ).tocsr()
        self._grid = {"idx": idx, "lat": lat, "lon": lon, "graph": graph,
                      "step": step, "lat0": lat0, "lon0": lon0, "ni": ni, "nj": nj}
        return self._grid

    def _cell_of(self, g, lat: float, lon: float) -> int:
        """緯度経度にいちばん近い海の升目 (無ければ -1)。"""
        i = int((lat - g["lat0"]) / g["step"] + 0.5)
        j = int((lon - g["lon0"]) / g["step"] + 0.5)
        best = -1
        for r in range(0, 3):
            for di in range(-r, r + 1):
                for dj in range(-r, r + 1):
                    if max(abs(di), abs(dj)) != r:
                        continue
                    a, b = i + di, j + dj
                    if 0 <= a < g["ni"] and 0 <= b < g["nj"] and g["idx"][a, b] >= 0:
                        return int(g["idx"][a, b])
            if best >= 0:
                break
        return best

    def water_distances(self, lat: float, lon: float):
        """震源から各海升目までの水路距離 [km]。"""
        g = self._water_grid()
        if g is None:
            return None
        from scipy.sparse.csgraph import dijkstra

        src = self._cell_of(g, lat, lon)
        if src < 0:
            return None
        return g, dijkstra(g["graph"], indices=src)

    def forecast(
        self,
        lat: float,
        lon: float,
        depth_km: float,
        magnitude: float,
        rake_deg: float = 90.0,
        is_offshore: bool = True,
    ) -> TsunamiForecast | None:
        """震源から各予報区の予想高さ・到達時刻を求める。"""
        if not is_offshore or depth_km > MAX_DEPTH_KM or magnitude < MIN_MAGNITUDE:
            return None

        mt = magnitude  # 津波マグニチュードは Mw とほぼ等しいとみなす
        eff = mechanism_factor(rake_deg)

        out: list[ZoneForecast] = []
        wd = self.water_distances(lat, lon)
        g, dist = wd if wd else (None, None)

        for z in self.zones:
            coast = np.array(z["coast"], dtype=float)
            straight = haversine_array(lat, lon, coast[:, 0], coast[:, 1])
            delta = float(max(straight.min(), 10.0))
            k = int(np.argmin(straight))

            if g is not None:
                # 沿岸点のまわりの海升目までの水路距離のうち、いちばん短いもの
                best, bk = math.inf, -1
                for cand in np.argsort(straight)[:60]:
                    cell = self._cell_of(g, float(coast[cand, 0]), float(coast[cand, 1]))
                    if cell >= 0 and dist[cell] < best:
                        best, bk = float(dist[cell]), int(cand)
                if bk >= 0 and math.isfinite(best):
                    # 升目の粗さのぶん、直線距離を下回らないようにする
                    delta = float(max(best, straight[bk] * 0.9, 10.0))
                    k = bk

            h = eff * 10.0 ** (mt - math.log10(delta) - 5.55)
            if delta > REF_DISTANCE_KM:
                h *= (delta / REF_DISTANCE_KM) ** (-FAR_DECAY)
            detour = delta / max(float(straight[k]), 10.0)
            if detour > 1.0:
                h *= detour ** (-DETOUR_PENALTY)
            if h < 0.05:
                continue
            grade, _note, level = grade_for(h)
            arrival = delta / CELERITY_KM_S + SHOALING_DELAY_S
            out.append(
                ZoneForecast(
                    code=z["code"],
                    name=z["name"],
                    grade=grade,
                    grade_level=level,
                    height_m=h,
                    height_class=height_class(h),
                    arrival_s=arrival,
                    lat=float(coast[k, 0]),
                    lon=float(coast[k, 1]),
                )
            )

        if not out:
            return None
        out.sort(key=lambda z: (-z.grade_level, z.arrival_s))
        top = out[0]
        return TsunamiForecast(
            issued_at=ISSUE_DELAY_S,
            max_grade=top.grade,
            max_level=top.grade_level,
            zones=out,
        )
