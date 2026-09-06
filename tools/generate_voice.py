#!/usr/bin/env python3
"""Gemini の音声合成で、地震情報と津波予報の読み上げ音声を作る.

読み上げ文は「地震情報です」「宮城県沖」「最大震度は」「5弱」…のように
部品に分けて合成し、再生時につなげる。こうすることで、設定モードで指定した
任意の震源についても、あらかじめ用意した音声だけで読み上げられる。

    地震情報です。宮城県沖で地震がありました。最大震度は5弱です。
    震源の深さは約 20 キロメートル、地震の規模を示すマグニチュードは
    7.3 と推定されます。

    大津波警報が発表されました。宮城県、岩手県では 10メートル 以上の
    津波が予想されます。ただちに高台へ避難してください。

使い方::

    export GEMINI_API_KEY=...
    python tools/generate_voice.py --scope core     # 定型句・震度・数値のみ (約 110 個)
    python tools/generate_voice.py                  # 地名も含めて全部 (約 480 個)
    python tools/generate_voice.py --limit 5 --dry-run

生成済みの音声は読み飛ばすため、途中で止めても再実行で続きから作れる。
出力は web/sounds/voice/ に 24kHz モノラルの WAV と、対応表 index.json。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"
OUT = ROOT / "web" / "sounds" / "voice"

API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "gemini-2.5-flash-preview-tts"
DEFAULT_VOICE = "Kore"

# 読み上げの口調。テキストの前に置いて話し方を指示する。
STYLE = "落ち着いた、はっきりした声で、防災情報のアナウンスのように読んでください: "

# ---------------------------------------------------------------- 読み上げ文

# 定型句
PHRASES = {
    # 地震情報
    "info_lead": "地震情報です。",
    "info_quake": "で地震がありました。",
    "info_maxshindo": "最大震度は",
    "info_desu": "です。",
    "info_depth_lead": "震源の深さは約",
    "info_km": "キロメートル、",
    "info_mag_lead": "地震の規模を示すマグニチュードは",
    "info_mag_tail": "と推定されます。",
    "info_no_tsunami": "この地震による津波の心配はありません。",
    "info_shallow": "震源の深さはごく浅く、",
    # 津波
    "tsunami_major": "大津波警報が発表されました。",
    "tsunami_warning": "津波警報が発表されました。",
    "tsunami_advisory": "津波注意報が発表されました。",
    "tsunami_forecast": "津波予報が発表されました。",
    "tsunami_zones_lead": "対象は、",
    "tsunami_zones_tail": "です。",
    "tsunami_expect": "では、",
    "tsunami_expect_tail": "の津波が予想されます。",
    "tsunami_evacuate_major": "ただちに高台や避難ビルへ避難してください。",
    "tsunami_evacuate_warning": "ただちに海岸から離れ、高台へ避難してください。",
    "tsunami_evacuate_advisory": "海の中や海岸から離れてください。",
    "tsunami_evacuate_forecast": "若干の海面変動が予想されますが、被害の心配はありません。",
    "tsunami_arrival": "津波の到達が予想されます。",
    # つなぎ
    "conj_and": "、",
    "conj_nado": "など、",
}

# 震度階級
SHINDO = {
    "shindo_0": "震度0", "shindo_1": "震度1", "shindo_2": "震度2", "shindo_3": "震度3",
    "shindo_4": "震度4", "shindo_5m": "震度5弱", "shindo_5p": "震度5強",
    "shindo_6m": "震度6弱", "shindo_6p": "震度6強", "shindo_7": "震度7",
}

# 津波の予想高さ
HEIGHTS = {
    "height_10p": "10メートル以上", "height_10": "10メートル", "height_5": "5メートル",
    "height_3": "3メートル", "height_1": "1メートル", "height_02": "20センチ",
    "height_slight": "若干の海面変動",
}


def magnitude_phrases() -> dict[str, str]:
    """マグニチュード 3.0〜9.5 を 0.1 刻みで。"""
    out = {}
    for i in range(30, 96):
        m = i / 10.0
        out[f"mag_{i}"] = f"{m:.1f}"
    return out


def depth_phrases() -> dict[str, str]:
    """深さの読み上げ (10 km 刻み + 深発地震の代表値)。"""
    values = list(range(0, 101, 10)) + [120, 150, 200, 250, 300, 350, 400, 500, 600, 700]
    return {f"depth_{v}": str(v) for v in values}


def region_phrases() -> dict[str, str]:
    """震央地名 (地震情報の「〜で地震がありました」の部分)。"""
    regions = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))["regions"]
    return {f"region_{r['code']}": r["name"] for r in regions}


def zone_phrases() -> dict[str, str]:
    """津波予報区。"""
    zones = json.loads((DATA / "tsunami_zones.json").read_text(encoding="utf-8"))["zones"]
    return {f"zone_{z['code']}": z["name"] for z in zones}


def build_phrases(scope: str) -> dict[str, str]:
    out: dict[str, str] = {}
    out.update(PHRASES)
    out.update(SHINDO)
    out.update(HEIGHTS)
    out.update(magnitude_phrases())
    out.update(depth_phrases())
    if scope == "full":
        out.update(region_phrases())
        out.update(zone_phrases())
    return out


# ---------------------------------------------------------------- 音声合成
def pcm_to_wav(pcm: bytes, rate: int, channels: int = 1, width: int = 2) -> bytes:
    """生の PCM に WAV のヘッダを付ける。"""
    block = channels * width
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, rate, rate * block, block, width * 8)
    header += b"data" + struct.pack("<I", len(pcm))
    return header + pcm


def parse_rate(mime: str) -> int:
    m = re.search(r"rate=(\d+)", mime or "")
    return int(m.group(1)) if m else 24000


def synthesize(text: str, api_key: str, model: str, voice: str, retries: int = 4) -> bytes:
    """1 つの読み上げ文を合成して WAV のバイト列を返す。"""
    url = f"{API_BASE}/{model}:generateContent?key={api_key}"
    body = {
        "contents": [{"parts": [{"text": STYLE + text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}
            },
        },
    }
    data = json.dumps(body).encode("utf-8")

    for attempt in range(retries):
        req = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                payload = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code in (429, 500, 503) and attempt < retries - 1:
                wait = 5 * (attempt + 1)
                print(f"    {e.code} のため {wait} 秒待って再試行", flush=True)
                time.sleep(wait)
                continue
            raise RuntimeError(f"HTTP {e.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < retries - 1:
                time.sleep(4 * (attempt + 1))
                continue
            raise RuntimeError(f"通信に失敗しました: {e}") from None

        try:
            part = payload["candidates"][0]["content"]["parts"][0]["inlineData"]
        except (KeyError, IndexError):
            raise RuntimeError(f"音声が返りませんでした: {json.dumps(payload)[:300]}") from None
        pcm = base64.b64decode(part["data"])
        return pcm_to_wav(pcm, parse_rate(part.get("mimeType", "")))

    raise RuntimeError("再試行の上限に達しました")


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scope", choices=("core", "full"), default="full",
                    help="core は定型句・震度・数値のみ、full は地名も含む")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--voice", default=DEFAULT_VOICE,
                    help="Gemini の音声名 (Kore, Aoede, Charon, Puck など)")
    ap.add_argument("--limit", type=int, default=0, help="先頭 N 件だけ作る (試験用)")
    ap.add_argument("--interval", type=float, default=0.4, help="呼び出しの間隔 [s]")
    ap.add_argument("--dry-run", action="store_true", help="読み上げ文の一覧だけ出す")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    phrases = build_phrases(args.scope)
    items = list(phrases.items())
    if args.limit:
        items = items[: args.limit]

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.dry_run:
        try:
            print(f"読み上げ文 {len(items)} 件 (scope={args.scope})")
            for key, text in items[:40]:
                print(f"  {key:16s} {text}")
            if len(items) > 40:
                print(f"  … 他 {len(items) - 40} 件")
        except BrokenPipeError:
            pass   # head などで打ち切られた場合
        return 0

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY を環境変数に設定してください。", file=sys.stderr)
        print("  export GEMINI_API_KEY=...", file=sys.stderr)
        return 1

    index_path = out_dir / "index.json"
    index = {}
    if index_path.exists():
        index = json.loads(index_path.read_text(encoding="utf-8")).get("clips", {})

    made = skipped = failed = 0
    for n, (key, text) in enumerate(items, 1):
        dest = out_dir / f"{key}.wav"
        if dest.exists() and key in index:
            skipped += 1
            continue
        try:
            wav = synthesize(text, api_key, args.model, args.voice)
        except RuntimeError as e:
            print(f"  [失敗] {key}: {e}", flush=True)
            failed += 1
            continue
        dest.write_bytes(wav)
        index[key] = {"text": text, "file": f"{key}.wav", "bytes": len(wav)}
        made += 1
        if made % 10 == 0 or n == len(items):
            index_path.write_text(
                json.dumps({"voice": args.voice, "model": args.model, "clips": index},
                           ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
            print(f"  {n}/{len(items)}  作成 {made} / 既存 {skipped} / 失敗 {failed}", flush=True)
        time.sleep(args.interval)

    index_path.write_text(
        json.dumps({"voice": args.voice, "model": args.model, "clips": index},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    total = sum(c["bytes"] for c in index.values())
    print(f"\n完了: 作成 {made} / 既存 {skipped} / 失敗 {failed}")
    print(f"  {index_path.parent} に {len(index)} 件 ({total / 1024 / 1024:.1f} MB)")
    if failed:
        print("  失敗したものは再実行すると続きから作れます。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
