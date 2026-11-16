/** 成績の左右表示・更新の祝福・背後の演出停止・オフラインを実 Chromium で確認する。 */
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
  return { ...nearWinGame(engine), id: crypto.randomUUID(), actions, seed: 4294967295, elapsedMs: seconds * 1000 };
}

/** ランキングダイアログを表示し、各リストを文字列として取り出す。 */
async function ranking(page, expectedError = null) {
  await page.evaluate('document.querySelector("#records-link").focus()');
  await key(page, 'Enter');
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), true);
  assert.equal(await page.evaluate('document.activeElement.id'), 'records-title');
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").scrollTop'), 0);
  const status = await textOf(page, '#records-status');
  if (expectedError) assert.match(status, expectedError);
  else assert.equal(status, '', 'Normal rankings need no explanatory sentence');
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").textContent.includes("最速時間")'), true);
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").textContent.includes("最短クリア時間")'), false);
  return page.evaluate('["best-time", "best-moves"].map(id => [...document.getElementById(id).children].map(item => item.textContent))');
}

/** ダイアログを閉じた後のフォーカスも確認し、次の盤面操作へ進む。 */
async function closeRanking(page) {
  await page.evaluate(`document.querySelector('#records-dialog button[value="close"]').focus()`);
  await pointerClick(page, '#records-dialog button[value=close]');
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), false);
  assert.equal(await page.evaluate('document.activeElement.id'), 'records-link');
}

/** 保存成功後の祝福を待ち、メッセージと読み上げ・フォーカスの入口を確認する。 */
async function recordNotice(page, message) {
  await page.waitFor('document.querySelector("#records-dialog").open', 'new ranking achievement notice', 4000);
  const title = await textOf(page, '#records-title');
  assert.match(title, /ランキング更新、おめでとうございます！$/);
  if (message) assert.equal(title, message);
  assert.equal(await page.evaluate('document.querySelector("#records-dialog table").hidden'), true);
  assert.equal(await page.evaluate('document.querySelector("#record-actions").hidden'), false);
  assert.equal(await page.evaluate('document.activeElement.id'), 'records-title');
  assert.equal(await page.evaluate('document.querySelectorAll("dialog[open]").length'), 1);
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#records-dialog button")].map(button => button.textContent)'),
    ['つづけてチャレンジ', 'ランキングを見る', '閉じる']);
}

/** 祝福の選択を実クリックで確定し、別タスクで届く close 処理が終わるまで待つ。 */
async function closeNotice(page, action = 'close') {
  await pointerClick(page, `#records-dialog button[value="${action}"]`);
  await page.waitFor(action === 'records' ? 'document.querySelector("#records-title").textContent === "成績ランキング"'
    : '!document.querySelector("#records-dialog").open', 'achievement action completes');
  await pause(30);
}

/** 各カテゴリの3位が140秒・80手になる、先に達成した3件を用意する。 */
function noticeBaseline() {
  const entries = [0, 1, 2].map(index => ({ id: crypto.randomUUID(), date: `2020-01-0${index + 1}T00:00:00.000Z`,
    time: 100 + index * 20, moves: 60 + index * 10 }));
  return [entries, entries];
}

/** 上位更新の3パターン、圏外、各ボタン、復元抑止と小画面での表示を確認する。 */
async function checkRecordNotices(page, browser) {
  const original = await page.evaluate(`localStorage.getItem(${JSON.stringify(recordsKey)})`);
  const baseline = noticeBaseline();
  /** 各ケースを同じ保存済みランキングから開始し、前ケースの勝利と混ぜない。 */
  async function prepare(seconds, actions) {
    await page.evaluate(`localStorage.setItem(${JSON.stringify(recordsKey)}, ${JSON.stringify(JSON.stringify(baseline))})`);
    const game = nearWin(seconds, actions);
    await loadFixture(page, game, server.url);
    return game;
  }
  /** 最後のホーム移動を実入力で行い、自動送りが完了するまで待つ。 */
  async function complete() {
    await pointerClick(page, '#auto-home');
    await waitAutomatic(page);
  }
  for (const [seconds, actions, message, action] of [
    [50, 99, '最速時間のランキング更新、おめでとうございます！', 'records'],
    [200, 51, '最小手数のランキング更新、おめでとうございます！', 'new'],
    [50, 51, '最速時間と最小手数のランキング更新、おめでとうございます！', 'close'],
  ]) {
    await prepare(seconds, actions);
    await complete();
    assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), false, 'Celebration remains visible before the popup');
    await recordNotice(page, message);
    const snapshot = await page.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`);
    const records = await page.evaluate(`localStorage.getItem(${JSON.stringify(recordsKey)})`);
    const stopped = await page.evaluate('celebrationAudit.length');
    await key(page, 'z', 2);
    await key(page, 'y', 2);
    assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`), snapshot,
      'History shortcuts do not change a game behind the achievement popup');
    await assertMotionStopped(page, stopped, 'Achievement popup');
    if (action === 'close') {
      const other = await browser.page();
      await other.command('Page.bringToFront');
      await page.waitFor('document.hidden', 'achievement tab hidden');
      await page.command('Page.bringToFront');
      await page.waitFor('!document.hidden', 'achievement tab restored');
      await other.command('Page.close');
      for (const value of ['reduce', 'no-preference']) {
        await page.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
      }
      await assertMotionStopped(page, stopped, 'Achievement popup after visibility and motion preference changes');
    }
    await closeNotice(page, action);
    if (action === 'records') {
      await page.waitFor('document.querySelector("#records-dialog").open', 'achievement opens rankings');
      assert.equal(await page.evaluate('document.activeElement.id'), 'records-title');
      assert.equal(await page.evaluate('document.querySelectorAll("dialog[open]").length'), 1);
      await assertMotionStopped(page, stopped, 'Switching achievement to ranking');
      await closeRanking(page);
      assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`), snapshot);
    } else if (action === 'new') {
      await page.waitFor('document.querySelector("#moves").textContent === "0"', 'continue challenge starts new game');
      assert.equal(await page.evaluate('document.querySelector("#confirm-dialog").open'), false);
      const next = await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`);
      assert.notEqual(next.id, JSON.parse(snapshot).id);
      assert.equal(next.started, false);
      assert.equal(next.elapsedMs, 0);
    } else {
      assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`), snapshot);
      await page.waitFor(`celebrationAudit.length > ${stopped}`, 'rotation resumes after achievement closes', 3000);
    }
    assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(recordsKey)})`), records,
      'Choosing a popup action never changes the saved ranking');
  }

  // 保存済みの勝利は復元・Redo・同じ試行の再登録で何度も祝福しない。
  await page.navigate(server.url);
  await pause(1300);
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), false);
  await pointerClick(page, '#undo');
  await pointerClick(page, '#redo');
  await pause(1300);
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), false);

  for (const [seconds, actions] of [[200, 99], [140, 79]]) {
    await prepare(seconds, actions);
    await complete();
    await pause(1400);
    assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), false,
      'Outside the top three, including a later tie at third place, has no achievement popup');
  }
  await prepare(50, 51);
  await complete();
  await pointerClick(page, '#undo');
  await pause(1400);
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), false,
    'Undo during the celebration prevents a stale achievement popup');

  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 900]]) {
    await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    await prepare(50, 51);
    if (width < 900) await page.click('#maximize');
    await complete();
    await recordNotice(page, '最速時間と最小手数のランキング更新、おめでとうございます！');
    const layout = await page.evaluate(`(() => {
      const dialog = document.querySelector('#records-dialog'); const box = dialog.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight,
        overflow: dialog.scrollWidth > dialog.clientWidth,
        buttons: [...dialog.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { bottom: rect.bottom, hit: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) };
        }) };
    })()`);
    assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height,
      `Achievement popup fits ${width}x${height}: ${JSON.stringify(layout)}`);
    assert.equal(layout.overflow, false);
    assert.ok(layout.buttons.every(button => button.hit && button.bottom <= layout.height));
    const shot = await page.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(temp, `achievement-${width}x${height}.png`), Buffer.from(shot.data, 'base64'));
    const snapshot = await page.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`);
    await key(page, 'Escape');
    await page.waitFor('!document.querySelector("#records-dialog").open', 'Escape closes achievement');
    assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`), snapshot);
    if (width < 900) {
      assert.equal(await page.evaluate('document.body.classList.contains("maximized")'), true,
        'Escape dismisses the popup without exiting maximized mode');
      await page.click('#maximize');
    }
  }
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await prepare(50, 51);
  await complete();
  await recordNotice(page);
  assert.equal(await page.evaluate('celebrationAudit.length'), 0, 'Reduced motion skips the celebration before the notice');
  await closeNotice(page);
  await page.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.evaluate(`localStorage.setItem(${JSON.stringify(recordsKey)}, ${JSON.stringify(original)})`);
}

/** ダイアログを開いている間、回転も次の予約も進まないことを実時間で確認する。 */
async function assertMotionStopped(page, count, label) {
  const faces = await page.evaluate('[...document.querySelectorAll(".foundations .card-face")].map(face => face.textContent)');
  await pause(1200);
  assert.equal(await page.evaluate('celebrationAudit.length'), count, label + ': no new animation starts');
  assert.equal(await page.evaluate('document.querySelector("#board").getAnimations({ subtree: true }).some(animation => animation.playState === "running")'), false,
    label + ': no animation runs behind the popup');
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".foundations .card-face")].map(face => face.textContent)'), faces,
    label + ': card glyphs stay still');
}

/** 祝賀と独立回転を止め、タブ復帰・設定変更でも停止を保ち、閉じた後だけ再開する。 */
async function checkPopupMotion(page, browser) {
  // 旧形式の fixture は成績対象外なので、既に検証したランキングを変更しない。
  await loadFixture(page, nearWinGame(engine), server.url);
  await page.click('#auto-home');
  await waitAutomatic(page);
  await page.waitFor('celebrationAudit.some(item => item.duration === 250)', 'celebration begins before ranking');
  const snapshot = await page.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`);
  await ranking(page);
  let stopped = await page.evaluate('celebrationAudit.length');
  await assertMotionStopped(page, stopped, 'Celebration interrupted by ranking');

  const other = await browser.page();
  await other.command('Page.bringToFront');
  await page.waitFor('document.hidden', 'ranking tab hidden');
  await page.command('Page.bringToFront');
  await page.waitFor('!document.hidden', 'ranking tab restored');
  await other.command('Page.close');
  await assertMotionStopped(page, stopped, 'Tab visibility changes while ranking is open');
  for (const value of ['reduce', 'no-preference']) {
    await page.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
  }
  await assertMotionStopped(page, stopped, 'Motion preference changes while ranking is open');

  await key(page, 'Escape');
  await page.waitFor('!document.querySelector("#records-dialog").open', 'ranking closed with Escape');
  assert.equal(await page.evaluate('document.activeElement.id'), 'records-link');
  await page.waitFor(`celebrationAudit.length > ${stopped}`, 'independent rotation resumes after Escape', 3000);
  assert.equal(await page.evaluate('celebrationAudit.at(-1).frames.at(-1).transform'), 'rotateY(360deg)',
    'Closing the popup resumes independent rotations without replaying the celebration');

  await ranking(page);
  stopped = await page.evaluate('celebrationAudit.length');
  await assertMotionStopped(page, stopped, 'Independent rotation interrupted by ranking');
  await closeRanking(page);
  await page.waitFor(`celebrationAudit.length > ${stopped}`, 'independent rotation resumes after close button', 3000);
  assert.equal(await page.evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`), snapshot,
    'Pausing and resuming decoration never changes the completed game');
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
    // 最短の1秒待機・100ms回転に固定し、停止中に予約が発火しないことも短時間で検証する。
    Math.random = () => 0;
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
    await recordNotice(page);
    await closeNotice(page);
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

  for (const [width, height] of [[1280, 900], [320, 568], [390, 844], [844, 390]]) {
    await page.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    if (width < 900) await page.click('#maximize');
    const lists = await ranking(page);
    assert.equal(lists[0].length, 3);
    assert.deepEqual(lists[1].map(text => text.split(' · ')[0]), ['52手', '60手', '70手']);
    for (const list of lists) for (const item of list) assert.match(item, /\d{4}\/\d{1,2}\/\d{1,2}/, 'Each result keeps its achievement date');
    const actions = await textOf(page, '#moves');
    await key(page, 'z', 2);
    assert.equal(await textOf(page, '#moves'), actions, 'History shortcuts do not operate behind the dialog');
    const bounds = await page.evaluate(`(() => { const d = document.querySelector('#records-dialog'); const r = d.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight }; })()`);
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height);
    const columns = await page.evaluate(`(() => {
      const dialog = document.querySelector('#records-dialog');
      return { overflow: dialog.scrollWidth > dialog.clientWidth,
        columns: ['best-time', 'best-moves'].map(id => {
          const list = document.getElementById(id); const rect = list.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top,
            overflow: list.scrollWidth > list.clientWidth,
            // 値・日付の1行とシードの1行を分けて測り、狭い画面の折り返しを検出する。
            rows: [...list.children].map(item => {
              const box = item.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(item.firstElementChild);
              const lines = new Set([...range.getClientRects()].map(rect => rect.top)).size;
              range.selectNodeContents(item.querySelector('.record-seed'));
              return { top: box.top, bottom: box.bottom, lines,
                seedLines: new Set([...range.getClientRects()].map(rect => rect.top)).size,
                seed: item.querySelector('.record-seed').textContent };
            }) };
        }) };
    })()`);
    const [left, right] = columns.columns;
    assert.ok(left.right <= right.left + 1 && Math.abs(left.top - right.top) < 1,
      `Time and moves are aligned side by side at ${width}px: ${JSON.stringify(columns)}`);
    assert.equal(columns.overflow || left.overflow || right.overflow, false, 'Both columns fit without horizontal scrolling');
    for (let index = 0; index < 3; index += 1) {
      assert.ok(Math.abs(left.rows[index].top - right.rows[index].top) < 1, 'Each of the three ranking rows aligns across columns');
      assert.equal(left.rows[index].lines, 1, `Time result ${index + 1} stays on one line at ${width}px`);
      assert.equal(right.rows[index].lines, 1, `Move result ${index + 1} stays on one line at ${width}px`);
      for (const row of [left.rows[index], right.rows[index]]) {
        assert.equal(row.seedLines, 1, `The seed stays on its own line at ${width}px`);
        assert.match(row.seed, /4294967295/);
      }
    }
    const shot = await page.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(join(temp, `ranking-${width}x${height}.png`), Buffer.from(shot.data, 'base64'));
    await closeRanking(page);
    if (width < 900) await page.click('#maximize');
  }
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await checkRecordNotices(page, browser);
  await checkPopupMotion(page, browser);
  await loadFixture(page, nearWinGame(engine), server.url);
  await page.click('#auto-home');
  await waitAutomatic(page);
  await pause(1400);
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), false, 'Legacy completion has no ranking achievement popup');
  assert.deepEqual(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordsKey)}))`), records, 'Legacy games remain playable without an inaccurate record');

  // 保存拒否は対局を止めず、同じ画面でランキングを開くと再試行できる。
  await loadFixture(page, nearWin(30, 51), server.url);
  await page.evaluate(`window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
    if (key === ${JSON.stringify(recordsKey)}) throw new DOMException('denied', 'QuotaExceededError');
    return originalSetItem.call(this, key, value);
  }`);
  await page.click('#auto-home');
  await waitAutomatic(page);
  await pause(1400);
  assert.equal(await page.evaluate('document.querySelector("#records-dialog").open'), false, 'A failed record write never claims a ranking update');
  assert.equal(await page.evaluate('document.querySelector("#win-panel").hidden'), false);
  assert.match(await textOf(page, '#storage-status'), /成績を保存できません/);
  await ranking(page, /成績を保存できません/);
  await closeRanking(page);
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
  await page.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.navigate(server.url);
  assert.equal((await ranking(page))[0].length, 3);
  assert.deepEqual(await page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(recordsKey)}))`), finalRecords);
  await closeRanking(page);
  await page.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.evaluate(`localStorage.setItem(${JSON.stringify(recordsKey)}, ${JSON.stringify(JSON.stringify(noticeBaseline()))})`);
  await loadFixture(page, nearWin(1, 51), server.url);
  await pointerClick(page, '#auto-home');
  await recordNotice(page, '最速時間と最小手数のランキング更新、おめでとうございます！');
  await closeNotice(page, 'records');
  assert.equal(await textOf(page, '#records-title'), '成績ランキング');
  assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
  console.log('PASS records: two aligned columns at 320/390/844/1280px, no explanatory sentence, fastest-time heading, dates/top-three/ties, modal/keyboard/fullscreen, denied-write retry and offline restart');
  console.log('PASS celebration: four concurrent K/Q/J/K flips, 500/100/200/100/200 ms, unchanged game history');
  console.log('PASS ranking motion: celebration and independent rotation stop behind popup, remain stopped through visibility/motion-preference changes, resume only after Escape or close button');
  console.log('PASS ranking achievement: three messages, successful top-three writes only, new/ranking/close/Escape, after celebration or reduced motion, no duplicate/restored/redo/outside/failed-write notice, small/fullscreen layout and offline completion');
  console.log('Screenshots: ' + temp);
} finally {
  await browser?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
