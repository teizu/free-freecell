/** Service Worker の準備と更新状況を通知する。ゲームの処理やタイマーには触れない。 */
const PUBLISHED = '__FREECELL_BUILD__' === 'published';

/** ビルド済みの公開物だけをキャッシュし、失敗しても現在のゲームを継続する。 */
export async function setupOffline(onStatus) {
  if (!PUBLISHED) {
    onStatus('ローカル版 · サーバー起動中はネット接続なしで遊べます');
    return;
  }
  if (!('serviceWorker' in navigator) || !isSecureContext) {
    onStatus('この環境ではオフライン再起動を利用できません');
    return;
  }
  onStatus('オフラインで遊ぶ準備をしています…');
  try {
    const registration = await navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { scope: './' });

    /** インストールの完了と更新の待機を区別し、誤った準備完了表示を避ける。 */
    function report(worker) {
      if (registration.waiting) onStatus('更新の準備ができました。すべてのタブを閉じて開き直すと適用します');
      else if (registration.active) onStatus('オフラインでも遊べます');
      else if (worker?.state === 'redundant') onStatus('オフライン準備に失敗しました。次回の起動時に再試行します');
    }

    /** 新版のダウンロード後は標準の待機を使い、対局中に強制切り替えしない。 */
    function observe(worker) {
      if (worker) worker.addEventListener('statechange', () => report(worker));
      report(worker);
    }
    registration.addEventListener('updatefound', () => observe(registration.installing));
    observe(registration.installing);
  } catch {
    onStatus('オフライン準備を確認できません。読み込み済みのゲームは遊べます');
  }
}
