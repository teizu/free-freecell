/**
 * FreeCell の画面と操作。ルールは game.js、保存は storage.js に任せる。
 * DOM はゲーム状態から描画し、時計と案内だけを個別に更新する。
 */
import { SUITS, rank, cardLabel, createGame, getBoard, getActions, move, quickMove, autoHome, undo, redo, restart, isWon } from './game.js';
import { loadGame, saveGame, saveReload, takeReload } from './storage.js';
import { setupOffline } from './offline.js';
import { positionOf, setupDrag } from './drag.js';
import { setupEffects } from './effects.js';
import { formatTime, loadRecords, saveRecord } from './records.js';

const find = (id) => document.getElementById(id);
const boardElement = find('board');
const maximize = find('maximize');
const dialog = find('confirm-dialog');
const storageKey = `freecell:${new URL('./', location.href).pathname}:v1`;
const reloadKey = `${storageKey}:reload`;
const recordsKey = `${storageKey}:records`;
const recordsDialog = find('records-dialog');
const resumed = takeReload(reloadKey);
const restored = resumed ? { game: resumed.game, error: null } : loadGame(storageKey);
let game = restored.game ?? createGame();
let selected = null;
let runningSince = null;
let replacementPending = false;
let lastCardClick = null;
let pointerType = '';
// 読み込み・変更時で同じ保存エラーを案内する。
const autoSaveError = '自動設定の保存に失敗。この画面では操作できます。';
let settingError = '';
let recordError = '';
let automaticRun = 0;
let automaticAnimation = null;
let landscape = false;
let maximized = false;
let previousScroll = 0;
try {
  find('auto-enabled').checked = resumed?.automatic ?? localStorage.getItem(`${storageKey}:auto-home`) === '1';
  if (resumed) localStorage.setItem(`${storageKey}:auto-home`, resumed.automatic ? '1' : '0');
} catch {
  settingError = autoSaveError;
}

/** 文言は HTML として解釈せず、日本語のまま読み上げ領域へ渡す。 */
function announce(message) {
  find('message').textContent = message;
  fitBoard();
}

/** 小画面では列の枚数と表示可能な高さから縮め、盤面全体を見渡せるようにする。 */
function fitBoard() {
  const view = window.visualViewport;
  // 拡大・パン中も解除ボタンを可視領域の右上に保ち、タップ領域の大きさを変えない。
  maximize.style.transform = maximized && view
    ? `translate(${view.offsetLeft + view.width - innerWidth - 8 / view.scale}px, ${view.offsetTop + 2 / view.scale}px) scale(${1 / view.scale})` : '';
  // ピンチによる拡大は利用者に任せ、拡大中に縮小し直さない。
  if (view && view.scale !== 1) return;
  const column = boardElement.querySelector('.column');
  if (!column) return;
  const wide = matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
  if (wide !== landscape) {
    landscape = wide;
    // 横向きに入ったときだけ盤面へ進む。メニューを読むためのスクロールは奪わない。
    requestAnimationFrame(() => { if (!maximized) wide ? boardElement.parentElement.scrollIntoView({ block: 'start' }) : scrollTo(0, 0); });
  }
  // 文字の送り幅ではなく全 52 枚共通の枠（574×766）と四辺 2px で大きさを決める。
  // ボタン自身の幅を読むと、再計算するたびに縮むため、列の幅を上限にする。
  const maximum = (column.getBoundingClientRect().width - 4) * 766 / 574 + 4;
  const small = matchMedia('(max-width: 800px), (max-height: 500px)').matches;
  if (!maximized && !small) {
    boardElement.style.setProperty('--card-height', `${Math.min(142, maximum)}px`);
    boardElement.style.removeProperty('--card-step');
    return;
  }
  const viewHeight = view?.height ?? innerHeight;
  const available = maximized || wide ? viewHeight : Math.max(80, viewHeight - boardElement.getBoundingClientRect().top - scrollY - 8);
  const steps = Math.max(1, ...getBoard(game).tableau.map((pile) => pile.length - 1));
  // 見出し・余白・解除ボタンの領域を除き、札の上端のランクと小スートも見える段差を確保する。
  const fixed = small ? 51 : 87.2;
  const height = Math.max(20, Math.min(maximum, (available - fixed - steps * 2) / (2 + steps * .32)));
  const step = Math.max(1, Math.min(Math.max(26, height * .32 + 2), (available - fixed - height * 2) / steps));
  boardElement.style.setProperty('--card-height', `${height}px`);
  boardElement.style.setProperty('--card-step', `${step}px`);
}

/** 進行を変えず表示を同期する。全画面の通知が重なっても元の閲覧位置を保つ。 */
function setMaximized(next) {
  cancelAutomatic();
  cancelDrag();
  if (next && !maximized) previousScroll = scrollY;
  maximized = next;
  document.body.classList.toggle('maximized', maximized);
  maximize.textContent = maximized ? '解除' : '最大化';
  maximize.setAttribute('aria-pressed', String(maximized));
  fitBoard();
  if (!maximized) scrollTo(0, previousScroll);
  maximize.focus({ preventScroll: true });
}

/** 実入力から全画面を要求する。非対応・拒否時はページ内の最大化を使う。 */
async function toggleMaximize() {
  if (maximize.disabled) return;
  maximize.disabled = true;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      setMaximized(!maximized);
      if (maximized && document.fullscreenEnabled) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    }
  } catch {
    // 入場拒否ならページ内表示を維持する。退出拒否でも解除ボタンから再試行できる。
  } finally {
    maximize.disabled = false;
    maximize.focus({ preventScroll: true });
  }
}

/** 全画面の確定後だけ横向きを要求する。向きの切り替え待ちでも解除は操作できる。 */
async function syncFullscreen() {
  setMaximized(Boolean(document.fullscreenElement));
  try {
    if (maximized) await screen.orientation?.lock?.('landscape');
    else screen.orientation?.unlock?.();
  } catch {
    // 非対応・拒否・退出による中止では、現在の向きのまま専用レイアウトを使う。
  }
}

/** 停止や保存の直前に、表示中に経過した単調増加の時間を状態へ反映する。 */
function settleTime() {
  if (runningSince !== null) {
    const now = performance.now();
    game = { ...game, elapsedMs: game.elapsedMs + Math.max(0, now - runningSince) };
    runningSince = now;
  }
}

/** 時計だけを更新し、カードのフォーカスと読み上げを毎秒動かさない。 */
function showTime() {
  const elapsed = game.elapsedMs + (runningSince === null ? 0 : performance.now() - runningSince);
  const seconds = Math.floor(elapsed / 1000);
  find('time').textContent = formatTime(seconds);
}

/** 勝利・未開始・非表示の時間を除外し、Undo しても経過時間は巻き戻さない。 */
function refreshClock() {
  settleTime();
  runningSince = game.started && !isWon(getBoard(game)) && !document.hidden ? performance.now() : null;
  showTime();
}

/** 保存できない場合もメモリー上のゲームを継続し、専用の案内を残す。 */
function persist() {
  settleTime();
  const error = saveGame(storageKey, game) ?? (settingError || recordError);
  find('storage-status').hidden = !error;
  find('storage-status').textContent = error ?? '';
  return !error;
}

/** 初回クリアだけを記録する。旧版の局は過去の操作数が不明なのでランキングに含めない。 */
function recordWin() {
  if (!game.id || game.recorded || !isWon(getBoard(game))) return;
  // 保存を再試行しても、最初にクリアした日時・時間・手数を取り直さない。
  game = { ...game, result: game.result ?? {
    id: game.id, date: new Date().toISOString(), time: Math.floor(game.elapsedMs / 1000), moves: getActions(game),
  } };
  recordError = saveRecord(recordsKey, game.result);
  if (!recordError) game = { ...game, recorded: true };
}

/** 保存済みの上位記録を読み直す。日付・値は textContent に渡し、HTML として解釈しない。 */
function showRecords(event) {
  event.preventDefault();
  cancelAutomatic();
  recordWin();
  persist();
  const { records, error } = loadRecords(recordsKey);
  find('records-status').textContent = error || recordError || 'このブラウザーの各上位3件';
  records.forEach((entries, index) => {
    const list = find(index ? 'best-moves' : 'best-time');
    list.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement('li');
      item.textContent = `${index ? `${entry.moves}手` : formatTime(entry.time)} · ${new Date(entry.date).toLocaleDateString('ja-JP')}`;
      list.append(item);
    }
    if (!entries.length) list.textContent = '記録はありません';
  });
  recordsDialog.showModal();
}

/** 更新の要求前に保存を確認し、再読込の直前にタブ専用の引き継ぎも確定する。 */
function prepareUpdate(reloading) {
  cancelAutomatic();
  cancelDrag();
  if (!persist() || (reloading && !saveReload(reloadKey, game, find('auto-enabled').checked))) return false;
  return true;
}

/** 選択だけなら DOM を置き換えず、同じカードへの連続クリックを維持する。 */
function markSelection(button) {
  const { zone, index, offset } = button.dataset;
  const active = selected?.zone === zone && selected.index === Number(index)
    && (zone !== 'tableau' || Number(offset) >= selected.offset);
  button.setAttribute('aria-pressed', String(Boolean(active)));
  button.setAttribute('aria-label', button.dataset.label + (active ? '、選択中' : ''));
}

/** 選択範囲と読み上げ名だけを更新し、フォーカスとカードの位置を保つ。 */
function updateSelection() {
  boardElement.querySelectorAll('[data-card]').forEach(markSelection);
}

/** カードと空き枠に共通の位置情報を付け、マウスとキーボードの操作をそろえる。 */
function positionButton(zone, index, offset) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.zone = zone;
  button.dataset.index = index;
  if (offset !== undefined) button.dataset.offset = offset;
  return button;
}

/** トランプ文字でカード全体を描画し、読み上げには日本語のカード名を与える。 */
function cardButton(card, zone, index, offset) {
  const suit = SUITS[Math.floor(card / 13)];
  const button = positionButton(zone, index, offset);
  button.className = `card ${suit.color}`;
  button.dataset.card = card;
  const place = zone === 'tableau' ? `場札 ${index + 1}` : zone === 'cells' ? `フリーセル ${index + 1}` : 'ホームセル';
  button.dataset.label = `${place}、${cardLabel(card)}`;
  markSelection(button);
  const face = document.createElement('span');
  face.className = 'card-face';
  // Unicode の Knight (末尾 C) を飛ばして Q・K を対応させ、補助面文字は code point で作る。
  face.textContent = String.fromCodePoint(0x1f0a0 + Math.floor(card / 13) * 16 + rank(card) + (rank(card) >= 12 ? 1 : 0));
  face.setAttribute('aria-hidden', 'true');
  button.append(face);
  return button;
}

/** 空の場所もボタンにして、カードがない移動先へキーボードで到達できるようにする。 */
function emptyButton(zone, index) {
  const button = positionButton(zone, index);
  button.className = 'empty-slot';
  const label = zone === 'tableau' ? `場札 ${index + 1}` : zone === 'cells' ? `フリーセル ${index + 1}` : `${SUITS[index].name}のホームセル`;
  button.setAttribute('aria-label', `${label}、空き`);
  button.textContent = zone === 'foundations' ? `${SUITS[index].symbol}\uFE0E` : '+';
  return button;
}

/** 上段の 4 枠をひとつの名前付きグループとして作る。 */
function topGroup(board, zone, title) {
  const section = document.createElement('section');
  section.className = `top-group ${zone}`;
  section.setAttribute('aria-label', title);
  const heading = document.createElement('h2');
  heading.textContent = title;
  const slots = document.createElement('div');
  slots.className = 'top-slots';
  for (let index = 0; index < 4; index += 1) {
    const card = zone === 'cells' ? board.cells[index] : board.foundations[index].at(-1);
    slots.append(card == null ? emptyButton(zone, index) : cardButton(card, zone, index));
  }
  section.append(heading, slots);
  return section;
}

/** 盤面を状態から作り直す。フォーカスがあったカードは移動後も追いかける。 */
function render() {
  cancelDrag();
  lastCardClick = null;
  const active = document.activeElement;
  const focused = boardElement.contains(active) ? active.dataset : null;
  const focusCard = focused?.card;
  const focusPosition = focused ? { ...focused } : null;
  const board = getBoard(game);
  const tableau = document.createElement('section');
  tableau.className = 'tableau';
  tableau.setAttribute('aria-label', '場札');
  board.tableau.forEach((cards, index) => {
    const column = document.createElement('div');
    column.className = 'column';
    column.dataset.column = index;
    column.style.minHeight = `calc(var(--card-height) + ${Math.max(0, cards.length - 1)} * var(--card-step))`;
    if (!cards.length) column.append(emptyButton('tableau', index));
    cards.forEach((card, offset) => {
      const button = cardButton(card, 'tableau', index, offset);
      button.style.top = `calc(${offset} * var(--card-step))`;
      column.append(button);
    });
    tableau.append(column);
  });
  boardElement.replaceChildren(topGroup(board, 'cells', 'フリーセル'), topGroup(board, 'foundations', 'ホームセル'), tableau);
  find('moves').textContent = getActions(game);
  find('progress').textContent = board.foundations.reduce((sum, pile) => sum + pile.length, 0);
  find('undo').disabled = game.cursor === 0;
  find('redo').disabled = game.cursor + 1 === game.history.length;
  find('win-panel').hidden = !isWon(board);
  effects.win(isWon(board));
  fitBoard();
  refreshClock();
  recordWin();
  if (focusPosition) {
    const sameCard = focusCard === undefined ? null : boardElement.querySelector(`[data-card="${focusCard}"]`);
    const samePile = boardElement.querySelector(`[data-zone="${focusPosition.zone}"][data-index="${focusPosition.index}"]`);
    (sameCard ?? samePile ?? boardElement.querySelector('button')).focus({ preventScroll: true });
  } else if (active?.disabled || active?.closest('[hidden]')) {
    // 履歴端や勝利画面の終了で操作元が使えなくなっても、次の操作へ移れるようにする。
    const next = active.id === 'undo' ? find('redo') : active.id === 'redo' ? find('undo') : find('new-game');
    (next.disabled ? find('new-game') : next).focus({ preventScroll: true });
  }
}

/** 選択を解除しても盤面と履歴を変えず、現在のフォーカスを維持する。 */
function clearSelection() {
  if (!selected) return;
  selected = null;
  updateSelection();
  announce('選択解除。');
}

/** 後続の自動移動を止め、確定済みの札はホームの最終位置へ戻す。 */
function cancelAutomatic() {
  automaticRun += 1;
  automaticAnimation?.cancel();
  automaticAnimation = null;
  boardElement.querySelector('.auto-moving')?.classList.remove('auto-moving');
  boardElement.parentElement.classList.remove('auto-active');
}

/** 最初の成功した移動を待ち、以後は 1 枚ずつ確定・保存・演出する。明示的な自動ボタンは別扱い。 */
async function finishMove(message, automatic = game.started && find('auto-enabled').checked, moved = false) {
  cancelAutomatic();
  const run = automaticRun;
  let count = 0;
  selected = null;
  render();
  persist();
  const animate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  while (automatic && !document.hidden) {
    settleTime();
    const result = autoHome(game, animate ? 1 : 52);
    if (!result.count) break;
    const before = getBoard(game);
    const after = getBoard(result.game);
    const home = after.foundations.findIndex((pile, index) => pile.length > before.foundations[index].length);
    const selector = `[data-card="${after.foundations[home].at(-1)}"]`;
    const from = animate ? boardElement.querySelector(selector).getBoundingClientRect() : null;
    game = result.game;
    count += result.count;
    render();
    persist();
    effects.move('foundations', isWon(getBoard(game)));
    if (animate) {
      const card = boardElement.querySelector(selector);
      const to = card.getBoundingClientRect();
      card.classList.add('auto-moving');
      boardElement.parentElement.classList.add('auto-active');
      // 移動後の札を元の位置から描くので、途中で中止しても盤面と履歴が食い違わない。
      automaticAnimation = card.animate([
        { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: 100, easing: 'ease-out' });
      await automaticAnimation.finished.catch(() => {});
      if (run !== automaticRun) return;
      automaticAnimation = null;
      card.classList.remove('auto-moving');
      boardElement.parentElement.classList.remove('auto-active');
    }
  }
  if (count) message = `${count}枚を自動でホームへ移動。`;
  if ((moved || count) && isWon(getBoard(game))) effects.celebrate();
  announce(isWon(getBoard(game)) ? 'クリア！' : message);
}

/** クリックとドロップで同じ判定・自動移動・保存を使い、不正な移動は選択を維持する。 */
function tryMove(from, to) {
  settleTime();
  const result = move(game, from, to);
  if (result.error) announce(result.error);
  else {
    game = result.game;
    effects.move(to.zone, isWon(getBoard(game)));
    finishMove('移動完了。', undefined, true);
  }
}

/** クリック・タップ・Enter/Space は、同じボタンの click から処理する。 */
function choosePosition(event) {
  const button = event.target.closest('button[data-zone]');
  if (!button) {
    clearSelection();
    return;
  }
  const position = positionOf(button);
  const card = button.dataset.card;
  const now = performance.now();
  const repeated = card !== undefined && lastCardClick?.card === card && event.detail > 0
    && (event.detail > 1 || (pointerType === 'touch' && now - lastCardClick.time < 400));
  lastCardClick = event.detail > 0 && card !== undefined ? { card, time: now } : null;
  if (repeated) {
    lastCardClick = null;
    settleTime();
    const result = quickMove(game, position);
    if (result.error) announce(result.error);
    else {
      const sentHome = getBoard(result.game).foundations.some((pile, index) => pile.length > getBoard(game).foundations[index].length);
      game = result.game;
      effects.move(sentHome ? 'foundations' : 'cells', isWon(getBoard(game)));
      finishMove('移動完了。', undefined, true);
    }
    return;
  }
  if (selected && selected.zone === position.zone && selected.index === position.index && selected.offset === position.offset) {
    clearSelection();
    return;
  }
  if (!selected) {
    if (position.zone === 'foundations') {
      announce('ホームの取消は「戻す」。');
      return;
    }
    if (button.dataset.card === undefined) {
      announce('まず移動する札を選択。');
      return;
    }
    selected = position;
    const count = position.zone === 'tableau' ? getBoard(game).tableau[position.index].length - position.offset : 1;
    updateSelection();
    announce(`${cardLabel(Number(button.dataset.card))}${count > 1 ? `から ${count} 枚` : ''}を選択。次に移動先を選択。`);
    return;
  }
  tryMove(selected, position);
}

/** 進行中のゲームを置き換える場合だけ、キャンセル可能な確認を表示する。 */
async function confirmReplacement(restarting) {
  if (!game.started || isWon(getBoard(game))) return true;
  find('confirm-title').textContent = restarting ? '初期状態にリセットしますか？' : 'ゲームを切り替えますか？';
  find('confirm-cancel').textContent = restarting ? 'リセットしない' : '続けて遊ぶ';
  find('confirm-accept').textContent = restarting ? 'リセットする' : '切り替える';
  find('confirm-text').textContent = restarting
    ? '同じ配りに戻し、進行・履歴を消去します。'
    : '別の配りに替え、進行・履歴を消去します。';
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), { once: true });
    dialog.showModal();
    find('confirm-cancel').focus();
  });
}

/** 再配札と同じ配りでの再開を、共通の確認と初期化で扱う。 */
async function replaceGame(restarting) {
  // dialog.close のイベント処理が終わるまでは、次の確認を重ねて開かない。
  if (replacementPending) return;
  replacementPending = true;
  try {
    if (!await confirmReplacement(restarting)) return;
    runningSince = null;
    recordError = '';
    game = restarting ? restart(game) : createGame();
    finishMove(restarting ? '同じ配りで再開。' : '新規ゲーム開始。');
    // 新しい配りの確定時だけ鳴らし、確認の取り消し・リセット・保存局の復元とは区別する。
    if (!restarting) effects.start();
  } finally {
    replacementPending = false;
  }
}

/** 履歴を移動し、勝利の取り消しとタイマーの再開も通常の描画へ任せる。 */
function changeHistory(operation, message) {
  settleTime();
  game = operation(game);
  // 戻した札を即座に送り直さず、保存からの復元と同様に履歴位置を尊重する。
  finishMove(message, false);
}

document.addEventListener('pointerdown', (event) => {
  pointerType = event.pointerType;
  if (!event.target.closest('#board [data-card]')) lastCardClick = null;
});
boardElement.addEventListener('click', choosePosition);
const cancelDrag = setupDrag(boardElement, {
  /** 元の選択を押し始めた札に切り替える。移動が確定するまでは履歴を変えない。 */
  start(from) {
    lastCardClick = null;
    selected = from;
    updateSelection();
  },
  drop: tryMove,
  cancel: clearSelection,
});
const effects = setupEffects(boardElement, find('sound-toggle'), `${storageKey}:sound`);
// ドラッグ後の疑似 click を除外した後で、利用者の次の入力を優先して自動移動を止める。
for (const type of ['pointerdown', 'click', 'keydown']) document.addEventListener(type, cancelAutomatic, true);
find('auto-home').addEventListener('click', () => {
  settleTime();
  finishMove('安全に送れる札はありません。', true);
});
find('auto-enabled').addEventListener('change', () => {
  try {
    localStorage.setItem(`${storageKey}:auto-home`, find('auto-enabled').checked ? '1' : '0');
    settingError = '';
  } catch {
    settingError = autoSaveError;
  }
  settleTime();
  finishMove(find('auto-enabled').checked ? '自動移動オン。' : '自動移動オフ。');
});
window.addEventListener('resize', () => { cancelAutomatic(); fitBoard(); });
window.visualViewport?.addEventListener('resize', fitBoard);
window.visualViewport?.addEventListener('scroll', fitBoard);
maximize.addEventListener('click', toggleMaximize);
// 戻る・Escape・ブラウザー側の操作で全画面が終了した場合も通常表示へ戻す。
document.addEventListener('fullscreenchange', syncFullscreen);
find('new-game').addEventListener('click', () => replaceGame(false));
find('win-new').addEventListener('click', () => replaceGame(false));
find('restart').addEventListener('click', () => replaceGame(true));
find('undo').addEventListener('click', () => changeHistory(undo, '1手戻しました。'));
find('redo').addEventListener('click', () => changeHistory(redo, '1手やり直しました。'));
find('records-link').addEventListener('click', showRecords);
document.addEventListener('keydown', (event) => {
  // 入力欄の編集や IME・確認ダイアログでは、ブラウザー本来のキー操作を優先する。
  const editing = event.target.closest('input:not([type=checkbox]), textarea, select') || event.target.isContentEditable;
  const modal = dialog.open || recordsDialog.open;
  if (!modal && !editing && !event.isComposing && !event.altKey && !event.shiftKey
    && (event.ctrlKey || event.metaKey)) {
    const key = event.key.toLowerCase();
    if (key === 'z' || key === 'y') {
      event.preventDefault();
      changeHistory(key === 'z' ? undo : redo, key === 'z' ? '1手戻しました。' : '1手やり直しました。');
    }
  }
  if (event.key === 'Escape' && !modal) {
    if (maximized) toggleMaximize();
    lastCardClick = null;
    clearSelection();
  }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('button, summary, dialog, #board')) clearSelection();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelAutomatic();
  refreshClock();
  persist();
});
window.addEventListener('pagehide', () => {
  cancelAutomatic();
  settleTime();
  runningSince = null;
  persist();
});
window.addEventListener('pageshow', refreshClock);
setInterval(showTime, 1000);
setInterval(() => {
  if (game.started && !document.hidden && !isWon(getBoard(game))) persist();
}, 10000);

render();
if (restored.error) announce(restored.error);
else if (isWon(getBoard(game))) announce('クリア済み。「もう一局遊ぶ」で次へ。');
else if (restored.game) announce('保存局を復元。');
persist();
setupOffline((status) => { find('offline-status').textContent = status; }, find('apply-update'), prepareUpdate);
