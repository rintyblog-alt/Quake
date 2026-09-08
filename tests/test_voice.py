"""読み上げ音声の部品が、Web 側が求めるものと食い違っていないか確かめる.

web/js/sound.js は「地震情報。」「午後」「3時」…と部品をつないで読み上げる。
tools/generate_voice.py が作る部品に 1 つでも欠けがあると、その場面の読み上げ
だけが黙って落ちる (playSequence が false を返してブラウザ内蔵の合成音声に
戻る) ので、両者の対応をここで突き合わせておく。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import generate_voice as gv  # noqa: E402

SOUND_JS = (ROOT / "web" / "js" / "sound.js").read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def phrases() -> dict[str, str]:
    return gv.build_phrases("full")


def js_array(name: str) -> list[str]:
    """sound.js の `var NAME = [ ... ];` を取り出す。"""
    m = re.search(r"var " + name + r"\s*=\s*\[(.*?)\];", SOUND_JS, re.S)
    assert m, f"{name} が sound.js に見つかりません"
    return [t.strip().strip("'\"") for t in m.group(1).split(",") if t.strip()]


def test_定型句のクリップ名がすべて用意されている(phrases):
    """sound.js に直に書いてあるクリップ名 ('info_lead' など) の突き合わせ。"""
    used = set(re.findall(r"'((?:flash|info|ampm|tsu|hypo)_[a-z_0-9]+)'", SOUND_JS))
    assert used, "クリップ名が拾えていない"
    missing = sorted(used - set(phrases))
    assert not missing, f"読み上げの部品が足りません: {missing}"


def test_震度のクリップがすべて用意されている(phrases):
    body = re.search(r"var SHINDO_CLIP = \{(.*?)\};", SOUND_JS, re.S)
    assert body
    keys = re.findall(r"'(shindo_[0-9a-z]+)'", body.group(1))
    assert len(keys) == 10, keys
    missing = sorted(set(keys) - set(phrases))
    assert not missing, f"震度の部品が足りません: {missing}"


def test_深さの刻みがPythonと一致する():
    js = [int(v) for v in js_array("DEPTHS")]
    assert js == gv.DEPTH_VALUES


def test_時刻の部品が24時間ぶん揃っている(phrases):
    # 12 時制 + 午前/午後。0 時は「午前0時」、12 時は「午後0時」と読む。
    for h in range(24):
        assert f"hour_{h % 12}" in phrases, h
    for m in range(60):
        assert f"min_{m}" in phrases, m
    assert "ampm_am" in phrases and "ampm_pm" in phrases


def test_マグニチュードは入力欄の範囲を覆う(phrases):
    # web/index.html の #cfg-mag は min=3 max=9.5 step=0.1
    for i in range(30, 96):
        assert f"mag_{i}" in phrases, i


def test_深さは入力欄の範囲で必ず近い値が選べる(phrases):
    for km in range(0, 701, 1):
        near = min(gv.DEPTH_VALUES, key=lambda v: abs(v - km))
        assert f"depth_{near}" in phrases
        assert abs(near - km) <= 50, (km, near)


def test_震央地名と震度観測地域名がすべて読める(phrases):
    texts = set(phrases.values())
    regions = json.loads((ROOT / "web" / "data" / "regions.json").read_text("utf-8"))
    for r in regions["regions"]:
        assert r["name"] in texts, r["name"]
    subs = json.loads((ROOT / "web" / "data" / "subdivisions.json").read_text("utf-8"))
    for name in subs["names"]:
        assert name in texts, name


def test_原稿が指定どおりつながる(phrases):
    """部品をつないだ結果が、依頼された原稿と一字一句合っているか。

    sound.js は列に PAUSE ('。') を混ぜてそこで一拍おく。原稿の句点のうち、
    部品の末尾に入っていないものがこれにあたる。
    """
    p = dict(phrases)
    p["。"] = "。"

    def join(*keys: str) -> str:
        return "".join(p[k] for k in keys)

    flash = join("flash_lead", "shindo_6p", "flash_wo") + "宮城県北部" + join("。", "flash_tail")
    assert flash == "震度速報。最大震度6強を。宮城県北部。で観測しました。"

    def info(tsunami: bool) -> str:
        return (join("info_lead", "ampm_pm", "hour_3", "min_47", "info_koro",
                     "shindo_6p", "info_observed",
                     "info_tsunami_now" if tsunami else "info_no_tsunami",
                     "info_hypo_lead")
                + "宮城県沖"
                + join("。", "info_depth_lead", "depth_60", "info_km", "mag_73",
                       "info_mag_tail"))

    assert info(False) == (
        "地震情報。午後3時47分頃、最大震度6強を観測する地震がありました。"
        "この地震による津波の心配はありません。震源地は、宮城県沖。深さ60"
        "キロメートル。地震の規模を示すマグニチュードは、7.3と、推定されています。"
    )
    assert info(True) == (
        "地震情報。午後3時47分頃、最大震度6強を観測する地震がありました。"
        "現在、津波予報等を発表中です。震源地は、宮城県沖。深さ60"
        "キロメートル。地震の規模を示すマグニチュードは、7.3と、推定されています。"
    )


def test_津波の原稿が指定どおりつながる(phrases):
    p = dict(phrases)
    p["。"] = "。"

    def join(*keys: str) -> str:
        return "".join(p[k] for k in keys)

    # #1 いちばん強い段
    first = (join("tsu_major", "tsu_issued", "tsu_evacuate") + "宮城県" + "。" + "岩手県" + "。"
             + join("tsu_ijou", "height_10p", "tsu_desu"))
    assert first == (
        "大津波警報が次の地域に発表されています。直ちに避難してください。"
        "宮城県。岩手県。以上の地域で、予想される津波の高さは、10メートル以上です。"
    )

    # #2 ほかの段が続くとき
    second = (join("tsu_mata", "tsu_advisory", "tsu_issued2") + "伊豆諸島" + "。"
              + join("tsu_ijou", "height_1", "tsu_desu"))
    assert second == (
        "また、津波注意報が、次の地域に発表されています。"
        "伊豆諸島。以上の地域で、予想される津波の高さは、1メートルです。"
    )

    # #3 震源に関する情報
    third = (join("hypo_lead") + "宮城県沖" + join("。", "info_depth_lead", "depth_20",
             "info_km", "mag_90", "info_mag_tail", "tsu_now_lead", "tsu_major", "tsu_now_tail"))
    assert third == (
        "震源に関する情報。震源地は、宮城県沖。深さ20キロメートル。"
        "地震の規模を示すマグニチュードは、9.0と、推定されています。"
        "現在、大津波警報等を発表中です。海岸からは直ちに離れてください。"
    )

    # 津波注意報だけのとき (軽い読み上げ)
    only = (join("tsu_advisory", "tsu_issued") + "千葉県九十九里・外房" + "。"
            + join("tsu_ijou", "height_02", "tsu_desu", "tsu_leave_sea"))
    assert only == (
        "津波注意報が次の地域に発表されています。千葉県九十九里・外房。"
        "以上の地域で、予想される津波の高さは、20センチです。海の中や海岸から離れてください。"
    )


def test_津波予報区と高さがすべて読める(phrases):
    texts = set(phrases.values())
    zones = json.loads((ROOT / "web" / "data" / "tsunami_zones.json").read_text("utf-8"))
    for z in zones["zones"]:
        assert z["name"] in texts, z["name"]
    # sim/tsunami.py が返す高さ階級はすべてクリップがある
    body = re.search(r"var HEIGHT_CLIP = \{(.*?)\};", SOUND_JS, re.S)
    assert body
    for cls, key in re.findall(r"'([^']+)': '([a-z0-9_]+)'", body.group(1)):
        assert key in phrases, (cls, key)


def test_句点の一拍がsound_jsに入っている():
    """地名のうしろの句点は部品に含まれないので、PAUSE で置く。"""
    assert "var PAUSE = '。';" in SOUND_JS
    assert "this.regionClip(info.area), PAUSE, 'flash_tail'" in SOUND_JS
    assert "this.regionClip(info.region), PAUSE," in SOUND_JS


def test_ネズミの声で作られている():
    assert gv.DEFAULT_VOICE == "squeak"
    assert gv.VOICES["squeak"] == {"gender": "female", "rate": 1.19}
    assert gv.LOCALE == "ja-JP"
