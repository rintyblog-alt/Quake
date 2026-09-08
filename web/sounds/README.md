# 音源の差し替え

このディレクトリに音声ファイルを置くと、アプリが合成音の代わりに再生します。
ファイルが無いスロットは WebAudio による合成音にフォールバックします。

## ファイル名

| スロット | 使われる場面 |
|---|---|
| `eew_forecast`   | 緊急地震速報（予報）の第1報 |
| `eew_warning`    | 緊急地震速報（警報）の第1報。無ければ `eew_forecast` で代える |
| `eew_update`     | 第2報以降の続報 |
| `eew_update_major` | 続報のうち、震源が 30 km 以上動いた・マグニチュードが 0.5 以上変わった・予想最大震度の階級が変わった・予報と警報が入れ替わった、のいずれかに当たるもの |
| `quake_info`     | 地震情報の受信（下の 3 つが無いときの代わり） |
| `quake_info_shindo` | 震度速報（VXSE51）。震度だけが先に出る |
| `quake_info_hypo`   | 震源に関する情報（VXSE52）。震源・規模・深さが決まる |
| `quake_info_detail` | 震源・震度に関する情報（VXSE53）。確定 |
| `tsunami_advisory` | 津波注意報 |
| `tsunami_warning`  | 津波警報 |
| `tsunami_major`    | 大津波警報 |
| `countdown_tick`   | 主要動到達までの秒読み |
| `countdown_final`  | 主要動到達 |
| `new_int_0` 〜 `new_int_6` | 観測点の反応。下記 |

### 観測点の反応 (`new_int_*`)

揺れの最大 PGA が段を越えるたびに、下から順に一度ずつ鳴らす。常時微動は
含めない値で判定するので、地震が起きていないときには鳴らない。段は
PGA の配色に合わせてある。

| スロット | しきい値 | 目安 |
|---|---|---|
| `new_int_0` | 0.2 gal | 微弱な反応（水色にかかるあたり） |
| `new_int_1` | 0.5 gal | 弱い反応（緑） |
| `new_int_2` | 2 gal | ギリ弱い反応（濃い緑から黄緑） |
| `new_int_3` | 5 gal | ちょっと強い反応（黄） |
| `new_int_4` | 20 gal | 強い反応（濃い黄から橙） |
| `new_int_5` | 150 gal | かなり強い反応（赤） |
| `new_int_6` | 500 gal | 極く強い反応（濃い赤・最大） |

拡張子は `.mp3` / `.ogg` / `.wav` のいずれか。

## manifest.json が必要です

差し替え音源は **`manifest.json` に書かれたものだけ** を読み込みます
（存在しないファイルを探しに行かないため）。`manifest.example.json` を
`manifest.json` にコピーし、実際に置いたファイルの行だけ残してください。

```json
{
  "eew_warning": "my_warning.mp3",
  "tsunami_major": "my_tsunami.ogg"
}
```

書かれていないスロットは合成音のまま動作します。

## 単一 HTML に埋め込む

`tools/build_bundle.py --sounds` を付けると、`manifest.json` に書かれた音源も
data URI として埋め込まれ、サーバーを立てずに音つきで開けるビルドになります。
既定では埋め込みません（リポジトリに入れないのと同じ理由）。

## 権利について

**このディレクトリの音声ファイルは Git の管理対象外です**（リポジトリ直下の
`.gitignore` で除外しています）。他者が作成した音源には著作権があり、
再配布はできません。手元で利用する場合も、配布元の利用条件を確認してください。
本リポジトリが同梱するのは合成音の生成コードのみです。

## 読み上げ音声 (Scratch の音声合成)

地震情報のアナウンスは `web/sounds/voice/` に置いた短いクリップをつないで
再生します。声は Scratch の音声合成の「ネズミ」＝ アルト (ja-JP / female) を
1.19 倍の速さで鳴らしたもので、倍率は再生側 (`web/js/sound.js`) で掛けます。

```bash
python tools/generate_voice.py --scope core   # 定型句・震度・数値のみ (186 語)
python tools/generate_voice.py                # 地名も含めて全部 (668 語)
python tools/generate_voice.py --dry-run      # 読み上げ文の一覧だけ
python tools/generate_voice.py --voice alto   # ふつうの声で作る
```

- 合成には Scratch の合成サーバ (`synthesis-service.scratch.mit.edu`) を使います。
  API キーは要りません。
- 出力は mp3 と、索引の `voice/index.json`。同じ読み上げ文は 1 ファイルを
  共有するので、668 語でも実ファイルは 531 個です。
- 途中で止めても再開できます（既にあるファイルは飛ばします）。
- 読み上げは必ず効果音が鳴り終わってから始まります。
- クリップが無い場面はブラウザの Web Speech API にフォールバックします
  （緊急地震速報と津波予報は今のところこちら）。

生成物は `.gitignore` で除外されており、リポジトリには入りません。
