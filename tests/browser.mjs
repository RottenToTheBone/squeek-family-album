import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const qa = fileURLToPath(new URL('../.qa/', import.meta.url));
await mkdir(qa, { recursive: true });
const base = process.env.ALBUM_URL || 'http://127.0.0.1:4179/';
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
    return result.violations.map(rule => [rule.id, rule.nodes.map(node => node.target.join(' '))]);
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
  assert.equal(await p.locator('.tree-node').count(), 7);
  assert.equal(await p.locator('.ledger-row').count(), 3);
  assert.equal(await p.locator('#f-originals').textContent(), '4');
  await fit(p);
  await accessibility(p);
  await p.screenshot({ path: path.join(qa, 'desktop.png'), fullPage: true });
  await p.locator('.tree-node[data-key="o-8924"]').focus();
  await p.keyboard.press('Enter');
  await ready(p, 8924);
  await p.locator('.tree-node[data-key="o-8925"]').click();
  await ready(p, 8925);
  assert.match(await p.locator('#art-source').textContent(), /Pre-burn block 12,051,304/);
  assert.match(await p.locator('#token-source').getAttribute('href'), /0x2b1490a77b/);
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
  assert.equal(await p.locator('#f-merges').textContent(), '0');
  assert.equal(await p.locator('.tree-node').count(), 1);
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
  // This ID is intentionally outside the bundled portraits and must resolve from the public service.
  if (process.env.ALBUM_LIVE === '1') {
    await find(p, 42);
    await ready(p, 42);
    assert.match(await p.locator('#hero-art').getAttribute('src'), /^data:image\/svg/);
    assert.match(await p.locator('#token-source').getAttribute('href'), /squeeks\/42/);
    console.log('Live official NFT lookup passed for #42');
    const stale = await browser.newContext();
    const original = JSON.parse(
      await readFile(new URL('../dist/data/archive.json', import.meta.url), 'utf8'),
    );
    const last = original.events.pop();
    original.safeBlock = last.block - 1;
    original.burned--;
    original.live++;
    delete original.portraits[last.donor];
    await stale.route(
      (url) => url.pathname.endsWith('/data/archive.json'),
      (r) => r.fulfill({ json: original }),
    );
    const newer = watch(await stale.newPage());
    await newer.goto(base + '?id=' + last.donor + '&lang=en');
    await newer.waitForFunction(
      (data) =>
        document.querySelector('#art-source').textContent.includes('Pre-burn block') &&
        document.querySelector('#record-code').textContent.includes(String(data.survivor).padStart(5, '0')) &&
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
  await find(op, '42');
  await op.waitForFunction(() =>
    document.querySelector('#status').textContent.includes('could not be verified'),
  );
  assert.ok(await op.locator('#share').isDisabled());
  await find(op, '1');
  await ready(op, 1);
  await offline.close();
  assert.deepEqual(errors, []);
  console.log(
    'Desktop, mobile, keyboard, original image, ledger, PNG, clipboard, deep link, language and offline checks passed',
  );
} finally {
  await browser.close();
}
