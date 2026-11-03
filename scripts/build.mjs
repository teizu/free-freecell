/** 静的ビルド。ソースの可読性を保ち、配布物の空白・コメントを削減して容量を検証する。 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { checkSize } from './size.mjs';

const digest = (content) => createHash('sha256').update(content).digest('hex');

/** 正式な構文解析で空白・コメントだけを削減し、日本語や文字列内の改行を維持する。 */
function compact(content, extension) {
  if (!['.js', '.css'].includes(extension)) return content;
  return transformSync(content, {
    loader: extension.slice(1),
    minifyWhitespace: true,
    charset: 'utf8',
    legalComments: 'none',
  }).code;
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
      const rewritten = rewriteReferences(content.toString('utf8').replaceAll('__FREECELL_BUILD__', 'published'), file);
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
  for (const file of inputs.keys()) if (file !== 'sw.js') compile(file);
  const assets = [...outputs].sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => [name, digest(content)]);
  const template = inputs.get('sw.js').toString('utf8');
  if (!template.includes('__FREECELL_VERSION__') || !template.includes('/*__FREECELL_ASSETS__*/ []')) {
    throw new Error('Service Worker のビルド用プレースホルダーがありません。');
  }
  // マニフェストの埋め込み後に変換し、SW 自身の変換結果の違いも版へ反映する。
  const worker = compact(template.replace('/*__FREECELL_ASSETS__*/ []', JSON.stringify(assets)), '.js');
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
