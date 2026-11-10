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
  for (const entry of input.reverse()) assert.equal(saveRecord('records', entry, () => saved), '');
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
  saveRecord('records', { ...first, time: 1, date: result(3).date }, () => saved);
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
    assert.ok(saveRecord('records', result(1, 20, 52), () => saved));
    assert.equal(saved.getItem('records'), data);
  }
  const denied = () => { throw new Error('denied'); };
  assert.ok(loadRecords('records', denied).error);
  assert.ok(saveRecord('records', result(1, 30, 52), denied));
  saved.values.delete('records');
  saved.setItem = () => { throw new Error('quota'); };
  assert.ok(saveRecord('records', result(1, 30, 52), () => saved));
  assert.equal(saved.getItem('other'), 'keep');
});

test('時間は 0 秒・分境界・1 時間以上を同じ表記で表示する', () => {
  assert.deepEqual([0, 59, 60, 3661].map(formatTime), ['0:00', '0:59', '1:00', '61:01']);
});
