# FreeCell

GitHub Pages で遊べる、日本語のフリーセルです。
HTML・CSS・JavaScript の静的サイトで、ゲームはブラウザー内だけで動作します。
Node.js 24 の標準機能で公開ファイルを生成し、外部パッケージのインストールは必要ありません。

## 最上位の方針

- **全配布物を 50KB（50,000 バイト、圧縮前）以下**に収めます。HTML・CSS・JavaScript・Service Worker・追加素材を合計し、開発文書や Git 履歴は含めません。
- ゲーム操作・配札・保存を端末内で完結させ、初回取得と更新に必要な通信だけに抑えます。
- 初回取得とキャッシュ完了後は、インターネットなしで再起動して遊べることを初回公開の必須条件にします。
- ローカルコピーは `localhost` の HTTP サーバーで起動でき、外部のライブラリ・API・Web フォントなどを取得しません。

詳細は [実装方針](docs/architecture.md)、開発時の遵守事項は [AGENTS.md](AGENTS.md) を参照してください。

## 現在の状態

配札、1 枚・連続したカードの移動、Undo／Redo、新しいゲーム、同じ配りのやり直し、手数・時間、勝利判定を実装しています。
マウス・タップ・キーボードで操作でき、進行の保存・復元と、配布版のオフライン起動に対応しています。
実ブラウザーでの最終確認と公開確認は進行中です。確認環境と未検証範囲は [検証記録](docs/verification.md) に記載します。
GitHub リポジトリは [teizu/free-freecell](https://github.com/teizu/free-freecell) です。初回 push は完了しています。
`origin` は SSH 設定のホスト別名を使った `git@teizu-github:teizu/free-freecell.git` です。
GitHub Pages の公開先は `https://teizu.github.io/free-freecell/` を予定しています。実際の公開状況は未確認です。

## ローカルで遊ぶ

Node.js 24 と Python 3 がある環境で、リポジトリ直下から次を実行します。

```sh
npm run build
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

ブラウザーで <http://127.0.0.1:8000/> を開きます。終了は `Ctrl+C` です。
ビルドもゲームもインターネット接続を必要としません。生成済みの `dist/` を別の端末にコピーして使う場合、Node.js は不要です。
「オフラインでも遊べます」と表示された後は、サーバーを止めても同じ URL で再起動できます。
ただし、ブラウザーのキャッシュ削除や保存禁止設定がある場合は、サーバーから再取得が必要です。

Python は静的ファイルの配信にだけ使用します。アプリの処理はすべてブラウザー内で動きます。
ES Modules と Service Worker を使うため、`file://` での HTML 直接起動は対象外です。

## 開発と検証

開発用ソースをビルドせず確認する場合は、公開物と別のポートを使います。

```sh
python3 -m http.server 8001 --bind 127.0.0.1 --directory src
```

<http://127.0.0.1:8001/> では Service Worker を登録しません。編集内容を直接確認でき、サーバー起動中はネット接続なしで遊べます。
オフライン再起動と更新動作は `dist/` で確認してください。

```sh
npm test
npm run build
npm run check:size
```

`npm run build` は JS・CSS に内容ハッシュを付け、Service Worker の保存対象を生成します。
`dist/` 全体が 50,000 バイトを超えると失敗します。ソースの説明コメントは維持します。

## 構成

```text
src/
  index.html             盤面、操作ボタン、遊び方
  main.js                描画・操作・時計・各機能の接続
  game.js                配札、合法手、履歴、勝利判定
  storage.js             保存・復元と検証
  offline.js             オフラインの準備・更新状況
  sw.js                  配布版のキャッシュと更新
  styles.css             レスポンシブな盤面
scripts/                 ビルド・容量チェック・ブラウザー検証
tests/                   ゲーム・保存・ビルド・キャッシュのテスト
dist/                    生成された公開物（Git 管理対象外）
docs/
  README.md              文書の案内
  game-spec.md           ゲーム仕様・操作・受け入れ条件
  architecture.md        構成・実装・検証の方針
  deployment.md          GitHub Pages の公開手順
  roadmap.md             実装の順序と確認項目
  verification.md        検証結果と未確認の範囲
.github/workflows/
  pages.yml              main の検証と dist/ の公開
  check.yml              PR の検証
```

仕様は [docs/README.md](docs/README.md)、公開方法は [公開手順](docs/deployment.md) から確認できます。
`main` への push でテスト・ビルド・容量チェックを行い、成功した `dist/` を GitHub Pages に公開します。
開発文書だけの変更では再公開しません。

## 参考

[Solitaire.Free の FreeCell](https://solitaire.free/freecell/) を機能の参考にしています。
具体的な採用範囲は [ゲーム仕様](docs/game-spec.md) に記載し、ソースコード・画像・文言の複製は行いません。
