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
これに `U+2660`（♠）、`U+2663`（♣）、`U+2665`（♥）、`U+2666`（♦）、空白 `U+0020` を加えた **57 文字**をサブセットに含める。空白は輪郭を持たず、送り幅は `260`。基本行メトリクスが端末の別フォントへ切り替わるのを避けるため、空白も同梱する。CSS の `unicode-range` は全範囲を許す既定値を使い、実際に適用する文字はサブセットの文字一覧で決まる。同じ文字一覧と標準の太さ・スタイルを CSS へ重複して書かず、容量を抑える。

52 枚のカードはすべて、1,000 units/em に対して輪郭範囲 `(51, 0, 625, 766)`、送り幅 `676`、左サイドベアリング `51` を持つ。カード枠を含む輪郭の実幅は `574`、実高は `766`。元フォントの hhea は ascent `1069`、descent `-630`、line gap `0` で、サブセットでも変更しない。
画面上の位置・縮尺は CSS で調整する。カード高から四辺の余白 2px を除いて字形を描き、カード幅は `(カード高 - 4px) × 574 / 766 + 4px` とする。送り幅 `676` ではなく輪郭の実寸比で白い外枠を決め、列の中央へ置く。疑似的な太字化や字形の引き伸ばしは行わない。
各札の上端にあるランクと小スートが見えるよう、通常の重なり幅はカード高の 32% に 2px を加えた値以上を基本とする。低い横向き画面では盤面全体に画面高を使い、字形と段差を調整する。全札のトランプ文字を保ち、別のランク・スートを横の余白に重ねる補助表示は使わない。

## 取得元とライセンス

取得元は [Google Fonts の Noto Sans Symbols 2](https://github.com/google/fonts/tree/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notosanssymbols2)。
Google Fonts のコミットを `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5` に固定する。
その `METADATA.pb` が示す上流は [notofonts/symbols](https://github.com/notofonts/symbols/tree/25b00f0d3f40873a005287514ba2a48558655314) のコミット `25b00f0d3f40873a005287514ba2a48558655314`、リリースは `NotoSansSymbols2-v2.008`。

著作権表記は `Copyright 2022 The Noto Project Authors (https://github.com/notofonts/symbols)`。
[元の OFL](https://github.com/google/fonts/blob/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notosanssymbols2/OFL.txt) は SIL Open Font License 1.1 で、著作権表記の後に Reserved Font Name の指定はない。
文字の削減と形式変更を行うサブセットも同じ OFL 1.1 で配布し、フォント内の著作権・名前・版・ライセンス情報を保持する。
公式 [OFL FAQ 1.10](https://openfontlicense.org/ofl-faq/) は、フォント内のメタデータに公式 OFL へのリンクを含める方式でもライセンス要件を満たすと説明している。全文収録を推奨しているが、このサイトでは容量を優先してリンク方式を採用する。FAQ 2.4 が求める著作権とライセンスのメタデータも保持する。

配布する WOFF2 の `name` テーブルは、ID 0 に元の著作権表記と上流 URL、ID 13 に OFL 1.1 の宣言と公式 URL、ID 14 に公式 URL `https://scripts.sil.org/OFL` を持つ。この元の URL は現在の公式サイト `https://openfontlicense.org/` へ転送されることを確認した（2026-11-03）。元のメタデータとフォントのバイト列は変えない。
フッターのリンクは [公式ライセンス全文](https://openfontlicense.org/open-font-license-official-text/) を指す。クリックしない限り外部取得は発生せず、ゲームとフォントのオフライン利用も維持する。外部の全文ページを開くときは接続が必要。

取得元の原本は [docs/licenses/OFL.txt](licenses/OFL.txt) にバイト列のまま保存し、開発資料として管理する。`src/` の外に置くため、公開物やオフラインキャッシュには別ファイルとして含めない。ゲーム本体の著作権表示とは分けて扱う。

## 固定した入力と出力

| ファイル | バイト数 | SHA-256 |
| --- | ---: | --- |
| 元の `NotoSansSymbols2-Regular.ttf` | 1,233,128 | `7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21` |
| `src/fonts/noto-sans-symbols-2-cards.woff2` | 9,952 | `c4247bce13cb2722614151d7ac9c4e8674254aa66487a1deb8c02081f3ded523` |
| `docs/licenses/OFL.txt`（開発資料） | 4,383 | `b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0` |

公開するフォントは、ライセンスのメタデータを含めて **9,952 バイト**。公開物全体の 50,000 バイト上限に含める。開発資料の OFL 原本は公開対象外で、独立したライセンスファイル 4,383 バイトの取得・キャッシュが不要になる。
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
スクリプトは固定 URL と元ファイルの SHA-256 を確認してから、52 枚のトランプ・4 スート・行メトリクス用の空白を生成する。生成前後の著作権・OFL 宣言・公式 URL も照合し、メタデータが欠落・変更した場合は出力を採用しない。OFL 原本の出力先は `docs/licenses/` とする。
日時の再計算を無効にし、同じ版のツールで同じ WOFF2 を再現する。元の縦メトリクスは変更しない。
更新時は出力の文字一覧、輪郭・送り幅・メトリクス、ライセンス保持、公開物の全体サイズ、実ブラウザーの表示とオフライン読み込みを確認する。
