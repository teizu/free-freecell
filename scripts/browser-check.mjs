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
const soundStorageKey = `${storageKey}:sound`;
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
            try {
              if (await this.evaluate(`(async () => Boolean(await (${expression})))()`)) return;
            } catch (error) {
              // ボタンからの再読込で文書が切り替わる瞬間だけは、新しい実行環境を待つ。
              if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
            }
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

/** 全 52 枚のトランプ文字と実フォント、ホーム記号、日本語、取得元を検証する。 */
async function checkCardFont(page, browser, url, label) {
  await page.evaluate('document.fonts.ready.then(() => true)');
  assert.equal(await page.evaluate(`document.fonts.check('16px "Noto Sans Symbols 2"', '🂡🂱🃁🃑♠♣♥♦')`), true);
  const cards = await page.evaluate(`[...document.querySelectorAll('[data-card]')].map(card => ({
    id: Number(card.dataset.card), face: card.querySelector('.card-face')?.textContent,
    hidden: card.querySelector('.card-face')?.getAttribute('aria-hidden'), label: card.getAttribute('aria-label')
  }))`);
  assert.deepEqual(cards.map(card => card.id).sort((a, b) => a - b), Array.from({ length: 52 }, (_, card) => card),
    'The initial deal and saved offline fixture must contain all 52 cards');
  // Chromium の Fontations 使用時は、実フォント名にバックエンド名が付記される。
  const isNoto = font => /^Noto Sans Symbols 2(?: \(Fontations\))?$/.test(font.familyName);
  let sample;
  for (const card of cards) {
    const rank = card.id % 13 + 1;
    // Unicode の Knight は通常の 52 枚に含まれず、Q/K の直前で一つ飛ばす。
    const expected = 0x1f0a0 + Math.floor(card.id / 13) * 0x10 + rank + (rank >= 12 ? 1 : 0);
    assert.equal([...(card.face ?? '')].length, 1, `Card ${card.id} must contain one Unicode code point`);
    assert.equal(card.face.codePointAt(0), expected, `Wrong playing-card glyph for card ${card.id}`);
    assert.equal(card.hidden, 'true', 'The visual glyph must not duplicate its spoken card label');
    assert.ok(card.label && !card.label.includes(card.face), 'The button must keep a readable Japanese label');
    const fonts = (await renderedFonts(page, `[data-card="${card.id}"] .card-face`)).filter(font => font.glyphCount > 0);
    assert.equal(fonts.length, 1, `A full card must use one font: ${JSON.stringify(fonts)}`);
    assert.ok(fonts[0].isCustomFont && isNoto(fonts[0]), `Card ${card.id} fell back from Noto: ${JSON.stringify(fonts)}`);
    assert.equal(fonts[0].glyphCount, 1, `Card ${card.id} must be rendered as one playing-card glyph`);
    sample = fonts[0];
  }
  for (let index = 0; index < 4; index += 1) {
    const home = await renderedFonts(page, `[data-zone="foundations"][data-index="${index}"]`);
    assert.ok(home.some(font => font.isCustomFont && isNoto(font) && font.glyphCount > 0),
      `Home symbol must use the downloaded font: ${JSON.stringify(home)}`);
  }
  const japanese = await renderedFonts(page, '#message');
  assert.ok(japanese.length && japanese.every(font => !font.isCustomFont),
    `Japanese must keep its system fallback: ${JSON.stringify(japanese)}`);
  const origin = new URL(url).origin;
  assert.ok(browser.network.filter(resource => /^https?:/.test(resource)).every(resource => new URL(resource).origin === origin),
    'The app must not fetch resources from an external origin');
  const fontUrls = [...new Set(browser.network.filter(resource => /\.woff2(?:[?#]|$)/.test(resource)))];
  assert.equal(fontUrls.length, 1, `Only the bundled card font should be requested: ${JSON.stringify(fontUrls)}`);
  assert.ok(new URL(fontUrls[0]).pathname.startsWith(`${prefix}fonts/`));
  assert.equal(await page.evaluate(`document.querySelector('.site-footer a').href`),
    'https://openfontlicense.org/open-font-license-official-text/');
  assert.equal(browser.network.some(resource => /\/OFL[^/]*\.txt(?:[?#]|$)/.test(resource)), false,
    'The license text is an official external link, not an automatically fetched asset');
  console.log(`PASS font ${label}: all 52 playing-card glyphs and four home suits use ${sample.familyName} (${sample.postScriptName}); Japanese uses system fonts; same-origin WOFF2`);
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
      version: document.querySelector('#version').textContent,
      restart: document.querySelector('#restart').textContent,
      brokenText: document.body.textContent.includes('\uFFFD'),
      toolbar: [...document.querySelectorAll('.toolbar button, .site-header button')].map(button => {
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
    assert.match(state.version, /^ver-\d{4}-\d{2}-\d{2}$/);
    assert.equal(state.restart, '最初からやり直す');
    assert.match(state.title, /^Free-FreeCell(?:\s|$)/);
    await capturePage(page, join(screenshotDirectory, `freecell-${width}x${height}.png`));
    await checkBoardBounds(page, `${width}x${height}`);
    console.log(`PASS layout: ${width}x${height}, Free-FreeCell title, UTF-8 Japanese, no page overflow`);
  }
}

/** 盤面を表示した位置で全列が収まり、字形枠から四辺の余白がそろうことを確かめる。 */
async function checkBoardBounds(page, label) {
  const bounds = await page.evaluate(`(() => {
    const board = document.querySelector('#board').getBoundingClientRect();
    const scroll = document.querySelector('#board-scroll');
    const scrollRect = scroll.getBoundingClientRect();
    const cards = [...document.querySelectorAll('[data-card]')].map(card => card.getBoundingClientRect());
    const context = document.createElement('canvas').getContext('2d');
    const margins = [];
    const clippedLabels = [...document.querySelectorAll('.top-slots button, .column > button:last-child')].flatMap(button => {
      const card = button.getBoundingClientRect();
      const labels = button.children.length ? [...button.children] : [button];
      return labels.flatMap(label => {
        if (!label.getClientRects().length) return [];
        const range = document.createRange();
        range.selectNodeContents(label);
        let text = range.getBoundingClientRect();
        let metricsDetails;
        if (label.classList.contains('card-face')) {
          // 全札グリフの em は絵柄より大きいため、空白ではなく実際の輪郭の収まりを測る。
          // 高さ 0 の inline-block で実際の基線を測り、Canvas の同一フォント計測から輪郭を求める。
          const style = getComputedStyle(label);
          context.font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
          const metrics = context.measureText(label.textContent);
          const scaleX = text.width / metrics.width;
          const scaleY = text.height / (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
          const marker = document.createElement('span');
          marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
          label.append(marker);
          const baseline = marker.getBoundingClientRect().top;
          marker.remove();
          metricsDetails = { rangeTop: text.top, rangeHeight: text.height, font: context.font,
            ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent,
            inkAscent: metrics.actualBoundingBoxAscent, inkDescent: metrics.actualBoundingBoxDescent, baseline, scaleY };
          text = {
            left: text.left - metrics.actualBoundingBoxLeft * scaleX,
            right: text.left + metrics.actualBoundingBoxRight * scaleX,
            top: baseline - metrics.actualBoundingBoxAscent * scaleY,
            bottom: baseline + metrics.actualBoundingBoxDescent * scaleY,
          };
          if (!Object.values(text).every(Number.isFinite)) return [{ card: button.dataset.card, invalidInkBounds: true }];
          margins.push({ card: button.dataset.card, left: text.left - card.left, right: card.right - text.right,
            top: text.top - card.top, bottom: card.bottom - text.bottom });
        }
        return text.left < card.left - 1 || text.right > card.right + 1 || text.top < card.top - 1 || text.bottom > card.bottom + 1
          ? [{ card: button.dataset.card ?? button.dataset.zone, text: label.textContent,
            left: text.left, right: text.right, top: text.top, bottom: text.bottom,
            cardLeft: card.left, cardRight: card.right, cardTop: card.top, cardBottom: card.bottom, metricsDetails }] : [];
      });
    });
    return { left: board.left, right: board.right, top: board.top, bottom: board.bottom,
      cardBottom: Math.max(...cards.map(card => card.bottom)),
      width: document.documentElement.clientWidth, height: innerHeight,
      landscape: matchMedia('(orientation: landscape) and (max-height: 500px)').matches,
      maximized: getComputedStyle(scroll).position === 'fixed',
      scrollTop: scrollRect.top, scrollHeight: scrollRect.height,
      scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, x: scrollX, y: scrollY, clippedLabels, margins };
  })()`);
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, `Board width ${label}: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.top >= -1 && bounds.bottom <= bounds.height + 1 && bounds.cardBottom <= bounds.height + 1,
    `Board height ${label}: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, `Board horizontal scrolling ${label}: ${JSON.stringify(bounds)}`);
  assert.equal(bounds.x, 0, `Horizontal page scroll ${label}`);
  if (bounds.maximized) {
    assert.ok(Math.abs(bounds.scrollTop) <= 1 && Math.abs(bounds.scrollHeight - bounds.height) <= 1,
      `Maximized board uses the entire viewport height ${label}: ${JSON.stringify(bounds)}`);
  } else if (bounds.landscape) {
    assert.ok(Math.abs(bounds.scrollTop) <= 1 && Math.abs(bounds.scrollHeight - bounds.height) <= 1,
      `Landscape board uses the entire viewport height ${label}: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.y > 0, 'Landscape starts at the board with the menu above it');
  } else assert.equal(bounds.y, 0, `Vertical page scroll ${label}`);
  assert.deepEqual(bounds.clippedLabels, [], `Visible labels must fit their cards ${label}`);
  const uneven = bounds.margins.filter(({ left, right, top, bottom }) => {
    const sides = [left, right, top, bottom];
    // フォントの基線と輪郭の端は別々に丸められるため、物理 1px ずつのずれを許容する。
    return Math.min(...sides) < .5 || Math.max(...sides) > 3.5 || Math.max(...sides) - Math.min(...sides) > 2.1;
  });
  assert.deepEqual(uneven, [], `The glyph frame must have approximately equal 2 px margins ${label}`);
}

/** viewport の反映を待ち、スクロールバーを含めた表示幅でページ全体を撮影する。 */
async function capturePage(page, path) {
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  if (await page.evaluate(`matchMedia('(orientation: landscape) and (max-height: 500px)').matches`)) {
    // 全ページの clip は CDP が一時的に高さを変えてしまうため、横向きは実際の一画面だけを撮る。
    const { data } = await page.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path, Buffer.from(data, 'base64'));
    return;
  }
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
async function key(page, keyName, modifiers = 0) {
  const enter = keyName === 'Enter';
  const letter = /^[a-z]$/i.test(keyName);
  const code = letter ? keyName.toUpperCase().charCodeAt(0) : enter ? 13 : keyName === 'Escape' ? 27 : keyName === 'Tab' ? 9 : 32;
  const physical = letter ? `Key${keyName.toUpperCase()}` : keyName === ' ' ? 'Space' : keyName;
  const event = { key: keyName, code: physical, windowsVirtualKeyCode: code, modifiers };
  await page.command('Input.dispatchKeyEvent', { type: 'keyDown', ...event, ...(enter ? { text: '\r', unmodifiedText: '\r' } : {}) });
  await page.command('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
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

/** 実クリックのユーザー操作として、音声の初回再生許可も含めて検証する。 */
async function pointerClick(page, selector) {
  const point = await inputPoint(page, selector);
  await page.command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
}

/** CDP のタッチ座標は可視 viewport 基準なので、ピンチ後のオフセットを差し引く。 */
async function inputPoint(page, selector, top = null) {
  return page.evaluate(`(() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2 - (visualViewport?.offsetLeft ?? 0),
      y: rect.top + (${JSON.stringify(top)} ?? rect.height / 2) - (visualViewport?.offsetTop ?? 0) };
  })()`);
}

/** 実際の描画位置へ入力を送り、DOM 差し替えによる二度押しの取りこぼしも検出する。 */
async function doublePointer(page, selector, touch = false, exposedEdge = false) {
  const point = await inputPoint(page, selector, exposedEdge ? 4 : null);
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
async function dragPointer(page, source, destination, { touch = false, exposedEdge = false, cancel = null, cards = 1, hold = 0 } = {}) {
  const start = await inputPoint(page, source, exposedEdge ? 5 : null);
  const end = typeof destination === 'string' ? await inputPoint(page, destination) : destination;
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
  // 指を行き先で止める指定がある場合だけ、速いスワイプの慣性判定を避けてから離す。
  if (hold) await pause(hold);
  if (touch) await page.command('Input.dispatchTouchEvent', { type: cancel === 'pointercancel' ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  else await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 });
  await pause(60);
  await waitAutomatic(page);
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
    assert.equal(await page.evaluate(`document.querySelectorAll('#board [aria-pressed="true"]').length`), 0, `${label}: the generated click must not select again`);
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

    const reveal = gameWithTails([[11, 1, 0, 19], [6], [32], [45], [7], [20], [33], [46]]);
    await loadFixture(page, reveal, server.url);
    await page.click('#auto-enabled');
    await dragPointer(page, position('tableau', 0, 6), position('cells', 0), { touch });
    assert.equal(await textOf(page, '#moves'), '3', `${label}: both automatic cards follow the drop despite its suppressed click`);
    assert.equal(await textOf(page, '#progress'), '2');
    await page.click('#undo');
    assert.equal(await textOf(page, '#moves'), '2');
    assert.equal(await textOf(page, '#progress'), '1');
    await page.click('#auto-enabled');
    console.log(`PASS drag ${label}: free cell/home/tableau, two-card run, illegal/outside/cancel, click suppression, undo/redo, automatic home, no gameplay network`);
  }
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}

/** 倍率を直接設定せず、画面内の 2 本の実タッチを離す・近づける入力で標準ピンチを起こす。 */
async function pinch(page, center, opening = true, leaveOneFinger = false) {
  const viewport = await page.evaluate(`({ scale: visualViewport.scale,
    width: visualViewport.width * visualViewport.scale, height: visualViewport.height * visualViewport.scale })`);
  const origin = { x: center.x * viewport.scale, y: center.y * viewport.scale };
  // 第 1 指は必ず対象の中心に置き、第 2 指は画面の余白が最大の方向へ動かす。
  const directions = [
    { x: 1, y: 0, room: viewport.width - origin.x }, { x: -1, y: 0, room: origin.x },
    { x: 0, y: 1, room: viewport.height - origin.y }, { x: 0, y: -1, room: origin.y },
  ];
  const direction = directions.sort((a, b) => b.room - a.room)[0];
  const from = opening ? 32 : 180;
  const to = opening ? 180 : 32;
  assert.ok(direction.room > 180, 'Both fingers must stay inside the physical touchscreen');

  /** 指の画面上の位置を一定に保つため、その時点の倍率で CDP の CSS 座標へ戻す。 */
  async function points(gap) {
    const scale = await page.evaluate('visualViewport.scale');
    return [
      { x: origin.x / scale, y: origin.y / scale, id: 0 },
      { x: (origin.x + direction.x * gap) / scale, y: (origin.y + direction.y * gap) / scale, id: 1 },
    ];
  }
  await page.command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: await points(from) });
  assert.equal(await page.evaluate(`document.querySelectorAll('.dragging').length`), 0,
    'Two fingers must cancel dragging before native pinch begins');
  for (let step = 1; step <= 12; step += 1) {
    await page.command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: await points(from + (to - from) * step / 12) });
    await pause(30);
  }
  if (leaveOneFinger) {
    // 片方だけ離し、残った指を動かしても元のドラッグを復活させない。
    const [remaining] = await points(to);
    await page.command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [remaining] });
    await page.command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...remaining, x: remaining.x + 10 }] });
    assert.equal(await page.evaluate(`document.querySelectorAll('.dragging').length`), 0);
  }
  await page.command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pause(80);
  return page.evaluate('visualViewport.scale');
}

/** どこからでも標準ピンチが使え、履歴と札サイズを保ち、拡大後も単指ドラッグできることを確認する。 */
async function checkPinchZoom(page, server, browser) {
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const card = position('tableau', 3, 6);
  const areas = [
    ['card', card], ['free cell', position('cells', 1)], ['home cell', position('foundations', 2)],
    ['toolbar', '#new-game'], ['checkbox', '#auto-enabled'], ['background', 'h1'],
  ];
  for (const [label, selector] of areas) {
    await loadFixture(page, orderedGame(), server.url);
    const initial = await page.evaluate(`({ scale: visualViewport.scale,
      height: document.querySelector('#board').style.getPropertyValue('--card-height') })`);
    assert.equal(initial.scale, 1);
    const networkStart = browser.network.length;
    await page.evaluate(`window.pinchStartedOnTarget = false;
      document.addEventListener('pointerdown', event => {
        window.pinchStartedOnTarget = Boolean(event.target.closest(${JSON.stringify(selector)}));
      }, { once: true, capture: true })`);
    const expanded = await pinch(page, await inputPoint(page, selector));
    assert.equal(await page.evaluate('window.pinchStartedOnTarget'), true, `${label}: the first finger must touch the target itself`);
    assert.ok(expanded > 1.2, `${label}: native pinch must enlarge the page, actual ${expanded}`);
    assert.equal(await textOf(page, '#moves'), '0', `${label}: pinch must not move any card`);
    assert.equal(await page.evaluate(`document.querySelector('#confirm-dialog').open || document.querySelector('#auto-enabled').checked`), false,
      `${label}: pinch must not activate the touched control`);
    assert.equal(await page.evaluate(`document.querySelector('#board').style.getPropertyValue('--card-height')`), initial.height,
      `${label}: fitting the board must not undo the user's zoom`);
    const center = await page.evaluate('({ x: visualViewport.width / 2, y: visualViewport.height / 2 })');
    const reduced = await pinch(page, center, false);
    assert.ok(reduced < expanded - 0.1, `${label}: inward pinch must reduce the page, actual ${reduced}`);
    assert.equal(await textOf(page, '#moves'), '0');
    assert.equal(browser.network.slice(networkStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0,
      `${label}: pinching must not fetch resources`);
  }

  // 先に 1 本指で追従を開始し、2 本目でホームへの誤ドロップをせずピンチへ切り替える。
  await loadFixture(page, orderedGame(), server.url);
  const start = await inputPoint(page, card);
  await page.command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] });
  const first = { x: start.x, y: start.y - 20, id: 0 };
  await page.command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [first] });
  assert.equal(await page.evaluate(`document.querySelectorAll('.dragging').length`), 1);
  const scale = await pinch(page, first, true, true);
  assert.ok(scale > 1.2, `Pinch begun during drag must enlarge the page, actual ${scale}`);
  assert.equal(await textOf(page, '#moves'), '0');
  assert.equal(await page.evaluate(`document.querySelectorAll('#board [aria-pressed="true"], .dragging').length`), 0);
  // 拡大された画面内で見えている列を使い、指を全て離した後の新しい操作を確認する。
  await dragPointer(page, card, position('cells', 3), { touch: true });
  assert.equal(await textOf(page, '#moves'), '1', 'One-finger drag must still work while zoomed');
  assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('cells', 3))}).dataset.card`), '39');
  assert.equal(await page.evaluate(`document.querySelectorAll('#board [aria-pressed="true"], .dragging').length`), 0);
  assert.ok(Math.abs(await page.evaluate('visualViewport.scale') - scale) < 0.01, 'Dragging must preserve the chosen zoom');
  await page.click('#undo');
  assert.equal(await textOf(page, '#moves'), '0');
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(server.url);
  console.log('PASS pinch: native zoom in/out over cards, free/home cells, toolbar, checkbox and background; drag-to-pinch cancellation, residual finger, zoomed drag, no gameplay network');
}

/** 横向きでは盤面の左右余白からメニューへ戻れ、メニュー操作もスクロールを奪わない。 */
async function checkLandscapeScroll(page, server, engine, browser, screenshots) {
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await loadFixture(page, orderedGame(), server.url);
  await page.waitFor(`Math.abs(document.querySelector('#board-scroll').getBoundingClientRect().top) < 1`, 'landscape initially scrolled to board');
  await checkBoardBounds(page, 'landscape full-height board');
  const networkStart = browser.network.length;
  const geometry = await page.evaluate(`(() => { const box = document.querySelector('#board-scroll').getBoundingClientRect();
    return { left: box.left, right: innerWidth - box.right, width: innerWidth }; })()`);
  assert.ok(geometry.left >= 20 && geometry.right >= 20, 'Both edges leave enough room for a finger');

  /** 実際の 1 本指スワイプを送り、最後に止めて慣性スクロールによる検証の揺れを防ぐ。 */
  async function swipe(x, from, to) {
    await page.command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from, id: 0 }] });
    for (let step = 1; step <= 8; step += 1) {
      await page.command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * step / 8, id: 0 }] });
      await pause(35);
    }
    await pause(100);
    await page.command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  for (const x of [geometry.left / 2, geometry.width - geometry.right / 2]) {
    await page.evaluate(`document.querySelector('#board-scroll').scrollIntoView({ block: 'start' })`);
    await swipe(x, 60, 340);
    await page.waitFor('scrollY < 1', 'side swipe reveals the upper menu');
    const menu = await page.evaluate(`document.querySelector('#new-game').getBoundingClientRect().top`);
    assert.ok(menu >= 0 && menu < 390, 'Game controls remain reachable by scrolling');
    await page.click('#auto-enabled');
    await page.click('#auto-enabled');
    assert.equal(await page.evaluate('scrollY'), 0, 'Redrawing from menu settings must not force the user back to the board');
    await swipe(x, 340, 60);
    await page.waitFor('scrollY > 50', 'side swipe returns toward the board');
    assert.equal(await textOf(page, '#moves'), '0');
    assert.equal(await page.evaluate(`document.querySelectorAll('.dragging').length`), 0);
  }
  await page.evaluate(`document.querySelector('#board-scroll').scrollIntoView({ block: 'start' })`);
  await capturePage(page, join(screenshots, 'freecell-landscape-scroll.png'));
  assert.equal(browser.network.slice(networkStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0,
    'Side scrolling and menu settings must not fetch assets');
  await loadFixture(page, nearWinGame(engine), server.url);
  await pointerClick(page, '[data-card="51"]');
  await pointerClick(page, position('foundations', 3));
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await checkBoardBounds(page, 'landscape after winning');
  await loadFixture(page, orderedGame(), server.url);
  const pinchNetworkStart = browser.network.length;
  const height = await page.evaluate(`document.querySelector('#board').style.getPropertyValue('--card-height')`);
  const expanded = await pinch(page, await inputPoint(page, position('tableau', 3, 6)));
  assert.ok(expanded > 1.2, 'Native pinch also enlarges the full-height landscape board');
  assert.equal(await page.evaluate(`document.querySelector('#board').style.getPropertyValue('--card-height')`), height);
  assert.equal(await textOf(page, '#moves'), '0');
  assert.equal(browser.network.slice(pinchNetworkStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0);
  await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.navigate(server.url);
  await page.waitFor('scrollY === 0', 'portrait starts from the upper menu');
  await checkBoardBounds(page, 'portrait after landscape');
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(server.url);
  console.log('PASS landscape: full-height board, equal card margins, two scroll gutters, reachable menu, no forced scrolling, pinch and portrait restoration');
}

/** 全画面と横向き要求、左の操作欄、未対応時の最大化、解除・履歴・通信量を守る。 */
async function checkMaximization(page, server, browser, screenshots) {
  const active = `getComputedStyle(document.querySelector('#board-scroll')).position === 'fixed'`;
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await loadFixture(page, orderedGame(), server.url);
  const networkStart = browser.network.length;

  /** ピンチ後の小さな可視領域も含め、解除ボタンが四辺とも画面内にあることを確かめる。 */
  async function visibleToggle(label) {
    const rect = await page.evaluate(`(() => {
      const button = document.querySelector('#maximize');
      const box = button.getBoundingClientRect();
      const view = visualViewport;
      return { left: box.left - view.offsetLeft, right: box.right - view.offsetLeft,
        top: box.top - view.offsetTop, bottom: box.bottom - view.offsetTop,
        width: view.width, height: view.height, visible: Boolean(button.getClientRects().length) };
    })()`);
    assert.ok(rect.visible && rect.left >= -1 && rect.top >= -1 && rect.right <= rect.width + 1 && rect.bottom <= rect.height + 1,
      `Maximize control remains reachable ${label}: ${JSON.stringify(rect)}`);
  }

  /** 実タップから入退出し、要求したモードへ切り替わるまで待つ。 */
  async function toggle(expected, native = true) {
    await visibleToggle(expected ? 'before entering' : 'before leaving');
    await touchPoint(page, await inputPoint(page, '#maximize'));
    await page.waitFor(`(${expected ? active : `!(${active})`}) && !document.querySelector('#maximize').disabled
      && Boolean(document.fullscreenElement) === ${expected && native}`, expected ? 'maximized board' : 'normal board');
    assert.equal(await textOf(page, '#maximize'), expected ? '解除' : '最大化');
    assert.equal(await page.evaluate(`document.querySelector('#maximize').getAttribute('aria-pressed')`), String(expected));
  }

  /** 操作欄が盤面の左に独立し、操作を重複生成せず画面内へ収めることを確かめる。 */
  async function sidebar(label) {
    const layout = await page.evaluate(`(() => {
      const panel = document.querySelector('.controls');
      const menu = panel.getBoundingClientRect();
      const board = document.querySelector('#board-scroll').getBoundingClientRect();
      const controls = [...panel.querySelectorAll('button, .auto-toggle, .scoreboard > div')].map(control => {
        const rect = control.getBoundingClientRect();
        return { id: control.id || control.className, left: rect.left, right: rect.right,
          top: rect.top, bottom: rect.bottom, visible: getComputedStyle(control).visibility === 'visible' };
      });
      const sound = document.querySelector('#sound-toggle');
      const box = sound.getBoundingClientRect();
      return { sound: { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        visible: getComputedStyle(sound).visibility === 'visible',
        iconOnly: getComputedStyle(sound.firstElementChild).display === 'none',
        hit: sound.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) },
        menu: { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom },
        boardLeft: board.left, boardRight: board.right, width: innerWidth, height: innerHeight,
        controls, duplicateControls: ['new-game', 'restart', 'undo', 'redo', 'auto-home', 'auto-enabled', 'time', 'moves', 'progress']
          .filter(id => document.querySelectorAll('#' + id).length !== 1) };
    })()`);
    assert.ok(layout.menu.left >= -1 && layout.menu.top >= -1 && layout.menu.bottom <= layout.height + 1,
      `Sidebar bounds ${label}: ${JSON.stringify(layout)}`);
    assert.ok(layout.menu.right <= layout.boardLeft + 1 && layout.boardLeft > 0 && layout.boardRight <= layout.width + 1,
      `The menu and narrower board must not overlap ${label}: ${JSON.stringify(layout)}`);
    assert.ok(layout.controls.every(control => control.visible && control.left >= layout.menu.left - 1
      && control.right <= layout.menu.right + 1 && control.top >= -1 && control.bottom <= layout.height + 1),
      `Sidebar controls remain reachable ${label}: ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.duplicateControls, [], 'Fullscreen must reuse the existing live controls');
    assert.ok(layout.sound.visible && layout.sound.iconOnly && layout.sound.hit
      && layout.sound.left >= 0 && layout.sound.right <= layout.boardLeft
      && layout.sound.bottom <= layout.height && layout.height - layout.sound.bottom <= 10
      && layout.controls.every(control => control.bottom <= layout.sound.top),
      `The mute icon remains accessible at the lower left ${label}: ${JSON.stringify(layout)}`);
  }

  /** 全画面でも確認文と両ボタンが見え、盤面より手前で実タップを受けることを確かめる。 */
  async function visibleDialog() {
    await page.waitFor(`document.querySelector('#confirm-dialog').open`, 'visible fullscreen confirmation');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#confirm-dialog')).visibility`), 'visible');
    for (const selector of ['#confirm-cancel', '#confirm-accept']) {
      assert.equal(await page.evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        const rect = button.getBoundingClientRect();
        return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
          && button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      })()`), true, `${selector} must be visible and receive taps above the fullscreen board`);
    }
  }

  // 向きの要求はモックで順序だけを検証する。実機の物理的な回転とは区別する。
  await page.evaluate(`window.orientationRequests = []; window.orientationUnlocks = 0;
    screen.orientation.lock = orientation => {
      window.orientationRequests.push({ orientation, fullscreen: Boolean(document.fullscreenElement) });
      return Promise.resolve();
    };
    screen.orientation.unlock = () => { window.orientationUnlocks++; }`);
  // 実 API を呼ぶ際のオプションも記録し、ブラウザー UI を隠す要求を確認する。
  await page.evaluate(`window.fullscreenRequests = [];
    document.documentElement.requestFullscreen = function (options) {
      window.fullscreenRequests.push(options);
      return Element.prototype.requestFullscreen.call(this, options);
    }`);
  await page.click('#auto-enabled');
  await toggle(true);
  assert.equal(await page.evaluate('document.fullscreenElement === document.documentElement'), true);
  assert.deepEqual(await page.evaluate('window.fullscreenRequests'), [{ navigationUI: 'hide' }]);
  assert.equal(await textOf(page, '#moves'), '0');
  assert.equal(await textOf(page, '#time'), '0:00', 'Maximizing must not start an untouched automatic game');
  await checkBoardBounds(page, 'maximized portrait fallback');
  await sidebar('portrait when rotation is unavailable');
  await page.waitFor('window.orientationRequests.length === 1', 'landscape orientation request');
  assert.deepEqual(await page.evaluate('window.orientationRequests'), [{ orientation: 'landscape', fullscreen: true }]);
  assert.equal(await page.evaluate(`(() => {
    document.querySelector('#new-game').focus();
    return document.activeElement.id === 'new-game';
  })()`), true, 'The fullscreen sidebar must remain keyboard accessible');
  await toggle(false);
  await page.waitFor('window.orientationUnlocks > 0', 'orientation unlock after fullscreen');
  await page.click('#auto-enabled');
  const restoredZoom = await pinch(page, await inputPoint(page, position('tableau', 3, 6)));
  assert.ok(restoredZoom > 1.2, 'Leaving native fullscreen restores standard browser pinch');
  await page.command('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });

  // 同じ向きでの解除は元の閲覧位置に戻す。メニュー側へ勝手に戻さない。
  await page.evaluate('scrollTo(0, 100)');
  const originalScroll = await page.evaluate('scrollY');
  await toggle(true);
  await toggle(false);
  assert.ok(Math.abs(await page.evaluate('scrollY') - originalScroll) <= 1, 'Leaving maximum size restores the original scroll position');
  await toggle(true);
  // 戻る操作やブラウザー UI からの解除と同じ fullscreenchange の経路を通す。
  await page.evaluate('document.exitFullscreen()');
  await page.waitFor(`!(${active}) && !document.fullscreenElement`, 'browser-initiated fullscreen exit');
  assert.equal(await textOf(page, '#maximize'), '最大化');
  assert.equal(await page.evaluate(`document.querySelector('#maximize').getAttribute('aria-pressed')`), 'false');
  assert.ok(Math.abs(await page.evaluate('scrollY') - originalScroll) <= 1, 'External exit restores the original scroll position');
  await page.evaluate('scrollTo(0, 0)');
  await toggle(true);
  await page.evaluate('window.maximizeNode = document.querySelector("#maximize")');
  await dragPointer(page, position('tableau', 0, 6), position('cells', 0), { touch: true });
  assert.equal(await textOf(page, '#moves'), '1', 'Dragging still works in maximum size');
  assert.equal(await page.evaluate('window.maximizeNode === document.querySelector("#maximize")'), true,
    'Rendering cards must preserve the live maximize control');
  await key(page, 'z', 2);
  assert.equal(await textOf(page, '#moves'), '0');
  await key(page, 'y', 2);
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await page.evaluate(active), true, 'History shortcuts must not leave maximum size');
  await page.command('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await checkBoardBounds(page, 'maximized landscape');
  await sidebar('landscape');
  await visibleToggle('after changing orientation');
  assert.equal(await textOf(page, '#moves'), '1');
  const { data } = await page.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(screenshots, 'freecell-maximized-landscape.png'), Buffer.from(data, 'base64'));
  await key(page, 'Escape');
  await page.waitFor(`!(${active}) && !document.fullscreenElement && !document.querySelector('#maximize').disabled`, 'Escape leaves maximum size');
  assert.equal(await textOf(page, '#moves'), '1', 'Leaving maximum size keeps the game and history');
  await toggle(true);
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await checkBoardBounds(page, 'maximized after growing the viewport');
  await visibleToggle('after changing to a large fine-pointer viewport');
  await pointerClick(page, '#maximize');
  await page.waitFor(`!(${active}) && !document.fullscreenElement && !document.querySelector('#maximize').disabled`, 'visible control leaves maximum size on a large screen');
  assert.equal(browser.network.slice(networkStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0,
    'Maximum size, orientation changes and history controls must not fetch assets');

  await page.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await loadFixture(page, orderedGame(), server.url);
  // 同じ操作ボタンで履歴と確認を扱い、最大化を解除せずに次の局まで進める。
  await toggle(true);
  await sidebar('landscape controls');
  // 最大化中も同じ音声設定を実タップで切り替え、通常表示へ戻してからも状態を保つ。
  const originalSound = await page.evaluate(`document.querySelector('#sound-toggle').getAttribute('aria-pressed') === 'true'`);
  await touchPoint(page, await inputPoint(page, '#sound-toggle'));
  await page.waitFor(`document.querySelector('#sound-toggle').getAttribute('aria-pressed') === '${!originalSound}'`, 'fullscreen sound toggled');
  assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(soundStorageKey)})`), originalSound ? '0' : '1');
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#sound-toggle'), '::before').content`), originalSound ? '"♪×"' : '"♪"');
  const { root: documentRoot } = await page.command('DOM.getDocument');
  const { nodeId } = await page.command('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '#sound-toggle' });
  const { nodes } = await page.command('Accessibility.getPartialAXTree', { nodeId });
  const soundNode = nodes.find(node => node.role?.value === 'button');
  assert.equal(soundNode?.name?.value, '音声', 'An icon-only button keeps its accessible name');
  assert.equal(String(soundNode.properties.find(property => property.name === 'pressed').value.value), String(!originalSound));
  const { data: soundImage } = await page.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(screenshots, 'freecell-fullscreen-sound.png'), Buffer.from(soundImage, 'base64'));
  await toggle(false);
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#sound-toggle span')).display !== 'none'`), true);
  assert.equal(await page.evaluate(`document.querySelector('#sound-toggle').getAttribute('aria-pressed')`), String(!originalSound));
  await toggle(true);
  await touchPoint(page, await inputPoint(page, '#sound-toggle'));
  await page.waitFor(`document.querySelector('#sound-toggle').getAttribute('aria-pressed') === '${originalSound}'`, 'original sound restored');
  // 低い画面では左欄をスクロールし、最後のチェックと音声ボタンが重ならないことを確かめる。
  await page.command('Emulation.setDeviceMetricsOverride', { width: 844, height: 240, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await page.evaluate(`const panel = document.querySelector('.controls'); panel.scrollTop = panel.scrollHeight`);
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').getBoundingClientRect().bottom <= document.querySelector('#sound-toggle').getBoundingClientRect().top`), true);
  assert.equal(await page.evaluate(`(() => {
    const panel = document.querySelector('.controls');
    const area = panel.getBoundingClientRect();
    return panel.scrollHeight > panel.clientHeight && [...document.querySelectorAll('.scoreboard > div')].every(row => {
      const rect = row.getBoundingClientRect();
      return rect.top >= area.top && rect.bottom <= area.bottom
        && row.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    });
  })()`), true, 'Scrolling a short sidebar exposes every score above the fixed sound button');
  const { data: shortScoreImage } = await page.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(screenshots, 'freecell-score-short.png'), Buffer.from(shortScoreImage, 'base64'));
  await touchPoint(page, await inputPoint(page, '#sound-toggle'));
  await page.waitFor(`document.querySelector('#sound-toggle').getAttribute('aria-pressed') === '${!originalSound}'`, 'short viewport sound control');
  await touchPoint(page, await inputPoint(page, '#sound-toggle'));
  await page.waitFor(`document.querySelector('#sound-toggle').getAttribute('aria-pressed') === '${originalSound}'`, 'short viewport sound restored');
  await page.command('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await page.evaluate(`document.querySelector('.controls').scrollTop = 0`);
  const initialCards = await page.evaluate(`[...document.querySelectorAll('#board [data-card]')].map(card => card.dataset.card)`);
  await dragPointer(page, position('tableau', 0, 6), position('cells', 0), { touch: true, hold: 150 });
  // 左欄の数値が実際の移動・時計・履歴と連動し、同じ表示を二重生成しないことを確かめる。
  assert.equal(await textOf(page, '#moves'), '1');
  assert.equal(await textOf(page, '#progress'), '0');
  await page.waitFor(`document.querySelector('#time').textContent !== '0:00'`, 'visible sidebar clock starts');
  await touchPoint(page, await inputPoint(page, position('cells', 0)));
  await touchPoint(page, await inputPoint(page, position('foundations', 0)));
  await page.waitFor(`document.querySelector('#progress').textContent === '1'`, 'sidebar home count updates');
  assert.equal(await textOf(page, '#moves'), '2');
  await sidebar('live time, moves and home count');
  const { data: scoreImage } = await page.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(screenshots, 'freecell-score-playing.png'), Buffer.from(scoreImage, 'base64'));
  await touchPoint(page, await inputPoint(page, '#undo'));
  await page.waitFor(`document.querySelector('#progress').textContent === '0'`, 'sidebar home count undoes');
  assert.equal(await textOf(page, '#moves'), '1');
  await touchPoint(page, await inputPoint(page, '#undo'));
  await page.waitFor(`document.querySelector('#moves').textContent === '0'`, 'sidebar Undo applied');
  assert.equal(await textOf(page, '#moves'), '0', 'Sidebar Undo must use the existing history');
  await touchPoint(page, await inputPoint(page, '#redo'));
  await page.waitFor(`document.querySelector('#moves').textContent === '1'`, 'sidebar Redo applied');
  assert.equal(await textOf(page, '#moves'), '1', 'Sidebar Redo must restore that move');
  await touchPoint(page, await inputPoint(page, '#restart'));
  await visibleDialog();
  await touchPoint(page, await inputPoint(page, '#confirm-cancel'));
  await page.waitFor(`!document.querySelector('#confirm-dialog').open`, 'fullscreen reset cancelled');
  assert.equal(await textOf(page, '#moves'), '1');
  await touchPoint(page, await inputPoint(page, '#restart'));
  await visibleDialog();
  await touchPoint(page, await inputPoint(page, '#confirm-accept'));
  await page.waitFor(`document.querySelector('#moves').textContent === '0'`, 'fullscreen reset accepted');
  assert.equal(await textOf(page, '#time'), '0:00');
  assert.equal(await textOf(page, '#progress'), '0');
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#board [data-card]')].map(card => card.dataset.card)`), initialCards,
    'Reset in fullscreen restores the same initial deal');
  assert.equal(await page.evaluate(active), true);
  await touchPoint(page, await inputPoint(page, '#auto-enabled'));
  assert.equal(await textOf(page, '#moves'), '0', 'The sidebar automatic checkbox must still wait for the first move');
  await touchPoint(page, await inputPoint(page, '#auto-enabled'));
  await dragPointer(page, position('tableau', 0, 6), position('cells', 0), { touch: true, hold: 150 });
  await touchPoint(page, await inputPoint(page, '#new-game'));
  await visibleDialog();
  await touchPoint(page, await inputPoint(page, '#confirm-accept'));
  await page.waitFor(`document.querySelector('#moves').textContent === '0'`, 'fullscreen new game accepted');
  assert.notDeepEqual(await page.evaluate(`[...document.querySelectorAll('#board [data-card]')].map(card => card.dataset.card)`), initialCards);
  assert.equal(await page.evaluate(active), true, 'Reset and new game must preserve the dedicated layout');
  await toggle(false);
  await page.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await loadFixture(page, orderedGame(), server.url);
  const fallbackNetworkStart = browser.network.length;
  // 要求の成功後だけ Promise の完了を遅らせ、連打が入退出を重ねないことを確認する。
  await page.evaluate(`window.fullscreenCalls = 0;
    document.documentElement.requestFullscreen = function (options) {
      window.fullscreenCalls++;
      return Element.prototype.requestFullscreen.call(this, options)
        .then(() => new Promise(resolve => { window.finishFullscreen = resolve; }));
    }`);
  await touchPoint(page, await inputPoint(page, '#maximize'));
  await page.waitFor(`document.fullscreenElement && typeof window.finishFullscreen === 'function'`, 'delayed fullscreen entry');
  assert.equal(await page.evaluate(`document.querySelector('#maximize').disabled`), true);
  await page.evaluate(`document.querySelector('#maximize').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.querySelector('#maximize').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  assert.equal(await page.evaluate('window.fullscreenCalls'), 1, 'Repeated clicks must not overlap a pending fullscreen request');
  assert.equal(await page.evaluate('document.fullscreenElement === document.documentElement'), true);
  await page.evaluate('window.finishFullscreen(); delete document.documentElement.requestFullscreen');
  await page.waitFor(`!document.querySelector('#maximize').disabled`, 'fullscreen request finishes');

  // 解除を拒否されても表示状態を先に戻さず、次の操作で再試行できる。
  await page.evaluate(`window.fullscreenExitCalls = 0;
    document.exitFullscreen = () => {
      window.fullscreenExitCalls++;
      return Promise.reject(new Error('Test fullscreen exit denial'));
    }`);
  await touchPoint(page, await inputPoint(page, '#maximize'));
  await page.waitFor(`window.fullscreenExitCalls === 1 && !document.querySelector('#maximize').disabled`, 'rejected fullscreen exit');
  assert.equal(await page.evaluate(active), true);
  assert.equal(await page.evaluate('document.fullscreenElement === document.documentElement'), true);
  assert.equal(await textOf(page, '#maximize'), '解除');
  await page.evaluate('delete document.exitFullscreen');
  await toggle(false);

  // 開始拒否なら表示領域内の最大化で遊べる。未処理の Promise 拒否を発生させない。
  await page.evaluate(`window.fullscreenCalls = 0;
    document.documentElement.requestFullscreen = () => {
      window.fullscreenCalls++;
      return Promise.reject(new Error('Test fullscreen entry denial'));
    }`);
  await toggle(true, false);
  assert.equal(await page.evaluate('window.fullscreenCalls'), 1);
  await checkBoardBounds(page, 'maximum size after native rejection');
  await toggle(false, false);
  await page.evaluate('delete document.documentElement.requestFullscreen');
  assert.equal(await textOf(page, '#moves'), '0', 'Fullscreen failures and repeated input must not move cards');
  assert.equal(browser.network.slice(fallbackNetworkStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0);

  // 向き固定の未対応・拒否・遅延は、全画面と解除ボタンを妨げない。
  await page.evaluate(`screen.orientation.lock = undefined`);
  await toggle(true);
  await sidebar('missing orientation API');
  await toggle(false);
  await page.evaluate(`window.orientationFailures = 0;
    screen.orientation.lock = () => {
      window.orientationFailures++;
      return Promise.reject(new Error('Test orientation denial'));
    }`);
  await toggle(true);
  await page.waitFor('window.orientationFailures === 1', 'rejected landscape lock');
  assert.equal(await page.evaluate('document.fullscreenElement === document.documentElement'), true);
  await toggle(false);
  await page.evaluate(`window.orientationUnlocks = 0;
    screen.orientation.unlock = () => { window.orientationUnlocks++; };
    screen.orientation.lock = () => new Promise(resolve => { window.finishOrientation = resolve; })`);
  await toggle(true);
  await page.waitFor(`typeof window.finishOrientation === 'function'`, 'pending orientation lock');
  assert.equal(await page.evaluate(`document.querySelector('#maximize').disabled`), false,
    'A pending rotation must not disable the exit control');
  await toggle(false);
  await page.waitFor('window.orientationUnlocks > 0', 'unlock while orientation request is pending');
  await page.evaluate('window.finishOrientation()');
  await pause(50);
  assert.equal(await page.evaluate(active), false, 'A late orientation result must not re-enter maximum size');
  assert.equal(await page.evaluate('Boolean(document.fullscreenElement)'), false);
  await page.evaluate('delete screen.orientation.lock; delete screen.orientation.unlock');

  // 未対応ブラウザーの経路では従来の標準ピンチと可視領域内の解除ボタンを保つ。
  await page.evaluate(`Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false })`);
  const zoomNetworkStart = browser.network.length;
  await toggle(true, false);
  const height = await page.evaluate(`document.querySelector('#board').style.getPropertyValue('--card-height')`);
  const expanded = await pinch(page, await inputPoint(page, position('tableau', 3, 6)));
  assert.ok(expanded > 1.2, `Fallback maximum size preserves native pinch: actual scale ${expanded}`);
  assert.equal(await page.evaluate(`document.querySelector('#board').style.getPropertyValue('--card-height')`), height);
  await visibleToggle('while zoomed');
  await toggle(false, false);
  assert.ok(Math.abs(await page.evaluate('visualViewport.scale') - expanded) < .01, 'Leaving maximum size preserves the chosen zoom');
  assert.equal(await textOf(page, '#moves'), '0', 'Pinch and maximum-size controls must not move any card');
  assert.equal(browser.network.slice(zoomNetworkStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0);
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(server.url);
  assert.equal(await page.evaluate(`Boolean(document.querySelector('#maximize').getClientRects().length)`), false,
    'The maximize control is hidden in the normal desktop layout');
  console.log('PASS maximum size: native fullscreen, landscape request/unlock and failure races, left sidebar/reset/new/history, live time/moves/home counts, lower-left sound icon/tap/accessibility/short viewport, button/browser/Escape exit, scroll restore, unsupported fallback pinch and zoomed exit');
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

/** 自動送りの表示と期待する履歴位置が揃うまで待ち、固定秒数の待機を避ける。 */
async function waitAutomatic(page, moves = null) {
  const expected = moves === null ? 'true' : `document.querySelector('#moves').textContent === '${moves}'`;
  await page.waitFor(`!document.querySelector('.auto-moving') && (${expected})`, 'automatic move completion');
}

/** 未開始の局では自動設定を保存するだけに留め、最初の成功操作か明示ボタンから進める。 */
async function checkAutomaticStart(page, server) {
  await loadFixture(page, orderedGame(), server.url);
  await page.click('#auto-enabled');
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
  await pause(1100);
  assert.equal(await textOf(page, '#moves'), '0', 'Enabling automatic mode must not start an untouched deal');
  assert.equal(await textOf(page, '#time'), '0:00', 'The clock stays stopped before the first successful move');
  await page.click(position('tableau', 0, 6));
  await page.click(position('foundations', 1));
  assert.equal(await textOf(page, '#moves'), '0', 'Selection and an illegal move must not start automatic play');
  await page.navigate(server.url);
  assert.equal(await textOf(page, '#moves'), '0', 'Restoring an untouched deal must not start automatic play');
  assert.equal(await textOf(page, '#time'), '0:00');
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
  await page.click(position('tableau', 0, 6));
  await page.click(position('cells', 0));
  await waitAutomatic(page, 53);
  assert.equal(await textOf(page, '#progress'), '52', 'Automatic play begins after a successful user move');
  await page.click('#restart');
  await page.click('#confirm-accept');
  assert.equal(await textOf(page, '#moves'), '0', 'Restarting preserves automatic mode without starting it');
  assert.equal(await textOf(page, '#time'), '0:00');
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
  await page.click('#auto-home');
  await waitAutomatic(page, 52);
  await page.click('#win-new');
  assert.equal(await textOf(page, '#moves'), '0', 'A new game after winning waits for a player move');
  assert.equal(await textOf(page, '#time'), '0:00');
  await page.click('#new-game');
  assert.equal(await textOf(page, '#moves'), '0', 'A fresh deal keeps automatic mode armed without moving');
  assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).started`), false);
  await page.click('#auto-enabled');
  console.log('PASS automatic start: untouched checkbox/new/restart/restore keep zero moves and stopped time; user move or explicit automatic button starts play');
}

/** 安全な自動移動、チェック設定の保存、履歴操作時の自動移動抑止を確かめる。 */
async function checkAutomaticHome(page, server, engine, browser) {
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), false, 'Automatic home starts disabled');
  await loadFixture(page, orderedGame(), server.url);
  const requestStart = browser.network.length;
  await page.click('#auto-home');
  await waitAutomatic(page, 52);
  assert.equal(await textOf(page, '#moves'), '52');
  assert.equal(await textOf(page, '#progress'), '52');
  await page.click('#undo');
  assert.equal(await textOf(page, '#moves'), '51', 'An automatic move is one undo step');
  await page.click('#redo');
  assert.equal(await textOf(page, '#moves'), '52');
  assert.equal(browser.network.slice(requestStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0);

  // スペードの 3 は合法でも、赤の A が未完了なのでボタンでは動かさない。
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

  // 赤を 3 で止めた局でも、両黒の 5 まで安全に送り切れることを表示から確認する。
  const twoRanksAhead = gameWithTails([
    [4, 3, 2, 1, 0], [25, 15, 14, 13], [38, 28, 27, 26], [43, 42, 41, 40, 39],
    [10], [23], [36], [49],
  ]);
  assert.equal(engine.validateGame(twoRanksAhead), true);
  await loadFixture(page, twoRanksAhead, server.url);
  await page.click('#auto-home');
  await waitAutomatic(page, 16);
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('[data-zone="foundations"][data-card]')].map(card => Number(card.dataset.card))`),
    [4, 15, 28, 43], 'Both black foundations reach 5 while both red foundations remain at 3');

  const reveal = gameWithTails([[11, 0, 19], [6], [32], [45], [7], [20], [33], [46]]);
  assert.equal(engine.validateGame(reveal), true);
  await loadFixture(page, reveal, server.url);
  await page.click('#auto-enabled');
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
  assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(autoStorageKey)})`), '1');
  assert.equal(await textOf(page, '#moves'), '0');
  await page.click(position('tableau', 0, 6));
  await page.click(position('cells', 0));
  await waitAutomatic(page, 2);
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
  await waitAutomatic(page, 2);
  assert.equal(await textOf(page, '#moves'), '2', 'Enabling the checkbox immediately sends safe cards');
  await page.click('#auto-enabled');
  await page.navigate(server.url);
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), false);
  assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(autoStorageKey)})`), '0');
  console.log('PASS automatic home: safe cards only, immediate checkbox action, after-move action, settings restore, independent undo/redo');
}

/** 自動送りが見える速さで進み、入力・画面切替が古い非同期処理を確実に止めることを確認する。 */
async function checkAutomaticAnimation(page, server, browser) {
  await loadFixture(page, orderedGame(), server.url);
  const animation = await page.evaluate(`(() => {
    const source = document.querySelector('[data-card="0"]').getBoundingClientRect();
    const home = document.querySelector('[data-zone="foundations"][data-index="0"]').getBoundingClientRect();
    document.querySelector('#auto-home').click();
    const moving = document.querySelector('.auto-moving');
    const effect = moving?.getAnimations()[0]?.effect;
    const frames = effect?.getKeyframes();
    const first = frames ? new DOMMatrix(frames[0].transform) : null;
    const last = frames ? new DOMMatrix(frames.at(-1).transform) : null;
    return { duration: effect?.getTiming().duration, zone: moving?.dataset.zone, card: moving?.dataset.card,
      moves: document.querySelector('#moves').textContent,
      expected: { x: source.left - home.left, y: source.top - home.top },
      from: first && { x: first.m41, y: first.m42 }, to: last && { x: last.m41, y: last.m42 } };
  })()`);
  assert.equal(animation.duration, 100, 'Each automatic card must have a 100 ms movement animation');
  assert.equal(animation.zone, 'foundations');
  assert.equal(animation.card, '0');
  assert.equal(animation.moves, '1', 'Only the first card may commit before the first animation finishes');
  assert.deepEqual(animation.to, { x: 0, y: 0 });
  assert.ok(Math.abs(animation.from.x - animation.expected.x) < 1 && Math.abs(animation.from.y - animation.expected.y) < 1,
    `The home card must start at its old tableau position: ${JSON.stringify(animation)}`);
  const interrupted = await page.evaluate(`(() => {
    const before = Number(document.querySelector('#moves').textContent);
    document.querySelector('#undo').click();
    return before - 1;
  })()`);
  await pause(350);
  assert.equal(await textOf(page, '#moves'), String(interrupted), 'Undo must stop all pending automatic moves');
  assert.equal(await page.evaluate(`document.querySelectorAll('.auto-moving').length`), 0);
  await page.click('#redo');
  assert.equal(await textOf(page, '#moves'), String(interrupted + 1), 'Redo restores only one committed automatic card');

  // 未開始の局では設定だけを変え、オン・オフ操作から最初の一枚を自動で送らない。
  await loadFixture(page, orderedGame(), server.url);
  await page.evaluate(`document.querySelector('#auto-enabled').click(); document.querySelector('#auto-enabled').click()`);
  await pause(350);
  assert.equal(await textOf(page, '#moves'), '0', 'Toggling automatic mode must not play the first move');
  assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), false);

  // 確認ダイアログを開くだけで進行を止め、キャンセル・承認のどちらにも古い送りを持ち込まない。
  await loadFixture(page, orderedGame(), server.url);
  await page.evaluate(`document.querySelector('#auto-home').click(); document.querySelector('#restart').click()`);
  assert.equal(await page.evaluate(`document.querySelector('#confirm-dialog').open`), true);
  await page.click('#confirm-cancel');
  await pause(350);
  assert.equal(await textOf(page, '#moves'), '1');
  await page.click('#restart');
  await page.click('#confirm-accept');
  await pause(350);
  assert.equal(await textOf(page, '#moves'), '0');

  // 実際の pointerdown とキー入力も、一度確定した手数のまま後続を止める。
  for (const input of ['pointer', 'keyboard']) {
    await loadFixture(page, orderedGame(), server.url);
    await page.evaluate(`document.querySelector('#auto-home').click()`);
    if (input === 'pointer') {
      await page.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', buttons: 1 });
      await page.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', buttons: 0 });
    } else await key(page, 'Escape');
    const stopped = await textOf(page, '#moves');
    assert.ok(Number(stopped) > 0 && Number(stopped) < 52);
    await pause(350);
    assert.equal(await textOf(page, '#moves'), stopped, `${input}: later animation callbacks must not move more cards`);
  }

  await loadFixture(page, orderedGame(), server.url);
  await page.evaluate(`document.querySelector('#auto-home').click()`);
  const background = await browser.page();
  await background.command('Page.bringToFront');
  await page.waitFor('document.hidden', 'automatic game hidden');
  const stopped = await textOf(page, '#moves');
  await pause(350);
  assert.equal(await textOf(page, '#moves'), stopped);
  await page.command('Page.bringToFront');
  await page.waitFor('!document.hidden', 'automatic game visible');
  await pause(350);
  assert.equal(await textOf(page, '#moves'), stopped, 'Returning to the tab must not resume a cancelled sequence');
  await background.command('Page.close');

  await page.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    await loadFixture(page, orderedGame(), server.url);
    const immediate = await page.evaluate(`(() => {
      document.querySelector('#auto-home').click();
      return { moves: document.querySelector('#moves').textContent, animations: document.getAnimations().length };
    })()`);
    assert.deepEqual(immediate, { moves: '52', animations: 0 }, 'Reduced motion must send all cards without animation or delay');
  } finally {
    await page.command('Emulation.setEmulatedMedia', { features: [] });
  }
  console.log('PASS automatic animation: 100 ms tableau-to-home motion, sequential history, interruption by undo/toggle/reset/input/hidden, reduced motion');
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
  assert.equal(await page.evaluate(`document.querySelectorAll('#board [aria-pressed="true"]').length`), 0);
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
  assert.equal(await page.evaluate(`document.querySelectorAll('#board [aria-pressed="true"]').length`), 1);
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
  assert.equal(await textOf(page, '#confirm-title'), '初期状態にリセットしますか？');
  assert.equal(await textOf(page, '#confirm-cancel'), 'リセットしない');
  assert.equal(await textOf(page, '#confirm-accept'), 'リセットする');
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
  assert.equal(await textOf(page, '#confirm-title'), 'ゲームを切り替えますか？');
  assert.equal(await textOf(page, '#confirm-cancel'), '続けて遊ぶ');
  assert.equal(await textOf(page, '#confirm-accept'), '切り替える');
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

/** 実キー入力で履歴を動かし、編集・変換・確認中の入力を奪わないことを確かめる。 */
async function checkHistoryShortcuts(page, server) {
  await loadFixture(page, orderedGame(), server.url);
  await page.click(position('tableau', 0, 6));
  await page.click(position('cells', 0));
  await key(page, 'z', 2);
  assert.equal(await textOf(page, '#moves'), '0', 'Ctrl-Z undoes one move');
  await key(page, 'z', 2);
  assert.equal(await textOf(page, '#moves'), '0', 'Ctrl-Z at the first position is harmless');
  await key(page, 'y', 2);
  assert.equal(await textOf(page, '#moves'), '1', 'Ctrl-Y redoes one move');
  await key(page, 'y', 2);
  assert.equal(await textOf(page, '#moves'), '1', 'Ctrl-Y at the last position is harmless');
  await key(page, 'z', 4);
  assert.equal(await textOf(page, '#moves'), '0', 'Command-Z also undoes one move');
  await key(page, 'y', 4);
  assert.equal(await textOf(page, '#moves'), '1', 'Command-Y also redoes one move');
  await key(page, 'z', 3);
  assert.equal(await textOf(page, '#moves'), '1', 'Ctrl-Alt-Z must not be treated as Undo');
  await key(page, 'z', 10);
  assert.equal(await textOf(page, '#moves'), '1', 'Ctrl-Shift-Z must not be treated as Undo');

  for (const tag of ['input', 'textarea', 'select', 'div']) {
    await page.evaluate(`(() => {
      const input = document.createElement(${JSON.stringify(tag)});
      input.id = 'shortcut-editable';
      if (input.tagName === 'DIV') input.contentEditable = 'true';
      document.body.append(input);
      input.focus();
    })()`);
    await key(page, 'z', 2);
    assert.equal(await textOf(page, '#moves'), '1', `${tag}: Ctrl-Z is left to the editor`);
    await page.evaluate(`document.querySelector('#shortcut-editable').remove()`);
  }
  const composing = await page.evaluate(`(() => {
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return { prevented: event.defaultPrevented, moves: document.querySelector('#moves').textContent };
  })()`);
  assert.deepEqual(composing, { prevented: false, moves: '1' }, 'IME composition must not be consumed by the history shortcut');
  await page.click('#restart');
  await key(page, 'z', 2);
  assert.equal(await textOf(page, '#moves'), '1', 'A confirmation dialog blocks board history shortcuts');
  await page.click('#confirm-cancel');
  await page.evaluate(`document.querySelector('#auto-enabled').focus()`);
  await key(page, 'z', 2);
  assert.equal(await textOf(page, '#moves'), '0', 'Focusing the automatic checkbox must not block Undo');
  await key(page, 'y', 2);
  assert.equal(await textOf(page, '#moves'), '1', 'Shortcuts recover after closing the dialog');
  console.log('PASS history shortcuts: native Ctrl-Z/Ctrl-Y, history bounds, Alt/input/textarea/select/contenteditable/IME/dialog guards');
}

/** ネイティブ Web Audio の生成と波形を計測し、共通ゲイン・移動音・開始と完了フレーズ・許可・消音・保存を確認する。 */
async function checkSound(page, server, engine, browser) {
  const { identifier } = await page.command('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const audit = window.soundAudit = { contexts: [], tones: [] };
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor(...args) { super(...args); audit.contexts.push(this); }
        createGain() {
          const node = super.createGain();
          node.soundAutomation = [];
          for (const method of ['setValueAtTime', 'linearRampToValueAtTime']) {
            const original = node.gain[method].bind(node.gain);
            node.gain[method] = (value, time) => { node.soundAutomation.push({ method, value, time }); return original(value, time); };
          }
          return node;
        }
        createOscillator() {
          const node = super.createOscillator();
          const record = { frequencies: [], stops: [] };
          audit.tones.push(record);
          for (const method of ['setValueAtTime', 'linearRampToValueAtTime']) {
            const original = node.frequency[method].bind(node.frequency);
            node.frequency[method] = (value, time) => { record.frequencies.push({ method, value, time }); return original(value, time); };
          }
          const connect = node.connect.bind(node);
          node.connect = target => { record.gain = target.soundAutomation; return connect(target); };
          const start = node.start.bind(node);
          node.start = time => { record.start = time; record.type = node.type; return start(time); };
          const stop = node.stop.bind(node);
          node.stop = time => { record.stops.push(time ?? this.currentTime); return stop(time); };
          return node;
        }
      };
    })()`,
  });
  try {
    await loadFixture(page, orderedGame(), server.url);
    assert.equal(await textOf(page, '#sound-toggle'), ' 音声オン', 'Sound is on by default and the button shows the current state');
    assert.equal(await page.evaluate(`document.querySelector('#sound-toggle').getAttribute('aria-pressed')`), 'true');
    assert.equal(await page.evaluate(`document.querySelector('#sound-toggle').getAttribute('aria-label')`), '音声');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#sound-toggle'), '::before').content`), '"♪"');
    assert.equal(await page.evaluate('soundAudit.contexts.length'), 0, 'Loading a page does not create an audio context');
    await page.click(position('tableau', 0, 6));
    assert.equal(await page.evaluate('soundAudit.contexts.length'), 0, 'Synthetic clicks do not request playback permission');
    await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    let requestStart = browser.network.length;
    await pointerClick(page, 'h1');
    await page.waitFor(`soundAudit.contexts[0]?.state === 'running'`, 'audio context unlocked by user input');
    await pointerClick(page, position('tableau', 0, 6));
    const beforeCell = await page.evaluate('soundAudit.tones.length');
    await pointerClick(page, position('cells', 0));
    assert.equal(await textOf(page, '#moves'), '1');
    assert.equal(await page.evaluate('soundAudit.tones.length'), beforeCell + 1, 'A free-cell drop produces only its movement sound');
    assert.equal(await page.evaluate('soundAudit.tones.at(-1).frequencies[0].value'), 720);
    await pointerClick(page, position('cells', 0));
    const beforeHome = await page.evaluate('soundAudit.tones.length');
    await pointerClick(page, position('foundations', 0));
    assert.equal(await textOf(page, '#moves'), '2');
    assert.equal(await page.evaluate('soundAudit.tones.length'), beforeHome + 1, 'A home placement must not add a click before or after its sound');
    const tones = await page.evaluate('soundAudit.tones');
    const click = tones.find(tone => tone.frequencies[0]?.value === 600);
    const cell = tones.find(tone => tone.frequencies[0]?.value === 720);
    const home = tones.find(tone => tone.frequencies[0]?.value === 900);
    assert.ok(click && cell && home, 'Clicks and placing a card home produce distinct native oscillator tones');
    for (const [tone, peak, duration] of [[click, .1, .025], [cell, .1, .06], [home, .1, .09]]) {
      assert.equal(tone.type, 'sine');
      assert.equal(Math.max(...tone.gain.map(event => event.value)), peak);
      assert.equal(tone.gain[0].value, 0);
      assert.equal(tone.gain.at(-1).value, 0);
      assert.ok(Math.abs(tone.stops[0] - tone.start - duration) < 1e-6);
    }
    assert.equal(home.frequencies.at(-1).value, 1200);
    await pointerClick(page, '#undo');
    const undoClick = await page.evaluate('soundAudit.tones.at(-1)');
    assert.equal(undoClick.frequencies[0].value, 600);
    assert.equal(undoClick.stops.length, 1, 'Undo must keep its own short click sound instead of immediately cancelling it');
    assert.equal(browser.network.slice(requestStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0,
      'Click and home synthesis do not fetch assets');

    // 各入力経路が同じ移動音へ到達し、失敗や履歴の再適用では再生しないことを確かめる。
    for (const method of ['keyboard', 'mouse drag', 'touch drag', 'double-click', 'double-tap']) {
      const touch = method.startsWith('touch') || method === 'double-tap';
      await page.command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 2 });
      await page.command('Emulation.setDeviceMetricsOverride', { width: touch ? 390 : 1280, height: touch ? 844 : 900, deviceScaleFactor: 1, mobile: touch });
      await loadFixture(page, orderedGame(), server.url);
      await pointerClick(page, 'h1');
      await page.waitFor(`soundAudit.contexts[0]?.state === 'running'`, 'audio ready for ' + method);
      const source = position('tableau', 4, 5);
      if (method === 'keyboard') {
        await page.evaluate(`document.querySelector(${JSON.stringify(source)}).focus()`);
        await key(page, 'Enter');
        await page.evaluate(`document.querySelector(${JSON.stringify(position('cells', 0))}).focus()`);
        await key(page, 'Enter');
      } else if (method.endsWith('drag')) {
        // 次のタップへスワイプの慣性判定を持ち越さず、音の経路だけを確認する。
        await dragPointer(page, source, position('cells', 0), { touch, hold: 150 });
      } else {
        await doublePointer(page, source, touch);
      }
      assert.equal(await textOf(page, '#moves'), '1', method);
      assert.equal(await page.evaluate('soundAudit.tones.filter(tone => tone.frequencies[0]?.value === 720).length'), 1, method);
      assert.equal(await page.evaluate('soundAudit.tones.at(-1).frequencies[0].value'), 720, method + ' keeps the movement sound');
    }
    await page.command('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await pointerClick(page, position('tableau', 0, 6));
    await pointerClick(page, position('cells', 0));
    assert.equal(await textOf(page, '#moves'), '1', 'An occupied free cell rejects the drop');
    await pointerClick(page, '#undo');
    await pointerClick(page, '#redo');
    assert.equal(await page.evaluate('soundAudit.tones.filter(tone => tone.frequencies[0]?.value === 720).length'), 1,
      'Failed moves and Undo/Redo must not play the free-cell placement sound');
    const beforeDisabled = await page.evaluate('soundAudit.tones.length');
    await pointerClick(page, '#redo');
    assert.equal(await page.evaluate('soundAudit.tones.length'), beforeDisabled, 'An already disabled button stays silent');
    await pointerClick(page, '#undo');
    assert.equal(await textOf(page, '#moves'), '0');
    assert.equal(await page.evaluate('soundAudit.tones.length'), beforeDisabled + 1,
      'The last Undo still clicks even though its handler disables the button');
    assert.equal(await page.evaluate('soundAudit.tones.at(-1).frequencies[0].value'), 600);


    // 同じ成功移動なら、クリック・マウス・タッチで専用音を一度だけ鳴らす。
    let tableauTone;
    for (const method of ['click', 'mouse drag', 'touch drag']) {
      const touch = method === 'touch drag';
      await page.command('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 2 });
      await page.command('Emulation.setDeviceMetricsOverride', { width: touch ? 390 : 1280, height: touch ? 844 : 900, deviceScaleFactor: 1, mobile: touch });
      for (const zone of ['tableau', 'foundations']) {
        await loadFixture(page, orderedGame(), server.url);
        await pointerClick(page, 'h1');
        await page.waitFor(`soundAudit.contexts[0]?.state === 'running'`, 'audio ready for ' + method + '/' + zone);
        const source = position('tableau', 0, 6);
        // 黒 A を赤 2 の上へ置くか、ホームへ送る。
        const target = zone === 'tableau' ? position('tableau', 5, 5) : position('foundations', 0);
        if (method === 'click') await pointerClick(page, source);
        const before = await page.evaluate('soundAudit.tones.length');
        if (method === 'click') await pointerClick(page, target);
        else await dragPointer(page, source, target, { touch, hold: 150 });
        assert.equal(await textOf(page, '#moves'), '1', method + '/' + zone);
        assert.equal(await page.evaluate('soundAudit.tones.length'), before + 1, 'One dedicated tone: ' + method + '/' + zone);
        const tone = await page.evaluate('soundAudit.tones.at(-1)');
        assert.equal(tone.frequencies[0].value, zone === 'tableau' ? 660 : 900);
        assert.equal(Math.max(...tone.gain.map(event => event.value)), .1);
        assert.equal(tone.type, 'sine');
        assert.ok(Math.abs(tone.stops[0] - tone.start - (zone === 'tableau' ? .06 : .09)) < 1e-6);
        if (zone === 'tableau') tableauTone = tone;
        // 同じ移動の取り消しと不正なドロップでは、成功音を再生しない。
        await pointerClick(page, '#undo');
        if (method !== 'click') {
          const beforeInvalid = await page.evaluate('soundAudit.tones.length');
          await dragPointer(page, source, position('tableau', 1, 6), { touch, hold: 150 });
          assert.equal(await page.evaluate('soundAudit.tones.length'), beforeInvalid);
          assert.equal(await textOf(page, '#moves'), '0');
        }
      }
    }
    await page.command('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    // 新規配りの確定だけが開始音の契機。確認の表示・取消・リセット・復元では鳴らさない。
    let startTone;
    for (const state of ['unstarted', 'playing', 'won']) {
      await loadFixture(page, state === 'unstarted' ? orderedGame() : nearWinGame(engine), server.url);
      if (state === 'won') {
        await page.click('#auto-home');
        await waitAutomatic(page);
      }
      await pointerClick(page, 'h1');
      await page.waitFor(`soundAudit.contexts[0]?.state === 'running'`, 'audio ready for new game');
      assert.equal(await page.evaluate('soundAudit.tones.length'), 0, 'Restoration stays silent');
      await pointerClick(page, state === 'won' ? '#win-new' : '#new-game');
      if (state === 'playing') {
        assert.equal(await page.evaluate('soundAudit.tones.filter(tone => tone.frequencies.length === 3).length'), 0);
        await pointerClick(page, '#confirm-cancel');
        assert.equal(await page.evaluate('soundAudit.tones.filter(tone => tone.frequencies.length === 3).length'), 0);
        await pointerClick(page, '#new-game');
        await pointerClick(page, '#confirm-accept');
      }
      await page.waitFor('soundAudit.tones.some(tone => tone.frequencies.length === 3)', 'three-note start');
      assert.equal(await page.evaluate('soundAudit.tones.filter(tone => tone.frequencies.length === 3).length'), 1);
      startTone = await page.evaluate('soundAudit.tones.find(tone => tone.frequencies.length === 3)');
      assert.deepEqual(startTone.frequencies.map(event => event.value), [523, 659, 784]);
      assert.equal(startTone.type, 'sine');
      assert.equal(Math.max(...startTone.gain.map(event => event.value)), .1);
      assert.ok(Math.abs(startTone.stops[0] - startTone.start - .34) < 1e-6);
      for (const [index, note] of startTone.frequencies.entries()) {
        assert.ok(Math.abs(note.time - startTone.start - index * .12) < 1e-6);
        assert.ok(Math.abs(startTone.gain[index * 3 + 2].time - note.time - .1) < 1e-6);
      }
      assert.equal(await textOf(page, '#moves'), '0');
      assert.equal(await textOf(page, '#time'), '0:00');
      await pointerClick(page, '#restart');
      assert.equal(await page.evaluate('soundAudit.tones.filter(tone => tone.frequencies.length === 3).length'), 1,
        'Restarting the same deal must not replay the new-deal phrase');
    }


    await loadFixture(page, nearWinGame(engine), server.url);
    await pointerClick(page, 'h1');
    await page.waitFor(`soundAudit.contexts[0]?.state === 'running'`, 'audio ready for automatic victory');
    await pointerClick(page, '#auto-home');
    await waitAutomatic(page);
    assert.equal(await page.evaluate('soundAudit.tones.length'), 1, 'An automatic victory plays only the fanfare');
    assert.equal(await page.evaluate('soundAudit.tones[0].frequencies.length'), 6);

    await loadFixture(page, nearWinGame(engine), server.url);
    requestStart = browser.network.length;
    await pointerClick(page, 'h1');
    await page.waitFor(`soundAudit.contexts[0]?.state === 'running'`, 'audio context ready for the final card');
    await pointerClick(page, '[data-card="51"]');
    await pointerClick(page, position('foundations', 3));
    const fanfare = await page.evaluate('soundAudit.tones.find(tone => tone.frequencies[0]?.value === 523)');
    assert.ok(fanfare, 'Placing the last card starts a short fanfare');
    assert.deepEqual(fanfare.frequencies.map(event => event.value), [523, 659, 784, 1047, 784, 1568]);
    assert.ok(Math.abs(fanfare.stops[0] - fanfare.start - .9) < 1e-6);
    assert.equal(Math.max(...fanfare.gain.map(event => event.value)), .5);
    assert.equal(fanfare.type, 'triangle');
    for (const [index, note] of fanfare.frequencies.entries()) {
      assert.ok(Math.abs(note.time - fanfare.start - index * .12) < 1e-6);
      assert.ok(Math.abs(fanfare.gain[index * 3 + 2].time - note.time - (index === 5 ? .3 : .1)) < 1e-6,
        'The first five notes are short and the final high note rings longer');
    }
    const completedTones = await page.evaluate('soundAudit.tones.length');
    await key(page, 'z', 2);
    const stoppedFanfare = await page.evaluate('soundAudit.tones.find(tone => tone.frequencies[0]?.value === 523)');
    assert.ok(stoppedFanfare.stops.length >= 2 && stoppedFanfare.stops.at(-1) < stoppedFanfare.stops[0],
      'Undo immediately stops the remaining fanfare notes');
    await page.click('#redo');
    assert.equal(await page.evaluate('soundAudit.tones.length'), completedTones, 'Redoing a win does not replay the fanfare');
    // 観測した実際の包絡線をオフライン音声エンジンにも通し、デジタル波形の振幅上限を確認する。
    const levels = await page.evaluate(`Promise.all(${JSON.stringify([click, tableauTone, cell, home, startTone, fanfare])}.map(async tone => {
      const duration = tone.stops[0] - tone.start;
      const context = new OfflineAudioContext(1, Math.ceil(duration * 48000), 48000);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      for (const event of tone.frequencies) oscillator.frequency[event.method](event.value, Math.max(0, event.time - tone.start));
      for (const event of tone.gain) gain.gain[event.method](event.value, Math.max(0, event.time - tone.start));
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(0); oscillator.stop(duration);
      const buffer = await context.startRendering();
      const samples = buffer.getChannelData(0);
      return { peak: Math.max(...samples.map(Math.abs)),
        rms: Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) };
    }))`);
    for (const [index, limit] of [.1, .1, .1, .1, .1, .5].entries()) {
      assert.ok(levels[index].peak > limit * .9 && levels[index].peak <= limit + .00001);
      assert.ok(levels[index].rms > 0 && levels[index].rms < limit);
      if (index < 5) assert.ok(levels[5].rms > levels[index].rms * 2, 'The win remains louder than ordinary effects');
    }
    console.log('Sound levels (click/tableau/cell/home/start/win): ' + JSON.stringify(levels));

    await pointerClick(page, '#sound-toggle');
    assert.equal(await textOf(page, '#sound-toggle'), ' 音声オフ');
    assert.equal(await page.evaluate(`document.querySelector('#sound-toggle').getAttribute('aria-pressed')`), 'false');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#sound-toggle'), '::before').content`), '"♪×"');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#sound-toggle'), '::before').color`), 'rgb(255, 0, 0)');
    assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(soundStorageKey)})`), '0');
    const mutedCount = await page.evaluate('soundAudit.tones.length');
    await pointerClick(page, '#undo');
    await pointerClick(page, '#new-game');
    await pointerClick(page, '#confirm-accept');
    assert.equal(await page.evaluate('soundAudit.tones.length'), mutedCount, 'Muted controls do not create sound nodes');
    assert.equal(browser.network.slice(requestStart).filter(url => new URL(url).pathname !== `${prefix}sw.js`).length, 0, 'Sound synthesis does not fetch assets');
    await page.navigate(server.url);
    assert.equal(await textOf(page, '#sound-toggle'), ' 音声オフ');
    await pointerClick(page, '#redo');
    assert.equal(await page.evaluate('soundAudit.contexts.length'), 0, 'The saved mute setting prevents context creation');
    await loadFixture(page, nearWinGame(engine), server.url);
    await pointerClick(page, '[data-card="51"]');
    await pointerClick(page, position('foundations', 3));
    assert.equal(await page.evaluate('soundAudit.contexts.length'), 0, 'A muted victory does not create or play audio');
    await pointerClick(page, '#sound-toggle');
    await page.waitFor(`soundAudit.contexts[0]?.state === 'running'`, 'sound re-enabled by real click');
    assert.equal(await textOf(page, '#sound-toggle'), ' 音声オン');
    assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(soundStorageKey)})`), '1');
    await page.evaluate(`window.soundOriginalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
      if (key === ${JSON.stringify(soundStorageKey)}) throw new DOMException('Sound setting denied', 'QuotaExceededError');
      return soundOriginalSetItem.call(this, key, value);
    }`);
    await pointerClick(page, '#sound-toggle');
    assert.equal(await textOf(page, '#sound-toggle'), ' 音声オフ', 'Muting remains usable when saving is denied');
  } finally {
    await page.command('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await page.navigate(server.url);
  }
  const unsupported = await page.command('Page.addScriptToEvaluateOnNewDocument', { source: 'window.AudioContext = undefined' });
  try {
    await loadFixture(page, orderedGame(), server.url);
    await pointerClick(page, position('tableau', 0, 6));
    await pointerClick(page, position('cells', 0));
    assert.equal(await textOf(page, '#moves'), '1', 'Unavailable audio never blocks card movement');
  } finally {
    await page.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: unsupported.identifier });
    await page.navigate(server.url);
  }
  console.log('PASS sound: gain 0.1 except win 0.5, shared click/drag tones for all destinations, three-note start only on new deal, no extra movement clicks, 900 ms six-note triangle fanfare only on completion, stop/redo/mute guards, current-state labels, no audio fetch, saved mute');
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
  assert.equal(await page.evaluate(`document.querySelectorAll('#board [aria-pressed="true"]').length`), 2);
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

/** 実際のタイマーと Web Animations を観測し、4 枚の独立性・上下限・中止を確かめる。 */
async function checkVictoryEffects(page, server, engine, browser) {
  await loadFixture(page, nearWinGame(engine), server.url);
  await page.evaluate(`(() => {
    const audit = window.winAudit = { timers: [], pending: new Map(), animations: [], maximum: 0 };
    const timeout = window.setTimeout;
    const clear = window.clearTimeout;
    const animate = Element.prototype.animate;
    window.originalRandom = Math.random;
    Math.random = () => 0;
    window.setTimeout = function (callback, delay, ...args) {
      const record = { delay, at: performance.now() };
      const id = timeout(() => {
        audit.pending.delete(id);
        callback(...args);
      }, delay);
      if (delay >= 1000 && delay <= 15000) {
        audit.timers.push(record);
        audit.pending.set(id, record);
      }
      return id;
    };
    window.clearTimeout = function (id) { audit.pending.delete(id); clear(id); };
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);
      if (JSON.stringify(frames).includes('rotateY')) {
        audit.animations.push({ card: this.dataset.card, frames, duration: options.duration, at: performance.now(), animation });
        audit.maximum = Math.max(audit.maximum, audit.animations.filter(item => item.animation.playState === 'running').length);
      }
      return animation;
    };
  })()`);
  const last = await page.evaluate(`document.querySelector('[data-zone="tableau"][data-card]').dataset.card`);
  await page.click(`[data-card="${last}"]`);
  await page.click(position('foundations', 3));
  await page.waitFor('winAudit.animations.length === 4', 'four simultaneous king rotations');
  const first = await page.evaluate(`({ delays: winAudit.timers.slice(0, 4).map(item => item.delay),
    cards: winAudit.animations.map(item => Number(item.card)), durations: winAudit.animations.map(item => item.duration),
    transforms: winAudit.animations[0].frames.map(frame => frame.transform), maximum: winAudit.maximum })`);
  assert.deepEqual(first.delays, [1000, 1000, 1000, 1000]);
  assert.deepEqual(first.cards, [12, 25, 38, 51]);
  assert.deepEqual(first.durations, [100, 100, 100, 100]);
  assert.deepEqual(first.transforms, ['rotateY(0deg)', 'rotateY(360deg)']);
  assert.equal(first.maximum, 4, 'All four kings may rotate concurrently');
  await page.click('#undo');
  assert.equal(await page.evaluate('winAudit.pending.size'), 0);
  assert.equal(await page.evaluate(`winAudit.animations.filter(item => item.animation.playState === 'running').length`), 0);

  // 最長の回転でも、次の開始は回転終了からではなく前の開始から約 1 秒後になる。
  await page.evaluate(`winAudit.timers = []; winAudit.animations = []; window.randomCalls = 0;
    Math.random = () => { const call = randomCalls++; return call < 4 || (call - 4) % 2 ? 0 : 1 - Number.EPSILON; }`);
  await page.click('#redo');
  await page.waitFor('winAudit.animations.length >= 8', 'second independently scheduled king rotations');
  const intervals = await page.evaluate(`winAudit.animations.slice(0, 4).map(first => {
    const second = winAudit.animations.find(item => item.card === first.card && item !== first);
    return { duration: first.duration, interval: second.at - first.at };
  })`);
  assert.ok(intervals.every(item => item.duration >= 499 && item.duration <= 500));
  assert.ok(intervals.every(item => item.interval >= 900 && item.interval <= 1200),
    `A 500 ms rotation must still start every 1 second: ${JSON.stringify(intervals)}`);
  await page.click('#undo');

  // 最初の待機は 1 秒、回転から後は最大値近くにして、15 秒を実際に待たず上下限を検証する。
  await page.evaluate(`winAudit.timers = []; winAudit.animations = []; window.randomCalls = 0; Math.random = () => randomCalls++ < 4 ? 0 : 1 - Number.EPSILON`);
  await page.click('#redo');
  await page.waitFor('winAudit.animations.length === 4 && winAudit.timers.length === 8', 'maximum speed and independently rescheduled waits');
  const maximum = await page.evaluate(`({ durations: winAudit.animations.map(item => item.duration), delays: winAudit.timers.slice(4).map(item => item.delay) })`);
  assert.ok(maximum.durations.every(duration => duration >= 499 && duration <= 500));
  assert.ok(maximum.delays.every(delay => delay >= 14999 && delay <= 15000));
  await page.click('#undo');

  // 各札が別々の乱数を使い、全体で一つの頻度にそろえられていないことを確かめる。
  await page.evaluate(`winAudit.timers = []; window.randomValues = [0, .25, .5, 1 - Number.EPSILON]; Math.random = () => randomValues.shift() ?? .5`);
  await page.click('#redo');
  const independent = await page.evaluate('winAudit.timers.map(item => item.delay)');
  assert.equal(independent.length, 4);
  assert.equal(new Set(independent).size, 4);
  assert.ok(independent.every(delay => delay >= 1000 && delay <= 15000));

  await page.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.waitFor('winAudit.pending.size === 0', 'reduced motion cancels all king timers');
  assert.equal(await page.evaluate('document.getAnimations().length'), 0);
  await page.command('Emulation.setEmulatedMedia', { features: [] });
  await page.waitFor('winAudit.pending.size === 4', 'motion preference restoration schedules four kings');
  const background = await browser.page();
  try {
    await background.command('Page.bringToFront');
    await page.waitFor('document.hidden && winAudit.pending.size === 0', 'hidden victory suspends four kings');
    await page.command('Page.bringToFront');
    await page.waitFor('!document.hidden && winAudit.pending.size === 4', 'visible victory resumes four kings');
  } finally {
    await background.command('Page.close');
  }
  await page.click('#win-new');
  assert.equal(await page.evaluate('winAudit.pending.size'), 0);
  assert.equal(await page.evaluate('document.getAnimations().length'), 0);
  await page.evaluate('Math.random = window.originalRandom');
  console.log('PASS victory effects: four independent rotateY animations, 100–500 ms, 1–15 s start intervals, overlap, undo/new/reduced-motion/visibility cancellation');
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
    await waitAutomatic(page, 53);
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
    assert.equal(await page.evaluate(`document.querySelectorAll('#board [aria-pressed="true"]').length`), 0);
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
  // 上限間際でも更新経路を試せるよう、規則を追加せず既存の背景色だけを置き換える。
  const updatedCSS = css.replace('#f6f5ef', '#f6f5ee');
  assert.notEqual(updatedCSS, css, 'The update fixture must change the stylesheet');
  await writeFile(join(source, 'styles.css'), updatedCSS);
  const oldStylesheet = await page.evaluate(`document.querySelector('link[rel="stylesheet"]').href`);
  const originalCaches = await page.evaluate('caches.keys()');
  const updateStart = server.requests.length;
  await build(source, join(temp, 'live'));
  await page.evaluate(`navigator.serviceWorker.getRegistration().then(registration => registration.update())`);
  await page.waitFor(`navigator.serviceWorker.getRegistration().then(registration => Boolean(registration?.waiting))`, 'waiting updated service worker');
  await page.waitFor(`!document.querySelector('#apply-update').hidden`, 'update button');
  assert.equal(await page.evaluate(`document.querySelector('link[rel="stylesheet"]').href`), oldStylesheet);
  assert.equal(await textOf(page, '#moves'), '1');
  const waitingCaches = await page.evaluate('caches.keys()');
  assert.ok(originalCaches.every((name) => waitingCaches.includes(name)), 'Old cache must remain while the game is open');
  const updateRequests = server.requests.slice(updateStart);
  assert.ok(updateRequests.every((request) => !/\/(?:game|storage|main|offline|drag)-|\/fonts\//.test(request.path)), 'Unchanged JS and font should be reused from the old application cache');
  console.log(`Update HTTP: ${updateRequests.length} requests, ${updateRequests.reduce((sum, request) => sum + request.bytes, 0)} body bytes`);
  console.log('PASS update waiting: unchanged JS reused; active game and old cache retained');
  return { oldStylesheet, originalCaches };
}

/** クリックしたタブだけを新版へ進め、保存拒否・別タブ・オフラインでも進行を守る。 */
async function checkClickUpdate(page, browser, server, temp) {
  const other = await browser.page();
  let uncontrolled;
  try {
    await other.navigate(server.url);
    await other.click('#undo');
    assert.equal(await textOf(other, '#moves'), '0');
    const otherOrigin = await other.evaluate('performance.timeOrigin');
    // スーパーリロード相当の制御外文書でも、待機版の適用通知とボタンを使える。
    uncontrolled = await browser.page();
    await uncontrolled.command('Network.setBypassServiceWorker', { bypass: true });
    await uncontrolled.navigate(server.url);
    assert.equal(await uncontrolled.evaluate('navigator.serviceWorker.controller'), null);
    await uncontrolled.command('Network.setBypassServiceWorker', { bypass: false });
    await uncontrolled.click('#redo');
    await uncontrolled.click('#redo');
    assert.equal(await textOf(uncontrolled, '#moves'), '2');
    const uncontrolledOrigin = await uncontrolled.evaluate('performance.timeOrigin');
    await page.command('Page.bringToFront');
    const update = await prepareUpdate(page, server, temp);
    const origin = await page.evaluate('performance.timeOrigin');

    // 保存不能なら SW の切替すら始めず、現在の対局と更新ボタンを保つ。
    await page.evaluate(`window.originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage) throw new DOMException('Test save failure', 'QuotaExceededError');
        return window.originalSetItem.call(this, key, value);
      }`);
    await page.click('#apply-update');
    assert.equal(await page.evaluate('performance.timeOrigin'), origin);
    assert.match(await textOf(page, '#offline-status'), /保存できない/);
    assert.equal(await page.evaluate(`document.querySelector('#apply-update').disabled`), false);
    assert.equal(await page.evaluate(`navigator.serviceWorker.getRegistration().then(registration => Boolean(registration.waiting))`), true);
    await page.evaluate('Storage.prototype.setItem = window.originalSetItem; delete window.originalSetItem');

    // 新版一式の準備後は配信元を停止しても適用できる。連打で再読込を重ねない。
    await server.close();
    await page.evaluate(`document.querySelector('#apply-update').click(); document.querySelector('#apply-update').click()`);
    await page.waitFor(`performance.timeOrigin !== ${origin} && document.readyState === 'complete'
      && document.querySelector('[data-zone="tableau"]')`, 'clicked update reload');
    await page.evaluate('document.fonts.ready.then(() => true)');
    const newOrigin = await page.evaluate('performance.timeOrigin');
    const newStylesheet = await page.evaluate(`document.querySelector('link[rel="stylesheet"]').href`);
    assert.notEqual(newStylesheet, update.oldStylesheet);
    assert.equal(await textOf(page, '#moves'), '1');
    assert.equal(await page.evaluate(`document.querySelector('#auto-enabled').checked`), true);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(position('cells', 0))}).dataset.card`), '19');
    assert.equal(await page.evaluate(`sessionStorage.getItem(${JSON.stringify(`${storageKey}:reload`)})`), null);
    await pause(150);
    assert.equal(await page.evaluate('performance.timeOrigin'), newOrigin, 'An update click must reload only once');
    assert.equal(await other.evaluate('performance.timeOrigin'), otherOrigin, 'Updating one tab must not reload another game');
    assert.equal(await textOf(other, '#moves'), '0');
    assert.equal(await other.evaluate(`document.querySelector('link[rel="stylesheet"]').href`), update.oldStylesheet);
    await other.waitFor(`!document.querySelector('#apply-update').hidden`, 'other tab update button');
    assert.equal(await other.evaluate(`fetch(${JSON.stringify(update.oldStylesheet)}, { cache: 'reload' }).then(response => response.ok)`), true,
      'An older open tab must still obtain its hashed assets without the server');
    const retainedCaches = await page.evaluate('caches.keys()');
    assert.ok(update.originalCaches.every(name => retainedCaches.includes(name)), 'Old open tabs retain their cache');
    assert.equal(await uncontrolled.evaluate('performance.timeOrigin'), uncontrolledOrigin);
    await uncontrolled.waitFor(`!document.querySelector('#apply-update').hidden`, 'uncontrolled tab update button');

    // 既に新版 SW が動いていても、タブ固有の控えを保存できなければ再読込をしない。
    await other.evaluate(`window.originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === sessionStorage) throw new DOMException('Test session failure', 'QuotaExceededError');
        return window.originalSetItem.call(this, key, value);
      }`);
    await other.click('#apply-update');
    assert.equal(await other.evaluate('performance.timeOrigin'), otherOrigin);
    assert.match(await textOf(other, '#offline-status'), /保存できない/);
    assert.equal(await other.evaluate(`document.querySelector('#apply-update').disabled`), false);
    await other.evaluate('Storage.prototype.setItem = window.originalSetItem; delete window.originalSetItem');
    await other.click('#apply-update');
    await other.waitFor(`performance.timeOrigin !== ${otherOrigin} && document.readyState === 'complete'
      && document.querySelector('[data-zone="tableau"]')`, 'other tab requested reload');
    assert.equal(await other.evaluate(`document.querySelector('link[rel="stylesheet"]').href`), newStylesheet);
    assert.equal(await textOf(other, '#moves'), '0', 'The second tab must keep its own game instead of restoring the first tab');
    assert.equal(await other.evaluate(`sessionStorage.getItem(${JSON.stringify(`${storageKey}:reload`)})`), null);
    assert.equal(await page.evaluate('performance.timeOrigin'), newOrigin);
    await uncontrolled.click('#apply-update');
    await uncontrolled.waitFor(`performance.timeOrigin !== ${uncontrolledOrigin} && document.readyState === 'complete'
      && document.querySelector('[data-zone="tableau"]')`, 'uncontrolled tab requested reload');
    assert.equal(await uncontrolled.evaluate(`document.querySelector('link[rel="stylesheet"]').href`), newStylesheet);
    assert.equal(await uncontrolled.evaluate('Boolean(navigator.serviceWorker.controller)'), true);
    assert.equal(await textOf(uncontrolled, '#moves'), '2');
  } finally {
    await other.command('Page.close');
    await uncontrolled?.command('Page.close');
  }
  // 共有 localStorage へ最後に保存したタブを明示し、オフライン再起動の基準をそろえる。
  await page.command('Page.bringToFront');
  await page.click('#redo');
  assert.equal(await textOf(page, '#moves'), '2');
  await page.click('#undo');
  assert.equal(await textOf(page, '#moves'), '1');
  console.log('PASS click update: saved progress and settings, one reload, independent/previously uncontrolled tabs, storage failures, offline activation and old assets');
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
    assert.equal(await page.evaluate(`document.querySelector('#apply-update').hidden`), true, 'A first installation has no pending update');
    await checkCardFont(page, browser, server.url, 'online');
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
    await checkHistoryShortcuts(page, server);
    await checkSound(page, server, engine, browser);
    await checkQuickMove(page, server);
    await checkAutomaticStart(page, server);
    await checkAutomaticHome(page, server, engine, browser);
    await checkAutomaticAnimation(page, server, browser);
    await checkGroupMove(page, server, engine);
    await checkDragAndDrop(page, server, engine, browser);
    await checkPinchZoom(page, server, browser);
    await checkLandscapeScroll(page, server, engine, browser, temp);
    await checkMaximization(page, server, browser, temp);
    await checkWin(page, server, engine);
    await checkVictoryEffects(page, server, engine, browser);
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
    await page.click('#sound-toggle');
    assert.equal(await textOf(page, '#sound-toggle'), ' 音声オフ');
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
    if (!externalUrl) {
      await checkClickUpdate(page, browser, server, temp);
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
    assert.equal(await textOf(page, '#sound-toggle'), ' 音声オフ', 'Muted sound survives a complete offline browser restart');
    await checkCardFont(page, browser, server.url, 'offline restart');
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
