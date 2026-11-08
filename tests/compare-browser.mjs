import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CURRENT } from '../dist/receipts.js';
import { scanCard } from './card-scan.mjs';

async function pairReady(page, keep, donor) {
  await page.waitForFunction(([a, b]) =>
    !document.getElementById('compare-result').hidden &&
    document.getElementById('keep-id').textContent === '#' + a &&
    document.getElementById('donor-id').textContent === '#' + b &&
    ['keep-art', 'donor-art'].every((id) => {
      const img = document.getElementById(id);
      return img.complete && img.naturalWidth > 0;
    }) && !document.getElementById('compare-share').disabled,
  [keep, donor], { timeout: 22000 });
}

async function submitPair(page, keep, donor) {
  await page.locator('#compare-keep').fill(String(keep));
  await page.locator('#compare-donor').fill(String(donor));
  await page.locator('#compare-submit').click();
}

async function checkBlocked(page, phrase) {
  await page.locator('#compare-status').filter({ hasText: phrase }).waitFor();
  const share = page.locator('#compare-share');
  assert.ok(!(await share.isVisible()) || await share.isDisabled(), 'invalid pair still exportable');
}

// Rendering the two images into the reverse slots must break the test even if the labels and QR are correct.
async function compareCardPixels(page, keep, donor) {
  const originals = await Promise.all([keep, donor].map(async (id) => {
    const svg = await readFile(new URL('../dist/current-art/' + id + '.svg', import.meta.url));
    return svg.toString('base64');
  }));
  const scores = await page.evaluate(async (sources) => {
    const card = document.querySelector('#card-preview');
    await card.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 240;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const results = [];
    for (const [i, x] of [69, 426].entries()) {
      const original = new Image();
      original.src = 'data:image/svg+xml;base64,' + sources[i];
      await original.decode();
      ctx.clearRect(0, 0, 240, 240);
      ctx.drawImage(original, 0, 0, 240, 240);
      const reference = ctx.getImageData(0, 0, 240, 240).data;
      ctx.drawImage(card, x, 251, 240, 240, 0, 0, 240, 240);
      const actual = ctx.getImageData(0, 0, 240, 240).data;
      let matched = 0, tested = 0;
      for (let p = 0; p < actual.length; p += 4) {
        // Ignore transparent margins and the dark backdrop shared by many portraits.
        if (reference[p + 3] < 250 || Math.max(reference[p], reference[p + 1], reference[p + 2]) < 35) continue;
        tested++;
        if ([0, 1, 2].every((c) => Math.abs(actual[p + c] - reference[p + c]) < 4)) matched++;
      }
      results.push({ matched, tested });
    }
    return results;
  }, originals);
  for (const { matched, tested } of scores) assert.ok(tested >= 100 && matched / tested > 0.99, `wrong preview portrait (${matched}/${tested} matching artwork pixels)`);
}

async function exportAndScan(page, base, qa, keep, donor, at, lang) {
  await page.locator('#compare-share').click();
  await page.locator('#save-card:not([hidden])').waitFor();
  await compareCardPixels(page, keep, donor);
  const downloading = page.waitForEvent('download');
  await page.locator('#save-card').click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), `squeek-current-preview-${keep}-${donor}.png`);
  const dest = path.join(qa, `merge-preview-${keep}-${donor}-${lang}.png`);
  await download.saveAs(dest);
  const png = await readFile(dest);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1120, 716]);
  const params = { release: CURRENT.release, view: 'compare', keep, donor, at, lang };
  const route = await scanCard(page, png, params, base);
  await page.locator('#copy-link').click();
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(copied.origin + copied.pathname, 'https://squeek.machinepaystack.com/');
  assert.equal(copied.search, new URL(route).search);
  await page.keyboard.press('Escape');
  const reopened = await page.context().newPage();
  try {
    await reopened.goto(route);
    await pairReady(reopened, keep, donor);
    assert.equal(await reopened.locator('html').getAttribute('lang'), lang === 'en' ? 'en' : 'zh-Hans');
    assert.equal(await reopened.locator('#compare-keep').inputValue(), String(keep));
    assert.equal(await reopened.locator('#compare-donor').inputValue(), String(donor));
  } finally { await reopened.close(); }
}

export async function compareRegressions({ browser, base, qa, ready, fit, accessibility, watch }) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  try {
    // Isolate the snapshot from concurrent merges so the QR's exact block is testable.
    await context.route((u) => u.pathname === '/v1/economy/state', (r) => r.abort());
    const manifest = await (await context.request.get(new URL('data/current.json', base).href)).json();
    const burned = new Set(manifest.events.map((e) => e.donor));
    const levels = new Map(manifest.events.map((e) => [e.survivor, e.level]));
    const liveLevel = (id) => levels.get(id) ?? 1;
    const byLevel = new Map();
    for (const id of new Set([...levels.keys(), ...Object.keys(manifest.portraits).map(Number)])) {
      if (burned.has(id)) continue;
      const level = liveLevel(id);
      if (!byLevel.has(level)) byLevel.set(level, []);
      byLevel.get(level).push(id);
    }
    const livePair = [...byLevel].find(([level, ids]) => level > 1 && level < 10 && ids.length >= 2) ??
      [...byLevel].find(([level, ids]) => level < 10 && ids.length >= 2);
    // If all bundled survivors have reached the cap, the known pre-burn checkpoint is still valid.
    const [a, b] = livePair ? livePair[1] : [7458, 7453];
    const at = livePair ? manifest.safeBlock : 12076747;
    const tokens = Array.from({ length: manifest.issued }, (_, i) => i + 1);
    const otherLevel = livePair && tokens.find((id) => !burned.has(id) && liveLevel(id) !== livePair[0]);
    const page = watch(await context.newPage());
    await page.goto(base + '?lang=en&private_ref=EXAMPLE_ONLY#private');
    await ready(page, 7458);
    await page.locator('#compare-open').click();
    if (livePair) await submitPair(page, a, b);
    else await page.goto(base + '?release=current&view=compare&keep=7458&donor=7453&at=12076747&lang=en');
    await pairReady(page, a, b);
    await fit(page);
    await accessibility(page);
    await page.screenshot({ path: path.join(qa, 'merge-compare-desktop.png'), fullPage: true });
    await exportAndScan(page, base, qa, a, b, at, 'en');
    await page.locator('#compare-swap').focus();
    await page.keyboard.press('Enter');
    await pairReady(page, b, a);
    await page.goBack();
    await pairReady(page, a, b);
    await page.goForward();
    await pairReady(page, b, a);
    await page.locator('#lang').click();
    await pairReady(page, b, a);
    await page.setViewportSize({ width: 320, height: 844 });
    await fit(page);
    await accessibility(page);
    await page.screenshot({ path: path.join(qa, 'merge-compare-mobile.png'), fullPage: true });
    await exportAndScan(page, base, qa, b, a, at, 'zh');

    await page.locator('#lang').click();
    const invalidPairs = [[a, a, /different/i], [7458, 7453, /burned/i], ['10000', b, /9,999/]];
    if (otherLevel) invalidPairs.push([a, otherLevel, /same level/i]);
    for (const [keep, donor, error] of invalidPairs) {
      await submitPair(page, keep, donor);
      await checkBlocked(page, error);
    }

    // This pair has in fact merged. Its saved pre-burn QR must still reopen as a preview.
    const past = new URL(base);
    past.search = new URLSearchParams({ release: CURRENT.release, view: 'compare', keep: 7458, donor: 7453, at: 12076747, lang: 'en', private_ref: 'EXAMPLE_ONLY' });
    past.hash = 'private';
    await page.goto(past.href);
    await pairReady(page, 7458, 7453);
    assert.match(await page.locator('#compare-status').textContent(), /has changed/i);
    await exportAndScan(page, base, qa, 7458, 7453, 12076747, 'en');

    for (const [key, value, error] of [['at', manifest.safeBlock + 5000, /outside/i], ['at', 1, /outside/i], ['release', 'archive', /current collection/i]]) {
      const invalid = new URL(past);
      invalid.searchParams.set(key, value);
      await page.goto(invalid.href);
      await checkBlocked(page, error);
    }
    // A delayed valid response must not re-enable the old result after editing/submitting another pair.
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const slow = watch(await context.newPage());
    try {
      const held = slow.waitForRequest((request) => new URL(request.url()).pathname === '/current-art/7453.svg');
      await slow.route('**/current-art/7453.svg', async (r) => { await hold; await r.continue(); });
      await slow.goto(past.href, { waitUntil: 'domcontentloaded' });
      await held;
      await submitPair(slow, a, a);
      await checkBlocked(slow, /different/i);
      release();
      await slow.waitForLoadState('networkidle');
      await checkBlocked(slow, /different/i);
    } finally {
      release();
      await slow.close();
    }
    const uncached = tokens.filter((id) => !manifest.portraits[id] && !burned.has(id) && !levels.has(id)).slice(0, 2);
    if (process.env.ALBUM_LIVE === '1' && uncached.length === 2) {
      const queried = new Set();
      page.on('request', (request) => {
        if (request.method() !== 'POST') return;
        const call = request.postDataJSON();
        if (call?.method === 'eth_call' && call.params[0].to === CURRENT.collection &&
          call.params[0].data.startsWith('0xc87b56dd') && call.params[1] === '0x' + manifest.safeBlock.toString(16))
          queried.add(Number(BigInt('0x' + call.params[0].data.slice(10))));
      });
      await page.goto(base + '?release=current&view=compare&lang=en');
      await submitPair(page, ...uncached);
      await pairReady(page, ...uncached);
      assert.deepEqual([...queried].sort(), [...uncached].sort());
      console.log(`Both unbundled originals #${uncached.join('/#')} matched tokenURI at ${manifest.safeBlock}.`);
    }
    console.log(`Swapped #${a}/#${b}; both exported portraits matched their originals. Scanned preview PNGs in both directions, including pre-burn #7458/#7453.`);
  } finally { await context.close(); }
}
