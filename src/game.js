/**
 * フリーセルの純粋なルールと履歴管理。カードはスート別の整数 0〜51 で表す。
 * DOM・時計・保存には依存せず、成功した操作だけで新しい状態を返す。
 */
import { validRecord } from './records.js';

export const SUITS = [
  { symbol: '♠', name: 'スペード', color: 'black' },
  { symbol: '♥', name: 'ハート', color: 'red' },
  { symbol: '♦', name: 'ダイヤ', color: 'red' },
  { symbol: '♣', name: 'クラブ', color: 'black' },
];

// ルールと画面で場所の識別値を共有する。保存される盤面のキーや値は従来のままに保つ。
export const TABLEAU = 'tableau';
export const HOME = 'foundations';
export const CELLS = 'cells';

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
  return initialGame(board);
}

export const getBoard = (game) => game.history[game.cursor];
// 旧保存では取り消した回数を復元できないため、保持されている履歴の長さを下限とする。
export const getActions = (game) => game.actions ?? game.history.length - 1;
export const isWon = (board) => board.foundations.length === 4 && board.foundations.every((pile) => pile.length === 13);

/** 配りが同じ再挑戦も別の局として識別し、成績と累積操作数を初期化する。 */
function initialGame(board) {
  return { version: 1, history: [board], cursor: 0, elapsedMs: 0, started: false, id: crypto.randomUUID(), actions: 0 };
}

/** 下側のカードが交互色で 1 段小さければ、場札として重ねられる。 */
function canStack(card, below) {
  return rank(card) + 1 === rank(below) && SUITS[suit(card)].color !== SUITS[suit(below)].color;
}

/** 位置の種類と範囲だけを検証し、不正な入力で配列を参照しない。 */
function validLocation(location) {
  if (!location || ![TABLEAU, CELLS, HOME].includes(location.zone)) return false;
  const count = location.zone === TABLEAU ? 8 : 4;
  return Number.isInteger(location.index) && location.index >= 0 && location.index < count;
}

/** 盤面の合法手を適用する。空の移動先と、移動後に空く元列は補助列に数えない。 */
function moveBoard(board, from, to) {
  const { tableau, cells, foundations } = board;
  const fail = (error) => ({ board, error });
  if (!validLocation(from) || !validLocation(to)) return fail('移動先を選択。');
  if (from.zone === to.zone && from.index === to.index) return fail('別の移動先を選択。');
  if (from.zone === HOME) return fail('ホームの取消は「戻す」。');

  let cards;
  if (from.zone === TABLEAU) {
    const source = tableau[from.index];
    if (!Number.isInteger(from.offset) || from.offset < 0 || from.offset >= source.length) {
      return fail('移動する札を選択。');
    }
    cards = source.slice(from.offset);
    if (!cards.every((card, index) => index === 0 || canStack(card, cards[index - 1]))) {
      return fail('一括移動は赤黒交互・1段ずつ降順のみ。');
    }
  } else {
    const card = cells[from.index];
    if (card === null) return fail('空のフリーセルは移動不可。');
    cards = [card];
  }

  const card = cards[0];
  if (to.zone === TABLEAU) {
    const target = tableau[to.index];
    if (target.length && !canStack(card, target.at(-1))) {
      return fail('場札は反対色・1小さい札のみ。');
    }
    const freeCells = cells.filter((value) => value === null).length;
    const emptyColumns = tableau.filter((pile, index) => pile.length === 0 && index !== to.index).length;
    const capacity = (freeCells + 1) * 2 ** emptyColumns;
    if (cards.length > capacity) return fail(`空き枠不足。移動は${capacity}枚まで。`);
  } else {
    if (cards.length !== 1) return fail('フリーセルとホームへは1枚ずつ。');
    if (to.zone === CELLS && cells[to.index] !== null) return fail('空のフリーセルを選択。');
    if (to.zone === HOME && (suit(card) !== to.index || rank(card) !== foundations[to.index].length + 1)) {
      return fail('ホームは同マークをAから昇順。');
    }
  }

  const next = {
    tableau: tableau.map((pile) => [...pile]),
    cells: [...cells],
    foundations: foundations.map((pile) => [...pile]),
  };
  if (from.zone === TABLEAU) next.tableau[from.index].splice(from.offset);
  else next.cells[from.index] = null;
  if (to.zone === CELLS) next.cells[to.index] = card;
  else next[to.zone][to.index].push(...cards);
  return { board: next, error: null };
}

/** 成功した移動を 1 手として追加し、戻した後の別操作では先の履歴を捨てる。 */
export function move(game, from, to) {
  const result = moveBoard(getBoard(game), from, to);
  if (result.error) return { game, error: result.error };
  return {
    game: { ...game, history: [...game.history.slice(0, game.cursor + 1), result.board], cursor: game.cursor + 1, started: true, actions: getActions(game) + 1 },
    error: null,
  };
}

/** 露出した 1 枚をホーム優先で移す。手動指定なので自動移動の安全条件は課さない。 */
export function quickMove(game, from) {
  const fail = (error) => ({ game, error });
  if (!validLocation(from) || from.zone === HOME) return fail('場札かフリーセルの札を選択。');
  const board = getBoard(game);
  const pile = from.zone === TABLEAU ? board.tableau[from.index] : null;
  if (pile && (!pile.length || from.offset !== pile.length - 1)) return fail('列の末尾の札だけ移動可。');
  const card = pile ? pile.at(-1) : board.cells[from.index];
  if (card === null) return fail('空のフリーセルは移動不可。');
  const home = move(game, from, { zone: HOME, index: suit(card) });
  if (!home.error) return home;
  if (from.zone === CELLS) return fail('この札はホームへ移動不可。');
  const index = board.cells.indexOf(null);
  return index < 0 ? fail('フリーセルに空きなし。') : move(game, from, { zone: CELLS, index });
}

/** 安全な札を履歴へ残してホームに送る。上限を指定すれば画面で 1 枚ずつ再生できる。 */
export function autoHome(game, limit = 52) {
  let count = 0;
  while (count < limit) {
    const board = getBoard(game);
    const source = piles(board).find(({ zone, cards }) => {
      if (zone === HOME || !cards.length) return false;
      const card = cards.at(-1);
      const value = rank(card);
      if (board.foundations[suit(card)].length + 1 !== value) return false;
      return safeHome(board, card);
    });
    if (!source) return { game, count };
    game = move(game, { ...source, offset: source.cards.length - 1 }, {
      zone: HOME, index: suit(source.cards.at(-1)),
    }).game;
    count += 1;
  }
  return { game, count };
}

/**
 * 場札の足場を失わずに送れるか確認する。A・2、反対色の N-1 が両方済んだ札は安全。
 * 反対色が N-2 でも、同色の N-3 が済んでいればよい。未達なら残る同色の N-2 を
 * 逃がすため、反対色の N-1 とその足場である対象札 N が必要になり得る。
 */
function safeHome(board, card) {
  const value = rank(card);
  const color = SUITS[suit(card)].color;
  const oppositeReady = (gap) => SUITS.every((other, index) => other.color === color
    || board.foundations[index].length >= value - gap);
  return value <= 2 || oppositeReady(1) || (oppositeReady(2)
    && SUITS.every((other, index) => other.color !== color || board.foundations[index].length >= value - 3));
}

/** 時計は巻き戻さず、盤面を 1 手戻す操作自体も累積手数へ加える。 */
export function undo(game) {
  return game.cursor > 0 ? { ...game, cursor: game.cursor - 1, actions: getActions(game) + 1 } : game;
}

/** 保存している次の盤面へ進む。末尾では状態を変えない。 */
export function redo(game) {
  return game.cursor + 1 < game.history.length ? { ...game, cursor: game.cursor + 1, actions: getActions(game) + 1 } : game;
}

/** 同じ初期配列に戻し、手数・経過時間・開始状態を初期化する。 */
export function restart(game) {
  return initialGame(game.history[0]);
}

/** 保存された盤面の構造、52 枚の一意性、ホームセルの順序を確認する。 */
function validBoard(board) {
  if (!board) return false;
  const { tableau, cells, foundations } = board;
  if (!Array.isArray(tableau) || tableau.length !== 8
    || !Array.isArray(cells) || cells.length !== 4
    || !Array.isArray(foundations) || foundations.length !== 4) return false;
  if (!tableau.every(Array.isArray) || !foundations.every(Array.isArray)) return false;
  if (!cells.every((card) => card === null || isCard(card))) return false;
  const cards = [...tableau.flat(), ...cells.filter((card) => card !== null), ...foundations.flat()];
  if (cards.length !== 52 || !cards.every(isCard) || new Set(cards).size !== 52) return false;
  return foundations.every((pile, suitIndex) => pile.length <= 13
    && pile.every((card, index) => card === suitIndex * 13 + index));
}

/** 履歴比較と移動候補の列挙用に、フリーセルも通常のカード配列へそろえる。 */
function piles(board) {
  return [
    ...board.tableau.map((cards, index) => ({ zone: TABLEAU, index, cards })),
    ...board.cells.map((card, index) => ({ zone: CELLS, index, cards: card === null ? [] : [card] })),
    ...board.foundations.map((cards, index) => ({ zone: HOME, index, cards })),
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
  if (!game) return false;
  const { history, cursor, elapsedMs, started, actions, id, recorded, result } = game;
  if (game.version !== 1 || !Array.isArray(history) || history.length === 0
    || !Number.isInteger(cursor) || cursor < 0 || cursor >= history.length
    || typeof started !== 'boolean' || !Number.isFinite(elapsedMs)
    || elapsedMs < 0 || elapsedMs > Number.MAX_SAFE_INTEGER) return false;
  if (started !== (history.length > 1) || (!started && elapsedMs !== 0)) return false;
  // 旧形式は読み込めるが、ID のある新局には正確な累積手数を必須とする。
  if (actions !== undefined && (!Number.isSafeInteger(actions)
    || actions < history.length - 1 || (!started && actions !== 0))) return false;
  if (id !== undefined && (typeof id !== 'string'
    || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id)
    || actions === undefined)) return false;
  if (recorded !== undefined && typeof recorded !== 'boolean') return false;
  // 保存再試行用の初回成績は Undo 後も保つが、他の局の成績や破損値は復元しない。
  if (result !== undefined && (!validRecord(result) || result.id !== id)) return false;
  if (!history.every(validBoard)) return false;
  const initial = history[0];
  if (initial.cells.some((card) => card !== null) || initial.foundations.some((pile) => pile.length)
    || !initial.tableau.every((pile, index) => pile.length === (index < 4 ? 7 : 6))) return false;
  return history.every((board, index) => index === 0 || validTransition(history[index - 1], board));
}
