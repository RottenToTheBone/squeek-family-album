import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { scanCard } from './card-scan.mjs';

// Independent reference for this specific historical receipt and its original artwork.
const event = 'm-12076748-87';
const receipt = 'https://sepolia.etherscan.io/tx/0xe2035a8e291cc04c0c4c6f3c7598190022205d0fb65345e7f8074f32e0dcdb85';
const fields = { release: 'core-sepolia-20261103', view: 'replay', event, phase: 'after', lang: 'zh' };
const digests = {
  donor: '2a696ab65c79cbf1fe3b2e93d168cc2c285dc8f51de8e3b9f8c3ead3cdb3c76e',
  survivor: 'af637fff17a0b16cea68f2a7f14f3455d3ff6675d0c3bbb252582811c135c80e',
};
const base = new URL(process.env.ALBUM_URL || 'http://127.0.0.1:4179/');
const qa = fileURLToPath(new URL('../.qa/replay/', import.meta.url));
await mkdir(qa, { recursive: true });
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
  acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));

function route(params) {
  const url = new URL(base);
  url.search = new URLSearchParams(params);
  return url;
}

async function imageDigest(img) {
  const base64 = await img.evaluate(async element => {
    await element.decode();
    const data = new Uint8Array(await (await fetch(element.currentSrc)).arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < data.length; offset += 16384)
      binary += String.fromCharCode(...data.subarray(offset, offset + 16384));
    return btoa(binary);
  });
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

async function checkPhase(page, phase) {
  const before = phase === 'before';
  await page.locator('#replay-' + phase + '[aria-pressed=true]').waitFor();
  await page.waitForFunction(() => ['donor', 'survivor'].every(role => {
    const img = document.querySelector('#replay-' + role + '-art');
    return img?.complete && img.naturalWidth > 0 && !img.hidden;
  }));
  assert.match((await page.locator('#replay-phase-block').innerText()).replace(/[,\s]/g, ''),
    before ? /12076747/ : /12076748/);
  assert.equal(new URL(page.url()).searchParams.get('phase'), phase);
  for (const [role, digest] of Object.entries(digests))
    assert.equal(await imageDigest(page.locator('#replay-' + role + '-art')), digest, role + ' original');
  assert.match(await page.locator('#replay-survivor-state').innerText(), before ? /1|一/ : /2|二/);
  assert.match(await page.locator('#replay-donor-state').innerText(), before ? /1|一/ : /burn|销毁/i);
}

async function checkLayout(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
  await page.addScriptTag({ path: fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url)) });
  const issues = await page.evaluate(async () => {
    const { violations } = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return violations.map(rule => [rule.id, rule.nodes.map(node => node.target.join(' '))]);
  });
  assert.deepEqual(issues, [], 'WCAG issues');
}

async function exportAndScan(page, lang) {
  await page.locator('#replay-share').click();
  await page.locator('#save-card:not([hidden])').waitFor();
  const pixels = await page.evaluate(async () => {
    const preview = document.querySelector('#card-preview');
    await preview.decode();
    const size = 262;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    return [
      ['donor', 65, '#293d2f'],
      ['survivor', 404, '#485649'],
    ].map(([role, x, background]) => {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(document.querySelector('#replay-' + role + '-art'), 0, 0, size, size);
      const reference = ctx.getImageData(0, 0, size, size).data;
      ctx.drawImage(preview, x, 204, size, size, 0, 0, size, size);
      const actual = ctx.getImageData(0, 0, size, size).data;
      let matching = 0;
      for (let i = 0; i < actual.length; i += 4)
        if ([0, 1, 2].every(ch => Math.abs(actual[i + ch] - reference[i + ch]) < 4)) matching++;
      return matching / (size * size);
    });
  });
  assert.ok(pixels.every(score => score > 0.99), 'incorrect recorded artwork in PNG: ' + pixels);
  const downloading = page.waitForEvent('download');
  await page.locator('#save-card').click();
  const download = await downloading;
  assert.match(download.suggestedFilename(), /\.png$/);
  const dest = path.join(qa, '7453-merge-' + lang + '.png');
  await download.saveAs(dest);
  const png = await readFile(dest);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1120, 716]);
  const fromQr = new URL(await scanCard(page, png, { ...fields, lang }, base));
  await page.locator('#copy-link').click();
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(copied.origin, 'https://squeek.machinepaystack.com');
  assert.equal(copied.search, fromQr.search);
  await page.keyboard.press('Escape');
  const reopened = await context.newPage();
  try {
    await reopened.goto(fromQr.href);
    await checkPhase(reopened, 'after');
    assert.equal(await reopened.locator('html').getAttribute('lang'), lang === 'zh' ? 'zh-Hans' : lang);
  } finally { await reopened.close(); }
}

try {
  // Both the genuine replay and its card should work from the bundled proofs and originals.
  await context.route(url => ['http:', 'https:'].includes(url.protocol) && url.origin !== base.origin, r => r.abort());
  const page = await context.newPage();
  await page.goto(route({ lang: 'zh' }).href);
  const primary = page.locator('#replay-open');
  assert.match(await primary.innerText(), /找回 #7453 的原画/);
  assert.ok(await page.locator('#history-example').isVisible());
  assert.ok(await page.locator('#compare-open').isVisible());
  await page.waitForFunction(() => document.querySelector('#hero-art')?.naturalWidth > 0);
  await page.screenshot({ path: path.join(qa, 'home-zh.png') });
  await primary.focus();
  await page.keyboard.press('Enter');
  await checkPhase(page, 'after');
  assert.equal(await page.locator('#replay-receipt').getAttribute('href'), receipt);
  assert.equal((await page.locator('#replay-tx').innerText()).trim(), receipt.split('/').at(-1));
  const svgDownload = page.waitForEvent('download');
  await page.locator('#replay-original').click();
  const downloadedSvg = await svgDownload;
  assert.match(downloadedSvg.suggestedFilename(), /7453.*\.svg$/);
  const svgBytes = await readFile(await downloadedSvg.path());
  assert.equal(createHash('sha256').update(svgBytes).digest('hex'), digests.donor);
  await checkLayout(page);
  await page.screenshot({ path: path.join(qa, 'replay-zh.png'), fullPage: true });
  await page.locator('#replay-before').focus();
  await page.keyboard.press('Enter');
  await checkPhase(page, 'before');
  await page.reload();
  await checkPhase(page, 'before');
  await page.locator('#replay-next').click();
  await checkPhase(page, 'after');
  await page.goBack();
  await checkPhase(page, 'before');
  assert.ok(await page.locator('#replay-share').isDisabled());
  await page.goForward();
  await checkPhase(page, 'after');
  await exportAndScan(page, 'zh');

  await page.locator('#lang').click();
  await checkPhase(page, 'after');
  await exportAndScan(page, 'en');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('#replay-before').click();
  await checkPhase(page, 'before');
  assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.id === 'album-image').length), 0);
  await checkLayout(page);
  await page.locator('#lang').click();
  await page.locator('#replay-after').click();
  await checkPhase(page, 'after');
  await page.setViewportSize({ width: 390, height: 844 });
  await checkLayout(page);
  await page.screenshot({ path: path.join(qa, 'mobile-zh.png'), fullPage: true });
  await page.locator('#replay-history').click();
  await page.waitForFunction(() => document.querySelector('#selected-id')?.textContent === '#8925' &&
    document.querySelector('#hero-art')?.naturalWidth > 0);
  assert.equal(await imageDigest(page.locator('#hero-art')), '8306e510060c4d222fd85d8cdde98b28b33f39ed9cca1c338482846f8f5b1973');

  const duplicate = route(fields);
  duplicate.searchParams.append('event', event);
  async function rejected(page, url) {
    await page.goto(url.href);
    await page.locator('#replay-status.error').waitFor();
    assert.match(await page.locator('#replay-status.error').innerText(), /[\u3400-\u9fff]/);
    assert.equal(await page.locator('#replay-result').isVisible(), false, url.search);
    assert.equal(await page.locator('#replay-share').isDisabled(), true, url.search);
    assert.equal(await page.locator('#replay-receipt').isVisible(), false, url.search);
  }
  for (const url of [duplicate, route({ ...fields, event: 'm-12076748-88' }), route({ ...fields, phase: 'future' }),
    route({ ...fields, release: 'stream-game-sepolia-test-20261026-01' })]) {
    await rejected(page, url);
  }
  // A matching event key alone is insufficient. Alter the claimed receipt, then corrupt the recovered bytes.
  await page.route('**/data/current.json*', async intercepted => {
    const response = await intercepted.fetch();
    const snapshot = await response.json();
    snapshot.events.find(item => item.donor === 7453).tx = '0x' + 'a'.repeat(64);
    await intercepted.fulfill({ json: snapshot });
  });
  await rejected(page, route(fields));
  await page.unroute('**/data/current.json*');
  await page.route('**/current-art/7453.svg', intercepted =>
    intercepted.fulfill({ body: '<svg/>', contentType: 'image/svg+xml' }));
  await rejected(page, route(fields));
  assert.deepEqual(errors, []);
  console.log('Replay passed: original SVG digests, both chain states, receipt, PNG pixels, QR round trips in two languages, keyboard, mobile, WCAG, historical #8925 and invalid links.');
} finally { await browser.close(); }
