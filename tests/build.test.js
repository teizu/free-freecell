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
  const original = { 'index.html': 'first', 'main-123456789abc.js': 'shared' };
  const shared = new Map([['another-app:v1', new Map()], ['freecell:/different/:old', new Map()]]);
  const old = workerHarness('v1', original, shared);
  await old.lifecycle('install');
  const fresh = workerHarness('v2', { ...original, 'index.html': 'second' }, shared);
  await fresh.lifecycle('install');
  assert.deepEqual(fresh.fetched, ['https://example.test/free-freecell/']);
  assert.ok(shared.has('freecell:/free-freecell/:v1'), 'old tabs retain their cache while new worker waits');
  assert.equal(await (await old.request('https://example.test/free-freecell/')).text(), 'first');
  assert.equal(await (await fresh.request('https://example.test/free-freecell/')).text(), 'second');
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
