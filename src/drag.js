/** マウス・タッチのドラッグを共通化する。合法性と履歴は呼び出し元に任せる。 */

import { TABLEAU, HOME } from './game.js';

/** ボタンに記録された位置を、ゲームの操作で使う数値へ戻す。 */
export function positionOf(button) {
  const { zone, index, offset } = button.dataset;
  return { zone, index: Number(index), ...(offset === undefined ? {} : { offset: Number(offset) }) };
}

/** 少し動かすまでは通常のクリックを維持し、移動後だけクリックを抑止する。 */
export function setupDrag(board, { start, drop, cancel }) {
  let gesture = null;
  let suppressClick = false;

  /** 移動中の札はヒット判定から除外し、その下のカード・空枠・列を行き先にする。 */
  function destination(event) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || !board.contains(element)) return null;
    const button = element.closest('button[data-zone]');
    if (button) return positionOf(button);
    const column = element.closest('[data-column]');
    return column ? { zone: TABLEAU, index: Number(column.dataset.column) } : null;
  }

  /** 先にジェスチャーを閉じてから画面へ通知し、再描画や capture 解除の再入を防ぐ。 */
  function finish(event, cancelled = false) {
    if (!gesture || (event?.pointerId !== undefined && event.pointerId !== gesture.id)) return;
    const current = gesture;
    gesture = null;
    if (board.hasPointerCapture(current.id)) board.releasePointerCapture(current.id);
    if (!current.cards) return;
    const to = cancelled ? null : destination(event);
    for (const card of current.cards) {
      card.classList.remove('dragging');
      card.style.removeProperty('transform');
      card.style.removeProperty('z-index');
    }
    board.parentElement.classList.remove('drag-active');
    suppressClick = true;
    if (to) drop(current.from, to);
    else cancel();
  }

  /** 2 本目の指でドラッグを中止し、CSS で許可した標準ピンチ操作へ引き渡す。 */
  document.addEventListener('pointerdown', () => {
    suppressClick = false;
    finish(null, true);
  }, true);
  /** 押した位置だけを記録し、タップ時の既存の選択・二度押し処理には干渉しない。 */
  board.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) {
      finish(null, true);
      return;
    }
    if (event.button !== 0) return;
    const button = event.target.closest('button[data-card]');
    if (!button || button.dataset.zone === HOME) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, button, from: positionOf(button) };
  });
  /** 8px 以上の移動から札を捕捉し、連続札も同じ距離だけ追従させる。 */
  window.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (!event.buttons) {
      finish(event, true);
      return;
    }
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.cards) {
      if (Math.hypot(dx, dy) < 8) return;
      board.setPointerCapture(gesture.id);
      const { button, from } = gesture;
      gesture.cards = from.zone === TABLEAU
        ? [...button.parentElement.querySelectorAll('[data-card]')].filter(card => Number(card.dataset.offset) >= from.offset)
        : [button];
      start(from);
      board.parentElement.classList.add('drag-active');
      gesture.cards.forEach((card, index) => {
        card.classList.add('dragging');
        card.style.zIndex = 10 + index;
      });
    }
    event.preventDefault();
    for (const card of gesture.cards) card.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  window.addEventListener('pointerup', (event) => finish(event));
  window.addEventListener('pointercancel', (event) => finish(event, true));
  /** タッチの暗黙 capture が札から盤面へ移る通知は、操作の中止と区別する。 */
  board.addEventListener('lostpointercapture', (event) => {
    if (event.target === board) finish(event, true);
  });
  window.addEventListener('blur', () => finish(null, true));
  window.addEventListener('resize', () => finish(null, true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(null, true); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') finish(null, true); });
  /** ドロップ後に生成される click だけを止め、キーボードの click は通す。 */
  document.addEventListener('click', (event) => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  return () => finish(null, true);
}
