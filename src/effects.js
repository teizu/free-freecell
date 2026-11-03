/**
 * 音声ファイルを使わない効果音と、クリア後のキングの演出。
 * ゲーム状態や履歴は変更せず、非表示・動きを減らす設定では演出を止める。
 */
export function setupEffects(board, button, key) {
  let enabled = true;
  let context;
  let voice;
  let won = false;
  let winners = [];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  try { enabled = localStorage.getItem(key) !== '0'; } catch { /* 保存不可でも音の切り替えは使える。 */ }

  /** 記号と文言の両方で現在の音声状態を示し、読み上げにも有効・無効を伝える。 */
  function label() {
    button.firstElementChild.textContent = enabled ? ' 音声オン' : ' 音声オフ';
    button.setAttribute('aria-pressed', String(enabled));
  }

  /** 重ね鳴らしを避け、ミュートと画面非表示でも発音を確実に止める。 */
  function silence() {
    voice?.stop();
    voice = null;
  }

  /** 実際の入力時だけ音声を準備する。読み込みや自動移動から再生許可を要求しない。 */
  function unlock(event) {
    if (!enabled || !event.isTrusted) return;
    // 次の入力で前の音を止める。click より先なので、その操作のクリック音は消さない。
    silence();
    try {
      context ??= new AudioContext();
      if (context.state === 'suspended') context.resume().catch(() => {});
    } catch { /* 音声非対応でもゲームは続ける。 */ }
  }

  /**
   * 操作音は正弦波、クリアは明るい三角波の 6 音を約 900ms で鳴らす。
   * 許可前の音は溜めずに省略し、次の発音やミュートでは予約済みの残音も止める。
   */
  function play(kind = 'click') {
    if (!enabled || document.hidden || context?.state !== 'running') return;
    silence();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    const home = kind === 'home';
    const completed = kind === 'win';
    // ド・ミ・ソ・高いド・ソ・高いソ。最後は 1 オクターブ跳び、長く響かせる。
    const notes = completed ? [523, 659, 784, 1047, 784, 1568] : [home ? 900 : 600];
    if (completed) oscillator.type = 'triangle';
    const duration = completed ? .3 : home ? .065 : .025;
    notes.forEach((frequency, index) => {
      const start = now + index * .12;
      const length = completed && index < notes.length - 1 ? .1 : duration;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (home) oscillator.frequency.linearRampToValueAtTime(1200, start + duration);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(completed ? .22 : home ? .18 : .12, start + .004);
      gain.gain.linearRampToValueAtTime(0, start + length);
    });
    oscillator.connect(gain).connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      if (voice === oscillator) voice = null;
    };
    voice = oscillator;
    oscillator.start(now);
    oscillator.stop(now + (notes.length - 1) * .12 + duration);
  }

  /** 再描画・Undo・非表示で、古い要素のタイマーとアニメーションを残さない。 */
  function stopWin() {
    for (const item of winners) {
      clearTimeout(item.timer);
      item.animation?.cancel();
    }
    winners = [];
  }

  /** 4 枚それぞれが独立して回転を繰り返す。同期する全体タイマーは持たない。 */
  function win(value) {
    won = value;
    stopWin();
    if (!won || document.hidden || motion.matches) return;
    for (const card of board.querySelectorAll('.foundations .card')) {
      const item = {};
      winners.push(item);
      /** 開始間隔は 1〜15 秒。最短間隔が最長回転より長く、同じ札の演出は重ならない。 */
      function schedule() {
        if (!winners.includes(item)) return;
        item.timer = setTimeout(() => {
          item.animation = card.animate([
            { transform: 'rotateY(0deg)' }, { transform: 'rotateY(360deg)' },
          ], { duration: 100 + Math.random() * 400, easing: 'ease-in-out' });
          schedule();
        }, 1000 + Math.random() * 14000);
      }
      schedule();
    }
  }

  label();
  button.addEventListener('click', (event) => {
    enabled = !enabled;
    silence();
    label();
    try { localStorage.setItem(key, enabled ? '1' : '0'); } catch { /* この画面内の選択は保持する。 */ }
    if (enabled) unlock(event);
  });
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, unlock, true);
  // ドラッグ後の疑似 click を取り除くリスナーより後に登録し、移動完了音より先に鳴らす。
  document.addEventListener('click', (event) => {
    const target = event.target.closest('button, input, summary');
    if (event.isTrusted && target && target !== button && !target.disabled) play();
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) silence();
    win(won);
  });
  motion.addEventListener('change', () => win(won));
  window.addEventListener('pagehide', () => { silence(); stopWin(); });
  window.addEventListener('pageshow', () => win(won));
  // クリア音はホーム移動を確定した呼び出し元だけが指定し、復元・再描画では鳴らさない。
  return { home: (completed = false) => play(completed ? 'win' : 'home'), win };
}
