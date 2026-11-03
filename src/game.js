/**
 * フリーセルの純粋なルールと履歴管理。カードはスート別の整数 0〜51 で表す。
 * DOM・時計・保存には依存せず、成功した操作だけで新しい状態を返す。
 */
export const SUITS = [
  { symbol: '♠', name: 'スペード', color: 'black' },
  { symbol: '♥', name: 'ハート', color: 'red' },
  { symbol: '♦', name: 'ダイヤ', color: 'red' },
  { symbol: '♣', name: 'クラブ', color: 'black' },
];

export const rank = (card) => card % 13 + 1;
const suit = (card) => Math.floor(card / 13);
const isCard = (card) => Number.isInteger(card) && card >= 0 && card < 52;
const sameCards = (left, right) => left.length === right.length && left.every((card, index) => card === right[index]);

/** 読み上げと操作の案内に使う、日本語のカード名を作る。 */
export function cardLabel(card) {
  const value = rank(card);
  const name = ({ 1: 'エース', 11: 'ジャック', 12: 'クイーン', 13: 'キング' })[value] ?? value;
  return `${SUITS[suit(card)].name}の${name}`;
}

/** Fisher–Yates 法でシャッフルし、左から順に 8 列へ配る。 */
export function createGame(random = Math.random) {
  const deck = Array.from({ length: 52 }, (_, card) => card);
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [deck[index], deck[other]] = [deck[other], deck[index]];
  }
  const board = {
    tableau: Array.from({ length: 8 }, () => []),
    cells: Array(4).fill(null),
    foundations: Array.from({ length: 4 }, () => []),
  };
  deck.forEach((card, index) => board.tableau[index % 8].push(card));
  return { version: 1, history: [board], cursor: 0, elapsedMs: 0, started: false };
}

export const getBoard = (game) => game.history[game.cursor];
export const isWon = (board) => board.foundations.length === 4 && board.foundations.every((pile) => pile.length === 13);

/** 下側のカードが交互色で 1 段小さければ、場札として重ねられる。 */
function canStack(card, below) {
  return rank(card) + 1 === rank(below) && SUITS[suit(card)].color !== SUITS[suit(below)].color;
}

/** 位置の種類と範囲だけを検証し、不正な入力で配列を参照しない。 */
function validLocation(location) {
  if (!location || !['tableau', 'cells', 'foundations'].includes(location.zone)) return false;
  const count = location.zone === 'tableau' ? 8 : 4;
  return Number.isInteger(location.index) && location.index >= 0 && location.index < count;
}

/** 盤面の合法手を適用する。空の移動先と、移動後に空く元列は補助列に数えない。 */
function moveBoard(board, from, to) {
  const fail = (error) => ({ board, error });
  if (!validLocation(from) || !validLocation(to)) return fail('移動する場所を選んでください。');
  if (from.zone === to.zone && from.index === to.index) return fail('別の移動先を選んでください。');
  if (from.zone === 'foundations') return fail('ホームセルのカードは「戻す」で取り消せます。');

  let cards;
  if (from.zone === 'tableau') {
    const source = board.tableau[from.index];
    if (!Number.isInteger(from.offset) || from.offset < 0 || from.offset >= source.length) {
      return fail('移動するカードを選んでください。');
    }
    cards = source.slice(from.offset);
    if (!cards.every((card, index) => index === 0 || canStack(card, cards[index - 1]))) {
      return fail('まとめて動かせるのは、赤黒交互で 1 つずつ小さくなる並びです。');
    }
  } else {
    const card = board.cells[from.index];
    if (card === null) return fail('空のフリーセルからは移動できません。');
    cards = [card];
  }

  const card = cards[0];
  if (to.zone === 'tableau') {
    const target = board.tableau[to.index];
    if (target.length && !canStack(card, target.at(-1))) {
      return fail('場札には色の違う、数字が 1 つ小さいカードを置けます。');
    }
    const freeCells = board.cells.filter((value) => value === null).length;
    const emptyColumns = board.tableau.filter((pile, index) => pile.length === 0 && index !== to.index).length;
    const capacity = (freeCells + 1) * 2 ** emptyColumns;
    if (cards.length > capacity) return fail(`空き枠が足りません。今は ${capacity} 枚まで動かせます。`);
  } else {
    if (cards.length !== 1) return fail('フリーセルとホームセルには 1 枚ずつ移します。');
    if (to.zone === 'cells' && board.cells[to.index] !== null) return fail('空いているフリーセルを選んでください。');
    if (to.zone === 'foundations' && (suit(card) !== to.index || rank(card) !== board.foundations[to.index].length + 1)) {
      return fail('ホームセルには同じマークを A から順に置きます。');
    }
  }

  const next = {
    tableau: board.tableau.map((pile) => [...pile]),
    cells: [...board.cells],
    foundations: board.foundations.map((pile) => [...pile]),
  };
  if (from.zone === 'tableau') next.tableau[from.index].splice(from.offset);
  else next.cells[from.index] = null;
  if (to.zone === 'cells') next.cells[to.index] = card;
  else next[to.zone][to.index].push(...cards);
  return { board: next, error: null };
}

/** 成功した移動を 1 手として追加し、戻した後の別操作では先の履歴を捨てる。 */
export function move(game, from, to) {
  const result = moveBoard(getBoard(game), from, to);
  if (result.error) return { game, error: result.error };
  return {
    game: { ...game, history: [...game.history.slice(0, game.cursor + 1), result.board], cursor: game.cursor + 1, started: true },
    error: null,
  };
}

/** 露出した 1 枚をホーム優先で移す。手動指定なので自動移動の安全条件は課さない。 */
export function quickMove(game, from) {
  const fail = (error) => ({ game, error });
  if (!validLocation(from) || from.zone === 'foundations') return fail('場札かフリーセルのカードを選んでください。');
  const board = getBoard(game);
  const pile = from.zone === 'tableau' ? board.tableau[from.index] : null;
  if (pile && (!pile.length || from.offset !== pile.length - 1)) return fail('列の最後のカードだけを移動できます。');
  const card = pile ? pile.at(-1) : board.cells[from.index];
  if (card === null) return fail('空のフリーセルからは移動できません。');
  const home = move(game, from, { zone: 'foundations', index: suit(card) });
  if (!home.error) return home;
  if (from.zone === 'cells') return fail('このカードはまだホームセルへ移動できません。');
  const index = board.cells.indexOf(null);
  return index < 0 ? fail('空いているフリーセルがありません。') : move(game, from, { zone: 'cells', index });
}

/** 後の場札の組み替えを妨げない札だけを、1 枚ずつ履歴へ残してホームに送る。 */
export function autoHome(game) {
  let count = 0;
  while (true) {
    const board = getBoard(game);
    const source = piles(board).find(({ zone, cards }) => {
      if (zone === 'foundations' || !cards.length) return false;
      const card = cards.at(-1);
      const value = rank(card);
      if (board.foundations[suit(card)].length + 1 !== value) return false;
      // A・2、または反対色の両スートが 1 段下まで片付いた札は、場札の足場に不要。
      return value <= 2 || SUITS.every((other, index) => other.color === SUITS[suit(card)].color
        || board.foundations[index].length >= value - 1);
    });
    if (!source) return { game, count };
    game = move(game, { ...source, offset: source.cards.length - 1 }, {
      zone: 'foundations', index: suit(source.cards.at(-1)),
    }).game;
    count += 1;
  }
}

/** 時計は巻き戻さず、現在の履歴位置だけを 1 手戻す。 */
export function undo(game) {
  return game.cursor > 0 ? { ...game, cursor: game.cursor - 1 } : game;
}

/** 保存している次の盤面へ進む。末尾では状態を変えない。 */
export function redo(game) {
  return game.cursor + 1 < game.history.length ? { ...game, cursor: game.cursor + 1 } : game;
}

/** 同じ初期配列に戻し、手数・経過時間・開始状態を初期化する。 */
export function restart(game) {
  return { version: 1, history: [game.history[0]], cursor: 0, elapsedMs: 0, started: false };
}

/** 保存された盤面の構造、52 枚の一意性、ホームセルの順序を確認する。 */
function validBoard(board) {
  if (!board || !Array.isArray(board.tableau) || board.tableau.length !== 8
    || !Array.isArray(board.cells) || board.cells.length !== 4
    || !Array.isArray(board.foundations) || board.foundations.length !== 4) return false;
  if (!board.tableau.every(Array.isArray) || !board.foundations.every(Array.isArray)) return false;
  if (!board.cells.every((card) => card === null || isCard(card))) return false;
  const cards = [...board.tableau.flat(), ...board.cells.filter((card) => card !== null), ...board.foundations.flat()];
  if (cards.length !== 52 || !cards.every(isCard) || new Set(cards).size !== 52) return false;
  return board.foundations.every((pile, suitIndex) => pile.length <= 13
    && pile.every((card, index) => card === suitIndex * 13 + index));
}

/** 履歴比較と移動候補の列挙用に、フリーセルも通常のカード配列へそろえる。 */
function piles(board) {
  return [
    ...board.tableau.map((cards, index) => ({ zone: 'tableau', index, cards })),
    ...board.cells.map((card, index) => ({ zone: 'cells', index, cards: card === null ? [] : [card] })),
    ...board.foundations.map((cards, index) => ({ zone: 'foundations', index, cards })),
  ];
}

/** 隣接する履歴の差から 1 回の移動を復元し、実際のルールで再検証する。 */
function validTransition(before, after) {
  const oldPiles = piles(before);
  const newPiles = piles(after);
  const changed = oldPiles.map((pile, index) => index).filter((index) => !sameCards(oldPiles[index].cards, newPiles[index].cards));
  if (changed.length !== 2) return false;
  const source = changed.find((index) => oldPiles[index].cards.length > newPiles[index].cards.length);
  const target = changed.find((index) => oldPiles[index].cards.length < newPiles[index].cards.length);
  if (source === undefined || target === undefined) return false;
  const from = { ...oldPiles[source], offset: newPiles[source].cards.length };
  const result = moveBoard(before, from, oldPiles[target]);
  return !result.error && piles(result.board).every((pile, index) => sameCards(pile.cards, newPiles[index].cards));
}

/** JSON 復元時に、開始配列と全履歴が同じゲームとして成立するか確認する。 */
export function validateGame(game) {
  if (!game || game.version !== 1 || !Array.isArray(game.history) || game.history.length === 0
    || !Number.isInteger(game.cursor) || game.cursor < 0 || game.cursor >= game.history.length
    || typeof game.started !== 'boolean' || !Number.isFinite(game.elapsedMs)
    || game.elapsedMs < 0 || game.elapsedMs > Number.MAX_SAFE_INTEGER) return false;
  if (game.started !== (game.history.length > 1) || (!game.started && game.elapsedMs !== 0)) return false;
  if (!game.history.every(validBoard)) return false;
  const initial = game.history[0];
  if (initial.cells.some((card) => card !== null) || initial.foundations.some((pile) => pile.length)
    || !initial.tableau.every((pile, index) => pile.length === (index < 4 ? 7 : 6))) return false;
  return game.history.every((board, index) => index === 0 || validTransition(game.history[index - 1], board));
}
