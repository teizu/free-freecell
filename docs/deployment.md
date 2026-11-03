# GitHub Pages 公開方針

## 配信対象

GitHub Pages のプロジェクトサイトを使用します。
公開 URL は通常 `https://<owner>.github.io/<repository>/` となります。
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

## GitHub 側で行う作業

以下は今後の公開手順です。現在はリモートリポジトリの作成・push・公開をしていません。

1. GitHub にログインし、[新規リポジトリ作成画面](https://github.com/new) を開きます。Owner を選び、Repository name は `freecell` を基本とします。
2. GitHub Free で Pages を使う場合は **Public** を選びます。この場合、ソースと開発文書も公開されます。Private を選ぶ場合は利用プランが Pages に対応していることを確認します。
3. README の追加はオフ、`.gitignore` と License は None にして、**Create repository** を押します。テンプレートやコード生成も使用せず、空で作ります。ローカルに履歴があるため、GitHub 側に別の初回コミットを作りません。
4. 作成後の Quick Setup に表示される接続先 URL をコピーし、ローカルに `origin` を登録して push します。以下の `YOUR_ACCOUNT` は実際の Owner に置き換えます。リポジトリ名を変えた場合は `freecell` も置き換えます。

   ```sh
   cd /home/moto/src/Game/freecell
   git remote add origin https://github.com/YOUR_ACCOUNT/freecell.git
   git push -u origin main
   ```

   HTTPS の認証は Git の認証マネージャーなどを使用します。SSH 鍵の登録済み環境では、代わりに Quick Setup の SSH URL を使えます。

5. GitHub で `main` にファイルが表示されることを確認します。リポジトリへの push だけではサイトは公開されません。

作成と push の手順は [GitHub 公式: ローカルコードの追加](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github) に基づきます。

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
