import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { browserRegressions } from './browser-regressions.mjs';
import { scanCard } from './card-scan.mjs';
import { compareRegressions } from './compare-browser.mjs';
import { CURRENT, HISTORICAL } from '../dist/receipts.js';

const qa = fileURLToPath(new URL('../.qa/', import.meta.url));
await mkdir(qa, { recursive: true });
const base = process.env.ALBUM_URL || 'http://127.0.0.1:4179/';
const bundled = JSON.parse(await readFile(new URL('../dist/data/archive.json', import.meta.url), 'utf8'));
const current = JSON.parse(await readFile(new URL('../dist/data/current.json', import.meta.url), 'utf8'));
const featuredBurn = current.events.find((e) => e.donor === 7453);
const sampledBurn = bundled.events.find((event) => event.donor === 8925);
const uncached = [42, ...Array.from({ length: bundled.issued }, (_, i) => i + 1)].find(
  (id) => !bundled.portraits[id] && !current.portraits[id],
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
      document.querySelector('#selected-id')?.textContent === '#' + token &&
      document.querySelector('#hero-art')?.hidden === false &&
      document.querySelector('#hero-art')?.naturalWidth > 0 &&
      document.querySelector('#share')?.disabled === false,
    id,
    { timeout: 22000 },
  );
}
async function find(page, id) {
  await page.locator('#token-input').fill(String(id));
  await page.locator('#lookup-form button').click();
}
async function exportFeaturedCard(page, id) {
  await ready(page, id);
  await page.locator('#share').click();
  await page.locator('#save-card:not([hidden])').waitFor();
  await page.locator('#card-preview').evaluate((img) => img.decode());
  // Check the exported hero pixels against the selected onchain image. A blank
  // placeholder or a card that kept the previous token must fail this check.
  const matches = await page.evaluate(() => {
    const pixels = (draw) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 345;
      const c = canvas.getContext('2d');
      draw(c);
      return c.getImageData(0, 0, 345, 345).data;
    };
    const original = pixels((c) => {
      c.fillStyle = '#26372b';
      c.fillRect(0, 0, 345, 345);
      c.drawImage(document.querySelector('#hero-art'), 0, 0, 345, 345);
    });
    const card = pixels((c) => c.drawImage(document.querySelector('#card-preview'), 68, 224, 345, 345, 0, 0, 345, 345));
    let same = 0;
    for (let i = 0; i < card.length; i++) if (Math.abs(original[i] - card[i]) <= 2) same++;
    return same / card.length;
  });
  assert.ok(matches > 0.99, 'exported hero differs from the selected portrait');
  const download = page.waitForEvent('download');
  await page.locator('#save-card').click();
  const dest = path.join(qa, 'current-family-' + id + '.png');
  await (await download).saveAs(dest);
  const png = await readFile(dest);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1120, 716]);
  const stage = await page.locator('.tree-node[aria-pressed=true]').getAttribute('data-key');
  const lang = await page.locator('html').getAttribute('lang');
  const route = await scanCard(page, png, { release: CURRENT.release, id, stage, lang: lang.startsWith('zh') ? 'zh' : 'en' }, base);
  const scanned = watch(await page.context().newPage());
  await scanned.goto(route);
  await ready(scanned, id);
  assert.equal(await scanned.locator('.tree-node[aria-pressed=true]').getAttribute('data-key'), stage);
  assert.equal(await scanned.locator('html').getAttribute('lang'), lang);
  await scanned.close();
  await page.keyboard.press('Escape');
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
  const historicalRoute = await scanCard(p, png, { release: HISTORICAL.release, id: 8925, stage: 'o-8925', lang: 'en' }, base);
  assert.equal(new URL(historicalRoute).search, new URL(link).search);
  await deep.goto(historicalRoute);
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
  const now = watch(await ctx.newPage());
  await now.goto(base);
  await ready(now, 7458);
  assert.equal(await now.locator('#current-edition').getAttribute('aria-current'), 'page');
  assert.equal(featuredBurn.survivor, 7458);
  assert.equal(await now.locator('.tree-node[aria-pressed=true]').getAttribute('data-key'), 'm-12076748-87');
  assert.equal(await now.locator('.ledger-row a[href$="' + featuredBurn.tx + '"]').count(), 1);
  await fit(now);
  await accessibility(now);
  await exportFeaturedCard(now, 7458);
  await now.locator('#example-donor').click();
  await ready(now, 7453);
  assert.ok((await now.locator('#token-source').getAttribute('href')).endsWith(featuredBurn.tx));
  assert.match(await now.locator('#art-source').textContent(), /^(Pre-burn block |销毁前区块 )12,076,747$/);
  await exportFeaturedCard(now, 7453);
  await now.setViewportSize({ width: 390, height: 844 });
  await fit(now);
  await now.screenshot({ path: path.join(qa, 'current-mobile.png'), fullPage: true });
  await now.setViewportSize({ width: 1440, height: 960 });
  await now.locator('#example-survivor').click();
  await ready(now, 7458);
  await now.screenshot({ path: path.join(qa, 'current-desktop.png'), fullPage: true });
  await now.locator('#history-example').click();
  await ready(now, 8925);
  assert.equal(await now.locator('#archive-edition').getAttribute('aria-current'), 'page');
  assert.equal(await now.locator('#token-source').getAttribute('href'), 'https://sepolia.etherscan.io/tx/' + sampledBurn.tx);
  await now.locator('#current-edition').click();
  assert.equal(new URL(now.url()).searchParams.get('id'), '8925');
  assert.equal(new URL(now.url()).searchParams.get('release'), CURRENT.release);
  if (process.env.ALBUM_LIVE === '1') {
    const recovery = await browser.newContext();
    // Exercise real archive-RPC recovery even when the public site has a bundled original.
    await recovery.route((u) => u.pathname.endsWith('/data/current.json'), async (r) => {
      const response = await r.fetch();
      const copy = await response.json();
      delete copy.portraits['7453'];
      await r.fulfill({ json: copy });
    });
    const donor = watch(await recovery.newPage());
    await donor.goto(base + '?release=current&id=7453&stage=o-7453&lang=en');
    await ready(donor, 7453);
    const recovered = await donor.locator('#hero-art').evaluate(async (img) => {
      if (!img.src.startsWith('data:image/svg')) return null;
      const bytes = await (await fetch(img.src)).arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
    });
    assert.equal(recovered, current.portraits['7453'].sha256, 'pre-burn tokenURI must match the released original');
    await recovery.close();
    await ready(now, 8925);
    await find(now, uncached);
    await ready(now, uncached);
    assert.match(await now.locator('#hero-art').getAttribute('src'), /^data:image\/svg/);
    await now.locator('#share').click();
    await now.locator('#save-card:not([hidden])').waitFor();
    await now.locator('#copy-link').click();
    const shared = new URL(await now.evaluate(() => navigator.clipboard.readText()));
    assert.equal(shared.searchParams.get('release'), CURRENT.release);
    assert.equal(shared.searchParams.get('id'), String(uncached));
    console.log('Real current token API and contract tokenURI agree for #' + uncached, CURRENT.collection);
    const old = await browser.newContext();
    const copy = structuredClone(bundled);
    delete copy.portraits[sampledBurn.donor];
    await old.route((u) => u.pathname.endsWith('/data/archive.json'), (r) => r.fulfill({ json: copy }));
    const past = watch(await old.newPage());
    const touched = [];
    past.on('request', (r) => { if (r.url().includes('api.squeekchain.com')) touched.push(r.url()); });
    await past.goto(base + '?release=archive&id=8925&lang=en');
    await ready(past, 8925);
    assert.match(await past.locator('#hero-art').getAttribute('src'), /^data:image\/svg/);
    assert.ok((await past.locator('#token-source').getAttribute('href')).endsWith(sampledBurn.tx));
    await find(past, uncached);
    await ready(past, uncached);
    assert.equal(await past.locator('#token-source').getAttribute('href'),
      'https://sepolia.etherscan.io/nft/' + HISTORICAL.collection + '/' + uncached);
    assert.deepEqual(touched, []);
    await old.close();
    console.log('Real historical pre-burn portrait and uncached historical token recovered from the old contract');
  }
  const offline = await browser.newContext();
  await offline.route(
    (url) => url.protocol === 'https:' && url.origin !== new URL(base).origin,
    (r) => r.abort(),
  );
  const op = watch(await offline.newPage());
  await op.goto(base + '?id=8925&lang=en');
  await ready(op, 8925);
  await op.waitForFunction(() => document.querySelector('#freshness').textContent.includes('Historical snapshot'));
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
  const packedDonor = current.events.find((event) => current.portraits[event.donor]?.pack)?.donor;
  if (process.env.ALBUM_PACKED === '1' && packedDonor) {
    const record = current.portraits[packedDonor];
    for (const corrupt of [false, true]) {
      const isolated = await browser.newContext();
      try {
        let packRequests = 0;
        await isolated.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
          if (url.origin !== new URL(base).origin || url.pathname === '/current-art/' + packedDonor + '.svg') return route.abort();
          if (url.pathname.endsWith('/' + record.pack)) {
            packRequests++;
            if (corrupt) return route.fulfill({ json: { [packedDonor]: gzipSync('wrong original').toString('base64') } });
          }
          return route.continue();
        });
        const page = watch(await isolated.newPage());
        await page.goto(base + '?release=current&id=' + packedDonor + '&lang=en');
        if (corrupt) {
          await page.getByText('Original portrait unavailable', { exact: true }).waitFor();
          assert.ok(await page.locator('#share').isDisabled());
        } else {
          await ready(page, packedDonor);
          const sha = await page.locator('#hero-art').evaluate(async (img) => {
            const bytes = await (await fetch(img.src)).arrayBuffer();
            return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
          });
          assert.equal(sha, record.sha256);
          await exportFeaturedCard(page, packedDonor);
        }
        assert.ok(packRequests >= 1);
      } finally { await isolated.close(); }
    }
    console.log('Same-origin pack restored #' + packedDonor + ', exported its card, and rejected a corrupted original.');
  }
  await browserRegressions(browser, base, bundled);
  await compareRegressions({ browser, base, qa, ready, fit, accessibility, watch });
  assert.deepEqual(errors, []);
  console.log(
    'Desktop, mobile, keyboard, original image, ledger, PNG, clipboard, deep link, language and offline checks passed',
  );
} finally {
  await browser.close();
}
