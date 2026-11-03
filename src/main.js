/**
 * FreeCell の画面と操作。ルールは game.js、保存は storage.js に任せる。
 * DOM はゲーム状態から描画し、時計と案内だけを個別に更新する。
 */
import { SUITS, rank, cardLabel, createGame, getBoard, move, undo, redo, restart, isWon } from './game.js';
import { loadGame, saveGame } from './storage.js';
import { setupOffline } from './offline.js';

const find = (id) => document.getElementById(id);
const boardElement = find('board');
const dialog = find('confirm-dialog');
const storageKey = `freecell:${new URL('./', location.href).pathname}:v1`;
const restored = loadGame(storageKey);
let game = restored.game ?? createGame();
let selected = null;
let runningSince = null;
let replacementPending = false;

/** 文言は HTML として解釈せず、日本語のまま読み上げ領域へ渡す。 */
function announce(message) {
  find('message').textContent = message;
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
  find('time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
  const error = saveGame(storageKey, game);
  find('storage-status').hidden = !error;
  find('storage-status').textContent = error ?? '';
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

/** スートとランクを表示し、色に依存しない日本語のカード名を与える。 */
function cardButton(card, zone, index, offset) {
  const suit = SUITS[Math.floor(card / 13)];
  const value = ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[rank(card)] ?? rank(card);
  const button = positionButton(zone, index, offset);
  button.className = `card ${suit.color}`;
  button.dataset.card = card;
  const inSelection = selected?.zone === zone && selected.index === index
    && (zone !== 'tableau' || offset >= selected.offset);
  button.setAttribute('aria-pressed', String(inSelection));
  const place = zone === 'tableau' ? `場札 ${index + 1}` : zone === 'cells' ? `フリーセル ${index + 1}` : 'ホームセル';
  button.setAttribute('aria-label', `${place}、${cardLabel(card)}${inSelection ? '、選択中' : ''}`);
  const corner = document.createElement('span');
  corner.className = 'card-corner';
  corner.textContent = `${value} ${suit.symbol}\uFE0E`;
  const center = document.createElement('span');
  center.className = 'card-center';
  center.textContent = `${suit.symbol}\uFE0E`;
  // 見た目の文字を重ねて読み上げず、ボタン全体の名前を利用する。
  corner.setAttribute('aria-hidden', 'true');
  center.setAttribute('aria-hidden', 'true');
  button.append(corner, center);
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
    column.style.height = `calc(var(--card-height) + ${Math.max(0, cards.length - 1)} * var(--card-step))`;
    if (!cards.length) column.append(emptyButton('tableau', index));
    cards.forEach((card, offset) => {
      const button = cardButton(card, 'tableau', index, offset);
      button.style.top = `calc(${offset} * var(--card-step))`;
      column.append(button);
    });
    tableau.append(column);
  });
  boardElement.replaceChildren(topGroup(board, 'cells', 'フリーセル'), topGroup(board, 'foundations', 'ホームセル'), tableau);
  find('moves').textContent = game.cursor;
  find('progress').textContent = board.foundations.reduce((sum, pile) => sum + pile.length, 0);
  find('undo').disabled = game.cursor === 0;
  find('redo').disabled = game.cursor + 1 === game.history.length;
  find('win-panel').hidden = !isWon(board);
  refreshClock();
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
  render();
  announce('選択を解除しました。');
}

/** クリック・タップ・Enter/Space は、同じボタンの click から処理する。 */
function choosePosition(event) {
  const button = event.target.closest('button[data-zone]');
  if (!button) {
    clearSelection();
    return;
  }
  const position = { zone: button.dataset.zone, index: Number(button.dataset.index) };
  if (button.dataset.offset !== undefined) position.offset = Number(button.dataset.offset);
  if (selected && selected.zone === position.zone && selected.index === position.index && selected.offset === position.offset) {
    clearSelection();
    return;
  }
  if (!selected) {
    if (position.zone === 'foundations') {
      announce('ホームセルからの移動は「戻す」で取り消せます。');
      return;
    }
    if (button.dataset.card === undefined) {
      announce('まず移動するカードを選んでください。');
      return;
    }
    selected = position;
    const count = position.zone === 'tableau' ? getBoard(game).tableau[position.index].length - position.offset : 1;
    render();
    announce(`${cardLabel(Number(button.dataset.card))}${count > 1 ? `から ${count} 枚` : ''}を選択しました。移動先を選んでください。`);
    return;
  }
  settleTime();
  const result = move(game, selected, position);
  if (result.error) {
    announce(result.error);
    return;
  }
  game = result.game;
  selected = null;
  render();
  persist();
  announce(isWon(getBoard(game)) ? 'クリア！ すべてのカードが揃いました。' : '移動しました。次のカードを選んでください。');
}

/** 進行中のゲームを置き換える場合だけ、キャンセル可能な確認を表示する。 */
async function confirmReplacement(restarting) {
  if (!game.started || isWon(getBoard(game))) return true;
  find('confirm-text').textContent = restarting
    ? '同じ配りで最初から始めます。現在の進行と履歴は消えます。'
    : '別の配りで始めます。現在の進行と履歴は消えます。';
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
    game = restarting ? restart(game) : createGame();
    selected = null;
    render();
    persist();
    announce(restarting ? '同じ配りで最初から始めました。' : '新しいゲームを始めました。');
  } finally {
    replacementPending = false;
  }
}

/** 履歴を移動し、勝利の取り消しとタイマーの再開も通常の描画へ任せる。 */
function changeHistory(operation, message) {
  settleTime();
  game = operation(game);
  selected = null;
  render();
  persist();
  announce(isWon(getBoard(game)) ? 'クリア！ すべてのカードが揃いました。' : message);
}

boardElement.addEventListener('click', choosePosition);
find('new-game').addEventListener('click', () => replaceGame(false));
find('win-new').addEventListener('click', () => replaceGame(false));
find('restart').addEventListener('click', () => replaceGame(true));
find('undo').addEventListener('click', () => changeHistory(undo, '1 手戻しました。'));
find('redo').addEventListener('click', () => changeHistory(redo, '1 手やり直しました。'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dialog.open) clearSelection();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('button, summary, dialog, #board')) clearSelection();
});
document.addEventListener('visibilitychange', () => {
  refreshClock();
  persist();
});
window.addEventListener('pagehide', () => {
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
else if (isWon(getBoard(game))) announce('クリア済みのゲームを復元しました。「もう一局遊ぶ」で始められます。');
else if (restored.game) announce('保存したゲームを復元しました。続きからどうぞ。');
persist();
setupOffline((status) => { find('offline-status').textContent = status; });
