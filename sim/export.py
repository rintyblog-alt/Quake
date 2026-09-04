"""シナリオ結果を Web 用 JSON に書き出す.

リアルタイム震度の時系列は観測点数 x 時刻数の大きな配列になるため、
計測震度を 10 倍した int8 に量子化し base64 で埋め込む。
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np

from .jma_intensity import shindo_class
from .scenario import ScenarioResult

FORMAT_VERSION = 1

# 量子化の範囲 (計測震度 x 10)
INTENSITY_SCALE = 10.0
INTENSITY_MIN = -3.0


def _encode_int8(arr: np.ndarray) -> str:
    q = np.clip(np.round(np.asarray(arr) * INTENSITY_SCALE), -128, 127).astype(np.int8)
    return base64.b64encode(q.tobytes()).decode("ascii")


def _encode_int16(arr: np.ndarray, scale: float) -> str:
    q = np.clip(np.round(np.asarray(arr) * scale), -32768, 32767).astype("<i2")
    return base64.b64encode(q.tobytes()).decode("ascii")


def to_payload(result: ScenarioResult) -> dict:
    """Web フロントエンドが読み込む辞書を作る。"""
    cfg = result.config
    origin = cfg.resolved_origin()
    ns, nt = result.realtime.shape

    rt = np.where(np.isfinite(result.realtime), result.realtime, INTENSITY_MIN)
    final = np.where(np.isfinite(result.final), result.final, INTENSITY_MIN)
    t_p = np.where(np.isfinite(result.t_p), result.t_p, -1.0)
    t_s = np.where(np.isfinite(result.t_s), result.t_s, -1.0)

    max_idx = int(np.argmax(final))

    payload = {
        "format": FORMAT_VERSION,
        "meta": {
            "name": cfg.name,
            "generator": "seismic-sim",
            "originTime": origin.isoformat(),
            "computeSeconds": round(result.elapsed_s, 1),
        },
        "source": {
            "lat": cfg.lat,
            "lon": cfg.lon,
            "depth": cfg.depth_km,
            "magnitude": cfg.magnitude,
            "kind": cfg.kind,
            "strike": cfg.strike,
            "dip": cfg.dip,
            "rake": cfg.rake,
            "region": result.region_name,
            "maxIntensity": round(float(final[max_idx]), 1),
            "maxShindo": shindo_class(float(final[max_idx])),
            "fault": result.fault.summary(),
            "rupture": {
                "lat": [round(float(v), 4) for v in result.fault.sub_lat],
                "lon": [round(float(v), 4) for v in result.fault.sub_lon],
                "depth": [round(float(v), 1) for v in result.fault.sub_depth],
                "delay": [round(float(v), 2) for v in result.fault.sub_delay],
            },
        },
        "timeline": {
            "dt": cfg.timeline_dt,
            "count": nt,
            "duration": float(result.times[-1]) if nt else 0.0,
        },
        "stations": {
            "count": ns,
            "encoding": "int8-base64",
            "scale": INTENSITY_SCALE,
            "realtime": _encode_int8(rt.ravel()),
            "final": _encode_int8(final),
            "pga": _encode_int16(result.pga, 10.0),
            "pgv": _encode_int16(result.pgv, 100.0),
            "tp": _encode_int16(t_p, 10.0),
            "ts": _encode_int16(t_s, 10.0),
        },
        "eew": [r.to_dict() for r in result.eew],
        "aftershocks": [a.to_dict() for a in result.aftershocks],
        "tsunami": result.tsunami.to_dict() if result.tsunami is not None else None,
    }
    return payload


def write(result: ScenarioResult, path: Path) -> Path:
    """シナリオ結果を JSON ファイルに書き出す。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(to_payload(result), ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return path


def index_entry(result: ScenarioResult, filename: str) -> dict:
    """シナリオ一覧に載せる要約。"""
    cfg = result.config
    final = np.where(np.isfinite(result.final), result.final, INTENSITY_MIN)
    return {
        "file": filename,
        "name": cfg.name,
        "region": result.region_name,
        "magnitude": cfg.magnitude,
        "depth": cfg.depth_km,
        "kind": cfg.kind,
        "maxIntensity": round(float(final.max()), 1),
        "maxShindo": shindo_class(float(final.max())),
        "originTime": cfg.resolved_origin().isoformat(),
        "tsunami": result.tsunami.max_grade if result.tsunami is not None else None,
        "aftershocks": len(result.aftershocks),
        "reports": len(result.eew),
    }
