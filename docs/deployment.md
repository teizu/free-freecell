# GitHub Pages 公開方針

## 配信対象

GitHub Pages のプロジェクトサイトを使用します。
リポジトリは `teizu/free-freecell` とし、公開予定 URL は `https://teizu.github.io/free-freecell/` です。
この URL は独自ドメインを使わないプロジェクトサイトの形式から決まるもので、実際の公開状況は未確認です。
HTML・CSS・JavaScript を静的に配信し、サーバー側のアプリは用意しません。
この構成は [GitHub Pages の概要](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) に基づきます。

`npm run build` で生成した `dist/` を GitHub Actions の公開成果物とし、`src/`・`docs/`・リポジトリ全体はアップロードしません。
ビルドには Node.js 24 だけを使い、外部パッケージのインストールは不要です。
JS・CSS の参照先を内容ハッシュ付きの相対 URL に変換し、Service Worker の保存対象一覧を生成します。
相対パスにより、ルートサイトとリポジトリ名付きのサブパスの両方に対応します。
全配布物は **50,000 バイト以下（圧縮前）**とし、ゲームの初回公開前に容量チェックとオフライン動作を確認します。
計測対象と更新通信の方針は [実装方針](architecture.md) を参照してください。
計測対象とアップロード先は、常に同じ `dist/` 全体です。ビルドが上限超過で失敗した場合は公開しません。

## GitHub Actions の設定

[pages.yml](../.github/workflows/pages.yml) を用意しています。
**`main` への push で、検証を通った版を自動公開します。**
`docs/`・`README.md`・`AGENTS.md` だけの更新では、アプリの再公開を行いません。
`workflow_dispatch` による手動実行も利用でき、公開対象は `main` に限定します。
[check.yml](../.github/workflows/check.yml) は PR で同じテストとビルドを行い、公開しません。

設定は [GitHub 公式のカスタムワークフロー手順](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) を基に、
checkout → Node.js の準備 → `npm test` → `npm run build` → Pages 設定 → `dist/` のアップロード → deploy の順としています。
公開ジョブには `contents: read`、`pages: write`、`id-token: write` を設定し、`github-pages` 環境を使用します。
アプリ用の秘密情報や外部 API キーは必要ありません。

## 設定済みのリポジトリ

2026-11-03 にリポジトリの作成と初回 push が完了しています。

| 項目 | 値 |
| --- | --- |
| GitHub リポジトリ | [teizu/free-freecell](https://github.com/teizu/free-freecell) |
| `origin` | `git@teizu-github:teizu/free-freecell.git` |
| ブランチ | `main`（追跡先: `origin/main`） |
| ローカルフォルダ | `/home/moto/src/Game/freecell` |
| Pages の公開予定 URL | `https://teizu.github.io/free-freecell/` |

`teizu-github` は利用者の SSH 設定にあるホスト別名です。この接続先を通常の `github.com` に書き換えずに使用します。
別の端末でこの SSH URL を使う場合は、その端末でも対応する SSH 設定と鍵を用意します。
ブラウザーから開く URL は `github.com`、サイトの配信先は `teizu.github.io` であり、SSH のホスト別名は使いません。

この作業フォルダでは `origin` と追跡先が設定済みのため、追加の `git remote add` は不要です。
変更をコミットして GitHub に送る際は、次のコマンドを使います。

```sh
git push origin main
```

`main` への push は公開処理を開始しますが、テスト・ビルド・デプロイが成功するまでは公開完了ではありません。

## サイトを公開するとき

1. GitHub の **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にします。
2. ローカルで `npm test` と `npm run build` を確認し、コミットを `main` に push します。再公開だけを行う場合は **Actions → Deploy GitHub Pages → Run workflow** で `main` を選んで実行できます。
3. 成功した実行の `github-pages` 環境から公開 URL を開き、下記の確認を行います。

ゲームとしての初回公開は、[実装計画](roadmap.md) の受け入れ確認を終えてから行います。
デプロイ結果、公開したコミット、実際に確認した条件は [検証記録](verification.md) に記載します。

## 公開時の確認

- 全配布物の合計が 50,000 バイト以下であり、CI でも超過時に公開を止める。
- 表示された実際の URL と公開したコミットを記録する。
- サブパスから HTML・CSS・JavaScript を取得でき、404 がない。
- 日本語とスート記号が文字化けせず、ブラウザーのコンソールにエラーがない。
- スマートフォンと PC の画面で必要なカード・操作が見える。
- ページ再読込で復元でき、保存が禁止されてもプレイを続けられる。
- 初回取得とキャッシュ完了後、ネットワークを切ってブラウザーを開き直しても、新規ゲームと保存したゲームの続行ができる。
- ローカルコピーを HTTP サーバーで起動し、外部ネットワークなしで遊べる。
- ゲーム操作や再配札で通信が発生せず、再訪時はキャッシュを利用する。初回・再訪・更新時の実転送量を記録する。
- 新版への更新が対局を中断せず、取得失敗時にも旧版を使える。
- 公開物に開発文書や設定ファイルを含めていない。

公開後の不具合は、対象変更を修正または revert したコミットを `main` に追加し、同じワークフローで再公開します。
ローカルの検証だけでは、GitHub 上の権限・Actions 実行・本番 URL での動作を確認したことにはなりません。
