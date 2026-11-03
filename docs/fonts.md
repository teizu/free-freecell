# カード全体の絵柄に使うフォント

カード全体の絵柄には **Noto Sans Symbols 2 Regular、Version 2.008** の Unicode トランプ文字を使う。
数字札・絵札を含む 52 枚、ホームセル用の 4 スート、行メトリクス用の空白を WOFF2 にしてサイトに同梱し、Google Fonts などの外部サーバーへゲーム実行時に接続しない。
スート記号だけを差し替える表示ではなく、各トランプ文字に含まれる枠・数字・スート・絵札の図形でカード全体を描く。日本語や独立した数字・英字はこのフォントに含めない。
図形の輪郭・送り幅・縦メトリクスを保ち、不要な文字とヒンティングを除いている。

## 文字の対応と描画メトリクス

| スート | A〜J | Q・K |
| --- | --- | --- |
| スペード | `U+1F0A1`〜`U+1F0AB` | `U+1F0AD`・`U+1F0AE` |
| ハート | `U+1F0B1`〜`U+1F0BB` | `U+1F0BD`・`U+1F0BE` |
| ダイヤ | `U+1F0C1`〜`U+1F0CB` | `U+1F0CD`・`U+1F0CE` |
| クラブ | `U+1F0D1`〜`U+1F0DB` | `U+1F0DD`・`U+1F0DE` |

各スートの末尾 `C` は Knight なので除外し、Q は `D`、K は `E` を使う。補助面の文字は `String.fromCodePoint` で生成し、UTF-16 の 1 コード単位として扱わない。
これに `U+2660`（♠）、`U+2663`（♣）、`U+2665`（♥）、`U+2666`（♦）、空白 `U+0020` を加えた **57 文字**をサブセットに含める。空白は輪郭を持たず、送り幅は `260`。基本行メトリクスが端末の別フォントへ切り替わるのを避けるため、CSS の適用範囲にも空白を含める。

52 枚のカードはすべて、1,000 units/em に対して輪郭範囲 `(51, 0, 625, 766)`、送り幅 `676`、左サイドベアリング `51` を持つ。カード枠を含む輪郭の実幅は `574`、実高は `766`。元フォントの hhea は ascent `1069`、descent `-630`、line gap `0` で、サブセットでも変更しない。
画面上の位置・縮尺は CSS で調整する。疑似的な太字化は使わず、元の絵柄をそのまま描画する。
各札の上端にあるランクと小スートが見えるよう、通常の重なり幅はカード高の 32% に 2px を加えた値以上を基本とする。狭い横向きで列が長く、全札の絵柄が極小になる場合もトランプ文字の描画を維持し、横の余白にランク・スートの補助表示を添える。

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
| `src/fonts/noto-sans-symbols-2-cards.woff2` | 9,952 | `c4247bce13cb2722614151d7ac9c4e8674254aa66487a1deb8c02081f3ded523` |
| `src/fonts/OFL.txt` | 4,383 | `b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0` |

フォントとライセンスの合計は **14,335 バイト**。両方とも公開物全体の 50,000 バイト上限に含める。
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
スクリプトは固定 URL と元ファイルの SHA-256 を確認してから、52 枚のトランプ・4 スート・行メトリクス用の空白を生成する。
日時の再計算を無効にし、同じ版のツールで同じ WOFF2 を再現する。元の縦メトリクスは変更しない。
更新時は出力の文字一覧、輪郭・送り幅・メトリクス、ライセンス保持、公開物の全体サイズ、実ブラウザーの表示とオフライン読み込みを確認する。
