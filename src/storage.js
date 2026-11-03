/** ゲーム専用の保存キーだけを読み書きし、保存できない環境でもプレイを止めない。 */
import { validateGame } from './game.js';

/** localStorage へのアクセスと JSON・状態検証を一つの失敗境界にまとめる。 */
export function loadGame(key, storageFactory = () => globalThis.localStorage) {
  try {
    const saved = storageFactory().getItem(key);
    if (saved === null) return { game: null, error: null };
    const game = JSON.parse(saved);
    if (!validateGame(game)) return { game: null, error: '保存データを復元できないため、新しいゲームを始めました。' };
    return { game, error: null };
  } catch {
    return { game: null, error: '保存データを読み込めませんでした。この画面でゲームを続けられます。' };
  }
}

/** 保存の失敗を短い案内として返す。容量超過や設定による拒否を外へ投げない。 */
export function saveGame(key, game, storageFactory = () => globalThis.localStorage) {
  try {
    storageFactory().setItem(key, JSON.stringify(game));
    return null;
  } catch {
    return '保存できません。この画面では遊べますが、閉じると今回の進行を失う場合があります。';
  }
}
