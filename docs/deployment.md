# GitHub Pages 公開方針

## 配信対象

GitHub Pages のプロジェクトサイトを使用します。
リポジトリは `teizu/free-freecell` とし、公開予定 URL は `https://teizu.github.io/free-freecell/` です。
この URL は独自ドメインを使わないプロジェクトサイトの形式から決まるもので、実際の公開状況は未確認です。
HTML・CSS・JavaScript を静的に配信し、サーバー側のアプリは用意しません。
この構成は [GitHub Pages の概要](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) に基づきます。

`src/` を GitHub Actions の公開成果物とし、`docs/` やリポジトリ全体をアップロードしません。
ビルド工程はありません。相対パスにより、ルートサイトとリポジトリ名付きのサブパスの両方で表示できるようにします。
全配布物は **50,000 バイト以下（圧縮前）**とし、ゲームの初回公開前に容量チェックとオフライン動作を確認します。
計測対象と更新通信の方針は [実装方針](architecture.md) を参照してください。
将来、最小化した公開物を生成する場合は、ワークフローの計測対象とアップロード先を同じ成果物に変更します。

## 初期段階の設定

[pages.yml](../.github/workflows/pages.yml) を用意しています。
起動条件は `workflow_dispatch` のみで、**push だけでは公開しません**。
`main` ブランチを選択した手動実行だけを受け付けます。
ゲームの初回公開後、自動公開が必要になれば `main` への push を起動条件に追加します。

設定は [GitHub 公式のカスタムワークフロー手順](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) を基に、
checkout → Pages 設定 → `src/` のアップロード → deploy の順としています。
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

リポジトリへの push と Pages の公開は別の操作です。現在のワークフローは手動実行時だけ公開します。

## サイトを公開するとき

1. GitHub の **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にします。
2. **Actions → Deploy GitHub Pages → Run workflow** で `main` を選び、実行します。
3. 成功した実行の `github-pages` 環境から公開 URL を開き、下記の確認を行います。

初期ソースをこの手順で公開すると「準備中」の画面が表示されます。
ゲームとしての初回公開は、[実装計画](roadmap.md) の受け入れ確認を終えてから行います。

## 公開時の確認

- 全配布物の合計が 50,000 バイト以下であり、CI でも超過時に公開を止める。
- 表示された実際の URL と公開したコミットを記録する。
- サブパスから HTML・CSS・JavaScript を取得でき、404 がない。
- 日本語とスート記号が文字化けせず、ブラウザーのコンソールにエラーがない。
- スマートフォンと PC の画面で必要なカード・操作が見える。
- 保存実装後は、ページ再読込で復元でき、保存が禁止されてもプレイを続けられる。
- 初回取得とキャッシュ完了後、ネットワークを切ってブラウザーを開き直しても、新規ゲームと保存したゲームの続行ができる。
- ローカルコピーを HTTP サーバーで起動し、外部ネットワークなしで遊べる。
- ゲーム操作や再配札で通信が発生せず、再訪時はキャッシュを利用する。初回・再訪・更新時の実転送量を記録する。
- 新版への更新が対局を中断せず、取得失敗時にも旧版を使える。
- 公開物に開発文書や設定ファイルを含めていない。

公開後の不具合は、対象変更を修正または revert したコミットを `main` に追加し、同じワークフローで再公開します。
ローカルの検証だけでは、GitHub 上の権限・Actions 実行・本番 URL での動作を確認したことにはなりません。
