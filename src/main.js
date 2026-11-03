/**
 * 初期画面にフリーセルの盤面配置を描画する。
 * ゲーム状態やカード操作は、ルール実装の段階で追加する。
 */

/** 指定された表示文字列から、操作を持たない配置見本のグループを作る。 */
function createSlotGroup(className, labels) {
  const group = document.createElement('div');
  group.className = `slot-group ${className}`;

  for (const label of labels) {
    const slot = document.createElement('span');
    slot.className = 'preview-slot';
    // スートの日本語・Unicode 表示をそのまま扱い、HTML として解釈しない。
    slot.textContent = label;
    group.append(slot);
  }

  return group;
}

/** フリーセル、ホームセル、場札の位置関係を描画する。 */
function renderBoardPreview(container) {
  const freeCells = createSlotGroup('free-cells', Array(4).fill(''));
  const foundations = createSlotGroup('foundations', ['♠', '♥', '♦', '♣']);
  const tableau = createSlotGroup('tableau', Array(8).fill(''));
  container.replaceChildren(freeCells, foundations, tableau);
}

renderBoardPreview(document.querySelector('#board-preview'));
