# カード記号のフォント

カードとホームセルの記号には **Noto Sans Symbols 2 Regular、Version 2.008** を使う。
必要な 4 スートだけを WOFF2 にしてサイトに同梱し、Google Fonts などの外部サーバーへゲーム実行時に接続しない。
サブセットの文字は `U+2660`（♠）、`U+2663`（♣）、`U+2665`（♥）、`U+2666`（♦）。日本語や数字、英字はこのフォントに含めない。
図形の輪郭・送り幅・縦メトリクスを保ち、不要な文字とヒンティングを除いている。

画面では `unicode-range` でスートだけに適用し、疑似的な太字化は使わない。元のフォントは多数の記号を扱うため下降領域が大きいが、4 スートの輪郭は 1,000 units/em に対して高さ 749 以下に収まる。CSS で ascent を 85%、descent を 15%、line gap を 0% とし、小さい札でも読みやすい位置に表示する。これは表示の行メトリクスの指定であり、同梱フォントのデータは変更しない。

## 取得元とライセンス

取得元は [Google Fonts の Noto Sans Symbols 2](https://github.com/google/fonts/tree/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notosanssymbols2)。
Google Fonts のコミットを `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5` に固定する。
その `METADATA.pb` が示す上流は [notofonts/symbols](https://github.com/notofonts/symbols/tree/25b00f0d3f40873a005287514ba2a48558655314) のコミット `25b00f0d3f40873a005287514ba2a48558655314`、リリースは `NotoSansSymbols2-v2.008`。

著作権表記は `Copyright 2022 The Noto Project Authors (https://github.com/notofonts/symbols)`。
[元の OFL](https://github.com/google/fonts/blob/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notosanssymbols2/OFL.txt) は SIL Open Font License 1.1 で、著作権表記の後に Reserved Font Name の指定はない。
文字の削減と形式変更を行うサブセットも同じ OFL 1.1 で配布し、フォント内の著作権・名前・版・ライセンス情報を保持する。
[src/fonts/OFL.txt](../src/fonts/OFL.txt) に元の著作権表記とライセンス全文をバイト列のまま同梱する。ゲーム本体の著作権表示とは分けて扱う。

## 固定した入力と出力

| ファイル | バイト数 | SHA-256 |
| --- | ---: | --- |
| 元の `NotoSansSymbols2-Regular.ttf` | 1,233,128 | `7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21` |
| `src/fonts/noto-sans-symbols-2-suits.woff2` | 1,028 | `392114a8c9fa6a4b65690761ee5c6c1c580d14b96fabd770b08fa3359fd9968d` |
| `src/fonts/OFL.txt` | 4,383 | `b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0` |

フォントとライセンスの合計は **5,411 バイト**。両方とも公開物全体の 50,000 バイト上限に含める。
元の大きな TTF は公開物・リポジトリには追加しない。

## サブセットの再生成

通常の `npm run build` は同梱済みのファイルを使うため、Python・FontTools の導入やフォントの再取得は不要。
フォントを再生成するときだけ、Python 3.12、FontTools 4.68.0、Brotli 1.2.1 を用意し、リポジトリ直下から次を実行する。

```sh
python3 -m venv /tmp/freecell-font-tools
/tmp/freecell-font-tools/bin/python -m pip install fonttools==4.68.0 brotli==1.2.1
/tmp/freecell-font-tools/bin/python scripts/subset-font.py
```

初回のパッケージ準備とスクリプトによる公式フォント取得にはネット接続が必要。
スクリプトは固定 URL と元ファイルの SHA-256 を確認してから、4 スートだけを生成する。
日時の再計算を無効にし、同じ版のツールで同じ WOFF2 を再現する。元の縦メトリクスは変更しない。
更新時は出力の文字一覧、輪郭・送り幅・メトリクス、ライセンス保持、公開物の全体サイズ、実ブラウザーの表示とオフライン読み込みを確認する。
