/**
 * Chromium の CDP を使い、公開用ファイルを実ブラウザーで検証する。
 * 外部ライブラリなし。実行例: CHROMIUM_BIN=/path/to/chrome node scripts/browser-check.mjs
 * 公開後の確認は --url https://teizu.github.io/free-freecell/ を指定する。
 * 生成した一時プロファイルとサーバーは終了時に片付け、アプリにテスト専用 API を追加しない。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.CHROMIUM_BIN
  ?? join(homedir(), '.cache/ms-playwright/chromium-1187/chrome-linux/chrome');
const urlArgument = process.argv.indexOf('--url');
const externalUrl = urlArgument === -1 ? null : new URL(process.argv[urlArgument + 1]).href;
const prefix = externalUrl ? new URL('./', externalUrl).pathname : '/free-freecell/';
const storageKey = `freecell:${prefix}:v1`;
const autoStorageKey = `${storageKey}:auto-home`;
const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** 公開フォルダだけをサブパスで配信し、実ネットワークの要求数とバイト数を記録する。 */
async function startServer(directory) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const relative = pathname.slice(prefix.length) || 'index.html';
    const target = resolve(directory, relative);
    if (!pathname.startsWith(prefix) || !target.startsWith(`${resolve(directory)}${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(target);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.txt': 'text/plain' }[extname(target)] ?? 'application/octet-stream';
      requests.push({ path: pathname, bytes: data.length });
      response.writeHead(200, { 'Content-Type': type.startsWith('font/') ? type : `${type}; charset=utf-8`, 'Cache-Control': 'max-age=600' });
      response.end(data);
    } catch {
      requests.push({ path: pathname, bytes: 0, missing: true });
      response.writeHead(404).end();
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}${prefix}`,
    close: () => server.listening ? new Promise((resolvePromise) => server.close(resolvePromise)) : Promise.resolve(),
  };
}

/** 新しい Chromium プロセスを起動し、CDP セッションの簡単な操作だけを公開する。 */
async function launchBrowser(profile, offline = false) {
  const child = spawn(executable, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    ...(offline ? ['--host-resolver-rules=MAP * ~NOTFOUND'] : []),
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  try {
    const endpoint = await new Promise((resolvePromise, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Chromium startup timed out: ${output}`)), 15000);
      child.stderr.on('data', (data) => {
        output += data;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolvePromise(match[1]);
        }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited ${code}: ${output}`)); });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolvePromise, reject) => {
      socket.addEventListener('open', resolvePromise, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    const errors = [];
    const network = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      if (message.method === 'Network.requestWillBeSent') network.push(message.params.request.url);
      if (!message.id) return;
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    });

    /** CDP 要求の対応付けを行い、異常時には待ち続けず失敗させる。 */
    function send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 15000);
        pending.set(id, { resolve: resolvePromise, reject, timer });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    }

    /** 新しいタブを作り、ブラウザー内の式を評価するための最小 API を用意する。 */
    async function page() {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const command = (method, params) => send(method, params, sessionId);
      await command('Page.enable');
      await command('Runtime.enable');
      await command('Network.enable');
      await command('DOM.enable');
      await command('CSS.enable');
      return {
        command,
        targetId,
        /** 例外を握りつぶさず、ブラウザーで計算した値を返す。 */
        async evaluate(expression) {
          const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
          return response.result.value;
        },
        /** DOM の用意ができるまで待ち、ネットワーク切断時の応答にも対応する。 */
        async navigate(url) {
          const previous = await this.evaluate('performance.timeOrigin');
          await command('Page.navigate', { url });
          await this.waitFor(`performance.timeOrigin !== ${previous} && document.readyState === 'complete' && document.querySelector('[data-zone="tableau"]')`, 'game page');
          await this.evaluate('document.fonts.ready.then(() => true)');
        },
        /** 時間ではなく条件の成立を待ち、失敗箇所を明示する。 */
        async waitFor(expression, label, timeout = 15000) {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            if (await this.evaluate(`(async () => Boolean(await (${expression})))()`)) return;
            await pause(50);
          }
          throw new Error(`Timed out waiting for ${label}: ${expression}`);
        },
        /** 通常のクリックイベントを送り、選択とボタン操作を検証する。 */
        async click(selector) {
          assert.ok(await this.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `Missing element: ${selector}`);
          await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
          // dialog の close は別タスクで届くため、描画前に次の入力を連打しない。
          await pause(50);
        },
      };
    }

    return {
      page, errors, network,
      /** ブラウザーを正常終了し、Service Worker と保存内容をディスクへ反映する。 */
      async close() {
        if (child.exitCode !== null) return;
        const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
        await send('Browser.close').catch(() => {});
        await exited;
        socket.close();
      },
    };
  } catch (error) {
    socket?.close();
    child.kill();
    throw error;
  }
}

/** 合法な最初の配りを作り、A から順にホームセルへ送れる再現可能な局を用意する。 */
function orderedGame() {
  const tableau = Array.from({ length: 8 }, () => []);
  let index = 0;
  for (let rank = 13; rank >= 1; rank -= 1) {
    for (let suit = 0; suit < 4; suit += 1) tableau[index++ % 8].push(suit * 13 + rank - 1);
  }
  return { version: 1, history: [{ tableau, cells: Array(4).fill(null), foundations: Array.from({ length: 4 }, () => []) }], cursor: 0, elapsedMs: 0, started: false };
}

/** 保存形式の入口だけを利用し、実装用のテストフックを作らず局を再現する。 */
async function loadFixture(page, game, url) {
  await loadSavedValue(page, JSON.stringify(game), url);
}

/** 遷移元の pagehide 保存が終わった後、新しい文書の起動前に保存値を置く。 */
async function loadSavedValue(page, value, url) {
  const { identifier } = await page.command('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(value)})`,
  });
  try {
    await page.navigate(url);
  } finally {
    await page.command('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
}

/** CSS の指定名だけでなく、実際の文字描画に使われたフォントを CDP から得る。 */
async function renderedFonts(page, selector) {
  const { root: document } = await page.command('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.command('DOM.querySelector', { nodeId: document.nodeId, selector });
  assert.ok(nodeId, `Missing font sample: ${selector}`);
  return (await page.command('CSS.getPlatformFontsForNode', { nodeId })).fonts;
}

/** 四つの絵柄の実フォント、数字・日本語のフォールバック、取得元を検証する。 */
async function checkSymbolFont(page, browser, url, label) {
  await page.evaluate('document.fonts.ready.then(() => true)');
  assert.equal(await page.evaluate(`document.fonts.check('16px "Noto Sans Symbols 2"', '♠♣♥♦')`), true);
  const cards = await page.evaluate(`Array.from({ length: 4 }, (_, suit) =>
    [...document.querySelectorAll('[data-card]')].find(card => Math.floor(Number(card.dataset.card) / 13) === suit).dataset.card)`);
  const suits = [];
  // Chromium の Fontations 使用時は、実フォント名にバックエンド名が付記される。
  const isNoto = font => /^Noto Sans Symbols 2(?: \(Fontations\))?$/.test(font.familyName);
  for (const [index, card] of cards.entries()) {
    const fonts = await renderedFonts(page, `[data-card="${card}"] .card-center`);
    const custom = fonts.filter(font => font.isCustomFont && font.glyphCount > 0);
    assert.equal(custom.length, 1, `A suit must use one downloaded font: ${JSON.stringify(fonts)}`);
    assert.ok(isNoto(custom[0]), `Unexpected suit font: ${JSON.stringify(custom[0])}`);
    suits.push(custom[0]);
    const home = await renderedFonts(page, `[data-zone="foundations"][data-index="${index}"]`);
    assert.ok(home.some(font => font.isCustomFont && isNoto(font) && font.glyphCount > 0),
      `Home symbol must use the downloaded font: ${JSON.stringify(home)}`);
  }
  const corner = await renderedFonts(page, '[data-card="9"] .card-corner');
  assert.ok(corner.some(font => font.isCustomFont && isNoto(font) && font.glyphCount === 1),
    `The 10 of spades corner must render its suit with Noto: ${JSON.stringify(corner)}`);
  assert.ok(corner.some(font => !font.isCustomFont && font.glyphCount >= 2),
    `The two rank digits must use the system font: ${JSON.stringify(corner)}`);
  const japanese = await renderedFonts(page, '#message');
  assert.ok(japanese.length && japanese.every(font => !font.isCustomFont),
    `Japanese must keep its system fallback: ${JSON.stringify(japanese)}`);
  const origin = new URL(url).origin;
  assert.ok(browser.network.filter(resource => /^https?:/.test(resource)).every(resource => new URL(resource).origin === origin),
    'The app must not fetch resources from an external origin');
  const fontUrls = [...new Set(browser.network.filter(resource => /\.woff2(?:[?#]|$)/.test(resource)))];
  assert.equal(fontUrls.length, 1, `Only the bundled suit font should be requested: ${JSON.stringify(fontUrls)}`);
  assert.ok(new URL(fontUrls[0]).pathname.startsWith(`${prefix}fonts/`));
  console.log(`PASS font ${label}: four suits rendered by ${suits[0].familyName} (${suits[0].postScriptName}); digits/Japanese use system fonts; same-origin WOFF2`);
}

/** デスクトップと狭い画面の表示、文字コード、表示文字列を検証する。 */
async function checkLayout(page, screenshotDirectory) {
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [768, 900], [1280, 900]]) {
    await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const state = await page.evaluate(`({
      width: innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
      charset: document.characterSet, lang: document.documentElement.lang,
      cards: document.querySelectorAll('[data-card]').length, title: document.title,
      heading: document.querySelector('h1').textContent,
      brokenText: document.body.textContent.includes('\uFFFD'),
      toolbar: [...document.querySelectorAll('.toolbar button')].map(button => {
        const rect = button.getBoundingClientRect();
        return { id: button.id, left: rect.left, right: rect.right };
      })
    })`);
    assert.ok(state.scrollWidth <= state.clientWidth, `Page overflow at ${width}px: ${JSON.stringify(state)}`);
    assert.ok(state.toolbar.every((button) => button.left >= 0 && button.right <= state.clientWidth),
      `Toolbar clipping at ${width}px: ${JSON.stringify(state)}`);
    if (width === 320) console.log(`320px toolbar bounds: ${JSON.stringify(state.toolbar)}; clientWidth=${state.clientWidth}`);
    assert.equal(state.charset, 'UTF-8');
    assert.equal(state.lang, 'ja');
    assert.equal(state.brokenText, false);
    assert.equal(state.heading, 'Free-FreeCell');
    assert.match(state.title, /^Free-FreeCell(?:\s|$)/);
    if (width < 900) await checkBoardBounds(page, `${width}x${height}`);
    await capturePage(page, join(screenshotDirectory, `freecell-${width}x${height}.png`));
    console.log(`PASS layout: ${width}x${height}, Free-FreeCell title, UTF-8 Japanese, no page overflow`);
  }
}

/** 横スクロールやページ移動なしで、全ての列と末尾カードまで画面内にあることを確かめる。 */
async function checkBoardBounds(page, label) {
  const bounds = await page.evaluate(`(() => {
    const board = document.querySelector('#board').getBoundingClientRect();
    const scroll = document.querySelector('#board-scroll');
    const cards = [...document.querySelectorAll('[data-card]')].map(card => card.getBoundingClientRect());
    const clippedLabels = [...document.querySelectorAll('.top-slots button, .column > button:last-child')].flatMap(button => {
      const card = button.getBoundingClientRect();
      const labels = button.children.length ? [...button.children] : [button];
      return labels.flatMap(label => {
        const range = document.createRange();
        range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        return text.left < card.left - 1 || text.right > card.right + 1 || text.top < card.top - 1 || text.bottom > card.bottom + 1
          ? [{ card: button.dataset.card ?? button.dataset.zone, text: label.textContent,
            top: text.top, bottom: text.bottom, cardTop: card.top, cardBottom: card.bottom }] : [];
      });
    });
    return { left: board.left, right: board.right, top: board.top, bottom: board.bottom,
      cardBottom: Math.max(...cards.map(card => card.bottom)),
      width: document.documentElement.clientWidth, height: innerHeight,
      scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, x: scrollX, y: scrollY, clippedLabels };
  })()`);
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, `Board width ${label}: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height + 1 && bounds.cardBottom <= bounds.height + 1,
    `Board height ${label}: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, `Board horizontal scrolling ${label}: ${JSON.stringify(bounds)}`);
  assert.equal(bounds.x, 0, `Horizontal page scroll ${label}`);
  assert.equal(bounds.y, 0, `Vertical page scroll ${label}`);
  assert.deepEqual(bounds.clippedLabels, [], `Visible labels must fit their cards ${label}`);
}

/** viewport の反映を待ち、スクロールバーを含めた表示幅でページ全体を撮影する。 */
async function capturePage(page, path) {
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const bounds = await page.evaluate(`({ width: innerWidth, height: document.documentElement.scrollHeight })`);
  const { data } = await page.command('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, ...bounds, scale: 1 },
  });
  await writeFile(path, Buffer.from(data, 'base64'));
}

/** コントロールの値を読み、表示と保存状態の検証を分かりやすくする。 */
async function textOf(page, selector) {
  return page.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
}

/** ネイティブのキーイベントを送り、通常のキーボード操作を再現する。 */
async function key(page, keyName) {
  const enter = keyName === 'Enter';
  const code = enter ? 13 : keyName === 'Escape' ? 27 : keyName === 'Tab' ? 9 : 32;
  const physical = keyName === ' ' ? 'Space' : keyName;
  await page.command('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code: physical, windowsVirtualKeyCode: code, ...(enter ? { text: '\r', unmodifiedText: '\r' } : {}) });
  await page.command('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code: physical, windowsVirtualKeyCode: code });
}

/** 盤面の位置から、カードまたは空枠の操作用セレクターを作る。 */
function position(zone, index, offset) {
  return `[data-zone="${zone}"][data-index="${index}"]${offset === undefined ? '' : `[data-offset="${offset}"]`}`;
}

/** DOM イベントの直接 dispatch に頼らず、一度の実タップをブラウザーへ送る。 */
async function touchPoint(page, point) {
  await page.command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** 実際の描画位置へ入力を送り、DOM 差し替えによる二度押しの取りこぼしも検出する。 */
async function doublePointer(page, selector, touch = false, exposedEdge = false) {
  const point = await page.evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + ${exposedEdge ? '4' : 'rect.height / 2'} };
  })()`);
  for (let count = 1; count <= 2; count += 1) {
    if (touch) {
      await touchPoint(page, point);
    } else {
      await page.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: count });
      await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: count });
    }
    await pause(80);
  }
}

/** 実ポインターで札を動かし、追従表示と終了・中止までをブラウザーに処理させる。 */
async function dragPointer(page, source, destination, { touch = false, exposedEdge = false, cancel = null, cards = 1 } = {}) {
  const start = await page.evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(source)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + ${exposedEdge ? '5' : 'rect.height / 2'} };
  })()`);
  const end = typeof destination === 'string' ? await page.evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(destination)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`) : destination;
  if (touch) await page.command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  else await page.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 4; step += 1) {
    const point = { x: start.x + (end.x - start.x) * step / 4, y: start.y + (end.y - start.y) * step / 4 };
    if (touch) await page.command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    else await page.command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1 });
    await pause(25);
  }
  const moving = await page.evaluate(`[...document.querySelectorAll('#board [data-card]')].filter(card => {
    const style = getComputedStyle(card); return style.transform !== 'none' || style.translate !== 'none';
  }).length`);
  assert.equal(moving, cards, 'The full dragged run must visibly follow the pointer');
  if (cancel === 'Escape') await key(page, 'Escape');
  if (cancel === 'second-inside' || cancel === 'second-outside') {
    const second = cancel === 'second-outside' ? { x: 2, y: 2 } : await page.evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(position('tableau', 2, 6))}).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page.command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...end, id: 0 }, { ...second, id: 1 }] });
    assert.equal(await page.evaluate(`document.querySelectorAll('#board .dragging').length`), 0,
      'A second finger must cancel the original drag before either finger is released');
  }
  if (touch) await page.command('Input.dispatchTouchEvent', { type: cancel === 'pointercancel' ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  else await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 });
  await pause(60);
  assert.equal(await page.evaluate(`document.querySelectorAll('#board [data-card]').length >= 1`), true);
  assert.equal(await page.evaluate(`[...document.querySelectorAll('#board [data-card]')].some(card => {
    const style = getComputedStyle(card); return style.transform !== 'none' || style.translate !== 'none';
  })`), false, 'No dragged card should remain translated after release or cancellation');
}

/** マウスとタッチのドラッグを通常ルール・履歴・自動処理へ接続して検証する。 */
async function checkDragAndDrop(page, server, engine, browser) {
  for (const touch of [false, true]) {
    const label = touch ? 'touch' : 'mouse';
    await page.command('Emulation.setDeviceMetricsOverride', { width: touch ? 390 : 1280, height: touch ? 844 : 900, deviceScaleFactor: 1, mobile: touch });
    await page.command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 1 });
    await loadFixture(page, orderedGame(), server.url);
    const networkStart = browser.network.length;
    await dragPointer(page, position('tableau', 0, 6), position('cells', 0), { touch });
    assert.equal(await textOf(page, '#moves'), '1', `${label}: a drop is one move`);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('cells', 0))}).dataset.card`), '0');
    assert.equal(await page.evaluate(`document.querySelectorAll('[aria-pressed="true"]').length`), 0, `${label}: the generated click must not select again`);
    await page.click('#undo');
    assert.equal(await textOf(page, '#moves'), '0');
    await page.click('#redo');
    assert.equal(await textOf(page, '#moves'), '1');
    await dragPointer(page, position('tableau', 1, 6), position('cells', 0), { touch });
    assert.equal(await textOf(page, '#moves'), '1', `${label}: an occupied free cell must reject the drop`);
    await dragPointer(page, position('cells', 0), position('foundations', 0), { touch });
    assert.equal(await textOf(page, '#moves'), '2');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('foundations', 0))}).dataset.card`), '0');
    assert.equal(browser.network.slice(networkStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0,
      `${label}: dragging must not fetch resources`);

    const single = gameWithTails([[5], [19], [32], [45], [9], [22], [35], [48]]);
    assert.equal(engine.validateGame(single), true);
    await loadFixture(page, single, server.url);
    await dragPointer(page, position('tableau', 0, 6), position('tableau', 1, 6), { touch });
    assert.equal(await textOf(page, '#moves'), '1');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', 1, 7))}).dataset.card`), '5');

    const almostWon = nearWinGame(engine);
    const board = engine.getBoard(almostWon);
    const occupied = board.tableau.findIndex(pile => pile.length);
    const empty = board.tableau.findIndex(pile => !pile.length);
    await loadFixture(page, almostWon, server.url);
    await dragPointer(page, position('tableau', occupied, 0), position('tableau', empty), { touch });
    assert.equal(await textOf(page, '#moves'), '52');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', empty, 0))}).dataset.card`), '51');

    const group = gameWithTails([[19, 5], [7], [32], [45], [9], [22], [35], [48]]);
    assert.equal(engine.validateGame(group), true);
    await loadFixture(page, group, server.url);
    await dragPointer(page, position('tableau', 0, 5), position('tableau', 1, 6), { touch, exposedEdge: true, cards: 2 });
    assert.equal(await textOf(page, '#moves'), '1', `${label}: a two-card run is one move`);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', 1, 7))}).dataset.card`), '19');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', 1, 8))}).dataset.card`), '5');
    await page.click('#undo');
    assert.equal(await textOf(page, '#moves'), '0');
    await dragPointer(page, position('tableau', 0, 5), position('cells', 0), { touch, exposedEdge: true, cards: 2 });
    assert.equal(await textOf(page, '#moves'), '0', `${label}: a group cannot enter one free cell`);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', 0, 6))}).dataset.card`), '5');

    // 移動先の規則違反・盤外・中止は履歴を作らず、続く通常操作も受け付ける。
    for (const cancel of ['illegal', 'outside', 'Escape', ...(touch ? ['pointercancel', 'second-inside', 'second-outside'] : [])]) {
      await loadFixture(page, orderedGame(), server.url);
      const destination = cancel === 'outside' ? { x: 2, y: 2 }
        : cancel === 'illegal' ? position('foundations', 1) : position('cells', 0);
      await dragPointer(page, position('tableau', 0, 6), destination, { touch, cancel });
      assert.equal(await textOf(page, '#moves'), '0', `${label}: ${cancel} must not move a card`);
      assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', 0, 6))}).dataset.card`), '0');
      await key(page, 'Escape');
      await page.click(position('tableau', 0, 6));
      await page.click(position('cells', 0));
      assert.equal(await textOf(page, '#moves'), '1', `${label}: normal selection still works after ${cancel}`);
    }

    const reveal = gameWithTails([[11, 0, 19], [6], [32], [45], [7], [20], [33], [46]]);
    await loadFixture(page, reveal, server.url);
    await page.click('#auto-enabled');
    await dragPointer(page, position('tableau', 0, 6), position('cells', 0), { touch });
    assert.equal(await textOf(page, '#moves'), '2', `${label}: automatic home follows the successful drop`);
    assert.equal(await textOf(page, '#progress'), '1');
    await page.click('#undo');
    assert.equal(await textOf(page, '#moves'), '1');
    assert.equal(await textOf(page, '#progress'), '0');
    await page.click('#auto-enabled');
    console.log(`PASS drag ${label}: free cell/home/tableau, two-card run, illegal/outside/cancel, click suppression, undo/redo, automatic home, no gameplay network`);
  }
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}

/** 二度押しでホームを優先し、移動できない単札だけをフリーセルへ送ることを検証する。 */
async function checkQuickMove(page, server) {
  await loadFixture(page, orderedGame(), server.url);
  await doublePointer(page, position('tableau', 0, 6));
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('foundations', 0))}).dataset.card`), '0');
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-zone="cells"][data-card]').length`), 0);

  await loadFixture(page, orderedGame(), server.url);
  await doublePointer(page, position('tableau', 4, 5));
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('cells', 0))}).dataset.card`), '1');
  await doublePointer(page, position('cells', 0));
  assert.equal(await textOf(page, '#moves'), '1', 'A cell card must stay put while its home is blocked');
  await doublePointer(page, position('tableau', 0, 6));
  await doublePointer(page, position('cells', 0));
  assert.equal(await textOf(page, '#moves'), '3');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('foundations', 0))}).dataset.card`), '1');
  // 手動の指定は安全判定を課さず、合法なら 3 以上でもホームへ送れる。
  await doublePointer(page, position('tableau', 0, 5));
  assert.equal(await textOf(page, '#moves'), '4');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('foundations', 0))}).dataset.card`), '2');

  await loadFixture(page, orderedGame(), server.url);
  await doublePointer(page, position('tableau', 0, 5), false, true);
  assert.equal(await textOf(page, '#moves'), '0', 'A buried card must not move by double-click');
  await key(page, 'Escape');
  for (let index = 0; index < 4; index += 1) {
    await page.click(position('tableau', index + 4, 5));
    await page.click(position('cells', index));
  }
  await doublePointer(page, position('tableau', 0, 6));
  assert.equal(await textOf(page, '#moves'), '5', 'Home takes priority even when all free cells are occupied');
  await doublePointer(page, position('tableau', 0, 5));
  assert.equal(await textOf(page, '#moves'), '5', 'No empty free cell must leave an unplayable card in place');
  console.log('PASS double-click: native input, home priority, free-cell fallback, buried/full/blocked refusal');
}

/** 各列の末尾を指定し、残りのカードを埋めた合法な初期配札を作る。 */
function gameWithTails(tails) {
  const reserved = new Set(tails.flat());
  const remaining = Array.from({ length: 52 }, (_, card) => card).filter(card => !reserved.has(card));
  const tableau = tails.map((tail, index) => remaining.splice(0, (index < 4 ? 7 : 6) - tail.length).concat(tail));
  return { version: 1, history: [{ tableau, cells: Array(4).fill(null), foundations: Array.from({ length: 4 }, () => []) }], cursor: 0, elapsedMs: 0, started: false };
}

/** 安全な自動移動、チェック設定の保存、履歴操作時の自動移動抑止を確かめる。 */
async function checkAutomaticHome(page, server, engine, browser) {
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), false, 'Automatic home starts disabled');
  await loadFixture(page, orderedGame(), server.url);
  const requestStart = browser.network.length;
  await page.click('#auto-home');
  assert.equal(await textOf(page, '#moves'), '52');
  assert.equal(await textOf(page, '#progress'), '52');
  await page.click('#undo');
  assert.equal(await textOf(page, '#moves'), '51', 'An automatic move is one undo step');
  await page.click('#redo');
  assert.equal(await textOf(page, '#moves'), '52');
  assert.equal(browser.network.slice(requestStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0);

  // スペードの 3 は合法でも、赤の 2 が未完了なのでボタンでは動かさない。
  let unsafe = gameWithTails([[2, 1, 0], [6], [19], [32], [45], [7], [20], [33]]);
  for (const offset of [6, 5]) {
    const result = engine.move(unsafe, { zone: 'tableau', index: 0, offset }, { zone: 'foundations', index: 0 });
    assert.equal(result.error, null);
    unsafe = result.game;
  }
  assert.equal(engine.validateGame(unsafe), true);
  await loadFixture(page, unsafe, server.url);
  await page.click('#auto-home');
  assert.equal(await textOf(page, '#moves'), '2');
  assert.equal(await textOf(page, '#progress'), '2');

  const reveal = gameWithTails([[11, 0, 19], [6], [32], [45], [7], [20], [33], [46]]);
  assert.equal(engine.validateGame(reveal), true);
  await loadFixture(page, reveal, server.url);
  await page.click('#auto-enabled');
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
  assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(autoStorageKey)})`), '1');
  assert.equal(await textOf(page, '#moves'), '0');
  await page.click(position('tableau', 0, 6));
  await page.click(position('cells', 0));
  assert.equal(await textOf(page, '#moves'), '2', 'A successful move triggers the newly exposed safe card');
  assert.equal(await textOf(page, '#progress'), '1');
  await page.click('#undo');
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await textOf(page, '#progress'), '0', 'Undo must not immediately resend the card');
  await page.navigate(server.url);
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
  assert.equal(await textOf(page, '#moves'), '1', 'Restoring a saved game must not resend the card');
  await page.click('#redo');
  assert.equal(await textOf(page, '#moves'), '2');
  await page.click('#undo');
  await page.click('#undo');
  await page.click('#redo');
  assert.equal(await textOf(page, '#moves'), '1', 'Redo must stop before the separate automatic history step');
  assert.equal(await textOf(page, '#progress'), '0');
  await page.click('#auto-enabled');
  await page.click('#auto-enabled');
  assert.equal(await textOf(page, '#moves'), '2', 'Enabling the checkbox immediately sends safe cards');
  await page.click('#auto-enabled');
  await page.navigate(server.url);
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), false);
  assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(autoStorageKey)})`), '0');
  console.log('PASS automatic home: safe cards only, immediate checkbox action, after-move action, settings restore, independent undo/redo');
}

/** 選択・拒否・履歴・再配札を操作し、ゲーム中に通信が増えないことも確認する。 */
async function checkControls(page, server, browser) {
  const network = browser.network;
  await loadFixture(page, orderedGame(), server.url);
  await pause(100);
  const networkStart = server.requests.length;
  const pageNetworkStart = network.length;
  assert.equal(await textOf(page, '#moves'), '0');
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-card]').length`), 52);
  const top = position('tableau', 0, 6);
  await page.command('Page.bringToFront');
  await page.evaluate(`document.querySelector(${JSON.stringify(top)}).focus()`);
  await key(page, 'Enter');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(top)}).getAttribute('aria-pressed')`), 'true');
  await key(page, 'Escape');
  assert.equal(await page.evaluate(`document.querySelectorAll('[aria-pressed="true"]').length`), 0);
  await page.evaluate(`document.querySelector(${JSON.stringify(top)}).focus()`);
  await key(page, ' ');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(top)}).getAttribute('aria-pressed')`), 'true');
  await key(page, 'Escape');
  await page.click(top);
  await page.click(position('cells', 0));
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('cells', 0))}).dataset.card`), '0');
  assert.equal(await page.evaluate(`document.activeElement.tagName`), 'BUTTON');

  await page.click(position('tableau', 1, 6));
  await page.click(position('cells', 0));
  assert.equal(await textOf(page, '#moves'), '1');
  assert.ok((await textOf(page, '#message')).length > 0);
  assert.equal(await page.evaluate(`document.querySelectorAll('[aria-pressed="true"]').length`), 1);
  await key(page, 'Escape');
  await page.evaluate(`document.querySelector('#undo').focus()`);
  await page.click('#undo');
  assert.equal(await textOf(page, '#moves'), '0');
  assert.equal(await page.evaluate(`document.activeElement.tagName === 'BUTTON' && !document.activeElement.disabled`), true);
  await page.evaluate(`document.querySelector('#redo').focus()`);
  await page.click('#redo');
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await page.evaluate(`document.activeElement.tagName === 'BUTTON' && !document.activeElement.disabled`), true);

  await page.click(position('cells', 0));
  await page.click(position('foundations', 0));
  assert.equal(await textOf(page, '#moves'), '2');
  await page.click('#undo');
  await page.click(position('cells', 0));
  await page.click(position('cells', 1));
  assert.equal(await textOf(page, '#moves'), '2');
  assert.equal(await page.evaluate(`document.querySelector('#redo').disabled`), true);

  await page.waitFor(`document.querySelector('#time').textContent !== '0:00'`, 'running clock', 3000);
  await checkHiddenClock(page, browser);
  await page.click('#restart');
  assert.equal(await page.evaluate(`document.querySelector('#confirm-dialog').open`), true);
  await page.click('#confirm-cancel');
  assert.equal(await textOf(page, '#moves'), '2');
  await page.click('#restart');
  await page.click('#confirm-accept');
  await page.waitFor(`document.querySelector('#moves').textContent === '0'`, 'restart confirmation');
  assert.equal(await textOf(page, '#moves'), '0');
  assert.equal(await textOf(page, '#time'), '0:00');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(top)}).dataset.card`), '0');

  await page.click(top);
  await page.click(position('cells', 0));
  await page.click('#new-game');
  await page.click('#confirm-cancel');
  assert.equal(await textOf(page, '#moves'), '1');
  await page.click('#new-game');
  await page.click('#confirm-accept');
  await page.waitFor(`document.querySelector('#moves').textContent === '0'`, 'new-game confirmation');
  assert.equal(await textOf(page, '#moves'), '0');
  const duringPlay = server.requests.slice(networkStart);
  // 起動に伴うブラウザー標準の SW 更新確認は、操作より後に完了することがある。
  assert.equal(duringPlay.filter((request) => request.path !== `${prefix}sw.js`).length, 0,
    `Game operations must not fetch assets: ${JSON.stringify(duringPlay)}`);
  assert.equal(network.slice(pageNetworkStart).filter((url) => new URL(url).pathname !== `${prefix}sw.js`).length, 0,
    'Game operations must not initiate page network requests');
  if (duringPlay.length) console.log(`Deferred startup SW check: ${JSON.stringify(duringPlay)}`);
  console.log('PASS controls: keyboard, illegal move, undo/redo branching, restart/new confirmation, timer, zero gameplay requests');
}

/** 別の実タブへ切り替え、非表示中は時計が止まり、復帰後に再開することを確認する。 */
async function checkHiddenClock(page, browser) {
  const background = await browser.page();
  await background.command('Page.bringToFront');
  await page.waitFor(`document.hidden`, 'hidden game tab');
  const paused = await textOf(page, '#time');
  const savedElapsed = await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).elapsedMs`);
  await pause(1200);
  assert.equal(await textOf(page, '#time'), paused);
  assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).elapsedMs`), savedElapsed);
  await page.command('Page.bringToFront');
  await page.waitFor(`!document.hidden`, 'visible game tab');
  await page.waitFor(`document.querySelector('#time').textContent !== ${JSON.stringify(paused)}`, 'resumed game clock', 3000);
  await background.command('Page.close');
  console.log('PASS visibility clock: stopped in a background tab and resumed on return');
}

/** 二枚の合法な並びを選択し、まとめた移動と一手の Undo を UI 経由で確認する。 */
async function checkGroupMove(page, server, engine) {
  const reserved = new Set([19, 5, 7]);
  const remaining = Array.from({ length: 52 }, (_, card) => card).filter((card) => !reserved.has(card));
  const tableau = [remaining.splice(0, 5).concat(19, 5), remaining.splice(0, 6).concat(7)];
  for (let index = 2; index < 8; index += 1) tableau.push(remaining.splice(0, index < 4 ? 7 : 6));
  const game = { version: 1, history: [{ tableau, cells: Array(4).fill(null), foundations: Array.from({ length: 4 }, () => []) }], cursor: 0, elapsedMs: 0, started: false };
  assert.equal(engine.validateGame(game), true);
  await loadFixture(page, game, server.url);
  await page.click(position('tableau', 0, 5));
  assert.equal(await page.evaluate(`document.querySelectorAll('[aria-pressed="true"]').length`), 2);
  await page.click(position('tableau', 1, 6));
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', 1, 7))}).dataset.card`), '19');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', 1, 8))}).dataset.card`), '5');
  await page.click('#undo');
  assert.equal(await textOf(page, '#moves'), '0');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', 0, 6))}).dataset.card`), '5');
  console.log('PASS group move: two selected cards, one move and one undo');
}

/** 保存した局を一手ずつ進め、合法な履歴を持つ勝利直前の状態を作る。 */
function nearWinGame(engine) {
  let game = orderedGame();
  for (let rank = 1; rank <= 13; rank += 1) {
    for (let suit = 0; suit < 4; suit += 1) {
      if (rank === 13 && suit === 3) return game;
      const card = suit * 13 + rank - 1;
      const board = engine.getBoard(game);
      const index = board.tableau.findIndex((column) => column.at(-1) === card);
      const result = engine.move(game, { zone: 'tableau', index, offset: board.tableau[index].length - 1 }, { zone: 'foundations', index: suit });
      assert.equal(result.error, null);
      game = result.game;
    }
  }
  throw new Error('Near-win fixture was not created');
}

/** 勝利の表示・取り消し・やり直しと、勝利後の新規ゲームを確認する。 */
async function checkWin(page, server, engine) {
  const game = nearWinGame(engine);
  assert.equal(engine.validateGame(game), true);
  await loadFixture(page, game, server.url);
  const board = engine.getBoard(game);
  const index = board.tableau.findIndex((column) => column.length);
  await page.click(position('tableau', index, 0));
  await page.click(position('foundations', 3));
  assert.equal(await page.evaluate(`document.querySelector('#win-panel').hidden`), false);
  assert.equal(await textOf(page, '#moves'), '52');
  const stopped = await textOf(page, '#time');
  await pause(1100);
  assert.equal(await textOf(page, '#time'), stopped);
  await page.click('#undo');
  assert.equal(await page.evaluate(`document.querySelector('#win-panel').hidden`), true);
  await page.click('#redo');
  assert.equal(await page.evaluate(`document.querySelector('#win-panel').hidden`), false);
  await page.evaluate(`document.querySelector('#win-new').focus()`);
  await page.click('#win-new');
  assert.equal(await textOf(page, '#moves'), '0');
  assert.equal(await page.evaluate(`document.querySelector('#confirm-dialog').open`), false);
  assert.equal(await page.evaluate(`document.activeElement.tagName === 'BUTTON' && !document.activeElement.closest('[hidden]')`), true);
  console.log('PASS victory: completion, stopped clock, undo/redo, new deal');
}

/** 保存データの破損と保存禁止を再現し、盤面が動き続けることを確認する。 */
async function checkStorage(page, server) {
  await loadSavedValue(page, '{broken', server.url);
  assert.equal(await textOf(page, '#moves'), '0');
  assert.match(await textOf(page, '#message'), /保存データ/);
  await loadFixture(page, orderedGame(), server.url);
  const { identifier } = await page.command('Page.addScriptToEvaluateOnNewDocument', {
    source: `Storage.prototype.setItem = function () { throw new DOMException('Storage disabled by test', 'QuotaExceededError'); };`,
  });
  try {
    await page.navigate(server.url);
    await page.click(position('tableau', 0, 6));
    await page.click(position('cells', 0));
    assert.equal(await textOf(page, '#moves'), '1');
    assert.ok((await textOf(page, '#storage-status')).length > 0);
    await page.click('#auto-enabled');
    assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
    assert.equal(await textOf(page, '#moves'), '53', 'Automatic home still works when saving its setting fails');
  } finally {
    await page.command('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await page.navigate(server.url);
  }
  console.log('PASS storage: corrupt JSON and denied writes keep the game playable');
}

/** 元の 7/6 枚の配りから 12 手で長い列を組み、縮小表示の厳しい条件を作る。 */
function longColumnGame(engine) {
  const tail = Array.from({ length: 12 }, (_, index) => {
    const rank = 12 - index;
    return (rank % 2 === 0 ? 13 : 0) + rank - 1;
  });
  const reserved = new Set([12, ...tail]);
  const remaining = Array.from({ length: 52 }, (_, index) => index).filter((card) => !reserved.has(card));
  const tableau = [remaining.splice(0, 6).concat(12)];
  for (let index = 1; index < 8; index += 1) {
    const placed = tail.filter((_, tailIndex) => tailIndex % 7 === index - 1).reverse();
    tableau.push(remaining.splice(0, (index < 4 ? 7 : 6) - placed.length).concat(placed));
  }
  let game = { version: 1, history: [{ tableau, cells: Array(4).fill(null), foundations: Array.from({ length: 4 }, () => []) }], cursor: 0, elapsedMs: 0, started: false };
  for (const card of tail) {
    const board = engine.getBoard(game);
    const index = board.tableau.findIndex((column) => column.at(-1) === card);
    const result = engine.move(game, { zone: 'tableau', index, offset: board.tableau[index].length - 1 }, { zone: 'tableau', index: 0 });
    assert.equal(result.error, null);
    game = result.game;
  }
  assert.equal(engine.validateGame(game), true);
  return game;
}

/** 長い列も画面内に収め、実タッチの単押しと二度押しでカードを操作する。 */
async function checkTouchAndLongColumn(page, server, engine, screenshots) {
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
    await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await loadFixture(page, longColumnGame(engine), server.url);
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await checkBoardBounds(page, `19-card column ${width}x${height}`);
    const last = position('tableau', 0, 18);
    const bounds = await page.evaluate(`(() => { const rect = document.querySelector(${JSON.stringify(last)}).getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
    await touchPoint(page, bounds);
    await page.waitFor(`document.querySelector(${JSON.stringify(last)}).getAttribute('aria-pressed') === 'true'`, 'touch selection');
    await checkBoardBounds(page, `selected 19-card column ${width}x${height}`);
    await capturePage(page, join(screenshots, `freecell-long-${width}x${height}.png`));
  }
  await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  // 背景や Escape を挟んだ操作は、400ms 以内でも別々の単押しとして扱う。
  for (const cancellation of ['background', 'Escape']) {
    await loadFixture(page, orderedGame(), server.url);
    const points = await page.evaluate(`(() => {
      const card = document.querySelector(${JSON.stringify(position('tableau', 0, 6))}).getBoundingClientRect();
      const board = document.querySelector('#board').getBoundingClientRect();
      return { card: { x: card.left + card.width / 2, y: card.top + card.height / 2 },
        background: { x: board.left + 1, y: board.top + 1 } };
    })()`);
    await touchPoint(page, points.card);
    if (cancellation === 'background') await touchPoint(page, points.background);
    else await key(page, 'Escape');
    assert.equal(await page.evaluate(`document.querySelectorAll('[aria-pressed="true"]').length`), 0);
    await touchPoint(page, points.card);
    assert.equal(await textOf(page, '#moves'), '0', `${cancellation} must cancel the double-tap sequence`);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('tableau', 0, 6))}).getAttribute('aria-pressed')`), 'true', `${cancellation} should allow a fresh selection`);
  }
  await loadFixture(page, orderedGame(), server.url);
  await doublePointer(page, position('tableau', 0, 6), true);
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('foundations', 0))}).dataset.card`), '0');
  await loadFixture(page, orderedGame(), server.url);
  await doublePointer(page, position('tableau', 4, 5), true);
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('cells', 0))}).dataset.card`), '1');
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  console.log('PASS touch: 19-card column fits all three mobile viewports; native double-tap prefers home and falls back to free cell');
}

/** 新版を一時配信し、旧版の対局を保持したまま更新が待機することを確認する。 */
async function prepareUpdate(page, server, temp) {
  const { build } = await import(join(root, 'scripts/build.mjs'));
  const source = join(temp, 'source');
  await cp(join(root, 'src'), source, { recursive: true });
  const css = await readFile(join(source, 'styles.css'), 'utf8');
  await writeFile(join(source, 'styles.css'), `${css}\n:root { --browser-update-check: 1; }\n`);
  const oldStylesheet = await page.evaluate(`document.querySelector('link[rel="stylesheet"]').href`);
  const originalCaches = await page.evaluate('caches.keys()');
  const updateStart = server.requests.length;
  await build(source, join(temp, 'live'));
  await page.evaluate(`navigator.serviceWorker.getRegistration().then(registration => registration.update())`);
  await page.waitFor(`navigator.serviceWorker.getRegistration().then(registration => Boolean(registration?.waiting))`, 'waiting updated service worker');
  assert.equal(await page.evaluate(`document.querySelector('link[rel="stylesheet"]').href`), oldStylesheet);
  assert.equal(await textOf(page, '#moves'), '1');
  const waitingCaches = await page.evaluate('caches.keys()');
  assert.ok(originalCaches.every((name) => waitingCaches.includes(name)), 'Old cache must remain while the game is open');
  const updateRequests = server.requests.slice(updateStart);
  assert.ok(updateRequests.every((request) => !/\/(?:game|storage|main|offline|drag)-|\/fonts\//.test(request.path)), 'Unchanged JS, font and license should be reused from the old application cache');
  console.log(`Update HTTP: ${updateRequests.length} requests, ${updateRequests.reduce((sum, request) => sum + request.bytes, 0)} body bytes`);
  console.log('PASS update waiting: unchanged JS reused; active game and old cache retained');
  return { oldStylesheet, originalCaches };
}

/** すべての検証を実行し、ブラウザー・サーバー・一時データを必ず解放する。 */
async function main() {
  const temp = await mkdtemp(join(tmpdir(), 'freecell-browser-'));
  const profile = join(temp, 'profile');
  if (!externalUrl) await cp(join(root, 'dist'), join(temp, 'live'), { recursive: true });
  const server = externalUrl
    ? { url: externalUrl, requests: [], close: async () => {} }
    : await startServer(join(temp, 'live'));
  let browser;
  try {
    const engine = await import(join(root, 'src/game.js'));
    browser = await launchBrowser(profile);
    let page = await browser.page();
    await page.navigate(server.url);
    await page.waitFor(`navigator.serviceWorker.getRegistration().then(registration => Boolean(registration?.active))`, 'active service worker');
    await checkSymbolFont(page, browser, server.url, 'online');
    const firstRequests = server.requests.slice();
    if (!externalUrl) {
      console.log(`First load HTTP: ${firstRequests.length} requests, ${firstRequests.reduce((sum, request) => sum + request.bytes, 0)} body bytes`);
      console.log(`First load paths: ${JSON.stringify(firstRequests)}`);
    } else {
      console.log(`Public URL: ${externalUrl}`);
      console.log(`Page resource timings: ${JSON.stringify(await page.evaluate(`performance.getEntriesByType('resource').map(entry => ({ name: entry.name, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize }))`))}`);
    }
    const revisitStart = server.requests.length;
    await page.navigate(server.url);
    await pause(100);
    const revisitRequests = server.requests.slice(revisitStart);
    if (!externalUrl) console.log(`Revisit HTTP: ${revisitRequests.length} requests, ${revisitRequests.reduce((sum, request) => sum + request.bytes, 0)} body bytes`);
    else assert.equal(await page.evaluate('Boolean(navigator.serviceWorker.controller)'), true);
    await checkLayout(page, temp);
    await checkControls(page, server, browser);
    await checkQuickMove(page, server);
    await checkAutomaticHome(page, server, engine, browser);
    await checkGroupMove(page, server, engine);
    await checkDragAndDrop(page, server, engine, browser);
    await checkWin(page, server, engine);
    await checkStorage(page, server);
    await checkTouchAndLongColumn(page, server, engine, temp);
    // 自動設定をオンのまま一手戻して保存し、再起動が盤面を勝手に進めないことも確かめる。
    await loadFixture(page, gameWithTails([[11, 0, 19], [6], [32], [45], [7], [20], [33], [46]]), server.url);
    await page.click('#auto-enabled');
    await page.click(position('tableau', 0, 6));
    await page.click(position('cells', 0));
    assert.equal(await textOf(page, '#moves'), '2');
    await page.click('#undo');
    await page.navigate(server.url);
    assert.equal(await textOf(page, '#moves'), '1');
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('cells', 0))}).dataset.card`), '19');
    assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
    if (!externalUrl) {
      const update = await prepareUpdate(page, server, temp);
      await browser.close();
      browser = await launchBrowser(profile);
      page = await browser.page();
      await page.navigate(server.url);
      assert.notEqual(await page.evaluate(`document.querySelector('link[rel="stylesheet"]').href`), update.oldStylesheet);
      await page.waitFor(`caches.keys().then(names => ${JSON.stringify(update.originalCaches)}.every(name => !names.includes(name)))`, 'old application cache cleanup');
      assert.equal(await textOf(page, '#moves'), '1');
      assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
      console.log('PASS update activation: new version after browser restart; progress preserved and old application cache removed');
    }
    await browser.close();
    await server.close();
    browser = await launchBrowser(profile, true);
    page = await browser.page();
    await page.command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await page.navigate(server.url);
    assert.equal(await page.evaluate(`document.documentElement.lang`), 'ja');
    assert.equal(await page.evaluate('Boolean(navigator.serviceWorker.controller)'), true);
    assert.equal(await page.evaluate(`fetch('./offline-probe', { cache: 'no-store' }).then(() => false, () => true)`), true, 'Offline probe must fail');
    assert.equal(await textOf(page, '#moves'), '1');
    assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
    await checkSymbolFont(page, browser, server.url, 'offline restart');
    await page.click('#undo');
    assert.equal(await textOf(page, '#moves'), '0');
    await page.click('#redo');
    assert.equal(await textOf(page, '#moves'), '1');
    await page.click('#auto-enabled');
    await page.click('#new-game');
    await page.click('#confirm-accept');
    await page.waitFor(`document.querySelector('#moves').textContent === '0'`, 'offline new-game confirmation');
    assert.equal(await textOf(page, '#moves'), '0');
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
    console.log(`PASS offline: browser process restarted with the same saved profile, DNS blocked, ${externalUrl ? 'network disabled' : 'HTTP server stopped'}; restore, undo/redo, new deal`);
    console.log(`Screenshots: ${temp}`);
  } finally {
    await browser?.close();
    await server.close();
    // スクリーンショットは確認用に残し、ブラウザープロファイルだけ削除する。
    await rm(profile, { recursive: true, force: true });
    await rm(join(temp, 'source'), { recursive: true, force: true });
    await rm(join(temp, 'live'), { recursive: true, force: true });
  }
}

await main();
