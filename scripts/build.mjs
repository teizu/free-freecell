/** 静的ビルド。ソースの可読性を保ち、配布物だけを最小化して容量を検証する。 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { minify } from 'html-minifier-terser';
import { checkSize } from './size.mjs';

const digest = (content) => createHash('sha256').update(content).digest('hex');

/** 構文・空白と JS の内部識別子を縮め、公開名と日本語・文字列の意味を維持する。 */
function compact(content, extension, format) {
  if (!['.js', '.css'].includes(extension)) return content;
  return transformSync(content, {
    loader: extension.slice(1),
    format,
    minifySyntax: true,
    minifyWhitespace: true,
    // export 名やプロパティ名は保ち、配布 JS 内部の名前だけを短縮する。
    minifyIdentifiers: extension === '.js',
    charset: 'utf8',
    legalComments: 'none',
  }).code;
}

/** HTML は解析して縮め、語間の空白と空白自体に意味がある要素の内容を保つ。 */
function compactHTML(content) {
  return minify(content, {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    // 固定版の空白判定を拡張し、script/style の先頭・末尾の改行も残す。
    canTrimWhitespace: (tag) => !['pre', 'textarea', 'script', 'style'].includes(tag),
  });
}

/** アプリの最終変更日を日本時間で固定し、再ビルドや閲覧だけでは日付を進めない。 */
async function updateDate(source, files) {
  let epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch === undefined) {
    try {
      // 文書だけの変更を除き、コピーした src の検証でも同じ履歴を参照する。
      epoch = execFileSync('git', ['log', '-1', '--format=%ct', '--', 'src', 'scripts/build.mjs', 'package.json', 'package-lock.json'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined;
    } catch {
      // Git を含まないソース配布では、保存されたファイルの更新日時を用いる。
    }
  }
  if (epoch !== undefined && !/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH は UNIX 秒の非負整数で指定してください。');
  const milliseconds = epoch === undefined
    ? Math.max(...await Promise.all([...files].map(async (file) => (await stat(resolve(source, file))).mtimeMs)))
    : Number(epoch) * 1000;
  // 日本時間は通年 UTC+9。実行環境のタイムゾーンに依存させない。
  const date = new Date(milliseconds + 9 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) throw new Error('更新日を有効な日時に変換できません。');
  return date.toISOString().slice(0, 10);
}

/** 静的な相対参照だけを扱い、循環依存や解決不能な参照は明示的に拒否する。 */
export async function build(source, destination) {
  source = resolve(source);
  destination = resolve(destination);
  if (source === destination || source.startsWith(`${destination}/`) || destination.startsWith(`${source}/`)) {
    throw new Error('ソースと公開先は、互いに含まれない別のフォルダにしてください。');
  }
  const inputs = new Map();
  const outputs = new Map();
  const names = new Map();
  const processing = new Set();

  /** ソース配下のファイルを読み、ディレクトリの列挙順を固定する。 */
  async function collect(folder = '') {
    const entries = await readdir(resolve(source, folder), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = posix.join(folder, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) inputs.set(path, await readFile(resolve(source, path)));
      else throw new Error(`ソースに通常ファイル以外があります: ${path}`);
    }
  }

  /** 引用符付きの相対ファイル参照を、変換後のファイル名へ置き換える。 */
  function rewriteReferences(content, file) {
    return content.replace(/(['"])(\.\.?\/[^'"\s]+)\1/g, (match, quote, reference) => {
      const target = posix.normalize(posix.join(posix.dirname(file), reference));
      // sw.js とディレクトリ参照は固定 URL として使う。
      if (target === 'sw.js' || reference.endsWith('/')) return match;
      if (!inputs.has(target)) throw new Error(`参照先がありません: ${file} → ${reference}`);
      const output = compile(target);
      const relative = posix.relative(posix.dirname(file), output);
      return `${quote}${relative.startsWith('.') ? relative : `./${relative}`}${quote}`;
    });
  }

  /** 依存先を先に変換し、その URL を含んだ内容からファイル名を決める。 */
  function compile(file) {
    if (names.has(file)) return names.get(file);
    if (processing.has(file)) throw new Error(`循環する静的参照があります: ${file}`);
    processing.add(file);
    const extension = extname(file);
    let content = inputs.get(file);
    if (['.js', '.css', '.html'].includes(extension)) {
      const rewritten = rewriteReferences(content.toString('utf8')
        .replaceAll('__FREECELL_BUILD__', 'published').replaceAll('__FREECELL_DATE__', date), file);
      content = Buffer.from(compact(rewritten, extension));
    }
    const hashed = ['.js', '.css', '.woff2', '.txt'].includes(extension);
    const output = hashed ? posix.join(posix.dirname(file), `${basename(file, extension)}-${digest(content).slice(0, 12)}${extension}`) : file;
    names.set(file, output);
    outputs.set(output, content);
    processing.delete(file);
    return output;
  }

  await collect();
  if (!inputs.has('index.html') || !inputs.has('sw.js')) throw new Error('index.html と sw.js が必要です。');
  // 非同期の HTML 変換を先に済ませ、依存ファイル名の解決は単純な同期処理に保つ。
  for (const [file, content] of inputs) {
    if (extname(file) === '.html') inputs.set(file, Buffer.from(await compactHTML(content.toString('utf8'))));
  }
  const date = await updateDate(source, inputs.keys());
  for (const file of inputs.keys()) if (file !== 'sw.js') compile(file);
  const assets = [...outputs].sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => [name, digest(content)]);
  const template = inputs.get('sw.js').toString('utf8');
  if (!template.includes('__FREECELL_VERSION__') || !template.includes('/*__FREECELL_ASSETS__*/ []')) {
    throw new Error('Service Worker のビルド用プレースホルダーがありません。');
  }
  // マニフェストの埋め込み後に変換し、SW 自身の変換結果の違いも版へ反映する。
  // SW はイベント登録だけを公開する。内部を関数へ閉じ込め、最上位の名前も短縮できるようにする。
  const worker = compact(template.replace('/*__FREECELL_ASSETS__*/ []', JSON.stringify(assets)), '.js', 'iife');
  const version = digest(worker).slice(0, 16);
  outputs.set('sw.js', Buffer.from(worker.replace('__FREECELL_VERSION__', version)));
  await rm(destination, { recursive: true, force: true });
  for (const [file, content] of outputs) {
    const target = resolve(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const size = await checkSize(destination);
  return { size, version, files: [...outputs.keys()].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await build(process.argv[2] || 'src', process.argv[3] || 'dist');
    console.log(`Built ${result.files.length} files: ${result.size.toLocaleString('en-US')} / 50,000 bytes (${result.version})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
