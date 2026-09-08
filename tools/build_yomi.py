#!/usr/bin/env python3
"""地名の読み (かな) を集めて web/data/yomi.json を書き出す.

合成音声に漢字のまま渡すと、地名は高い確率で読み違える
(日向灘 -> ひなたなだ、和歌山県南方沖 -> みなみがた など)。読み上げには
かなを渡し、画面には漢字を出す。

  細分区域・津波予報区  気象庁の電文コード表に「ふりがな」がある
  震央地名              ふりがなが無いので、data/yomi_tokens.json の語を
                        長いものから当てはめてつなぐ

    python tools/build_yomi.py
    python tools/build_yomi.py --check   # 読めない地名だけ出す
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
DATA = ROOT / "web" / "data"
CODE_ZIP = RAW / "jmacode.zip"
CODE_XLSX = "地震火山関連コード表.xlsx"


def sheet_yomi(sheet: str, name_col: int, kana_col: int) -> dict[str, str]:
    """コード表のシートから 名前 -> ふりがな を拾う。"""
    import openpyxl

    if not CODE_ZIP.exists():
        return {}
    z = zipfile.ZipFile(CODE_ZIP)
    wb = openpyxl.load_workbook(io.BytesIO(z.read(CODE_XLSX)), read_only=True)
    out: dict[str, str] = {}
    for row in wb[sheet].iter_rows(min_row=4, values_only=True):
        name = row[name_col] if len(row) > name_col else None
        kana = row[kana_col] if len(row) > kana_col else None
        if isinstance(name, str) and isinstance(kana, str) and kana.strip():
            out.setdefault(name.strip(), kana.strip())
    return out


def compose(name: str, tokens: dict[str, str], keys: list[str]) -> str | None:
    """語を長いものから当てはめてつなぐ。"""
    rest, out = name, []
    while rest:
        for k in keys:
            if rest.startswith(k):
                out.append(tokens[k])
                rest = rest[len(k) :]
                break
        else:
            return None
    return "".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="読めない地名だけ出す")
    args = ap.parse_args()

    tokens = {k: v for k, v in
              json.loads((ROOT / "data" / "yomi_tokens.json").read_text(encoding="utf-8")).items()
              if not k.startswith("_")}
    keys = sorted(tokens, key=len, reverse=True)

    yomi: dict[str, str] = {}
    # 細分区域 (シート 24 の A/B/C 列) と 津波予報区 (シート 31)
    for sheet, ncol, kcol, label in (("24", 1, 2, "細分区域"), ("31", 1, 2, "津波予報区")):
        got = sheet_yomi(sheet, ncol, kcol)
        yomi.update(got)
        print(f"  コード表 {label}: {len(got)} 件")

    # 遠地地震の地名は data/world_regions.json に読みを持たせてある
    world = json.loads((ROOT / "data" / "world_regions.json").read_text(encoding="utf-8"))
    for r in world["regions"]:
        yomi.setdefault(r["name"], r["kana"])
    print(f"  遠地の震央地名: {len(world['regions'])} 件")

    missing: list[str] = []
    for path, key in ((DATA / "regions.json", "regions"), ):
        for r in json.loads(path.read_text(encoding="utf-8"))[key]:
            if r["name"] in yomi:
                continue
            kana = compose(r["name"], tokens, keys)
            if kana:
                yomi[r["name"]] = kana
            else:
                missing.append(r["name"])

    # 表に載っていない細分区域・予報区も語をつないで埋める
    subs = json.loads((DATA / "subdivisions.json").read_text(encoding="utf-8"))
    zones = json.loads((DATA / "tsunami_zones.json").read_text(encoding="utf-8"))["zones"]
    for name in list(subs["names"]) + [z["name"] for z in zones]:
        if name in yomi:
            continue
        kana = compose(name, tokens, keys)
        if kana:
            yomi[name] = kana
        else:
            missing.append(name)

    if missing:
        print(f"  [警告] 読みが作れなかった地名 {len(missing)} 件")
        for m in missing[:20]:
            print("    ", m)
    if args.check:
        return 1 if missing else 0

    out = DATA / "yomi.json"
    out.write_text(json.dumps({"yomi": yomi}, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"  {out.name}: {len(yomi)} 件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
