import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Vary only browser-local responses. The public site and the upstream services
// do not receive fixture data.
export async function browserRegressions(browser, base, bundled) {
  const cases = JSON.parse(await readFile(new URL('svg-cases.json', import.meta.url), 'utf8'));
  const examples = bundled.events.filter((e) => [8924, 8925, 8926].includes(e.donor));
  const seed = {
    ...bundled,
    events: examples,
    burned: examples.length,
    live: bundled.issued - examples.length,
    portraits: Object.fromEntries([1, 8923, 8924, 8925, 8926].map((id) => [id, bundled.portraits[id]])),
  };
  const state = {
    status: 'available',
    release: { id: seed.releaseId },
    chain: {
      target: 'sepolia',
      chainId: 11155111,
      safeThroughBlock: seed.safeBlock,
      safeBlockTimestamp: seed.asOf,
      safeBlockHash: seed.safeBlockHash,
    },
    identities: {
      genesis: seed.collection,
      staking: { proxy: '0x4b67b739dfd832f4eac67a7aa3bc244fb74cea4f' },
    },
    nft: { issued: seed.issued, burned: seed.burned, live: seed.live },
  };
  const make = async (stateResponse = state) => {
    const c = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await c.route(
      (u) => u.pathname.endsWith('/data/archive.json'),
      (r) => r.fulfill({ json: seed }),
    );
    await c.route(
      (u) => u.pathname === '/v1/economy/state',
      (r) => r.fulfill({ json: stateResponse }),
    );
    await c.route(
      (u) => ['sepolia.gateway.tenderly.co', 'rpc.sepolia.ethpandaops.io'].includes(u.hostname),
      (r) => {
        const calls = r.request().postDataJSON();
        if (!Array.isArray(calls)) return r.abort();
        const results = calls.map(({ id, method, params }) => {
          let result = null;
          if (method === 'eth_chainId') result = '0xaa36a7';
          if (method === 'eth_getBlockByNumber')
            result = {
              number: params[0],
              hash: seed.safeBlockHash,
              timestamp: '0x' + (Date.parse(seed.asOf) / 1000).toString(16),
            };
          if (method === 'eth_call')
            result =
              '0x' +
              (params[0].data === '0x18160ddd' ? seed.live : seed.burned).toString(16).padStart(64, '0');
          return { jsonrpc: '2.0', id, result };
        });
        return r.fulfill({ json: results });
      },
    );
    return c;
  };
  const ready = (p, id) =>
    p.waitForFunction(
      (n) =>
        document.querySelector('#selected-id').textContent === '#' + n &&
        !document.querySelector('#hero-art').hidden,
      id,
    );
  const lookup = async (p, id) => {
    await p.locator('#token-input').fill(String(id));
    await p.locator('#lookup-form button').click();
  };
  const c = await make();
  try {
    const p = await c.newPage();
    await p.goto(base + '?id=8925&lang=en&private_ref=EXAMPLE_ONLY#fragment');
    await ready(p, 8925);
    await p.locator('#share').click();
    await p.locator('#save-card:not([hidden])').waitFor();
    await p.locator('#copy-link').click();
    const link = await p.evaluate(() => navigator.clipboard.readText());
    const u = new URL(link);
    assert.equal(u.origin, new URL(base).origin);
    assert.equal(u.pathname, new URL(base).pathname);
    assert.deepEqual([...u.searchParams.keys()].sort(), ['id', 'lang', 'stage']);
    assert.equal(u.hash, '');
    assert.equal(u.searchParams.get('id'), '8925');
    await p.evaluate(() =>
      Object.defineProperty(navigator.clipboard, 'writeText', {
        value: async () => {
          throw new Error('Permission denied');
        },
        configurable: true,
      }),
    );
    await p.locator('#copy-link').click();
    assert.equal(await p.locator('#card-status').textContent(), link);
    await p.keyboard.press('Escape');
    await lookup(p, 1);
    await ready(p, 1);
    await lookup(p, 8925);
    await ready(p, 8925);
    await p.locator('#share').click();
    await p.locator('#save-card:not([hidden])').waitFor();
    await p.goBack();
    await ready(p, 1);
    assert.equal(await p.locator('#share-dialog').isVisible(), false);
    await p.goForward();
    await ready(p, 8925);
    await p.locator('[data-key="o-8924"]').click();
    await ready(p, 8924);
    assert.equal(await p.title(), 'Squeek #8924 · Family Album');
    assert.equal(await p.locator('#token-input').inputValue(), '8924');
    const images = await Promise.all(
      Object.entries(bundled.portraits).map(async ([id, r]) => [
        +id,
        (await readFile(new URL('../dist/' + r.file, import.meta.url))).toString('base64'),
      ]),
    );
    const svgResult = await p.evaluate(
      async ({ cases, images }) => {
        const { svgImage } = await import(new URL('./svg.js', location.href));
        const data = (raw) => 'data:image/svg+xml;base64,' + btoa(raw);
        for (const [id, b64] of images)
          if (svgImage('data:image/svg+xml;base64,' + b64, id) !== 'data:image/svg+xml;base64,' + b64)
            throw new Error('Changed original #' + id);
        if (
          svgImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(cases.valid), 42) !==
          data(cases.valid)
        )
          throw new Error('Percent encoding differs');
        let rejected = 0;
        for (const item of cases.invalid) {
          const xml = item.includes('@SVG@')
            ? item.replace('@SVG@', cases.valid)
            : cases.valid.replace('</svg>', item + '</svg>');
          for (const value of [
            data(xml),
            'data:image/svg+xml,' + encodeURIComponent(xml),
            data([...xml].map((x) => x + '\0').join('')),
            data([...xml].map((x) => '\0' + x).join('')),
          ]) {
            try {
              svgImage(value, 42);
            } catch {
              rejected++;
              continue;
            }
            throw new Error('Accepted unexpected SVG');
          }
        }
        for (const value of [
          'data:image/svg+xml;charset=utf-16;base64,' + btoa(cases.valid),
          data('\xff\xfe' + cases.valid),
          data(cases.valid.replace('#42', '#41')),
        ]) {
          try {
            svgImage(value, 42);
          } catch {
            rejected++;
            continue;
          }
          throw new Error('Accepted encoding or title mismatch');
        }
        return { rejected, originals: images.length };
      },
      { cases, images },
    );
    assert.equal(svgResult.rejected, cases.invalid.length * 4 + 3);
    assert.equal(svgResult.originals, images.length);
    assert.doesNotMatch(await p.locator('meta[property="og:description"]').getAttribute('content'), /#\d+/);
    assert.match(
      await p.locator('meta[property="og:image"]').getAttribute('content'),
      /\/social-cover\.png$/,
    );
  } finally {
    await c.close();
  }

  const d = await make();
  try {
    let calls = 0;
    const image = 'data:image/svg+xml;base64,' + Buffer.from(cases.valid).toString('base64');
    const record = { ...state, tokenId: '42', level: 1, custody: { burned: false } };
    await d.route(
      (u) => u.pathname === '/v1/squeeks/42',
      (r) => {
        calls++;
        return r.fulfill({
          json: {
            ...record,
            metadata: calls === 1 ? null : { status: 'available', name: 'Squeek #42', imageDataUri: image },
          },
        });
      },
    );
    const p = await d.newPage();
    await p.goto(base + '?id=42&lang=en');
    await p.waitForFunction(
      () => document.querySelector('#art-fallback').textContent === 'Original portrait unavailable',
    );
    await lookup(p, 1);
    await ready(p, 1);
    await lookup(p, 42);
    await ready(p, 42);
    assert.equal(calls, 2);
    // A separate page has no image cache. The live lookup and the historical
    // tokenURI fallback must both reject a file with a stylesheet instruction.
    const malicious =
      'data:image/svg+xml;base64,' +
      Buffer.from(cases.invalid[0].replace('@SVG@', cases.valid)).toString('base64');
    await d.route(
      (u) => u.pathname === '/v1/squeeks/42',
      (r) => r.fulfill({ json: { ...record, metadata: { name: 'Squeek #42', imageDataUri: malicious } } }),
    );
    const meta =
      'data:application/json;base64,' +
      Buffer.from(JSON.stringify({ name: 'Squeek #42', image: malicious })).toString('base64');
    const bytes = Buffer.from(meta),
      word = (n) => n.toString(16).padStart(64, '0');
    const encoded =
      '0x' +
      word(32) +
      word(bytes.length) +
      bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
    let rpcCalls = 0;
    await d.route(
      (u) => ['sepolia.gateway.tenderly.co', 'rpc.sepolia.ethpandaops.io'].includes(u.hostname),
      (r) => {
        if (Array.isArray(r.request().postDataJSON())) return r.fallback();
        rpcCalls++;
        return r.fulfill({ json: { jsonrpc: '2.0', id: 1, result: encoded } });
      },
    );
    await p.reload();
    await p.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('could not be verified'),
    );
    assert.ok(await p.locator('#enlarge').isDisabled());
    const rejected = await p.evaluate(async (seed) => {
      const { lostPortrait } = await import(new URL('./chain.js', location.href));
      try {
        await lostPortrait(42, { block: 100 }, seed);
        return false;
      } catch {
        return true;
      }
    }, seed);
    assert.ok(rejected);
    assert.equal(rpcCalls, 2);
  } finally {
    await d.close();
  }

  for (const intent of ['lookup', 'deep-link language change']) {
    const slow = await make();
    try {
      let release, started;
      const gate = new Promise((resolve) => {
          release = resolve;
        }),
        waiting = new Promise((resolve) => {
          started = resolve;
        });
      await slow.route(
        (u) => u.pathname.endsWith('/data/archive.json'),
        async (r) => {
          started();
          await gate;
          await r.fulfill({ json: seed });
        },
      );
      const p = await slow.newPage();
      const route =
        intent === 'lookup' ? '?lang=en' : '?id=8925&stage=o-8925&lang=en&private_ref=EXAMPLE_ONLY#fragment';
      await p.goto(base + route, { waitUntil: 'commit' });
      await waiting;
      if (intent === 'lookup') await lookup(p, 1);
      else await p.locator('#lang').click();
      release();
      await ready(p, intent === 'lookup' ? 1 : 8925);
      if (intent !== 'lookup') {
        const url = new URL(p.url());
        assert.equal(url.searchParams.get('stage'), 'o-8925');
        assert.equal(url.searchParams.get('lang'), 'zh');
        assert.equal(url.searchParams.has('private_ref'), false);
        assert.equal(url.hash, '');
        assert.equal(await p.locator('.tree-node[aria-pressed=true]').getAttribute('data-key'), 'o-8925');
      }
    } finally {
      await slow.close();
    }
  }

  const later = {
    ...state,
    chain: { ...state.chain, safeThroughBlock: seed.safeBlock + 2 },
    nft: { ...state.nft, burned: state.nft.burned + 1, live: state.nft.live - 1 },
  };
  for (const badTime of [null, '2026-02-30T00:00:00Z']) {
    const ctx = await make(later);
    try {
      const errors = [];
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      const event = {
        type: 'nft.merged',
        occurredAt: badTime,
        payload: {
          collection: seed.collection,
          custody: 'wallet',
          survivorTokenId: '1',
          donorTokenId: '2',
          level: 2,
        },
        source: {
          kind: 'chain',
          target: 'sepolia',
          chainId: 11155111,
          releaseId: seed.releaseId,
          contractAddress: seed.collection,
          blockNumber: seed.safeBlock + 1,
          logIndex: 1,
          blockHash: '0x' + 'a'.repeat(64),
          transactionHash: '0x' + 'b'.repeat(64),
          confirmationStatus: 'safe',
        },
      };
      await ctx.route(
        (u) => u.pathname === '/v1/events',
        (r) => r.fulfill({ json: { ...later, events: [event], nextCursor: null } }),
      );
      await page.goto(base + '?id=8925&lang=en');
      await ready(page, 8925);
      await page.waitForFunction(() =>
        document.querySelector('#status').textContent.includes('archive time'),
      );
      assert.equal(await page.locator('.tree-node').count(), 7);
      assert.equal(await page.locator('.ledger-row').count(), 3);
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  }
  console.log(
    'Back/forward, clean links and clipboard fallback, queued search, metadata retry, SVG and invalid-delta regressions passed.',
  );
}
