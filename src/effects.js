/**
 * 音声ファイルを使わない効果音と、クリア後のキングの演出。
 * ゲーム状態や履歴は変更せず、非表示・動きを減らす設定では演出を止める。
 */
import { TABLEAU, HOME, CELLS } from './game.js';

/** 音声設定と勝利演出を準備し、画面側からの開始・停止要求を受け付ける。 */
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
   * クリアだけ gain 0.5 の三角波、操作・移動・開始は gain 0.1 の正弦波にする。
   * 移動先を音程で区別し、開始は 3 音、クリアは 6 音のフレーズで知らせる。
   * 許可前の音は溜めずに省略し、次の発音やミュートでは予約済みの残音も止める。
   */
  function play(kind = 'click') {
    if (!enabled || document.hidden || context?.state !== 'running') return;
    silence();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    const home = kind === HOME;
    const completed = kind === 'win';
    const starting = kind === 'start';
    // 開始はド・ミ・ソ。クリアはさらに高いド・ソ・高いソと続け、最後を長く響かせる。
    const notes = completed ? [523, 659, 784, 1047, 784, 1568] : starting ? [523, 659, 784]
      : [home ? 900 : kind === CELLS ? 720 : kind === TABLEAU ? 660 : 600];
    if (completed) oscillator.type = 'triangle';
    const duration = completed ? .3 : starting ? .1 : home ? .09 : kind === 'click' ? .025 : .06;
    notes.forEach((frequency, index) => {
      const start = now + index * .12;
      const length = completed && index < notes.length - 1 ? .1 : duration;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (home) oscillator.frequency.linearRampToValueAtTime(1200, start + duration);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(completed ? .5 : .1, start + .004);
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
      // Q・J は表示上の演出だけ。中断時は保存状態にかかわらず元の K へ戻す。
      item.face.textContent = item.king;
    }
    winners = [];
  }

  /** 祝賀指定時だけ 4 枚同時に絵札を巡り、その後は各スート独立の回転を繰り返す。 */
  function win(value, celebrate = false) {
    won = value;
    stopWin();
    if (!won || document.hidden || motion.matches) return;
    for (const card of board.querySelectorAll('.foundations .card')) {
      const face = card.firstElementChild;
      const item = { face, king: face.textContent };
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

      /** 縁が正面を向く半回転の境界で字形だけを替え、数字や履歴には触れない。 */
      async function salute() {
        // Unicode の Knight を飛ばすため、K→Q は -1、K→J は -3 のコードポイント差。
        for (const [offset, duration] of [[-1, 500], [-3, 200], [0, 200]]) {
          for (const angle of [90, 0]) {
            item.animation = card.animate([
              { transform: `rotateY(${angle ? 0 : -90}deg)` },
              { transform: `rotateY(${angle}deg)` },
            ], { duration: duration / 2, easing: 'ease-in-out' });
            await item.animation.finished.catch(() => {});
            // Undo・非表示・動きを減らす設定で中断した非同期処理は再開させない。
            if (!winners.includes(item)) return;
            face.textContent = String.fromCodePoint(item.king.codePointAt(0) + offset);
          }
          if (offset) await new Promise(resolve => { item.timer = setTimeout(resolve, 100); });
          if (!winners.includes(item)) return;
        }
        schedule();
      }
      if (celebrate) salute();
      else schedule();
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
  // 移動処理後に通知を受け、既に移動音が鳴っていればクリック音で上書きしない。
  // ドラッグ後の疑似 click はドラッグ側で除外される。
  // disabled の実 click はブラウザーが止める。操作後に disabled になった Undo は鳴らす。
  document.addEventListener('click', (event) => {
    const target = event.target.closest('button, input, summary');
    if (event.isTrusted && !voice && target && target !== button) play();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) silence();
    win(won);
  });
  motion.addEventListener('change', () => win(won));
  window.addEventListener('pagehide', () => { silence(); stopWin(); });
  window.addEventListener('pageshow', () => win(won));
  // クリア音はホーム移動を確定した呼び出し元だけが指定し、復元・再描画では鳴らさない。
  return {
    /** 成功した移動先を音へ変換し、クリックとドラッグで同じ音を鳴らす。 */
    move(zone, completed = false) {
      play(completed ? 'win' : zone);
    },
    start: () => play('start'),
    celebrate: () => win(won, true),
    win,
  };
}
