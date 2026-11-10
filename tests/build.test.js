/** 配布サイズ、依存を含む URL 更新、キャッシュ更新と失敗時の挙動を検証する。 */
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { build } from '../scripts/build.mjs';
import { checkSize, measureSize } from '../scripts/size.mjs';

const swTemplate = await readFile(new URL('../src/sw.js', import.meta.url), 'utf8');
const hash = (content, encoding = 'hex') => createHash('sha256').update(content).digest(encoding);

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

/** 日付や Git の有無を切り替え、テスト終了時に元の環境へ戻す。 */
function environment(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
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
  assert.match(html, /src=\.\/main-[a-f0-9]{12}\.js/);
  assert.match(await readFile(join(output, firstMain), 'utf8'), /日本語/);
  assert.equal(first.files.filter(name => name.endsWith('.js') && name !== 'sw.js').length, 1,
    'Imported modules are included in the entry instead of fetched as separate assets');
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

test('各 HTML の script を入口にまとめ、公開用置換と外部依存の拒否を最適化より先に行う', async (t) => {
  const { source, output } = await fixture(t);
  await mkdir(join(source, 'screens'));
  await writeFile(join(source, 'index.html'), '<script type="module" src="./screens/play.js"></script><script type="module" src="./watch.js"></script>');
  const original = 'export const value = "__FREECELL_BUILD__" === "published" ? "公開でオフライン準備" : "ソースは登録しない";';
  await writeFile(join(source, 'lib/value.js'), original);
  await writeFile(join(source, 'screens/play.js'), 'export { value } from "../lib/value.js";');
  await writeFile(join(source, 'watch.js'), 'export { value } from "./lib/value.js";');
  await writeFile(join(source, 'unused.js'), '未使用の開発モジュールは構文検査や配布の対象にしない');
  const result = await build(source, output);
  const scripts = result.files.filter(name => name.endsWith('.js') && name !== 'sw.js');
  assert.equal(scripts.length, 2);
  assert.ok(scripts.some(name => name.startsWith('screens/play-')));
  for (const file of scripts) {
    const generated = await readFile(join(output, file));
    const module = await import(`data:text/javascript;base64,${generated.toString('base64')}`);
    assert.equal(module.value, '公開でオフライン準備');
  }
  assert.equal(await readFile(join(source, 'lib/value.js'), 'utf8'), original, '開発用ソースの公開判定を書き換えない');
  const previous = await readFile(join(output, 'sw.js'));
  await writeFile(join(source, 'lib/value.js'), 'export { value } from "https://example.test/library.js";');
  await assert.rejects(build(source, output), /参照先がありません/);
  assert.deepEqual(await readFile(join(output, 'sw.js')), previous);
});

test('bundle 後も SW のサブパスと JSON の保存キーを保つ', async (t) => {
  const { source, output } = await fixture(t);
  await writeFile(join(source, 'offline.js'), `export function workerURL() {
    return '__FREECELL_BUILD__' === 'published' ? new URL('./sw.js', import.meta.url).href : null;
  }`);
  const saved = { version: 1, history: [{ tableau: [1], cells: [], foundations: [] }], cursor: 0, elapsedMs: 1250, started: true };
  await writeFile(join(source, 'main.js'), `import { workerURL } from './offline.js';
    export const worker = workerURL(); export const saved = JSON.stringify(${JSON.stringify(saved)});`);
  const result = await build(source, output);
  const file = result.files.find(name => name.startsWith('main-'));
  const bundled = await readFile(join(output, file), 'utf8');
  assert.match(bundled, /import\.meta\.url/);
  // 実ブラウザーの module URL を模し、data URL 上でも基準 URL の保持を確認する。
  const executable = bundled.replaceAll('import.meta.url', JSON.stringify(`https://example.test/free-freecell/${file}`));
  const module = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
  assert.equal(module.worker, 'https://example.test/free-freecell/sw.js');
  assert.deepEqual(JSON.parse(module.saved), saved, '識別子短縮は永続化されるプロパティ名を変えない');
});

test('更新日は指定した UNIX 秒を日本時間で表示し、同じ入力の再ビルドでは変わらない', async (t) => {
  const { source, output } = await fixture(t);
  environment(t, { SOURCE_DATE_EPOCH: String(Date.parse('2026-11-02T15:00:00Z') / 1000), TZ: 'UTC' });
  await writeFile(join(source, 'index.html'), '<p>ver-__FREECELL_DATE__</p>');
  const first = await build(source, output);
  assert.equal(await readFile(join(output, 'index.html'), 'utf8'), '<p>ver-2026-11-03</p>');
  assert.deepEqual(await build(source, output), first);

  process.env.SOURCE_DATE_EPOCH = String(Date.parse('2026-11-02T14:59:59Z') / 1000);
  const previous = await build(source, output);
  assert.equal(await readFile(join(output, 'index.html'), 'utf8'), '<p>ver-2026-11-02</p>');
  assert.notEqual(previous.version, first.version, '日付の変更もキャッシュの版へ反映する');
  assert.deepEqual(previous.files, first.files, '日付以外のアセット名は変えない');
});

test('Git がないソース配布ではファイルの最終更新日を使い、不正な指定日時では公開物を残す', async (t) => {
  const { source, output } = await fixture(t);
  environment(t, { SOURCE_DATE_EPOCH: undefined, PATH: '' });
  await writeFile(join(source, 'index.html'), '<p>ver-__FREECELL_DATE__</p>');
  for (const file of ['index.html', 'styles.css', 'main.js', 'lib/value.js', 'sw.js']) {
    const time = new Date(file === 'main.js' ? '2026-01-02T15:00:00Z' : '2026-01-01T00:00:00Z');
    await utimes(join(source, file), time, time);
  }
  const result = await build(source, output);
  assert.equal(await readFile(join(output, 'index.html'), 'utf8'), '<p>ver-2026-01-03</p>');
  assert.deepEqual(await build(source, output), result);
  const worker = await readFile(join(output, 'sw.js'), 'utf8');
  for (const invalid of ['', '-1', '日本語', '1.5', '9'.repeat(30)]) {
    process.env.SOURCE_DATE_EPOCH = invalid;
    await assert.rejects(build(source, output), /SOURCE_DATE_EPOCH|更新日/);
    assert.equal(await readFile(join(output, 'sw.js'), 'utf8'), worker);
  }
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
  assert.ok((await readFile(join(output, 'index.html'), 'utf8')).includes(`href=${licenseURL}`));
  const worker = await readFile(join(output, 'sw.js'), 'utf8');
  assert.ok(worker.includes(fontName) && worker.includes(hash(font, 'base64')));
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
  assert.ok((await readFile(join(output, 'index.html'), 'utf8')).includes(`href=${licenseURL}`));
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
    'export function conditional(value) {',
    '  const visits = [];',
    '  if (value) visits.push("真"); else visits.push("偽");',
    '  value && visits.push("短絡評価");',
    '  return { visits, zero: Object.is(value, -0), finite: Number.isFinite(value) };',
    '}',
  ].join('\n');
  await writeFile(join(source, 'lib/value.js'), original);
  await writeFile(join(source, 'main.js'), 'export * from \"./lib/value.js\";');
  await writeFile(join(source, 'styles.css'), '/* 配布前の説明 */ body::before { content: "日本語  /* 文字 */"; width: calc(100% - 2rem); }');
  const result = await build(source, output);
  const generatedName = result.files.find(name => name.startsWith('main-'));
  const generated = await readFile(join(output, generatedName), 'utf8');
  const module = await import(`data:text/javascript;base64,${Buffer.from(generated).toString('base64')}`);
  const sourceModule = await import(`data:text/javascript;base64,${Buffer.from(original).toString('base64')}`);
  for (const value of [undefined, null, 0, -0, false, true, '', NaN, '日本語']) {
    assert.deepEqual(module.conditional(value), sourceModule.conditional(value), '構文短縮でも分岐と副作用を保つ');
  }
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

test('HTML 圧縮は日本語・語間・属性と pre/textarea/script/style の内容を保つ', async (t) => {
  const { source, output } = await fixture(t);
  const preserved = [
    '<p title="日本語  の説明">前 <span>日本語</span> <em>English words</em> 次&nbsp;の字</p>',
    '<pre>\n  日本語  <span> 字間 </span>\n    次の行\n</pre>',
    '<textarea>\n  日本語  &lt;入力&gt;\n    次の行\n</textarea>',
    '<script>\n  const template = `日本語\n    そのまま`; // 改行も保つ\n</script>',
    '<style>\n  .message::before { content: "日本語  の字間"; }\n</style>',
  ];
  const original = [
    '<!doctype html>',
    '<html lang="ja">',
    '  <!-- 開発用の説明コメント -->',
    '  <head><meta charset="utf-8"><link href="./styles.css"></head>',
    '  <body>',
    ...preserved.map((element) => `    ${element}`),
    '    <button id="action" disabled aria-label="日本語 の操作"> 操作 </button>',
    '    <script type="module" src="./main.js"></script>',
    '  </body>',
    '</html>',
  ].join('\n');
  await writeFile(join(source, 'index.html'), original);
  const result = await build(source, output);
  const generated = await readFile(join(output, 'index.html'), 'utf8');
  for (const element of preserved) assert.ok(generated.includes(element), element);
  assert.match(generated, /<button id=action disabled(?:=disabled)? aria-label="日本語 の操作"> 操作 <\/button>/);
  assert.match(generated, /src=\.\/main-[a-f0-9]{12}\.js/);
  assert.doesNotMatch(generated, /開発用の説明コメント/);
  assert.ok(Buffer.byteLength(generated) < Buffer.byteLength(original));
  assert.equal(await readFile(join(source, 'index.html'), 'utf8'), original, '開発用 HTML は書き換えない');
  assert.ok((await readFile(join(output, 'sw.js'), 'utf8')).includes(hash(generated, 'base64')), '圧縮後の HTML をキャッシュの版へ反映する');
  assert.deepEqual(await build(source, output), result, '同じ HTML の再ビルド結果は変えない');
});

test('HTML の解析に失敗した場合も、直前の配布物を保持する', async (t) => {
  const { source, output } = await fixture(t);
  const result = await build(source, output);
  const previous = await readFile(join(output, 'sw.js'), 'utf8');
  await writeFile(join(source, 'index.html'), '<html><body><div title="閉じない属性');
  await assert.rejects(build(source, output), /Parse Error/);
  assert.equal(await readFile(join(output, 'sw.js'), 'utf8'), previous);
  assert.equal(await measureSize(output), result.size);
});

test('build bundles circular ESM once and rejects missing references and oversized output', async (t) => {
  const { source, output } = await fixture(t);
  await writeFile(join(source, 'main.js'), 'import { value } from "./lib/value.js"; globalThis.visits = (globalThis.visits || 0) + 1; globalThis.result = value;');
  await writeFile(join(source, 'lib/value.js'), 'import "../main.js"; export const value = "循環";');
  const cycle = await build(source, output);
  const context = vm.createContext({});
  vm.runInContext(await readFile(join(output, cycle.files.find(name => name.startsWith('main-'))), 'utf8'), context);
  assert.equal(context.visits, 1);
  assert.equal(context.result, '循環');
  await writeFile(join(source, 'lib/value.js'), 'import "./missing.js";');
  await assert.rejects(build(source, output), /参照先がありません/);
  await writeFile(join(source, 'lib/value.js'), 'export const value = 1;');
  await writeFile(join(source, 'large.dat'), Buffer.alloc(50_001));
  await assert.rejects(build(source, output), /容量上限/);
  await assert.rejects(build(source, source), /別のフォルダ/);
});

/** ソースの SW へ版と資産を埋め込み、未ビルドの境界条件を独立して検証する。 */
function workerHarness(version, files, shared = new Map(), server = new Map(Object.entries(files)), httpCache = new Map()) {
  const manifest = Object.entries(files).map(([name, body]) => [name, hash(body, 'base64')]);
  const script = swTemplate.replace('__FREECELL_VERSION__', version)
    .replace('/*__FREECELL_ASSETS__*/ []', JSON.stringify(manifest));
  return runWorker(script, files, shared, server, httpCache);
}

/** 同じ模擬環境でソース・配布済み双方の classic SW を実行し、登録したイベントを操作する。 */
function runWorker(script, files, shared = new Map(), server = new Map(Object.entries(files)), httpCache = new Map()) {
  const base = 'https://example.test/free-freecell/';
  const listeners = new Map();
  const fetched = [];
  const clients = [];
  let skipped = 0;
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
    URL, Request, Response, Uint8Array, btoa, crypto: webcrypto, caches,
    self: {
      location: { href: `${base}sw.js` }, addEventListener: (name, handler) => listeners.set(name, handler),
      clients: { matchAll: async () => clients }, skipWaiting: async () => { skipped += 1; },
    },
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
  vm.runInContext(script, context);
  return {
    shared, server, fetched, clients,
    get skipped() { return skipped; },
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
    /** 明示された更新要求だけを送り、待機解除の副作用を確かめる。 */
    message(data) {
      let result;
      listeners.get('message')({ data, waitUntil: (promise) => { result = promise; } });
      return result;
    },
  };
}

test('ビルド済み SW も明示更新・有効化・全資産のオフライン応答を保つ', async (t) => {
  const { source, output } = await fixture(t);
  const result = await build(source, output);
  const files = Object.fromEntries(await Promise.all(result.files.filter(name => name !== 'sw.js')
    .map(async name => [name, await readFile(join(output, name))])));
  const worker = runWorker(await readFile(join(output, 'sw.js'), 'utf8'), files);

  await worker.lifecycle('install');
  assert.equal(worker.skipped, 0, '圧縮済みのイベントも自動で待機解除しない');
  await worker.message({ type: 'SKIP_WAITING' });
  assert.equal(worker.skipped, 0);
  await worker.message({ type: 'APPLY_UPDATE' });
  assert.equal(worker.skipped, 1);
  await worker.lifecycle('activate');
  assert.ok(worker.shared.has(`freecell:/free-freecell/:${result.version}`));

  worker.server.clear();
  worker.fetched.length = 0;
  for (const [name, body] of Object.entries(files)) {
    const response = await worker.request(`https://example.test/free-freecell/${name}`);
    assert.ok(response.ok, name);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body, name);
  }
  const entry = await worker.request('https://example.test/free-freecell/');
  assert.deepEqual(Buffer.from(await entry.arrayBuffer()), files['index.html']);
  assert.equal(worker.fetched.length, 0, '配布した JS・CSS・日本語を再取得せず復元する');
});

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

test('SW は利用者の更新要求だけで待機を解除し、自動インストールでは切り替えない', async () => {
  const worker = workerHarness('v1', { 'index.html': 'new' });
  await worker.lifecycle('install');
  assert.equal(worker.skipped, 0);
  for (const data of [null, {}, 'APPLY_UPDATE', { type: 'SKIP_WAITING' }]) await worker.message(data);
  assert.equal(worker.skipped, 0);
  await worker.message({ type: 'APPLY_UPDATE' });
  assert.equal(worker.skipped, 1);
});

test('SW のクリック更新は旧タブの資産を保持し、別アプリのキャッシュを利用しない', async () => {
  const base = 'https://example.test/free-freecell/';
  const legacy = 'main-123456789abc.js';
  const fontName = 'fonts/cards-123456789abc.woff2';
  const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0xff, 0x80]);
  const foreign = new Map([[`${base}${legacy}`, new Response('別アプリの値')]]);
  const shared = new Map([['another-app:v1', foreign]]);
  const old = workerHarness('v1', { 'index.html': 'old', [legacy]: '旧版の資産', [fontName]: font }, shared);
  await old.lifecycle('install');
  const fresh = workerHarness('v2', { 'index.html': 'new', 'main-abcdef123456.js': 'new script' }, shared);
  await fresh.lifecycle('install');
  fresh.clients.push({ id: 'tab-old' });
  await fresh.message({ type: 'APPLY_UPDATE' });
  await fresh.lifecycle('activate');
  assert.ok(shared.has('freecell:/free-freecell/:v1'));
  fresh.server.clear();
  fresh.fetched.length = 0;
  assert.equal(await (await fresh.request(base)).text(), 'new', 'Navigation must use the complete new release');
  assert.equal(await (await fresh.request(`${base}${legacy}`)).text(), '旧版の資産');
  assert.deepEqual(Buffer.from(await (await fresh.request(`${base}${fontName}`)).arrayBuffer()), font);
  assert.equal(fresh.fetched.length, 0);
  assert.equal(fresh.request('https://example.test/free-freecell-other/main-123456789abc.js'), undefined);
  assert.equal(fresh.request('https://elsewhere.test/free-freecell/main-123456789abc.js'), undefined);
  assert.equal(fresh.request(`${base}legacy.js`), undefined);
  assert.equal(fresh.request(`${base}${legacy}`, 'POST'), undefined);

  // 自アプリにない資産は別アプリのキャッシュへ流れず、通常の通信へ戻す。
  const missing = 'styles-111111111111.css';
  foreign.set(`${base}${missing}`, new Response('foreign CSS'));
  fresh.server.set(missing, 'network CSS');
  assert.equal(await (await fresh.request(`${base}${missing}`)).text(), 'network CSS');
  assert.deepEqual(fresh.fetched, [`${base}${missing}`]);
  assert.ok(shared.has('another-app:v1'));
});
