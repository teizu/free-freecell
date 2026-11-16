/** 独立した上位 3 件、達成日、重複防止と保存失敗を実際の保存形式で検証する。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTime, loadRecords, saveRecord } from '../src/records.js';

/** 別アプリの値を含む Storage を用意する。 */
function storage() {
  const values = new Map([['other', 'keep']]);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

/** 異なる試行の記録を、順序と同値の比較を確認できる日時で作る。 */
function result(index, time, moves) {
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    date: `2026-11-${String(index).padStart(2, '0')}T12:34:56.000Z`, time, moves };
}

test('時間と手数を別々に上位3件保存し、同値では先の達成日を優先する', () => {
  const saved = storage();
  const input = [result(1, 100, 90), result(2, 150, 60), result(3, 120, 80), result(4, 100, 70), result(5, 200, 52)];
  for (const entry of input.reverse()) assert.equal(saveRecord('records', entry, () => saved).error, '');
  const { records, error } = loadRecords('records', () => saved);
  assert.equal(error, '');
  assert.deepEqual(records[0].map(entry => entry.id), [1, 4, 3].map(index => result(index).id));
  assert.deepEqual(records[1].map(entry => entry.id), [5, 2, 4].map(index => result(index).id));
  assert.deepEqual(records[0][0], result(1, 100, 90));
  assert.equal(saved.getItem('other'), 'keep');
});

test('同じ試行の再登録で順位や達成日時を変えず、最新の他の記録も保持する', () => {
  const saved = storage();
  const first = result(1, 60, 60);
  saveRecord('records', first, () => saved);
  saveRecord('records', result(2, 80, 52), () => saved);
  assert.deepEqual(saveRecord('records', { ...first, time: 1, date: result(3).date }, () => saved),
    { error: '', updated: [false, false] });
  const { records } = loadRecords('records', () => saved);
  assert.deepEqual(records[0], [first, result(2, 80, 52)]);
  assert.deepEqual(records[1], [result(2, 80, 52), first]);
});

test('記録なしと破損・読込拒否・容量超過を区別し、壊れた保存を上書きしない', () => {
  const saved = storage();
  assert.deepEqual(loadRecords('records', () => saved), { records: [[], []], error: '' });
  const invalid = [null, {}, [], [[result(1, -1, 52)], []], [[result(1, 30, 2.5)], []],
    [[{ ...result(1, 30, 52), date: 'invalid' }], []], [Array(4).fill(result(1, 30, 52)), []]];
  for (const data of ['{', ...invalid.map(value => JSON.stringify(value))]) {
    saved.setItem('records', data);
    assert.ok(loadRecords('records', () => saved).error);
    const response = saveRecord('records', result(1, 20, 52), () => saved);
    assert.ok(response.error);
    assert.deepEqual(response.updated, [false, false]);
    assert.equal(saved.getItem('records'), data);
  }
  const denied = () => { throw new Error('denied'); };
  assert.ok(loadRecords('records', denied).error);
  const unreadable = saveRecord('records', result(1, 30, 52), denied);
  assert.ok(unreadable.error);
  assert.deepEqual(unreadable.updated, [false, false]);
  saved.values.delete('records');
  saved.setItem = () => { throw new Error('quota'); };
  const unwritable = saveRecord('records', result(1, 30, 52), () => saved);
  assert.ok(unwritable.error);
  assert.deepEqual(unwritable.updated, [false, false]);
  assert.equal(saved.getItem('other'), 'keep');
});

test('初記録は両方を更新し、満員の順位表では時間のみ・手数のみ・両方・圏外を区別する', () => {
  const empty = storage();
  assert.deepEqual(saveRecord('records', result(1, 60, 60), () => empty),
    { error: '', updated: [true, true] });
  const cases = [
    [50, 90, [true, false]],
    [150, 55, [false, true]],
    [50, 55, [true, true]],
    [150, 90, [false, false]],
    // 3位と同値なら先の達成を優先し、2位と同値なら新しい3位として入る。
    [120, 80, [false, false]],
    [90, 70, [true, true]],
  ];
  for (const [time, moves, updated] of cases) {
    const saved = storage();
    for (const entry of [result(1, 60, 60), result(2, 90, 70), result(3, 120, 80)]) {
      saveRecord('records', entry, () => saved);
    }
    const entry = result(4, time, moves);
    assert.deepEqual(saveRecord('records', entry, () => saved), { error: '', updated });
    // 同じ結果を再試行しても、新たなランク入りとしては通知しない。
    assert.deepEqual(saveRecord('records', entry, () => saved), { error: '', updated: [false, false] });
  }
});

test('保存失敗では更新を通知せず、元の成績を保持して成功した再試行だけ通知する', () => {
  const saved = storage();
  const entry = result(1, 60, 60);
  const write = saved.setItem;
  saved.setItem = () => { throw new Error('quota'); };
  const failed = saveRecord('records', entry, () => saved);
  assert.ok(failed.error);
  assert.deepEqual(failed.updated, [false, false]);
  assert.equal(saved.getItem('records'), null);
  saved.setItem = write;
  assert.deepEqual(saveRecord('records', entry, () => saved), { error: '', updated: [true, true] });
  assert.deepEqual(loadRecords('records', () => saved).records, [[entry], [entry]]);
});

test('時間は 0 秒・分境界・1 時間以上を同じ表記で表示する', () => {
  assert.deepEqual([0, 59, 60, 3661].map(formatTime), ['0:00', '0:59', '1:00', '61:01']);
});
