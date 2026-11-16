/** シードの入力範囲と乱数列を固定し、配り番号の再現性を将来の変更から守る。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomSeed, seededRandom, validSeed } from '../src/seed.js';

test('シードは 0 と最大値を含む 32bit 非負整数だけを受け付ける', () => {
  for (const seed of [0, 1, 123, 0xffffffff]) assert.equal(validSeed(seed), true);
  for (const seed of [undefined, null, '', '123', false, true, {}, [], -1, .5, 0x100000000, NaN, Infinity]) {
    assert.equal(validSeed(seed), false);
    assert.throws(() => seededRandom(seed), RangeError);
  }
});

test('Mulberry32 の固定乱数列を維持し、同じシードの生成器は互いに独立する', () => {
  // 2^32 倍の整数で比較するため、表示上の小数丸めに影響されない。
  const expected = [
    [0, [1144304738, 1416247, 958946056, 627933444, 2007157716]],
    [1, [2693262067, 11749833, 2265367787, 4213581821, 4159151403]],
    [0xffffffff, [3850105811, 813802916, 3073704848, 4054706436, 3630262831]],
  ];
  for (const [seed, values] of expected) {
    const first = seededRandom(seed);
    assert.deepEqual(values.map(() => first() * 0x100000000), values);
    const second = seededRandom(seed);
    assert.deepEqual(values.map(() => second() * 0x100000000), values);
  }
});

test('通常配札用のシードは Web Crypto の 32bit 値をそのまま使い、0 も捨てない', (context) => {
  for (const seed of [0, 0xffffffff]) {
    const mocked = context.mock.method(crypto, 'getRandomValues', (values) => {
      assert.ok(values instanceof Uint32Array);
      assert.equal(values.length, 1);
      values[0] = seed;
      return values;
    });
    assert.equal(randomSeed(), seed);
    assert.equal(mocked.mock.callCount(), 1);
    mocked.mock.restore();
  }
});
