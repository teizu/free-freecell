/** アプリの一式を検証して保存し、同じ版だけでオフライン起動する。 */
const VERSION = '__FREECELL_VERSION__';
const ASSETS = /*__FREECELL_ASSETS__*/ [];
const BASE = new URL('./', self.location.href);
const PREFIX = `freecell:${BASE.pathname}:`;
const CACHE = `${PREFIX}${VERSION}`;
const URLS = new Map(ASSETS.map(([path, hash]) => [new URL(path, BASE).href, hash]));

/** CDN の更新途中や壊れた保存内容を、新版のキャッシュへ混入させない。 */
async function verify(response, expected) {
  if (!response.ok) throw new Error('アプリの取得に失敗しました。');
  const buffer = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  const hash = Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== expected) throw new Error('アプリの版が揃っていません。');
  return response;
}

/** 初回表示の HTTP キャッシュを再利用し、古い内容の場合だけ取り直す。 */
async function download(url, expected) {
  const html = url.endsWith('/index.html');
  // 起動 URL の違いを吸収し、ネットワークを使わず HTTP キャッシュを探す。
  if (html) {
    for (const candidate of [BASE.href, url]) {
      try {
        return await verify(await fetch(new Request(candidate, { cache: 'only-if-cached', mode: 'same-origin' })), expected);
      } catch {
        // 未保存や旧版なら次の候補を調べ、最後に最新版を取得する。
      }
    }
    return verify(await fetch(new Request(BASE.href, { cache: 'reload' })), expected);
  }
  const address = url;
  const response = await fetch(new Request(address, { cache: 'force-cache' }));
  try {
    return await verify(response, expected);
  } catch {
    return verify(await fetch(new Request(address, { cache: 'reload' })), expected);
  }
}

/** 変更のないファイルを再利用し、全ファイルが揃った場合だけインストールを完了する。 */
async function install() {
  const cache = await caches.open(CACHE);
  const previous = (await caches.keys()).filter((name) => name.startsWith(PREFIX) && name !== CACHE);
  try {
    for (const [url, expected] of URLS) {
      let response;
      // HTML は固定 URL なので旧版を再利用しない。内容付き URL は同梱フォントも再利用する。
      if (/\-[a-f0-9]{12}\.(js|css|woff2|txt)$/.test(new URL(url).pathname)) {
        for (const name of previous) {
          response = await (await caches.open(name)).match(url);
          if (response) break;
        }
      }
      await cache.put(url, response ? await verify(response, expected) : await download(url, expected));
    }
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
}

/** 現在の版を返す。キャッシュの一部が失われた場合も内容を検証して補う。 */
async function serve(url) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(url);
  if (saved) return saved;
  const response = await verify(await fetch(url), URLS.get(url));
  await cache.put(url, response.clone());
  return response;
}

self.addEventListener('install', (event) => event.waitUntil(install()));

// skipWaiting / clients.claim は使わず、旧版のタブが閉じてから新版へ切り替える。
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name)),
  )));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin) return;
  if (url.pathname === BASE.pathname || url.pathname === `${BASE.pathname}index.html`) {
    // 起点の / と /index.html は同じ保存内容を返す。検索文字列で再取得しない。
    url.pathname = `${BASE.pathname}index.html`;
    url.search = '';
  }
  if (URLS.has(url.href)) event.respondWith(serve(url.href));
});
