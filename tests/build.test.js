/** 配布サイズ、依存を含む URL 更新、キャッシュ更新と失敗時の挙動を検証する。 */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { build } from '../scripts/build.mjs';
import { checkSize, measureSize } from '../scripts/size.mjs';

const swTemplate = await readFile(new URL('../src/sw.js', import.meta.url), 'utf8');
const hash = (content) => createHash('sha256').update(content).digest('hex');

/** 一時作業場所を作り、成功・失敗のどちらでも後片付けを登録する。 */
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'freecell-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** ブラウザーで配信する最小構成を用意し、依存更新を独立して確認する。 */
async function fixture(t) {
  const root = await workspace(t);
  const source = join(root, 'src');
  const output = join(root, 'dist');
  await mkdir(join(source, 'lib'), { recursive: true });
  await writeFile(join(source, 'index.html'), '<html lang="ja"><link href="./styles.css"><script type="module" src="./main.js"></script></html>');
  await writeFile(join(source, 'styles.css'), 'body { color: green; }');
  await writeFile(join(source, 'main.js'), 'import { value } from "./lib/value.js"; console.log(value);');
  await writeFile(join(source, 'lib/value.js'), 'export const value = "日本語";');
  await writeFile(join(source, 'sw.js'), swTemplate);
  return { source, output };
}

test('size budget counts bytes, nested and hidden files; exactly 50,000 is allowed', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', '日本語.txt'), 'あ');
  await writeFile(join(root, '.extra'), Buffer.alloc(49_997));
  assert.equal(await measureSize(root), 50_000);
  assert.equal(await checkSize(root), 50_000);
  await writeFile(join(root, 'one-byte'), 'x');
  await assert.rejects(checkSize(root), /50,001/);
});

test('size rejects symlinks so files cannot escape the measured publication', async (t) => {
  const root = await workspace(t);
  await symlink('/tmp', join(root, 'external'));
  await assert.rejects(checkSize(root), /通常ファイル以外/);
});

test('build hashes imported dependencies, preserves relative URLs and keeps unchanged CSS stable', async (t) => {
  const { source, output } = await fixture(t);
  const first = await build(source, output);
  const html = await readFile(join(output, 'index.html'), 'utf8');
  const firstMain = first.files.find((name) => name.startsWith('main-'));
  const firstCSS = first.files.find((name) => name.startsWith('styles-'));
  assert.match(html, /src="\.\/main-[a-f0-9]{12}\.js"/);
  assert.match(await readFile(join(output, firstMain), 'utf8'), /\.\/lib\/value-[a-f0-9]{12}\.js/);
  assert.doesNotMatch(await readFile(join(output, 'sw.js'), 'utf8'), /__FREECELL_/);
  assert.equal(first.size, await measureSize(output));
  const repeat = await build(source, output);
  assert.deepEqual(repeat, first);

  await writeFile(join(source, 'lib/value.js'), 'export const value = "更新";');
  const second = await build(source, output);
  assert.notEqual(second.version, first.version);
  assert.notEqual(second.files.find((name) => name.startsWith('main-')), firstMain);
  assert.equal(second.files.find((name) => name.startsWith('styles-')), firstCSS);
  assert.ok(!(await readdir(output)).includes(firstMain), 'old generated files are removed');
});

test('フォントのバイナリと外部ライセンスリンクを保ち、変更を CSS・HTML・SW の版へ伝える', async (t) => {
  const { source, output } = await fixture(t);
  // UTF-8 として読めない値も含め、フォントを文字列へ変換せずコピーすることを確認する。
  const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0x80, 0xc3]);
  const licenseURL = 'https://openfontlicense.org/open-font-license-official-text/';
  await mkdir(join(source, 'fonts'));
  await writeFile(join(source, 'fonts/suits.woff2'), font);
  await writeFile(join(source, 'styles.css'), '@font-face { font-family: "Suit Test"; src: url("./fonts/suits.woff2") format("woff2"); }');
  await writeFile(join(source, 'index.html'), `<link href="./styles.css"><a href="${licenseURL}">ライセンス</a><script type="module" src="./main.js"></script>`);
  const first = await build(source, output);
  const fontName = `fonts/suits-${hash(font).slice(0, 12)}.woff2`;
  const firstCSS = first.files.find(name => name.startsWith('styles-'));
  const firstMain = first.files.find(name => name.startsWith('main-'));
  assert.deepEqual(await readFile(join(output, fontName)), font);
  assert.ok((await readFile(join(output, firstCSS), 'utf8')).includes(`./${fontName}`));
  assert.ok((await readFile(join(output, 'index.html'), 'utf8')).includes(`href="${licenseURL}"`));
  const worker = await readFile(join(output, 'sw.js'), 'utf8');
  assert.ok(worker.includes(fontName) && worker.includes(hash(font)));
  assert.ok(!worker.includes(licenseURL), 'External license pages must not be fetched or cached by the application');
  assert.equal(first.size, await measureSize(output));

  const changedFont = Buffer.concat([font, Buffer.from([0xfe])]);
  await writeFile(join(source, 'fonts/suits.woff2'), changedFont);
  const second = await build(source, output);
  const secondFont = second.files.find(name => name.endsWith('.woff2'));
  const secondCSS = second.files.find(name => name.startsWith('styles-'));
  assert.notEqual(secondFont, fontName);
  assert.notEqual(secondCSS, firstCSS);
  assert.notEqual(second.version, first.version);
  assert.deepEqual(await readFile(join(output, secondFont)), changedFont);
  assert.ok((await readFile(join(output, secondCSS), 'utf8')).includes(`./${secondFont}`));
  assert.ok((await readFile(join(output, 'index.html'), 'utf8')).includes(`./${secondCSS}`));
  assert.equal(second.files.find(name => name.startsWith('main-')), firstMain);
  assert.ok((await readFile(join(output, 'index.html'), 'utf8')).includes(`href="${licenseURL}"`));
  assert.ok(!(await readdir(join(output, 'fonts'))).includes(fontName.split('/').at(-1)));
});

test('build compacts generated code while preserving Japanese, literals and newline semantics', async (t) => {
  const { source, output } = await fixture(t);
  const original = [
    '/** ソースに残す説明コメント。 */',
    'export const value = `日本語',
    '  ${"字間"} と /* 文字列 */',
    '末尾`;',
    'export const pattern = /\\/\\*日本語\\*\\//u;',
    'export const url = "https://example.test/日本語";',
    'export function afterReturn() {',
    '  return',
    '  { text: "この改行は変えない" };',
    '}',
  ].join('\n');
  await writeFile(join(source, 'lib/value.js'), original);
  await writeFile(join(source, 'styles.css'), '/* 配布前の説明 */ body::before { content: "日本語  /* 文字 */"; width: calc(100% - 2rem); }');
  const result = await build(source, output);
  const generatedName = result.files.find(name => name.startsWith('lib/value-'));
  const generated = await readFile(join(output, generatedName), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(generated).toString('base64')}`);
  assert.equal(module.value, '日本語\n  字間 と /* 文字列 */\n末尾');
  assert.equal(module.pattern.test('/*日本語*/'), true);
  assert.equal(module.url, 'https://example.test/日本語');
  assert.equal(module.afterReturn(), undefined, 'a newline after return remains significant');
  assert.match(generated, /日本語/);
  assert.doesNotMatch(generated, /ソースに残す説明/);
  assert.ok(Buffer.byteLength(generated) < Buffer.byteLength(original));
  assert.ok(generatedName.includes(hash(generated).slice(0, 12)), 'filenames hash the emitted bytes');
  assert.equal(await readFile(join(source, 'lib/value.js'), 'utf8'), original);
  const css = await readFile(join(output, result.files.find(name => name.startsWith('styles-'))), 'utf8');
  assert.match(css, /日本語  \/\* 文字 \*\//);
  assert.match(css, /calc\(100% - 2rem\)/);
  assert.doesNotMatch(css, /配布前の説明/);
});

test('build rejects invalid syntax before replacing the last complete output', async (t) => {
  const { source, output } = await fixture(t);
  const first = await build(source, output);
  const previous = await readFile(join(output, 'sw.js'), 'utf8');
  await writeFile(join(source, 'lib/value.js'), 'export const value = ;');
  await assert.rejects(build(source, output), /Unexpected/);
  assert.equal(await readFile(join(output, 'sw.js'), 'utf8'), previous);
  assert.deepEqual((await readdir(output)).sort(), [...new Set(first.files.map(name => name.split('/')[0]))].sort());
});

test('build rejects circular dependencies, missing references and oversized output', async (t) => {
  const { source, output } = await fixture(t);
  await writeFile(join(source, 'lib/value.js'), 'import "../main.js";');
  await assert.rejects(build(source, output), /循環/);
  await writeFile(join(source, 'lib/value.js'), 'import "./missing.js";');
  await assert.rejects(build(source, output), /参照先がありません/);
  await writeFile(join(source, 'lib/value.js'), 'export const value = 1;');
  await writeFile(join(source, 'large.dat'), Buffer.alloc(50_001));
  await assert.rejects(build(source, output), /容量上限/);
  await assert.rejects(build(source, source), /別のフォルダ/);
});

/** CacheStorage とイベントを模した最小環境で、SW の版切り替えを実行する。 */
function workerHarness(version, files, shared = new Map(), server = new Map(Object.entries(files)), httpCache = new Map()) {
  const base = 'https://example.test/free-freecell/';
  const listeners = new Map();
  const fetched = [];
  const caches = {
    keys: async () => [...shared.keys()],
    delete: async (name) => shared.delete(name),
    open: async (name) => {
      if (!shared.has(name)) shared.set(name, new Map());
      const entries = shared.get(name);
      return {
        match: async (key) => entries.get(typeof key === 'string' ? key : key.url)?.clone(),
        put: async (key, value) => entries.set(typeof key === 'string' ? key : key.url, value.clone()),
      };
    },
  };
  const context = vm.createContext({
    URL, Request, Response, Uint8Array, crypto: webcrypto, caches,
    self: { location: { href: `${base}sw.js` }, addEventListener: (name, handler) => listeners.set(name, handler) },
    fetch: async (request) => {
      const url = typeof request === 'string' ? request : request.url;
      if (request.cache === 'only-if-cached') {
        return httpCache.has(url) ? new Response(httpCache.get(url)) : new Response('', { status: 504 });
      }
      fetched.push(url);
      const body = server.get(url.replace(base, '') || 'index.html');
      if (body === undefined) throw new Error('offline');
      return new Response(body);
    },
  });
  const manifest = Object.entries(files).map(([name, body]) => [name, hash(body)]);
  vm.runInContext(swTemplate.replace('__FREECELL_VERSION__', version).replace('/*__FREECELL_ASSETS__*/ []', JSON.stringify(manifest)), context);
  return {
    shared, server, fetched,
    /** ブラウザーがイベント完了まで保持する Promise を取得する。 */
    lifecycle(type) {
      let result;
      listeners.get(type)({ waitUntil: (promise) => { result = promise; } });
      return result;
    },
    /** SW が処理しない URL は undefined のまま返す。 */
    request(url, method = 'GET') {
      let result;
      listeners.get('fetch')({ request: new Request(url, { method }), respondWith: (promise) => { result = promise; } });
      return result;
    },
  };
}

test('SW caches a complete subpath app and serves both entry URLs offline without network', async () => {
  const worker = workerHarness('v1', { 'index.html': '日本語のゲーム', 'main-123456789abc.js': 'game' });
  await worker.lifecycle('install');
  await worker.lifecycle('activate');
  worker.server.clear();
  worker.fetched.length = 0;
  for (const path of ['', '?from=bookmark', 'index.html', 'main-123456789abc.js']) {
    const response = await worker.request(`https://example.test/free-freecell/${path}`);
    assert.ok(response.ok);
  }
  assert.equal(worker.fetched.length, 0);
  assert.equal(worker.request('https://example.test/other/index.html'), undefined);
  assert.equal(worker.request('https://elsewhere.test/free-freecell/'), undefined);
  assert.equal(worker.request('https://example.test/free-freecell/sw.js'), undefined);
  assert.equal(worker.request('https://example.test/free-freecell/', 'POST'), undefined);
});

test('SW reuses either initial HTML URL from HTTP cache without another HTML download', async () => {
  for (const entry of ['', 'index.html']) {
    const worker = workerHarness('v1', { 'index.html': '日本語のゲーム' }, new Map(), new Map(),
      new Map([[`https://example.test/free-freecell/${entry}`, '日本語のゲーム']]));
    await worker.lifecycle('install');
    assert.equal(worker.fetched.length, 0);
    assert.equal(await (await worker.request('https://example.test/free-freecell/')).text(), '日本語のゲーム');
  }
});

test('SW reuses unchanged assets and only deletes this app old caches at activation', async () => {
  const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0xff, 0x00, 0x80]);
  const original = {
    'index.html': 'first', 'main-123456789abc.js': 'shared',
    'fonts/suits-123456789abc.woff2': font,
  };
  const shared = new Map([['another-app:v1', new Map()], ['freecell:/different/:old', new Map()]]);
  const old = workerHarness('v1', original, shared);
  await old.lifecycle('install');
  const fresh = workerHarness('v2', { ...original, 'index.html': 'second' }, shared);
  await fresh.lifecycle('install');
  assert.deepEqual(fresh.fetched, ['https://example.test/free-freecell/']);
  assert.ok(shared.has('freecell:/free-freecell/:v1'), 'old tabs retain their cache while new worker waits');
  assert.equal(await (await old.request('https://example.test/free-freecell/')).text(), 'first');
  assert.equal(await (await fresh.request('https://example.test/free-freecell/')).text(), 'second');
  fresh.server.clear();
  assert.deepEqual(Buffer.from(await (await fresh.request('https://example.test/free-freecell/fonts/suits-123456789abc.woff2')).arrayBuffer()), font);
  await fresh.lifecycle('activate');
  assert.equal(shared.has('freecell:/free-freecell/:v1'), false);
  assert.ok(shared.has('another-app:v1'));
  assert.ok(shared.has('freecell:/different/:old'));
});

test('SW rejects incomplete or mixed releases while keeping the active release usable', async () => {
  const old = workerHarness('old', { 'index.html': 'old' });
  await old.lifecycle('install');
  const next = workerHarness('new', { 'index.html': 'new', 'main-123456789abc.js': 'script' }, old.shared, new Map([['index.html', 'stale']]));
  await assert.rejects(next.lifecycle('install'), /版が揃っていません/);
  assert.equal(next.shared.has('freecell:/free-freecell/:new'), false);
  assert.equal(await (await old.request('https://example.test/free-freecell/')).text(), 'old');
  const offline = workerHarness('offline', { 'index.html': 'new' }, old.shared, new Map());
  await assert.rejects(offline.lifecycle('install'), /offline/);
  assert.equal(offline.shared.has('freecell:/free-freecell/:offline'), false);
});
