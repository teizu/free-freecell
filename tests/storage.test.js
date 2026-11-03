/** 保存キーの隔離、JSON 復元、保存禁止・容量超過での継続を確認する。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, move } from '../src/game.js';
import { loadGame, saveGame, saveReload, takeReload } from '../src/storage.js';

/** 他のアプリのキーを含めた、最小限の Storage 互換テスト用オブジェクト。 */
function memoryStorage() {
  const data = new Map([['other-app', 'keep']]);
  return {
    data, getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key),
  };
}

test('履歴と時間を保存・復元し、指定されたキー以外を変更しない', () => {
  const storage = memoryStorage();
  const key = 'freecell:/free-freecell/:v1';
  assert.deepEqual(loadGame(key, () => storage), { game: null, error: null });
  let game = createGame(() => 0.5);
  game = move(game, { zone: 'tableau', index: 0, offset: 6 }, { zone: 'cells', index: 0 }).game;
  game.elapsedMs = 1234.5;
  assert.equal(saveGame(key, game, () => storage), null);
  assert.deepEqual(loadGame(key, () => storage), { game, error: null });
  assert.equal(storage.data.get('other-app'), 'keep');
  assert.equal(storage.data.size, 2);
});

test('壊れた JSON・未対応形式・重複札を復元せず、元の保存値は保持する', () => {
  const game = createGame(() => 0.5);
  game.history[0].tableau[0][0] = game.history[0].tableau[0][1];
  for (const saved of ['{', 'null', '{"version":2}', JSON.stringify(game)]) {
    const storage = memoryStorage();
    storage.setItem('game', saved);
    const result = loadGame('game', () => storage);
    assert.equal(result.game, null);
    assert.ok(result.error);
    assert.equal(storage.getItem('game'), saved);
    assert.equal(storage.data.get('other-app'), 'keep');
  }
});

test('Storage アクセス拒否・容量超過を例外として外へ漏らさない', () => {
  const denied = () => { throw new Error('SecurityError'); };
  assert.ok(loadGame('game', denied).error);
  assert.ok(saveGame('game', createGame(), denied));
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const game = createGame();
  const snapshot = JSON.stringify(game);
  assert.ok(saveGame('game', game, () => storage));
  assert.equal(JSON.stringify(game), snapshot);
  assert.equal(storage.data.get('other-app'), 'keep');
});

test('更新直前の進行と自動設定をタブごとに保存し、一度だけ復元する', () => {
  const key = 'freecell:/free-freecell/:v1:reload';
  const tabs = [memoryStorage(), memoryStorage()];
  let game = createGame(() => 0.5);
  game = move(game, { zone: 'tableau', index: 0, offset: 6 }, { zone: 'cells', index: 0 }).game;
  game = { ...game, cursor: 0, elapsedMs: 1234.5 };
  const otherGame = createGame(() => 0.25);
  const snapshot = JSON.stringify(game);
  assert.equal(saveReload(key, game, true, () => tabs[0]), true);
  assert.equal(saveReload(key, otherGame, false, () => tabs[1]), true);
  assert.deepEqual(takeReload(key, () => tabs[0]), { game, automatic: true });
  assert.deepEqual(takeReload(key, () => tabs[1]), { game: otherGame, automatic: false });
  assert.equal(JSON.stringify(game), snapshot);
  for (const storage of tabs) {
    assert.equal(takeReload(key, () => storage), null);
    assert.equal(storage.getItem(key), null);
    assert.equal(storage.data.get('other-app'), 'keep');
    assert.equal(storage.data.size, 1);
  }
});

test('更新用データの破損・不正な自動設定は一度で破棄し、ゲームへ取り込まない', () => {
  const game = createGame(() => 0.5);
  const damaged = structuredClone(game);
  damaged.history[0].tableau[0][0] = damaged.history[0].tableau[0][1];
  const values = ['{', 'null', '{}', JSON.stringify({ game, automatic: 'true' }),
    JSON.stringify({ game: damaged, automatic: true })];
  for (const value of values) {
    const storage = memoryStorage();
    storage.setItem('reload', value);
    assert.equal(takeReload('reload', () => storage), null);
    assert.equal(storage.getItem('reload'), null);
    assert.equal(storage.data.get('other-app'), 'keep');
  }
});

test('更新用の保存・読込・消去が拒否されたら成功や復元として扱わない', () => {
  const denied = () => { throw new Error('SecurityError'); };
  const game = createGame();
  assert.equal(saveReload('reload', game, true, denied), false);
  assert.equal(takeReload('reload', denied), null);
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(saveReload('reload', game, true, () => storage), false);
  storage.data.set('reload', JSON.stringify({ game, automatic: true }));
  storage.removeItem = () => { throw new Error('SecurityError'); };
  assert.equal(takeReload('reload', () => storage), null, 'A snapshot that cannot be consumed must not be restored repeatedly');
  assert.equal(storage.data.get('other-app'), 'keep');
});
