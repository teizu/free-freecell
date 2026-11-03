/** 公開ファイルの圧縮前サイズを集計し、50KB の上限を守る。 */
import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIZE_LIMIT = 50_000;

/** 隠しファイルも含めて再帰的に集計する。リンクは配布対象として認めない。 */
export async function measureSize(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) total += await measureSize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
    else throw new Error(`公開対象に通常ファイル以外があります: ${path}`);
  }
  return total;
}

/** 上限ちょうどを許可し、1 バイトでも超過した公開物は失敗にする。 */
export async function checkSize(directory) {
  const size = await measureSize(directory);
  if (size > SIZE_LIMIT) {
    throw new Error(`公開物が容量上限を超えています: ${size.toLocaleString('en-US')} / ${SIZE_LIMIT} bytes`);
  }
  return size;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const size = await checkSize(resolve(process.argv[2] || 'dist'));
    console.log(`Public files: ${size.toLocaleString('en-US')} / ${SIZE_LIMIT.toLocaleString('en-US')} bytes`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
