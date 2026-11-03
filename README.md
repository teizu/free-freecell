# FreeCell

GitHub Pages で遊べる、日本語のフリーセルを作るプロジェクトです。
HTML・CSS・JavaScript の静的サイトとして実装し、サーバーやビルドツールを必要としない構成から始めます。

## 現在の状態

初期セットアップ段階です。`src/` には日本語の案内、盤面の配置見本、遊び方を表示するひな形があります。
**配札、カード移動、Undo／Redo、保存などのゲーム機能は未実装で、まだ遊べません。**
GitHub のリモートリポジトリ作成、push、実際の Pages 公開は行っていません。

## ローカルで表示する

Python 3 を使用する場合、リポジトリ直下で次を実行します。

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory src
```

ブラウザーで <http://127.0.0.1:8000/> を開きます。終了は `Ctrl+C` です。
Python は確認用の HTTP サーバーにだけ使用します。アプリの動作に必要なのはブラウザーだけです。
ES Modules を使用するため、HTML ファイルの直接起動ではなく HTTP 経由で確認してください。

## 構成

```text
src/
  index.html             ページの起点と日本語の案内
  main.js                盤面の配置見本を描画
  styles.css             初期画面のスタイル
docs/
  README.md              文書の案内と今回の作業範囲
  game-spec.md           ゲーム仕様・操作・受け入れ条件
  architecture.md        構成・実装・検証の方針
  deployment.md          GitHub Pages の公開手順
  roadmap.md             実装の順序と確認項目
.github/workflows/
  pages.yml              src/ を手動公開するワークフロー
```

仕様は [docs/README.md](docs/README.md) から確認できます。
JavaScript の構文は `node --check src/main.js` で確認できます。
ゲームロジックのテストは、その実装と合わせて追加します。

## 参考

[Solitaire.Free の FreeCell](https://solitaire.free/freecell/) を機能の参考にしています。
具体的な採用範囲は [ゲーム仕様](docs/game-spec.md) に記載し、ソースコード・画像・文言の複製は行いません。
