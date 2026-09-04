"""陸域マスク.

都道府県界ポリゴンをラスタ化したビットマップを読み込み、
任意の緯度経度が陸域か海域かを判定する。
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).resolve().parent.parent / "web" / "data"


class LandMask:
    """緯度経度格子上の陸/海判定。"""

    def __init__(self, data_dir: Path | None = None) -> None:
        d = data_dir or DATA_DIR
        payload = json.loads((d / "landmask.json").read_text(encoding="utf-8"))
        self.lat_min = float(payload["lat_min"])
        self.lon_min = float(payload["lon_min"])
        self.lat_max = float(payload["lat_max"])
        self.lon_max = float(payload["lon_max"])
        self.step = float(payload["step"])
        self.n_lat = int(payload["n_lat"])
        self.n_lon = int(payload["n_lon"])
        bits = np.frombuffer(base64.b64decode(payload["bits"]), dtype=np.uint8)
        self.mask = np.unpackbits(bits)[: self.n_lat * self.n_lon].reshape(
            self.n_lat, self.n_lon
        ).astype(bool)

    def is_land(self, lat, lon) -> np.ndarray | bool:
        """緯度経度が陸域かどうか。範囲外は海域とみなす。"""
        la = np.asarray(lat, dtype=float)
        lo = np.asarray(lon, dtype=float)
        i = ((la - self.lat_min) / self.step).astype(int)
        j = ((lo - self.lon_min) / self.step).astype(int)
        ok = (i >= 0) & (i < self.n_lat) & (j >= 0) & (j < self.n_lon)
        out = np.zeros(np.shape(la), dtype=bool)
        if out.ndim == 0:
            return bool(ok and self.mask[int(i), int(j)])
        idx = np.where(ok)
        out[idx] = self.mask[i[idx], j[idx]]
        return out

    def distance_to_coast_km(self, lat: float, lon: float, max_km: float = 400.0) -> float:
        """最寄りの海岸線までの概算距離 [km] (陸域なら 0)。"""
        if self.is_land(lat, lon):
            return 0.0
        # 同心円状に探索し、最初に陸を見つけた半径を返す
        for r in np.arange(5.0, max_km, 5.0):
            az = np.radians(np.arange(0, 360, 6.0))
            dlat = (r / 111.32) * np.cos(az)
            dlon = (r / (111.32 * max(np.cos(np.radians(lat)), 0.05))) * np.sin(az)
            if np.any(self.is_land(lat + dlat, lon + dlon)):
                return float(r)
        return float(max_km)
