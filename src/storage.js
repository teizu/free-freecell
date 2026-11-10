/** ゲーム専用の保存キーだけを読み書きし、保存できない環境でもプレイを止めない。 */
import { validateGame } from './game.js';

/** localStorage へのアクセスと JSON・状態検証を一つの失敗境界にまとめる。 */
export function loadGame(key, storageFactory = () => globalThis.localStorage) {
  try {
    const saved = storageFactory().getItem(key);
    if (saved === null) return { game: null, error: null };
    const game = JSON.parse(saved);
    if (!validateGame(game)) return { game: null, error: '保存データを復元できず、新規ゲームを開始。' };
    return { game, error: null };
  } catch {
    return { game: null, error: '保存データの読込に失敗。この画面では遊べます。' };
  }
}

/** 保存の失敗を短い案内として返す。容量超過や設定による拒否を外へ投げない。 */
export function saveGame(key, game, storageFactory = () => globalThis.localStorage) {
  try {
    storageFactory().setItem(key, JSON.stringify(game));
    return null;
  } catch {
    return '保存不可。この画面では遊べますが、閉じると進行を失う場合があります。';
  }
}

/** 更新時だけタブ固有の控えを作り、別タブの永続保存による上書きから進行を守る。 */
export function saveReload(key, game, automatic, storageFactory = () => globalThis.sessionStorage) {
  try {
    storageFactory().setItem(key, JSON.stringify({ game, automatic }));
    return true;
  } catch {
    return false;
  }
}

/** 更新用の控えは一度だけ消費し、破損や保存拒否なら通常の永続保存へ戻る。 */
export function takeReload(key, storageFactory = () => globalThis.sessionStorage) {
  try {
    const storage = storageFactory();
    const value = storage.getItem(key);
    if (value === null) return null;
    storage.removeItem(key);
    const saved = JSON.parse(value);
    return validateGame(saved?.game) && typeof saved.automatic === 'boolean' ? saved : null;
  } catch {
    return null;
  }
}
