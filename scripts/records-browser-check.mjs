/** 成績の保存・一覧・小画面・オフラインと、4 枚同時の絵札回転を実 Chromium で確認する。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '../src/game.js';
import { launchBrowser, startServer, loadFixture, orderedGame, nearWinGame, position,
  textOf, pointerClick, key, pause, waitAutomatic } from './browser-check.mjs';

const temp = await mkdtemp(join(tmpdir(), 'freecell-records-'));
const server = await startServer(new URL('../dist', import.meta.url).pathname);
const profile = join(temp, 'profile');
const storageKey = 'freecell:/free-freecell/:v1';
const recordsKey = `${storageKey}:records`;
let browser;

/** 最終カードを置く前の局に、現在の保存形式の試行 ID・累積操作数を与える。 */
function nearWin(seconds, actions) {
  return { ...nearWinGame(engine), id: crypto.randomUUID(), actions, elapsedMs: seconds * 1000 };
}

/** ランキングダイアログを表示し、各リストを文字列として取り出す。 */
async function ranking(page) {
  await page.evaluate('document.querySelector("#records-link").focus()');
  await key(page, 'Enter');
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), true);
  assert.equal(await page.evaluate('document.activeElement.id'), 'records-title');
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").scrollTop'), 0);
  return page.evaluate('["best-time", "best-moves"].map(id => [...document.getElementById(id).children].map(item => item.textContent))');
}

/** ダイアログを閉じた後のフォーカスも確認し、次の盤面操作へ進む。 */
async function closeRanking(page) {
  await page.evaluate('document.querySelector("#records-dialog button").focus()');
  await pointerClick(page, '#records-dialog button');
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), false);
  assert.equal(await page.evaluate('document.activeElement.id'), 'records-link');
}

try {
  browser = await launchBrowser(profile);
  let page = await browser.page();
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.navigate(server.url);
  await page.waitFor('navigator.serviceWorker.ready.then(() => true)', 'offline ready');
  assert.deepEqual(await ranking(page), [[], []]);
  await closeRanking(page);
  // Web Animations の実処理はそのまま残し、各スートの開始時刻と指定時間を観測する。
  const audit = await page.command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.celebrationAudit = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      if (this.matches('.foundations .card')) celebrationAudit.push({ card: this.dataset.card, at: performance.now(), frames, duration: options.duration });
      return animate.call(this, frames, options);
    };
  })()` });

  const attempts = [[100, 89], [150, 59], [120, 79], [100, 69], [200, 51]];
  for (const [index, [seconds, actions]] of attempts.entries()) {
    const game = nearWin(seconds, actions);
    await loadFixture(page, game, server.url);
    await pointerClick(page, '[data-card="51"]');
    await pointerClick(page, position('foundations', 3));
    assert.equal(await textOf(page, '#moves'), String(actions + 1));
    const saved = await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`);
    assert.equal(saved.recorded, true);
    if (index === 0) {
      await page.waitFor('celebrationAudit.length >= 4', 'four kings begin together');
      const first = await page.evaluate('celebrationAudit.slice(0, 4)');
      assert.deepEqual(first.map(item => item.duration), [250, 250, 250, 250]);
      assert.ok(Math.max(...first.map(item => item.at)) - Math.min(...first.map(item => item.at)) < 20);
      // 各フリップの中間で Q、次に J が実際の DOM に現れ、最後は K に戻る。
      await page.waitFor(`[...document.querySelectorAll('.foundations .card-face')].every(face => face.textContent.codePointAt(0) % 16 === 13)`, 'four queens');
      await page.waitFor(`[...document.querySelectorAll('.foundations .card-face')].every(face => face.textContent.codePointAt(0) % 16 === 11)`, 'four jacks');
      await page.waitFor('celebrationAudit.length >= 24', 'last four flips');
      await pause(130);
      const flips = await page.evaluate('celebrationAudit.slice(0, 24)');
      for (const card of ['12', '25', '38', '51']) {
        const steps = flips.filter(item => item.card === card);
        assert.deepEqual(steps.map(item => item.duration), [250, 250, 100, 100, 100, 100]);
        assert.ok(steps[2].at - steps[1].at >= 340, 'Q holds for at least 100 ms after its second half');
        assert.ok(steps[4].at - steps[3].at >= 190, 'J holds for at least 100 ms after its second half');
      }
      assert.equal(await page.evaluate(`[...document.querySelectorAll('.foundations .card-face')].every(face => face.textContent.codePointAt(0) % 16 === 14)`), true);
      assert.deepEqual(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).history`), saved.history);
    }
  }
  const records = await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordsKey)}))`);
  assert.deepEqual(records[1].map(entry => entry.moves), [52, 60, 70]);
  assert.deepEqual(records[0].map(entry => entry.moves), [90, 70, 80]);
  for (const list of records) for (const entry of list) assert.match(entry.date, /^\d{4}-\d{2}-\d{2}T/);
  await page.click('#undo');
  assert.equal(await textOf(page, '#moves'), '53');
  await page.click('#redo');
  assert.equal(await textOf(page, '#moves'), '54');
  await page.navigate(server.url);
  assert.deepEqual(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordsKey)}))`), records, 'Undo/Redo and restoration must not duplicate a completed attempt');

  for (const [width, height] of [[1280, 900], [390, 844], [844, 390]]) {
    await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (width < 900) await page.click('#maximize');
    const lists = await ranking(page);
    assert.equal(lists[0].length, 3);
    assert.deepEqual(lists[1].map(text => text.split(' · ')[0]), ['52手', '60手', '70手']);
    const actions = await textOf(page, '#moves');
    await key(page, 'z', 2);
    assert.equal(await textOf(page, '#moves'), actions, 'History shortcuts do not operate behind the dialog');
    const bounds = await page.evaluate(`(() => { const d = document.querySelector('#records-dialog'); const r = d.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight }; })()`);
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height);
    const shot = await page.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(temp, `ranking-${width}x${height}.png`), Buffer.from(shot.data, 'base64'));
    await closeRanking(page);
    if (width < 900) await page.click('#maximize');
  }
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await loadFixture(page, nearWinGame(engine), server.url);
  await page.click('#auto-home');
  await waitAutomatic(page);
  assert.deepEqual(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordsKey)}))`), records, 'Legacy games remain playable without an inaccurate record');

  // 保存拒否は対局を止めず、同じ画面でランキングを開くと再試行できる。
  await loadFixture(page, nearWin(30, 51), server.url);
  await page.evaluate(`window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
    if (key === ${JSON.stringify(recordsKey)}) throw new DOMException('denied', 'QuotaExceededError');
    return originalSetItem.call(this, key, value);
  }`);
  await page.click('#auto-home');
  await waitAutomatic(page);
  assert.equal(await page.evaluate('document.querySelector("#win-panel").hidden'), false);
  assert.match(await textOf(page, '#storage-status'), /成績を保存できません/);
  const pending = await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).result`);
  // 保存失敗の後で Undo/Redo して翌日に再試行しても、最初の達成を登録する。
  await page.click('#undo');
  await page.click('#redo');
  await page.evaluate(`window.OriginalDate = Date; window.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [OriginalDate.now() + 86400000])); }
  }`);
  await page.evaluate('Storage.prototype.setItem = originalSetItem');
  await ranking(page);
  await closeRanking(page);
  const finalRecords = await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordsKey)}))`);
  assert.equal(finalRecords[0][0].moves, 52);
  assert.deepEqual(finalRecords[0][0], pending);
  await page.command('Page.removeScriptToEvaluateOnNewDocument', { identifier: audit.identifier });
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
  await browser.close();
  await server.close();
  browser = await launchBrowser(profile, true);
  page = await browser.page();
  await page.command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.navigate(server.url);
  assert.equal((await ranking(page))[0].length, 3);
  assert.deepEqual(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordsKey)}))`), finalRecords);
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
  console.log('PASS records: independent top three/date/ties, new attempts only, cumulative actions, no duplicate win, modal/keyboard/fullscreen, denied-write retry and offline restart');
  console.log('PASS celebration: four concurrent K/Q/J/K flips, 500/100/200/100/200 ms, unchanged game history');
  console.log('Screenshots: ' + temp);
} finally {
  await browser?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
