#!/usr/bin/env python3
"""Scratch の音声合成で、地震情報の読み上げ音声を作る.

Scratch の「音声合成」拡張が使っている合成サーバ (MIT) をそのまま叩く。
声は「ネズミ」= アルト (ja-JP / female) を再生速度 1.19 倍で鳴らしたもので、
ここでは素の アルト を mp3 で保存し、速度は再生側 (web/js/sound.js) で掛ける。

読み上げ文は部品に分けて合成し、再生時につなげる。こうすることで、設定モードで
指定した任意の震源についても、あらかじめ用意した音声だけで読み上げられる。

  揺れの検知
    千葉県南部で揺れを検出。

  緊急地震速報
    宮城県沖で地震。推定最大震度6強

  震度速報 (仮)
    震度速報。最大震度6強を。宮城県北部。で観測しました。

  地震情報 (確定・津波なし)
    地震情報。午後3時47分頃、最大震度6強を観測する地震がありました。
    この地震による津波の心配はありません。震源地は、宮城県沖。深さ60キロメートル。
    地震の規模を示すマグニチュードは、7.3と、推定されています。

  地震情報 (確定・津波発表中)
    …がありました。現在、津波予報等を発表中です。震源地は、…

  津波警報・大津波警報
    大津波警報が次の地域に発表されています。直ちに避難してください。
    宮城県、岩手県。以上の地域で、予想される津波の高さは、10メートル以上です。
    また、津波注意報が、次の地域に発表されています。…
    震源に関する情報。震源地は、宮城県沖。深さ20キロメートル。…
    現在、大津波警報等を発表中です。海岸からは直ちに離れてください。

使い方::

    python tools/generate_voice.py --scope core   # 定型句・震度・数値のみ
    python tools/generate_voice.py                # 地名も含めて全部
    python tools/generate_voice.py --dry-run

同じ読み上げ文は 1 度しか取りに行かず、生成済みのものは読み飛ばすので、
途中で止めても再実行で続きから作れる。出力は web/sounds/voice/ に mp3 と
対応表 index.json。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"
OUT = ROOT / "web" / "sounds" / "voice"

SYNTH_URL = "https://synthesis-service.scratch.mit.edu/synth"
LOCALE = "ja-JP"

# Scratch の声の定義 (scratch-vm の text2speech より)。
#   アルト   female / 等速      ネズミ   female / 1.19 倍
#   テノール male   / 等速      巨人     male   / 0.84 倍
VOICES = {
    "alto":   {"gender": "female", "rate": 1.0},
    "squeak": {"gender": "female", "rate": 1.19},   # ネズミ
    "tenor":  {"gender": "male",   "rate": 1.0},
    "giant":  {"gender": "male",   "rate": 0.84},
}
DEFAULT_VOICE = "squeak"

# ---------------------------------------------------------------- 読み上げ文

# 定型句。原稿の切れ目に合わせて分けてある。
PHRASES = {
    # 震度速報 (仮) : 震度速報。最大震度○を。○○○。で観測しました。
    "flash_lead": "震度速報。最大震度",
    "flash_wo": "を。",
    "flash_tail": "で観測しました。",

    # 揺れの検知 : ○○○で揺れを検出。
    "detect_tail": "で揺れを検出。",

    # 緊急地震速報 : ○○○で地震。推定最大震度○
    "eew_tail": "で地震。推定最大震度",

    # 地震情報 (確定)
    "info_lead": "地震情報。",
    "ampm_am": "午前",
    "ampm_pm": "午後",
    "info_koro": "頃、最大震度",
    "info_observed": "を観測する地震がありました。",
    "info_no_tsunami": "この地震による津波の心配はありません。",
    "info_tsunami_now": "現在、津波予報等を発表中です。",
    "info_hypo_lead": "震源地は、",
    "info_depth_lead": "深さ",
    "info_km": "キロメートル。地震の規模を示すマグニチュードは、",
    "info_mag_tail": "と、推定されています。",

    # 津波警報・大津波警報・津波注意報
    "tsu_major": "大津波警報",
    "tsu_warning": "津波警報",
    "tsu_advisory": "津波注意報",
    "tsu_issued": "が次の地域に発表されています。",
    "tsu_issued2": "が、次の地域に発表されています。",
    "tsu_evacuate": "直ちに避難してください。",
    "tsu_mata": "また、",
    "tsu_ijou": "以上の地域で、予想される津波の高さは、",
    "tsu_desu": "です。",
    "tsu_leave_sea": "海の中や海岸から離れてください。",

    # 津波発表中の震源情報 (#3)
    "hypo_lead": "震源に関する情報。震源地は、",
    "tsu_now_lead": "現在、",
    "tsu_now_tail": "等を発表中です。海岸からは直ちに離れてください。",
}

# 予想される津波の高さ
HEIGHTS = {
    "height_10p": "10メートル以上", "height_10": "10メートル", "height_5": "5メートル",
    "height_3": "3メートル", "height_1": "1メートル", "height_02": "20センチ",
    "height_slight": "若干の海面変動",
}

# 震度階級
SHINDO = {
    "shindo_0": "0", "shindo_1": "1", "shindo_2": "2", "shindo_3": "3", "shindo_4": "4",
    "shindo_5m": "5弱", "shindo_5p": "5強", "shindo_6m": "6弱", "shindo_6p": "6強",
    "shindo_7": "7",
}

# 深さ。気象庁の発表に合わせて 10 km 刻み + 深発地震の代表値。
DEPTH_VALUES = list(range(0, 101, 10)) + [120, 150, 200, 250, 300, 350, 400, 450,
                                          500, 550, 600, 650, 700]


def clock_phrases() -> dict[str, str]:
    """午前/午後の時刻。「○時」と「○分」。"""
    out = {}
    for h in range(0, 13):
        out[f"hour_{h}"] = f"{h}時"
    for m in range(0, 60):
        out[f"min_{m}"] = f"{m}分"
    return out


def magnitude_phrases() -> dict[str, str]:
    """マグニチュード 3.0〜9.5 を 0.1 刻みで。"""
    return {f"mag_{i}": f"{i / 10.0:.1f}" for i in range(30, 96)}


def depth_phrases() -> dict[str, str]:
    return {f"depth_{v}": str(v) for v in DEPTH_VALUES}


def load_yomi() -> dict[str, str]:
    """地名の読み (かな)。漢字のままだと合成音声が読み違える。"""
    path = DATA / "yomi.json"
    if not path.exists():
        print("  [警告] web/data/yomi.json が無いので漢字のまま読み上げます")
        return {}
    return json.loads(path.read_text(encoding="utf-8"))["yomi"]


def zone_phrases() -> dict[str, str]:
    """津波予報区 (「以上の地域で」の前に読み上げる沿岸の名前)。"""
    zones = json.loads((DATA / "tsunami_zones.json").read_text(encoding="utf-8"))["zones"]
    return {f"zone_{z['code']}": z["name"] for z in zones}


def region_phrases() -> dict[str, str]:
    """震央地名 (「震源地は、○○○」の部分)。"""
    regions = json.loads((DATA / "regions.json").read_text(encoding="utf-8"))["regions"]
    return {f"region_{r['code']}": r["name"] for r in regions}


def area_phrases() -> dict[str, str]:
    """震度観測地域名 (震度速報の「○○○で観測しました」の部分)。"""
    subs = json.loads((DATA / "subdivisions.json").read_text(encoding="utf-8"))
    return {f"area_{code}": name for code, name in zip(subs["codes"], subs["names"])}


# 地名のクリップ。画面には漢字を出し、読み上げにはかなを渡す。
PLACE_PREFIXES = ("region_", "area_", "zone_")


def build_phrases(scope: str) -> dict[str, str]:
    out: dict[str, str] = {}
    out.update(PHRASES)
    out.update(HEIGHTS)
    out.update(SHINDO)
    out.update(clock_phrases())
    out.update(magnitude_phrases())
    out.update(depth_phrases())
    if scope == "full":
        out.update(region_phrases())
        out.update(area_phrases())
        out.update(zone_phrases())
    return out


# ---------------------------------------------------------------- 音声合成
def text_id(text: str) -> str:
    """読み上げ文から決まるファイル名。同じ文は 1 つの mp3 で共有する。"""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def synthesize(text: str, gender: str, retries: int = 4, timeout: float = 30.0) -> bytes:
    query = urllib.parse.urlencode({"locale": LOCALE, "gender": gender, "text": text})
    url = f"{SYNTH_URL}?{query}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "seismic-sim/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                data = res.read()
            if len(data) < 512:
                raise RuntimeError(f"音声が短すぎます ({len(data)} B)")
            return data
        except Exception as e:                      # noqa: BLE001 - 通信は何でも起こる
            if attempt == retries - 1:
                raise RuntimeError(str(e)) from None
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("再試行の上限に達しました")


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scope", choices=("core", "full"), default="full",
                    help="core は定型句・震度・数値のみ、full は地名も含む")
    ap.add_argument("--voice", choices=sorted(VOICES), default=DEFAULT_VOICE,
                    help="Scratch の声 (既定: ネズミ)")
    ap.add_argument("--limit", type=int, default=0, help="先頭 N 件だけ作る (試験用)")
    ap.add_argument("--interval", type=float, default=0.15, help="呼び出しの間隔 [s]")
    ap.add_argument("--dry-run", action="store_true", help="読み上げ文の一覧だけ出す")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    voice = VOICES[args.voice]
    phrases = build_phrases(args.scope)
    items = list(phrases.items())
    if args.limit:
        items = items[: args.limit]

    yomi = load_yomi()
    # 地名は漢字ではなく、かなを合成に渡す
    spoken = {}
    unread = 0
    for key, text in items:
        if key.startswith(PLACE_PREFIXES):
            kana = yomi.get(text)
            if kana:
                spoken[key] = kana
                continue
            unread += 1
        spoken[key] = text
    if unread:
        print(f"  [警告] 読みが無い地名 {unread} 件は漢字のまま合成します")

    if args.dry_run:
        uniq = {t for _, t in items}
        try:
            print(f"読み上げ文 {len(items)} 件 (異なり {len(uniq)} 件, scope={args.scope})")
            for key, text in items[:40]:
                print(f"  {key:16s} {text}")
            if len(items) > 40:
                print(f"  … 他 {len(items) - 40} 件")
        except BrokenPipeError:
            pass
        return 0

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    index_path = out_dir / "index.json"
    clips: dict[str, dict] = {}
    if index_path.exists():
        old = json.loads(index_path.read_text(encoding="utf-8"))
        if old.get("voice") == args.voice:
            clips = old.get("clips", {})

    made = skipped = failed = 0
    for n, (key, text) in enumerate(items, 1):
        say = spoken[key]
        name = text_id(say) + ".mp3"
        dest = out_dir / name
        if dest.exists():
            clips[key] = {"text": text, "say": say, "file": name,
                          "bytes": dest.stat().st_size}
            skipped += 1
            continue
        try:
            mp3 = synthesize(say, voice["gender"])
        except RuntimeError as e:
            print(f"  [失敗] {key}: {e}", flush=True)
            failed += 1
            continue
        dest.write_bytes(mp3)
        clips[key] = {"text": text, "say": say, "file": name, "bytes": len(mp3)}
        made += 1
        if made % 25 == 0:
            write_index(index_path, args.voice, voice, clips)
            print(f"  {n}/{len(items)}  作成 {made} / 既存 {skipped} / 失敗 {failed}", flush=True)
        time.sleep(args.interval)

    write_index(index_path, args.voice, voice, clips)
    total = sum(f.stat().st_size for f in out_dir.glob("*.mp3"))
    print(f"\n完了: 作成 {made} / 既存 {skipped} / 失敗 {failed}")
    print(f"  {out_dir} に {len(clips)} 語 "
          f"/ {len(list(out_dir.glob('*.mp3')))} ファイル ({total / 1024 / 1024:.2f} MB)")
    if failed:
        print("  失敗したものは再実行すると続きから作れます。")
    return 0


def write_index(path: Path, name: str, voice: dict, clips: dict) -> None:
    path.write_text(
        json.dumps({"engine": "scratch", "voice": name, "locale": LOCALE,
                    "gender": voice["gender"], "rate": voice["rate"], "clips": clips},
                   ensure_ascii=False, indent=1),
        encoding="utf-8",
    )


if __name__ == "__main__":
    sys.exit(main())
