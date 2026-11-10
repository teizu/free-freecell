/** クリア成績だけをブラウザーに保存する。進行中の局や他の保存キーは変更しない。 */

/** 時間表示は盤面と成績で共有し、1 時間以上でも分を切り捨てない。 */
export function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 対局の未保存成績とランキングで共通の形式を検証し、不正な日時で例外を出さない。 */
export function validRecord(entry) {
  return entry && typeof entry.id === 'string' && entry.id.length === 36
    && typeof entry.date === 'string' && Number.isFinite(Date.parse(entry.date))
    && ['time', 'moves'].every(field => Number.isSafeInteger(entry[field]) && entry[field] >= 0);
}

/** 保存内容を検証し、破損時は上書きせず案内を返す。各ランキングは最大 3 件。 */
export function loadRecords(key, storage = () => localStorage) {
  try {
    const records = JSON.parse(storage().getItem(key) ?? '[[],[]]');
    if (!Array.isArray(records) || records.length !== 2 || !records.every(list => Array.isArray(list)
      && list.length <= 3 && list.every(validRecord))) {
      throw new Error();
    }
    return { records, error: '' };
  } catch {
    return { records: [[], []], error: '成績を読み込めません。' };
  }
}

/** 直前の保存を読み直し、同じ試行は一度だけ登録する。同値は先に達成した局を優先する。 */
export function saveRecord(key, entry, storage = () => localStorage) {
  const { records, error } = loadRecords(key, storage);
  if (error) return error;
  const next = ['time', 'moves'].map((field, index) => {
    const list = records[index];
    return (list.some(item => item.id === entry.id) ? list : [...list, entry])
      .sort((a, b) => a[field] - b[field] || a.date.localeCompare(b.date)).slice(0, 3);
  });
  try {
    storage().setItem(key, JSON.stringify(next));
    return '';
  } catch {
    return '成績を保存できません。この画面で再試行できます。';
  }
}
