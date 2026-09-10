#!/usr/bin/env python3
"""緊急地震速報 (警報) の読み上げを VOICEVOX 四国めたん で作る.

原稿::

    緊急地震速報です。緊急地震速報です。強い揺れが予想される地域をお伝えします。
    （地域名を全て読み上げる）
    ※緊急地震速報の続報です。（続報の地域名）
    対象地域では、慌てずに、まず身の安全を確保してください。

続報が無ければ地域名のあとそのまま最後の一文へ飛ぶ。地域名は都道府県の
単位で読むので、固定の 3 文 + 47 都道府県の 50 クリップを作る。

出力は web/sounds/voice/ に mt_*.mp3 として置き、同じ index.json に
"rate": 1.0 付きで書き足す (本体の読み上げは ×1.19 で鳴らしているため)。

VOICEVOX の core は GitHub の release から落として使う::

    curl -L -o core.zip https://github.com/VOICEVOX/voicevox_core/releases/download/0.15.7/voicevox_core-linux-x64-cpu-0.15.7.zip
    curl -L -o vv.whl   https://github.com/VOICEVOX/voicevox_core/releases/download/0.15.7/voicevox_core-0.15.7+cpu-cp38-abi3-linux_x86_64.whl
    curl -L -o ojt.tgz  https://github.com/r9y9/open_jtalk/releases/download/v1.11.1/open_jtalk_dic_utf_8-1.11.tar.gz

使い方::

    LD_LIBRARY_PATH=<core を展開した所> python tools/generate_metan_voice.py \
        --dict <open_jtalk_dic_utf_8-1.11 の所>

音源は権利の都合でリポジトリに入れていない (web/sounds/README.md)。
利用に際しては「VOICEVOX:四国めたん」のクレジットが要る。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "web" / "sounds" / "voice"

SPEAKER_ID = 2          # 四国めたん (ノーマル)
SPEAKER_NAME = "四国めたん"

LINES = {
    "mt_warn_lead": "緊急地震速報です。緊急地震速報です。"
                    "強い揺れが予想される地域をお伝えします。",
    "mt_warn_update": "緊急地震速報の続報です。",
    "mt_warn_tail": "対象地域では、慌てずに、まず身の安全を確保してください。",
}

PREFS = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]

# open_jtalk が取り違える読み。「、」を足して読点で切るより、読みを直接書く。
YOMI = {
    "茨城県": "いばらきけん",
    "宮城県": "みやぎけん",
    "神奈川県": "かながわけん",
    "岐阜県": "ぎふけん",
    "大分県": "おおいたけん",
    "滋賀県": "しがけん",
}


def ffmpeg() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def text_id(text: str) -> str:
    return "mt_" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dict", required=True, help="open_jtalk_dic_utf_8-1.11 の場所")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--speaker", type=int, default=SPEAKER_ID)
    args = ap.parse_args()

    from voicevox_core import AccelerationMode, VoicevoxCore

    core = VoicevoxCore(acceleration_mode=AccelerationMode.CPU,
                        open_jtalk_dict_dir=args.dict)
    core.load_model(args.speaker)

    items = dict(LINES)
    for p in PREFS:
        items["mt_pref_" + p] = p

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    index_path = out_dir / "index.json"
    payload = {}
    if index_path.exists():
        payload = json.loads(index_path.read_text(encoding="utf-8"))
    clips = payload.setdefault("clips", {})

    ff = ffmpeg()
    made = skipped = 0
    with tempfile.TemporaryDirectory() as tmp:
        for key, text in items.items():
            say = YOMI.get(text, text)
            name = text_id(say) + ".mp3"
            dest = out_dir / name
            if not dest.exists():
                wav = Path(tmp) / "a.wav"
                wav.write_bytes(core.tts(say, args.speaker))
                # 前後の無音を落としてから小さめに詰める。単一 HTML に
                # 埋め込むので、聞き取れる範囲でできるだけ軽くする。
                subprocess.run(
                    [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
                     "-af", ("silenceremove=start_periods=1:start_threshold=-45dB"
                             ":start_silence=0.02,areverse,"
                             "silenceremove=start_periods=1:start_threshold=-45dB"
                             ":start_silence=0.04,areverse"),
                     "-ac", "1", "-ar", "16000", "-b:a", "40k", str(dest)],
                    check=True,
                )
                made += 1
            else:
                skipped += 1
            clips[key] = {"text": text, "say": say, "file": name,
                          "bytes": dest.stat().st_size, "rate": 1.0}

    payload["clips"] = clips
    payload.setdefault("voice", "squeak")
    payload["credits"] = sorted(set(payload.get("credits", []) + ["VOICEVOX:四国めたん"]))
    index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1),
                          encoding="utf-8")
    total = sum((out_dir / c["file"]).stat().st_size
                for c in clips.values() if (out_dir / c["file"]).exists())
    print(f"完了: 作成 {made} / 既存 {skipped}  ({SPEAKER_NAME} id={args.speaker})")
    print(f"  {out_dir} に {len(clips)} 語 / {total / 1e6:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
