/** フリーセルの合法手、容量境界、履歴と復元検証を公開 API から確認する。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { autoHome, cardLabel, createGame, getBoard, isWon, move, quickMove, rank, redo, restart, undo, validateGame } from '../src/game.js';

const from = (index, offset = 0) => ({ zone: 'tableau', index, offset });
const to = (zone, index) => ({ zone, index });
const clone = (value) => JSON.parse(JSON.stringify(value));

/** 指定の配置以外を最後の列へ置き、規則テストでも 52 枚の一意性を維持する。 */
function fixture(columns, cells = [null, null, null, null], foundations = [[], [], [], []]) {
  const tableau = Array.from({ length: 8 }, (_, index) => [...(columns[index] ?? [])]);
  const used = new Set([...tableau.flat(), ...cells.filter((card) => card !== null), ...foundations.flat()]);
  const rest = Array.from({ length: 52 }, (_, card) => card).filter((card) => !used.has(card));
  tableau[7].unshift(...rest);
  const board = { tableau, cells: [...cells], foundations: foundations.map((pile) => [...pile]) };
  return { version: 1, history: [board], cursor: 0, elapsedMs: 0, started: false };
}

/** 移動後の盤面に 52 枚すべてが残り、元の状態が変更されないことも確認する。 */
function legal(game, source, target) {
  const original = clone(game);
  const result = move(game, source, target);
  assert.equal(result.error, null);
  const board = getBoard(result.game);
  const cards = [...board.tableau.flat(), ...board.cells.filter((card) => card !== null), ...board.foundations.flat()];
  assert.equal(cards.length, 52);
  assert.equal(new Set(cards).size, 52);
  assert.deepEqual(game, original);
  return result.game;
}

/** 不正な操作では盤面だけでなく、ゲームオブジェクト自体を差し替えない。 */
function illegal(game, source, target) {
  const original = clone(game);
  const result = move(game, source, target);
  assert.equal(result.game, game);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  assert.deepEqual(game, original);
}

test('配札は 52 枚を 7,7,7,7,6,6,6,6 枚に分け、初期状態を復元できる', () => {
  for (const random of [() => 0, () => 0.5, () => 0.9999, Math.random]) {
    const game = createGame(random);
    const board = getBoard(game);
    assert.deepEqual(board.tableau.map((pile) => pile.length), [7, 7, 7, 7, 6, 6, 6, 6]);
    assert.equal(new Set(board.tableau.flat()).size, 52);
    assert.deepEqual(board.cells, [null, null, null, null]);
    assert.equal(validateGame(clone(game)), true);
    assert.equal(isWon(board), false);
  }
});

test('カードの値と日本語の読み上げ名を数値 ID から作る', () => {
  assert.equal(rank(0), 1);
  assert.equal(rank(51), 13);
  assert.equal(cardLabel(19), 'ハートの7');
  assert.equal(cardLabel(0), 'スペードのエース');
  assert.equal(cardLabel(51), 'クラブのキング');
});

test('場札には交互色で 1 段小さい札だけを置ける', () => {
  legal(fixture([[19], [7]]), from(0), to('tableau', 1));
  for (const card of [6, 20, 18]) {
    illegal(fixture([[card], [7]]), from(0), to('tableau', 1));
  }
});

test('空列に K 以外も置け、フリーセル同士も 1 枚なら移せる', () => {
  const game = fixture([[5], []]);
  assert.deepEqual(getBoard(legal(game, from(0), to('tableau', 1))).tableau[1], [5]);
  const parked = legal(game, from(0), to('cells', 0));
  const shifted = legal(parked, to('cells', 0), to('cells', 1));
  assert.deepEqual(getBoard(shifted).cells, [null, 5, null, null]);
  legal(shifted, to('cells', 1), to('tableau', 1));
  illegal(parked, from(7, getBoard(parked).tableau[7].length - 1), to('cells', 0));
  illegal(parked, to('cells', 1), to('cells', 2));
});

test('同じ場所、存在しない場所、場札の範囲外を拒否する', () => {
  const game = createGame(() => 0.5);
  illegal(game, from(0), to('tableau', 0));
  illegal(game, from(8), to('cells', 0));
  illegal(game, from(0, -1), to('cells', 0));
  illegal(game, from(0, 7), to('cells', 0));
  illegal(game, { zone: 'tableau', index: 0 }, to('cells', 0));
  illegal(game, from(0, 6), to('cells', 4));
  illegal(game, null, to('cells', 0));
});

test('ホームセルはスート固定で A から進み、通常操作では戻せない', () => {
  let game = fixture([[0, 1], [13]]);
  illegal(game, from(0, 1), to('foundations', 0));
  illegal(game, from(1), to('foundations', 0));
  game = legal(game, from(0, 1), to('cells', 0));
  game = legal(game, from(0), to('foundations', 0));
  game = legal(game, to('cells', 0), to('foundations', 0));
  assert.deepEqual(getBoard(game).foundations[0], [0, 1]);
  illegal(game, to('foundations', 0), to('cells', 0));
});

test('簡易移動は安全条件にかかわらず合法なホームを優先し、元の状態を変更しない', () => {
  const game = fixture([[2]], [4, 13, 26, 39], [[0, 1], [], [], []]);
  const original = clone(game);
  const result = quickMove(game, from(0));
  assert.equal(result.error, null);
  assert.deepEqual(getBoard(result.game).foundations[0], [0, 1, 2]);
  assert.deepEqual(getBoard(result.game).cells, getBoard(game).cells);
  assert.equal(result.game.cursor, 1);
  assert.deepEqual(game, original);
});

test('ホームに送れない場札は最初の空きフリーセルへ移す', () => {
  const game = fixture([[5]], [0, null, 13, null]);
  const result = quickMove(game, from(0));
  assert.equal(result.error, null);
  assert.deepEqual(getBoard(result.game).tableau[0], []);
  assert.deepEqual(getBoard(result.game).cells, [0, 5, 13, null]);
});

test('簡易移動は埋もれた札・空き枠・不正な位置・満杯のフリーセルを拒否する', () => {
  const game = fixture([[5, 17]]);
  const cases = [null, from(8), from(0), from(0, -1), from(0, 2), from(0, '1'),
    { zone: 'tableau', index: 0 }, from(1, -1), to('cells', 0), to('foundations', 0)];
  for (const source of cases) {
    const original = clone(game);
    const result = quickMove(game, source);
    assert.equal(result.game, game);
    assert.ok(result.error);
    assert.deepEqual(game, original);
  }
  const full = fixture([[5]], [0, 13, 26, 39]);
  const result = quickMove(full, from(0));
  assert.equal(result.game, full);
  assert.match(result.error, /空いているフリーセル/);
});

test('フリーセルからの簡易移動はホームへだけ移し、送れなければそのままにする', () => {
  const game = fixture([], [0, 5, null, null]);
  const result = quickMove(game, to('cells', 0));
  assert.equal(result.error, null);
  assert.deepEqual(getBoard(result.game).foundations[0], [0]);
  const blocked = quickMove(result.game, to('cells', 1));
  assert.equal(blocked.game, result.game);
  assert.match(blocked.error, /まだホームセル/);
  assert.deepEqual(getBoard(blocked.game).cells, [null, 5, null, null]);
});

test('自動は全スートの A・2 を連続で送り、合法でない札や埋もれた札は送らない', () => {
  for (let suit = 0; suit < 4; suit += 1) {
    const game = fixture([[suit * 13 + 1, suit * 13]]);
    const original = clone(game);
    const result = autoHome(game);
    assert.equal(result.count, 2);
    assert.deepEqual(getBoard(result.game).foundations[suit], [suit * 13, suit * 13 + 1]);
    assert.deepEqual(game, original);
  }
  for (const game of [fixture([[1]]), fixture([[0, 5]])]) {
    assert.deepEqual(autoHome(game), { game, count: 0 });
    assert.equal(autoHome(game).game, game);
  }
});

test('3 以上の自動移動には反対色の両スートが 1 段下まで必要', () => {
  for (const [card, foundations] of [
    [2, [[0, 1], [13, 14], [26, 27], []]],
    [15, [[0, 1], [13, 14], [], [39, 40]]],
  ]) {
    const opposite = card === 2 ? [1, 2] : [0, 3];
    for (const suit of opposite) {
      const unsafe = foundations.map((pile, index) => index === suit ? pile.slice(0, 1) : pile);
      const game = fixture([[card]], undefined, unsafe);
      assert.deepEqual(autoHome(game), { game, count: 0 });
      assert.equal(autoHome(game).game, game);
    }
    const result = autoHome(fixture([[card]], undefined, foundations));
    assert.equal(result.count, 1);
    assert.equal(getBoard(result.game).foundations[Math.floor(card / 13)].at(-1), card);
  }
});

test('自動はフリーセルも再走査し、1 枚ずつ戻す・やり直すことができる', () => {
  const game = fixture([], [1, 0, null, null]);
  const original = clone(game);
  const result = autoHome(game);
  assert.equal(result.count, 2);
  assert.equal(result.game.cursor, 2);
  assert.deepEqual(getBoard(result.game).cells, [null, null, null, null]);
  const previous = undo(result.game);
  assert.deepEqual(getBoard(previous).foundations[0], [0]);
  assert.deepEqual(getBoard(previous).cells, [1, null, null, null]);
  assert.deepEqual(redo(previous), result.game);
  assert.deepEqual(game, original);
  assert.equal(autoHome(result.game).game, result.game);
});

test('順序の崩れた連続札と、複数枚のフリーセル・ホームセル移動を拒否する', () => {
  for (const run of [[7, 6], [7, 18]]) {
    illegal(fixture([run, []]), from(0), to('tableau', 1));
  }
  const game = fixture([[7, 19], [21]]);
  illegal(game, from(0), to('cells', 0));
  illegal(game, from(0), to('foundations', 0));
});

test('空きフリーセル 4・空列 0 では 5 枚まで移動できる', () => {
  const run = [7, 19, 5, 30, 3, 15];
  const game = fixture([run, [21], [9], [10], [11], [12], [22], [23]]);
  illegal(game, from(0), to('tableau', 1));
  const five = fixture([run.slice(0, 5), [21], [9], [10], [11], [12], [22], [23]]);
  assert.equal(getBoard(legal(five, from(0), to('tableau', 1))).tableau[0].length, 0);
});

test('空列 1 は補助に使えば 10 枚までだが、その空列への移動は 5 枚まで', () => {
  const run = [11, 23, 9, 34, 7, 19, 5, 30, 3, 15, 1];
  const ten = fixture([run.slice(0, 10), [25], [], [12], [22], [24], [38], [51]]);
  legal(ten, from(0), to('tableau', 1));
  illegal(ten, from(0), to('tableau', 2));
  const eleven = fixture([run, [25], [], [12], [22], [24], [38], [51]]);
  illegal(eleven, from(0), to('tableau', 1));
  const five = fixture([run.slice(0, 5), [25], [], [12], [22], [24], [38], [51]]);
  legal(five, from(0), to('tableau', 2));
});

test('補助枠なしでは 1 枚だけ許可し、元列が空になる分を容量に足さない', () => {
  const game = fixture([[7, 19], [21], [9], [10], [11], [12], [22], [23]], [0, 1, 2, 3]);
  illegal(game, from(0), to('tableau', 1));
  legal(fixture([[7], [21], [9], [10], [11], [12], [22], [23]], [0, 1, 2, 3]), from(0), to('tableau', 1));
});

test('Undo/Redo は盤面・手数だけを戻し、分岐で先の履歴を破棄する', () => {
  const initial = createGame(() => 0.5);
  assert.equal(undo(initial), initial);
  assert.equal(redo(initial), initial);
  const first = legal(initial, from(0, 6), to('cells', 0));
  const second = { ...legal(first, from(1, 6), to('cells', 1)), elapsedMs: 9876 };
  const previous = undo(second);
  assert.equal(previous.cursor, 1);
  assert.equal(previous.elapsedMs, 9876);
  assert.deepEqual(getBoard(previous), getBoard(first));
  assert.deepEqual(getBoard(redo(previous)), getBoard(second));
  assert.equal(undo(previous).started, true);
  assert.equal(validateGame(clone(undo(previous))), true);
  const branch = legal(previous, from(2, 6), to('cells', 2));
  assert.equal(branch.history.length, 3);
  assert.equal(redo(branch), branch);
  assert.equal(validateGame(clone(branch)), true);
  assert.deepEqual(restart(branch), initial);
});

test('最後の 1 枚で勝利し、戻すと解除・やり直すと再び勝利する', () => {
  const foundations = Array.from({ length: 4 }, (_, suit) => Array.from({ length: suit === 3 ? 12 : 13 }, (_, rank) => suit * 13 + rank));
  const game = fixture([[51]], [null, null, null, null], foundations);
  assert.equal(isWon(getBoard(game)), false);
  const won = legal(game, from(0), to('foundations', 3));
  assert.equal(isWon(getBoard(won)), true);
  assert.equal(isWon(getBoard(undo(won))), false);
  assert.equal(isWon(getBoard(redo(undo(won)))), true);
});

test('52 手で解ける配列を最後まで進め、勝利・Undo・Redo を含む全履歴を復元できる', () => {
  let game = createGame();
  const deck = Array.from({ length: 52 }, (_, index) => (index % 4) * 13 + 12 - Math.floor(index / 4));
  game.history[0].tableau = Array.from({ length: 8 }, (_, column) => deck.filter((_, index) => index % 8 === column));
  assert.equal(validateGame(game), true);
  for (let count = 0; count < 52; count += 1) {
    const board = getBoard(game);
    const column = board.tableau.findIndex((pile) => pile.length && rank(pile.at(-1)) === board.foundations[Math.floor(pile.at(-1) / 13)].length + 1);
    assert.notEqual(column, -1);
    const pile = board.tableau[column];
    game = legal(game, from(column, pile.length - 1), to('foundations', Math.floor(pile.at(-1) / 13)));
  }
  assert.equal(game.cursor, 52);
  assert.equal(isWon(getBoard(game)), true);
  assert.equal(validateGame(clone(game)), true);
  assert.equal(validateGame(clone(undo(game))), true);
  assert.equal(validateGame(clone(redo(undo(game)))), true);
});

test('全 52 枚の自動移動は通常の保存形式のまま勝利・Undo・Redo を復元できる', () => {
  const game = createGame();
  const deck = Array.from({ length: 52 }, (_, index) => (index % 4) * 13 + 12 - Math.floor(index / 4));
  game.history[0].tableau = Array.from({ length: 8 }, (_, column) => deck.filter((_, index) => index % 8 === column));
  const original = clone(game);
  const result = autoHome(game);
  assert.equal(result.count, 52);
  assert.equal(result.game.cursor, 52);
  assert.equal(result.game.history.length, 53);
  assert.equal(isWon(getBoard(result.game)), true);
  assert.equal(isWon(getBoard(undo(result.game))), false);
  assert.equal(isWon(getBoard(redo(undo(result.game)))), true);
  for (const state of [result.game, undo(result.game), redo(undo(result.game))]) {
    assert.equal(validateGame(clone(state)), true);
  }
  assert.deepEqual(game, original);
});

test('保存の版・位置・時計・開始状態・初期配置の破損を拒否する', () => {
  const game = createGame(() => 0.5);
  for (const change of [
    (value) => { value.version = 2; },
    (value) => { value.cursor = -1; },
    (value) => { value.cursor = 1; },
    (value) => { value.elapsedMs = -1; },
    (value) => { value.elapsedMs = Infinity; },
    (value) => { value.elapsedMs = 1; },
    (value) => { value.started = true; },
    (value) => { value.history[0].tableau[0].pop(); },
    (value) => { value.history[0].tableau[0][0] = value.history[0].tableau[0][1]; },
    (value) => { value.history[0].tableau[0][0] = 52; },
    (value) => { value.history[0].cells[0] = value.history[0].tableau[0].pop(); },
    (value) => { value.history[0].tableau[7].push(value.history[0].tableau[0].pop()); },
  ]) {
    const broken = clone(game);
    change(broken);
    assert.equal(validateGame(broken), false);
  }
  for (const invalid of [null, {}, [], { version: 1, history: [] }]) assert.equal(validateGame(invalid), false);
});

test('枚数が正しくても、履歴の飛び・札の並べ替え・開始状態の偽装を拒否する', () => {
  const initial = createGame(() => 0.5);
  const first = legal(initial, from(0, 6), to('cells', 0));
  const second = legal(first, from(1, 6), to('cells', 1));
  assert.equal(validateGame(second), true);
  const skipped = { ...second, history: [second.history[0], second.history[2]], cursor: 1 };
  assert.equal(validateGame(skipped), false);
  const reordered = clone(first);
  [reordered.history[1].tableau[2][0], reordered.history[1].tableau[2][1]] = reordered.history[1].tableau[2].slice(0, 2).reverse();
  assert.equal(validateGame(reordered), false);
  assert.equal(validateGame({ ...first, started: false }), false);
});

test('52 枚が一意でも、ホームセルのスート越境や順序違いを復元しない', () => {
  const initial = createGame(() => 0.5);
  const corrupt = clone(initial);
  const board = corrupt.history[0];
  board.foundations[0] = Array.from({ length: 14 }, (_, card) => card);
  board.tableau = board.tableau.map((pile) => pile.filter((card) => card >= 14));
  assert.equal(validateGame(corrupt), false);
  const ordinary = legal(initial, from(0, 6), to('cells', 0));
  const malformed = clone(ordinary);
  const card = malformed.history[1].cells[0];
  malformed.history[1].cells[0] = null;
  malformed.history[1].foundations[Math.floor(card / 13)] = [card];
  assert.equal(validateGame(malformed), false);
});
