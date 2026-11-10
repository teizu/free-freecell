/** 静的ビルド。ソースの可読性を保ち、配布物だけを最小化して容量を検証する。 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle, transformSync } from 'esbuild';
import { minify } from 'html-minifier-terser';
import { checkSize } from './size.mjs';

const digest = (content, encoding = 'hex') => createHash('sha256').update(content).digest(encoding);

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
    // 空白などを含まない属性だけ引用符を省き、日本語の文言とタグ構造は保つ。
    removeAttributeQuotes: true,
    collapseBooleanAttributes: true,
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

/** HTML の JS 入口ごとに依存をまとめ、CSS・フォントは独立した更新単位に保つ。 */
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

  /** 配布用の置換を最適化より先に行い、オフライン処理を誤って未使用扱いにしない。 */
  function published(content) {
    return content.toString('utf8').replaceAll('__FREECELL_BUILD__', 'published').replaceAll('__FREECELL_DATE__', date);
  }

  /** 各 script の依存をメモリー上のソースから解決し、外部取得や範囲外の読込を拒否する。 */
  async function bundleScript(entry) {
    const result = await bundle({
      entryPoints: [entry], bundle: true, write: false, format: 'esm',
      minify: true, charset: 'utf8', legalComments: 'none', logLevel: 'silent',
      plugins: [{
        name: 'local-source',
        /** ファイル名を入力一覧のキーに限定し、Node の探索やネットワークへ渡さない。 */
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path, importer, kind }) => {
            const file = kind === 'entry-point' ? path : posix.normalize(posix.join(posix.dirname(importer), path));
            if ((kind !== 'entry-point' && !path.startsWith('.')) || !inputs.has(file) || extname(file) !== '.js' || file === 'sw.js') {
              throw new Error(`参照先がありません: ${importer || entry} → ${path}`);
            }
            return { path: file, namespace: 'local-source' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'local-source' }, ({ path }) => ({ contents: published(inputs.get(path)), loader: 'js' }));
        },
      }],
    });
    return Buffer.from(result.outputFiles[0].contents);
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
      const rewritten = rewriteReferences(published(content), file);
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
  const date = await updateDate(source, inputs.keys());
  // 開発用モジュールをすべて配布せず、HTML から参照される JS だけを入口にする。
  // 先に全入口を解決し終えるので、入口どうしで import しても元ソースから組み立てる。
  const scripts = new Set();
  for (const [file, content] of inputs) {
    if (extname(file) !== '.html') continue;
    for (const [, reference] of content.toString('utf8').matchAll(/['"](\.\.?\/[^'"\s]+\.js)['"]/g)) {
      const target = posix.normalize(posix.join(posix.dirname(file), reference));
      if (target !== 'sw.js') scripts.add(target);
    }
  }
  const bundled = await Promise.all([...scripts].map(async file => [file, await bundleScript(file)]));
  for (const [file, content] of bundled) inputs.set(file, content);
  for (const file of inputs.keys()) if (extname(file) !== '.js' || scripts.has(file)) compile(file);
  // 参照をハッシュ付き URL に置換してから属性の引用符を省き、最後に HTML の内容を確定する。
  for (const [file, content] of outputs) {
    if (extname(file) === '.html') outputs.set(file, Buffer.from(await compactHTML(content.toString('utf8'))));
  }
  // 整合性検証は SHA-256 の全ビットを保ち、マニフェスト内の表現だけ Base64 に縮める。
  const assets = [...outputs].sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => [name, digest(content, 'base64')]);
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
