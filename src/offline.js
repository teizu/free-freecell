/** オフライン準備とクリック更新を扱う。進行の保存は画面側のコールバックへ任せる。 */
const PUBLISHED = '__FREECELL_BUILD__' === 'published';
// 同じ失敗理由は共有し、どの更新経路でも同じ案内にする。
const SAVE_ERROR = '保存できず更新を中止。この画面では続けられます。';
const UPDATE_ERROR = '更新に失敗しました。再試行してください。';

/** 新版を待機させ、保存できたタブだけが利用者の操作で再読み込みする。 */
export async function setupOffline(onStatus, button, prepareUpdate) {
  if (!PUBLISHED) {
    onStatus('ローカル版 · サーバー起動中はネット不要');
    return;
  }
  if (!('serviceWorker' in navigator) || !isSecureContext) {
    onStatus('この環境はオフライン再起動非対応です');
    return;
  }
  onStatus('オフライン準備中…');
  try {
    const initialController = navigator.serviceWorker.controller;
    const registration = await navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), { scope: './' });
    let changed = initialController !== null && initialController !== navigator.serviceWorker.controller;
    let requested = false;
    let reloading = false;
    let timeout;
    let waitingFor = null;

    /** 待機中と別タブでの適用済みを同じボタンで扱い、初回起動では表示しない。 */
    function report(worker) {
      button.hidden = !registration.waiting && !changed;
      button.disabled = requested;
      if (requested) onStatus('更新しています…');
      else if (!button.hidden) onStatus('新版あり。進行を引き継いで更新できます。');
      else if (registration.active) onStatus('オフラインでも遊べます');
      else if (worker?.state === 'redundant') onStatus('オフライン準備失敗。次回起動時に再試行します');
    }

    /** 失敗時は現在のゲームを残し、ボタンからやり直せるようにする。 */
    function failed(message) {
      clearTimeout(timeout);
      requested = false;
      waitingFor = null;
      report();
      onStatus(message);
    }

    /** 非同期の適用中に進んだ手も直前に保存し、他タブは再読み込みしない。 */
    function reload() {
      if (!requested || reloading) return;
      changed = true;
      if (!prepareUpdate(true)) {
        failed(SAVE_ERROR);
        return;
      }
      reloading = true;
      waitingFor = null;
      clearTimeout(timeout);
      location.reload();
    }

    /** 新版のインストール完了を通知する。ダウンロードだけでは対局を中断しない。 */
    function observe(worker) {
      let update = Boolean(worker && worker === registration.waiting);
      /** 制御外のタブでも、別タブが待機版を適用したことを検知する。 */
      function reportState() {
        if (worker?.state === 'installed' && registration.active) update = true;
        if (worker?.state === 'activated' && update) changed = true;
        report(worker);
      }
      if (worker) worker.addEventListener('statechange', reportState);
      reportState();
    }
    registration.addEventListener('updatefound', () => observe(registration.installing));
    /** 他タブでの適用は案内だけにし、自分が要求した更新だけを再読み込みへ進める。 */
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      changed ||= initialController !== null;
      if (requested) reload();
      else report();
    });
    /** 保存確認後に一度だけ待機解除を要求し、適用できない場合は操作可能な状態へ戻す。 */
    button.addEventListener('click', () => {
      if (requested) return;
      if (!prepareUpdate(false)) {
        failed(SAVE_ERROR);
        return;
      }
      requested = true;
      report();
      const waiting = registration.waiting;
      if (!waiting) {
        reload();
        return;
      }
      waitingFor = waiting;
      // 強制再読込などで SW の制御外にいるタブも、worker 自身の適用完了を待てる。
      waiting.addEventListener('statechange', () => {
        if (waitingFor !== waiting) return;
        if (waiting.state === 'activated') reload();
        else if (waiting.state === 'redundant') failed(UPDATE_ERROR);
      });
      timeout = setTimeout(() => {
        if (waitingFor === waiting) failed(UPDATE_ERROR);
      }, 10000);
      try {
        waiting.postMessage({ type: 'APPLY_UPDATE' });
      } catch {
        failed(UPDATE_ERROR);
      }
    });
    observe(registration.waiting ?? registration.installing);
  } catch {
    onStatus('オフライン準備未確認。読込済みのゲームは遊べます');
  }
}
