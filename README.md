# FreeCell

GitHub Pages で遊べる、日本語のフリーセルを作るプロジェクトです。
HTML・CSS・JavaScript の静的サイトとして実装し、サーバーやビルドツールを必要としない構成から始めます。

## 最上位の方針

- **全配布物を 50KB（50,000 バイト、圧縮前）以下**に収めます。HTML・CSS・JavaScript・Service Worker・追加素材を合計し、開発文書や Git 履歴は含めません。
- ゲーム操作・配札・保存を端末内で完結させ、初回取得と更新に必要な通信だけに抑えます。
- 初回取得とキャッシュ完了後は、インターネットなしで再起動して遊べることを初回公開の必須条件にします。
- ローカルコピーは `localhost` の HTTP サーバーで起動でき、外部のライブラリ・API・Web フォントなどを取得しません。

詳細は [実装方針](docs/architecture.md)、開発時の遵守事項は [AGENTS.md](AGENTS.md) を参照してください。

## 現在の状態

初期セットアップ段階です。`src/` には日本語の案内、盤面の配置見本、遊び方を表示するひな形があります。
**配札、カード移動、Undo／Redo、保存、オフライン再起動などのゲーム機能は未実装で、まだ遊べません。**
GitHub のリモートリポジトリ作成、push、実際の Pages 公開は行っていません。

## ローカルで表示する

Python 3 を使用する場合、リポジトリ直下で次を実行します。

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory src
```

ブラウザーで <http://127.0.0.1:8000/> を開きます。終了は `Ctrl+C` です。
Python は確認用の HTTP サーバーにだけ使用します。アプリの動作に必要なのはブラウザーだけです。
ES Modules を使用するため、HTML ファイルの直接起動ではなく HTTP 経由で確認してください。
ソースと Python が手元にあれば、この方法の表示にインターネット接続は不要です。
公開サイトを一度取得してからオフラインで再起動する機能は、Service Worker の実装時に追加します。

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
