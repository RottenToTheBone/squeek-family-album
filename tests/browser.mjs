import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserRegressions } from './browser-regressions.mjs';
import { ARCHIVES } from '../dist/receipts.js';

const qa = fileURLToPath(new URL('../.qa/', import.meta.url));
await mkdir(qa, { recursive: true });
const base = process.env.ALBUM_URL || 'http://127.0.0.1:4179/';
const bundled = JSON.parse(await readFile(new URL('../dist/data/archive.json', import.meta.url), 'utf8'));
const sampledBurn = bundled.events.find((event) => event.donor === 8925);
const uncached = [42, ...Array.from({ length: bundled.issued }, (_, i) => i + 1)].find(
  (id) => !bundled.portraits[id],
);
const executablePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
const browser = await chromium.launch({ headless: true, executablePath, args: ['--disable-gpu'] });
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
};
async function ready(page, id) {
  await page.waitForFunction(
    (token) =>
      document.querySelector('#selected-id').textContent === '#' + token &&
      !document.querySelector('#hero-art').hidden &&
      document.querySelector('#hero-art').naturalWidth > 0 &&
      !document.querySelector('#share').disabled,
    id,
    { timeout: 22000 },
  );
}
async function find(page, id) {
  await page.locator('#token-input').fill(String(id));
  await page.locator('#lookup-form button').click();
}
async function fit(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
}
async function accessibility(page) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) {
    const script = fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url));
    await page.addScriptTag({ path: script });
  }
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return result.violations.map((rule) => [rule.id, rule.nodes.map((node) => node.target.join(' '))]);
  });
  assert.deepEqual(violations, []);
}

try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  });
  const p = watch(await ctx.newPage());
  await p.goto(base + '?id=8923&lang=en');
  await ready(p, 8923);
  const originals = Number(await p.locator('#f-originals').textContent());
  assert.ok(originals >= 4);
  assert.equal(await p.locator('.tree-node').count(), 2 * originals - 1);
  assert.equal(await p.locator('.ledger-row').count(), originals - 1);
  await fit(p);
  await accessibility(p);
  await p.screenshot({ path: path.join(qa, 'desktop.png'), fullPage: true });
  await p.locator('.tree-node[data-key="o-8924"]').focus();
  await p.keyboard.press('Enter');
  await ready(p, 8924);
  await p.locator('.tree-node[data-key="o-8925"]').click();
  await ready(p, 8925);
  assert.equal(
    await p.locator('#art-source').textContent(),
    'Pre-burn block ' + (sampledBurn.block - 1).toLocaleString('en-US'),
  );
  assert.ok((await p.locator('#token-source').getAttribute('href')).endsWith(sampledBurn.tx));
  await p.locator('#enlarge').click();
  assert.ok(await p.locator('#art-dialog').isVisible());
  await p.keyboard.press('Escape');
  await p.locator('#share').click();
  await p.locator('#save-card:not([hidden])').waitFor();
  await accessibility(p);
  const download = p.waitForEvent('download');
  await p.locator('#save-card').click();
  const handle = await download;
  const dest = path.join(qa, 'family-card.png');
  await handle.saveAs(dest);
  const png = await readFile(dest);
  assert.equal(png.readUInt32BE(16), 1120);
  assert.equal(png.readUInt32BE(20), 716);
  assert.ok(png.length > 20000);
  await p.locator('#copy-link').click();
  const link = await p.evaluate(() => navigator.clipboard.readText());
  assert.equal(new URL(link).searchParams.get('stage'), 'o-8925');
  await p.keyboard.press('Escape');
  const deep = watch(await ctx.newPage());
  await deep.goto(link);
  await ready(deep, 8925);
  assert.equal(await deep.locator('[aria-pressed=true]').getAttribute('data-key'), 'o-8925');
  await deep.close();
  await find(p, '#1');
  await ready(p, 1);
  const n1 = Number(await p.locator('#f-originals').textContent());
  assert.equal(Number(await p.locator('#f-merges').textContent()), n1 - 1);
  assert.equal(await p.locator('.tree-node').count(), 2 * n1 - 1);
  await find(p, '10000');
  assert.equal(await p.locator('#token-input').getAttribute('aria-invalid'), 'true');
  await p.goBack();
  await ready(p, 8925);
  await p.locator('#lang').click();
  await ready(p, 8925);
  assert.equal(await p.locator('html').getAttribute('lang'), 'zh-Hans');
  await p.locator('#notes').click();
  assert.ok(await p.locator('#notes-data').textContent());
  await p.keyboard.press('Escape');
  for (const width of [320, 390, 768]) {
    await p.setViewportSize({ width, height: 844 });
    await find(p, 8923);
    await ready(p, 8923);
    await fit(p);
    if (width === 390) {
      await accessibility(p);
      await p.screenshot({ path: path.join(qa, 'mobile.png'), fullPage: true });
      await p.locator('.tree-node[data-key="o-8926"]').click();
      await p.locator('#art-dialog[open]').waitFor();
      assert.match(await p.locator('#art-modal-title').textContent(), /8926/);
      await p.keyboard.press('Escape');
    }
  }
  if (process.env.ALBUM_LIVE === '1') {
    if (uncached) {
      await find(p, uncached);
      await ready(p, uncached);
      assert.match(await p.locator('#hero-art').getAttribute('src'), /^data:image\/svg/);
      console.log('Live public artwork lookup passed for #' + uncached);
    }
    const stale = await browser.newContext();
    const original = structuredClone(bundled);
    const last = original.events.at(-1);
    original.safeBlock = last.block - 1;
    original.events = original.events.filter((event) => event.block <= original.safeBlock);
    original.burned = original.events.length;
    original.live = original.issued - original.burned;
    let header;
    for (const endpoint of ARCHIVES) {
      try {
        const reply = await stale.request.post(endpoint, {
          data: {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getBlockByNumber',
            params: ['0x' + original.safeBlock.toString(16), false],
          },
          timeout: 12000,
        });
        header = (await reply.json()).result;
        if (header?.hash) break;
      } catch {}
    }
    assert.ok(header?.hash, 'canonical header for the older test snapshot');
    original.safeBlockHash = header.hash;
    original.asOf = new Date(Number(BigInt(header.timestamp)) * 1000).toISOString();
    delete original.portraits[last.donor];
    await stale.route(
      (url) => url.pathname.endsWith('/data/archive.json'),
      (r) => r.fulfill({ json: original }),
    );
    let releaseFeed;
    const feedGate = new Promise((resolve) => {
      releaseFeed = resolve;
    });
    await stale.route(
      (url) => url.hostname === 'api.squeekchain.com' && url.pathname === '/v1/events',
      async (route) => {
        await feedGate;
        await route.continue();
      },
    );
    const stableId = Number(Object.keys(original.portraits)[0]);
    const newer = watch(await stale.newPage());
    await newer.goto(base + '?id=' + stableId + '&lang=en');
    await ready(newer, stableId);
    await newer.locator('#share').click();
    await newer.locator('#save-card:not([hidden])').waitFor();
    releaseFeed();
    await newer.locator('#share-dialog[open]').waitFor({ state: 'hidden', timeout: 60000 });
    await find(newer, last.donor);
    await newer.waitForFunction(
      (data) =>
        document.querySelector('#art-source').textContent.includes('Pre-burn block') &&
        document.querySelector('#token-source').href.endsWith(data.tx) &&
        document.querySelector('#hero-art').getAttribute('src')?.startsWith('data:image/svg'),
      last,
      { timeout: 40000 },
    );
    assert.match(await newer.locator('#token-source').getAttribute('href'), new RegExp(last.tx + '$'));
    await stale.close();
    console.log('Recovered latest missing merge and original SVG using the live feed and archive RPC');
  }
  const offline = await browser.newContext();
  await offline.route(
    (url) => url.protocol === 'https:' && url.origin !== new URL(base).origin,
    (r) => r.abort(),
  );
  const op = watch(await offline.newPage());
  await op.goto(base + '?id=8925&lang=en');
  await ready(op, 8925);
  await op.waitForFunction(() => document.querySelector('#status').textContent.includes('archive time'));
  if (uncached) {
    await find(op, uncached);
    await op.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('could not be verified'),
    );
    assert.ok(await op.locator('#share').isDisabled());
  }
  await find(op, '1');
  await ready(op, 1);
  await offline.close();
  await browserRegressions(browser, base, bundled);
  assert.deepEqual(errors, []);
  console.log(
    'Desktop, mobile, keyboard, original image, ledger, PNG, clipboard, deep link, language and offline checks passed',
  );
} finally {
  await browser.close();
}
