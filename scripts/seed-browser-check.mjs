/** シード入力・配札再現・保存互換・小画面と、完全オフライン再起動を実 Chromium で確認する。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '../src/game.js';
import { launchBrowser, startServer, loadFixture, orderedGame, nearWinGame, position,
  textOf, pointerClick, key, pause, waitAutomatic } from './browser-check.mjs';

const temp = await mkdtemp(join(tmpdir(), 'freecell-seed-'));
const profile = join(temp, 'profile');
const server = await startServer(new URL('../dist', import.meta.url).pathname);
const storageKey = 'freecell:/free-freecell/:v1';
const recordsKey = `${storageKey}:records`;
let browser;

const savedGame = (page) => page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`);

/** 各端末条件で viewport とタッチ判定を固定し、前のケースのスクロールを引き継がない。 */
async function viewport(page, width = 1280, height = 900) {
  await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await page.evaluate('scrollTo(0, 0)');
}

/** 実入力でダイアログを開き、初期フォーカスがシード入力へ移ることを確認する。 */
async function openSeed(page) {
  await page.evaluate('document.querySelector("#seed-game").scrollIntoView({ block: "nearest" })');
  await pointerClick(page, '#seed-game');
  await page.waitFor('document.querySelector("#seed-dialog").open', 'seed dialog opens');
  assert.equal(await page.evaluate('document.activeElement.id'), 'seed-input');
}

/** 貼り付けと同じテキスト入力経路を使い、空欄や全角文字を勝手に数値へ直さず渡す。 */
async function fillSeed(page, value) {
  await page.evaluate('document.querySelector("#seed-input").focus(); document.querySelector("#seed-input").select()');
  await page.command('Input.insertText', { text: value });
}

/** 指定シードで開始し、必要な場合だけ進行中の局を置き換える確認を承認する。 */
async function startSeed(page, value, expected = Number(value)) {
  const previous = await savedGame(page);
  await openSeed(page);
  await fillSeed(page, value);
  await pointerClick(page, '#seed-start');
  if (previous.started && !engine.isWon(engine.getBoard(previous))) {
    await page.waitFor('document.querySelector("#confirm-dialog").open', 'seed replacement confirmation');
    await pointerClick(page, '#confirm-accept');
  }
  await page.waitFor(`!document.querySelector('#seed-dialog').open && JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).id !== ${JSON.stringify(previous.id)}`,
    'seeded game starts');
  const game = await savedGame(page);
  assert.equal(game.seed, expected);
  assert.equal(await textOf(page, '#seed'), String(expected));
  assert.equal(game.started, false);
  assert.equal(game.actions, 0);
  assert.equal(game.elapsedMs, 0);
  assert.deepEqual(engine.getBoard(game), engine.getBoard(engine.createGame(expected)), 'Browser and source agree on the seeded deal');
  return game;
}

/** 同じ意味の表記は同じ配札となり、別シードと通常生成は正しいシードを表示する。 */
async function checkReproduction(page) {
  const first = await savedGame(page);
  assert.ok(Number.isInteger(first.seed) && first.seed >= 0 && first.seed <= 4294967295);
  assert.equal(await textOf(page, '#seed'), String(first.seed));
  assert.deepEqual(engine.getBoard(first), engine.getBoard(engine.createGame(first.seed)));
  const requestStart = browser.network.length;
  const zero = await startSeed(page, '0');
  const zeroAgain = await startSeed(page, '0000000000', 0);
  assert.deepEqual(zeroAgain.history[0], zero.history[0]);
  assert.notEqual(zeroAgain.id, zero.id, 'The same deal still starts a distinct ranked attempt');
  const fullWidth = await startSeed(page, '４２９４９６７２９５', 4294967295);
  const maximum = await startSeed(page, '4294967295');
  assert.deepEqual(fullWidth.history[0], maximum.history[0]);
  assert.notDeepEqual(maximum.history[0], zero.history[0]);
  await startSeed(page, ' 42 ', 42);
  const beforeNew = await savedGame(page);
  await pointerClick(page, '#new-game');
  await page.waitFor(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).id !== ${JSON.stringify(beforeNew.id)}`,
    'ordinary new game is committed');
  const random = await savedGame(page);
  assert.equal(await textOf(page, '#seed'), String(random.seed));
  assert.deepEqual(random.history[0], engine.getBoard(engine.createGame(random.seed)));
  assert.equal(browser.network.slice(requestStart).filter(url => !url.endsWith('/sw.js')).length, 0,
    'Seeded and ordinary new games create no gameplay request');
}

/** 不正入力・取消・入力欄でのショートカットが進行とシードを変えないことを確認する。 */
async function checkInputAndHistory(page) {
  await startSeed(page, '42');
  await openSeed(page);
  const initial = await savedGame(page);
  for (const invalid of ['', '-1', '1.5', '1e3', 'seed', '4294967296']) {
    await fillSeed(page, invalid);
    await pointerClick(page, '#seed-start');
    assert.equal(await page.evaluate('document.querySelector("#seed-dialog").open'), true);
    assert.equal(await page.evaluate('document.querySelector("#confirm-dialog").open'), false);
    assert.deepEqual(await savedGame(page), initial, 'Invalid seed does not replace the game');
    assert.ok(await textOf(page, '#seed-error'), 'Invalid input has a visible error message');
  }
  await pointerClick(page, '#seed-cancel');
  await page.waitFor('!document.querySelector("#seed-dialog").open', 'seed dialog cancelled');
  assert.deepEqual(await savedGame(page), initial);

  await pointerClick(page, position('tableau', 0, 6));
  await pointerClick(page, position('cells', 0));
  assert.equal(await textOf(page, '#moves'), '1');
  const progressed = await savedGame(page);
  await openSeed(page);
  await fillSeed(page, '123');
  await key(page, 'z', 2);
  await key(page, 'y', 2);
  await page.evaluate(`document.querySelector('#seed-input').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z', ctrlKey: true, isComposing: true, bubbles: true
  }))`);
  assert.equal(await textOf(page, '#moves'), '1', 'Input undo and IME do not undo cards');
  await fillSeed(page, '123');
  await pointerClick(page, '#seed-start');
  await page.waitFor('document.querySelector("#confirm-dialog").open', 'replacement is confirmed before changing a played game');
  await pointerClick(page, '#confirm-cancel');
  await page.waitFor('!document.querySelector("#confirm-dialog").open', 'replacement cancelled');
  const cancelled = await savedGame(page);
  assert.equal(cancelled.seed, 42);
  assert.equal(cancelled.id, progressed.id);
  assert.deepEqual(cancelled.history, progressed.history);
  if (await page.evaluate('document.querySelector("#seed-dialog").open')) await key(page, 'Escape');
  await startSeed(page, '123');
  await pointerClick(page, position('tableau', 0, 6));
  await pointerClick(page, position('cells', 0));
  await pointerClick(page, '#undo');
  await pointerClick(page, '#redo');
  assert.equal(await textOf(page, '#seed'), '123');
  await page.navigate(server.url);
  assert.equal(await textOf(page, '#seed'), '123');
  const beforeRestart = await savedGame(page);
  await pointerClick(page, '#restart');
  await page.waitFor('document.querySelector("#confirm-dialog").open', 'restart confirmation');
  await pointerClick(page, '#confirm-accept');
  await page.waitFor('document.querySelector("#moves").textContent === "0"', 'seeded restart');
  const restarted = await savedGame(page);
  assert.equal(restarted.seed, 123);
  assert.notEqual(restarted.id, beforeRestart.id);
  assert.deepEqual(restarted.history[0], beforeRestart.history[0]);
}

/** 新旧の成績を混在させ、シード0を空欄と誤認せず、旧記録は空欄で表示する。 */
async function checkRankings(page) {
  const entry = { id: crypto.randomUUID(), date: '2020-01-01T00:00:00.000Z', time: 100, moves: 100 };
  await page.evaluate(`localStorage.setItem(${JSON.stringify(recordsKey)}, ${JSON.stringify(JSON.stringify([[entry], [entry]]))})`);
  const legacy = orderedGame();
  await loadFixture(page, legacy, server.url);
  assert.equal(await textOf(page, '#seed'), '', 'A legacy unfinished deal has no invented seed');
  await pointerClick(page, '#records-link');
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".record-seed")].map(item => item.textContent)'), ['', '']);
  await pointerClick(page, '#records-dialog button[value=close]');
  await page.waitFor('!document.querySelector("#records-dialog").open', 'legacy records closed');
  const game = { ...nearWinGame(engine), id: crypto.randomUUID(), actions: 51, elapsedMs: 1000, seed: 0 };
  await loadFixture(page, game, server.url);
  await page.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await pointerClick(page, '#auto-home');
  await waitAutomatic(page);
  await page.waitFor('document.querySelector("#records-dialog").open', 'seeded result achievement');
  const records = await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordsKey)}))`);
  for (const list of records) {
    assert.equal(list[0].seed, 0);
    assert.equal(list[1].seed, '');
  }
  assert.equal((await savedGame(page)).result.seed, 0);
  await pointerClick(page, '#records-dialog button[value=records]');
  await page.waitFor('document.querySelector("#records-title").textContent === "成績ランキング"', 'seeded result list');
  const rendered = await page.evaluate('[...document.querySelectorAll(".record-seed")].map(item => item.textContent)');
  assert.match(rendered[0], /0/);
  assert.equal(rendered[1], '');
  assert.match(rendered[2], /0/);
  assert.equal(rendered[3], '');
  await pointerClick(page, '#records-dialog button[value=close]');
  await page.waitFor('!document.querySelector("#records-dialog").open', 'seeded result list closed');
  await page.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
}

/** 通常表示・最大化でシードが読め、入力モーダルを画面内から操作できることを確認する。 */
async function checkLayout(page) {
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 900]]) {
    await viewport(page, width, height);
    await loadFixture(page, engine.createGame(4294967295), server.url);
    if (width < 900) await page.click('#maximize');
    assert.equal(await textOf(page, '#seed'), '4294967295');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    if (width < 900) {
      await page.evaluate('document.querySelector("#seed").scrollIntoView({block: "nearest"})');
      assert.equal(await page.evaluate(`(() => {
        const seed = document.querySelector('#seed').getBoundingClientRect();
        const board = document.querySelector('#board-scroll').getBoundingClientRect();
        return seed.left >= 0 && seed.right <= board.left && seed.bottom <= innerHeight;
      })()`), true, 'The maximized seed is visible in the left sidebar');
    }
    await openSeed(page);
    const bounds = await page.evaluate(`(() => {
      const dialog = document.querySelector('#seed-dialog'); const box = dialog.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        overflow: dialog.scrollWidth > dialog.clientWidth,
        inputs: [...dialog.querySelectorAll('input, button')].map(item => {
          const rect = item.getBoundingClientRect();
          return item.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        }) };
    })()`);
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= width && bounds.bottom <= height, JSON.stringify(bounds));
    assert.equal(bounds.overflow, false);
    assert.ok(bounds.inputs.every(Boolean), 'Seed input and buttons are reachable');
    const shot = await page.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(temp, `seed-${width}x${height}.png`), Buffer.from(shot.data, 'base64'));
    const before = await savedGame(page);
    await key(page, 'Escape');
    await page.waitFor('!document.querySelector("#seed-dialog").open', 'Escape closes seed mode');
    assert.deepEqual(await savedGame(page), before);
    if (width < 900) {
      assert.equal(await page.evaluate('document.body.classList.contains("maximized")'), true);
      await page.click('#maximize');
    }
  }
  await viewport(page);
}

try {
  browser = await launchBrowser(profile);
  let page = await browser.page();
  await viewport(page);
  await page.navigate(server.url);
  await page.waitFor('navigator.serviceWorker.ready.then(() => true)', 'offline cache prepared');
  await checkReproduction(page);
  await checkInputAndHistory(page);
  await checkRankings(page);
  await checkLayout(page);
  const shared = await startSeed(page, '20261117');
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
  await browser.close();
  await server.close();
  browser = await launchBrowser(profile, true);
  page = await browser.page();
  await viewport(page);
  await page.command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.navigate(server.url);
  assert.equal(await textOf(page, '#seed'), '20261117');
  const offline = await startSeed(page, '20261117');
  assert.deepEqual(offline.history[0], shared.history[0], 'The same seed survives a completely offline browser restart');
  await pointerClick(page, '#records-link');
  await page.waitFor('document.querySelector("#records-dialog").open', 'offline seeded ranking');
  assert.match(await textOf(page, '#best-time .record-seed'), /0/);
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
  console.log('PASS seed: ordinary and explicit deals share deterministic seeds, 0/max/full-width/leading zeros, no gameplay network');
  console.log('PASS seed input: invalid values, cancel/confirmation/Escape, IME/history guards, restart/undo/redo/reload');
  console.log('PASS seed records: current and legacy games/results, seed zero, blank legacy seed, persisted and displayed independently');
  console.log('PASS seed layout/offline: 320/390/844/1280px, maximized sidebar, reachable modal, complete offline process restart');
  console.log('Screenshots: ' + temp);
} finally {
  await browser?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
