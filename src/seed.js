/** 数値シードから再現可能な配札用の乱数を作る。暗号や試行 ID の生成には使わない。 */

export const validSeed = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

/** 通常ゲームも、表示した番号を入力し直せるよう 32bit のシードを先に生成する。 */
export function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/**
 * Mulberry32 を固定した配札規約として使い、毎回同じ初期状態から開始する。
 * 32bit 整数の演算と 2^32 での除算だけなので、端末やブラウザーの乱数実装に依存しない。
 * 定数・演算順・後段のシャッフル順を変えると既存シードの配りが変わるため変更しない。
 */
export function seededRandom(seed) {
  if (!validSeed(seed)) throw new RangeError('シードは0〜4294967295の整数で指定してください。');
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}
