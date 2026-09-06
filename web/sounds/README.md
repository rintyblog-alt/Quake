# 音源の差し替え

このディレクトリに音声ファイルを置くと、アプリが合成音の代わりに再生します。
ファイルが無いスロットは WebAudio による合成音にフォールバックします。

## ファイル名

| ファイル名 | 使われる場面 |
|---|---|
| `eew_forecast.*`   | 緊急地震速報（予報）の第1報 |
| `eew_warning.*`    | 緊急地震速報（警報）の第1報 |
| `eew_update.*`     | 第2報以降の続報 |
| `quake_info.*`     | 地震情報の受信 |
| `tsunami_advisory.*` | 津波注意報 |
| `tsunami_warning.*`  | 津波警報 |
| `tsunami_major.*`    | 大津波警報 |
| `countdown_tick.*`   | 主要動到達までの秒読み |
| `countdown_final.*`  | 主要動到達 |

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

## 権利について

**このディレクトリの音声ファイルは Git の管理対象外です**（リポジトリ直下の
`.gitignore` で除外しています）。他者が作成した音源には著作権があり、
再配布はできません。手元で利用する場合も、配布元の利用条件を確認してください。
本リポジトリが同梱するのは合成音の生成コードのみです。

## 読み上げ音声 (Gemini TTS)

地震情報・津波予報のアナウンスは `web/sounds/voice/` に置いた短いクリップを
つなげて再生します。クリップが無い場合はブラウザの Web Speech API に
フォールバックします。

クリップは `tools/generate_voice.py` が Gemini の TTS で生成します。

```bash
export GEMINI_API_KEY=...            # または GOOGLE_API_KEY
python tools/generate_voice.py --scope core   # 定型句・震度・数値のみ (129 件)
python tools/generate_voice.py                # 震央地名・津波予報区も含む (489 件)
```

- 出力は 24 kHz モノラルの WAV と、索引の `voice/index.json`
- 途中で止めても再開できます（`index.json` にあるものは飛ばします）
- `--dry-run` で生成される語句の一覧だけ確認できます
- `--voice` で話者、`--model` でモデル、`--interval` で送信間隔を変えられます

生成物は `.gitignore` で除外されており、リポジトリには入りません。
