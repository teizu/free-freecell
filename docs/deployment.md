# GitHub Pages 公開方針

## 配信対象

GitHub Pages のプロジェクトサイトを使用します。
公開 URL は通常 `https://<owner>.github.io/<repository>/` となります。
HTML・CSS・JavaScript を静的に配信し、サーバー側のアプリは用意しません。
この構成は [GitHub Pages の概要](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) に基づきます。

`src/` を GitHub Actions の公開成果物とし、`docs/` やリポジトリ全体をアップロードしません。
ビルド工程はありません。相対パスにより、ルートサイトとリポジトリ名付きのサブパスの両方で表示できるようにします。

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

1. GitHub アカウントとリポジトリ名を決め、空のリポジトリを作ります。ローカルに初回コミットがあるため、GitHub 側で README などを追加しません。
2. アカウントのプランとリポジトリの公開範囲が Pages に対応していることを確認します。無料プランでは公開リポジトリを前提とします。
3. ローカルリポジトリへ接続先を登録し、`main` を push します。下の `<owner>` と `<repository>` は実際の値に置き換えます。

   ```sh
   git remote add origin git@github.com:<owner>/<repository>.git
   git push -u origin main
   ```

4. GitHub の **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にします。
5. **Actions → Deploy GitHub Pages → Run workflow** で `main` を選び、実行します。
6. 成功した実行の `github-pages` 環境から公開 URL を開き、下記の確認を行います。

初期ソースをこの手順で公開すると「準備中」の画面が表示されます。
ゲームとしての初回公開は、[実装計画](roadmap.md) の受け入れ確認を終えてから行います。

## 公開時の確認

- 表示された実際の URL と公開したコミットを記録する。
- サブパスから HTML・CSS・JavaScript を取得でき、404 がない。
- 日本語とスート記号が文字化けせず、ブラウザーのコンソールにエラーがない。
- スマートフォンと PC の画面で必要なカード・操作が見える。
- 保存実装後は、ページ再読込で復元でき、保存が禁止されてもプレイを続けられる。
- 公開物に開発文書や設定ファイルを含めていない。

公開後の不具合は、対象変更を修正または revert したコミットを `main` に追加し、同じワークフローで再公開します。
ローカルの検証だけでは、GitHub 上の権限・Actions 実行・本番 URL での動作を確認したことにはなりません。
