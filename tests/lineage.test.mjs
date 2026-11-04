import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prepareIndex, tokenNumber, treeRows } from '../dist/lineage.js';
import { refreshIndex } from '../dist/chain.js';

const root = new URL('../dist/', import.meta.url);
const seed = JSON.parse(await readFile(new URL('data/archive.json', root), 'utf8'));
const idx = prepareIndex(seed);

test('accepted token input stays within the issued range', () => {
  for (const v of ['1', '#8925', ' 008923 ', '9999']) assert.ok(tokenNumber(v, 9999));
  for (const v of ['', '#', '-4', '1.2', '1e2', '0', '10000', '0x12', '12cats'])
    assert.equal(tokenNumber(v, 9999), null);
});
test('a burned donor resolves to the complete surviving family in leaf order', () => {
  const f = idx.family(8925);
  assert.equal(f.root.id, 8923);
  assert.equal(f.root.level, 3);
  assert.deepEqual(
    f.originals.map((x) => x.id),
    [8923, 8924, 8925, 8926],
  );
  assert.deepEqual(
    f.history.map((n) => [n.event.donor, n.event.survivor]),
    [
      [8925, 8923],
      [8926, 8925],
      [8924, 8923],
    ],
  );
  assert.equal(treeRows(f.root).placed.length, 7);
  assert.equal(treeRows(f.root).rows, 4);
  assert.deepEqual(
    idx.family(1).originals.map((n) => n.id),
    [1],
  );
  assert.equal(idx.family(1).history.length, 0);
});
test('every archived family is complete and every portrait matches its indexed bytes and provenance', async () => {
  assert.equal(seed.events.length, seed.burned);
  assert.equal(seed.burned + seed.live, seed.issued);
  for (const [id, p] of Object.entries(seed.portraits)) {
    const f = idx.family(Number(id));
    assert.equal(f.originals.length, 2 ** (f.root.level - 1));
    assert.equal(f.history.length, f.originals.length - 1);
    const svg = await readFile(new URL(p.file, root));
    assert.equal(createHash('sha256').update(svg).digest('hex'), p.sha256);
    assert.ok(svg.includes('<title>Squeek #' + id + '</title>'));
    const burn = idx.absorbed.get(Number(id));
    assert.equal(p.source, burn ? 'archive' : 'chain');
    assert.equal(p.block, burn ? burn.block - 1 : seed.safeBlock);
  }
  for (const event of seed.events) {
    assert.ok(seed.portraits[event.donor]);
    assert.ok(seed.portraits[event.survivor]);
  }
});
test('duplicates, missing generations and reuse of burned IDs are distinguished', () => {
  const e = seed.events[0];
  assert.doesNotThrow(() => prepareIndex({ ...seed, events: [e, e] }));
  assert.throws(() => prepareIndex({ ...seed, events: [e, { ...e, donor: e.donor + 10 }] }), /Conflicting/);
  assert.throws(() => prepareIndex({ ...seed, events: [{ ...e, level: 3 }] }), /Incomplete/);
  assert.throws(
    () => prepareIndex({ ...seed, events: [e, { ...e, block: e.block + 1, logIndex: e.logIndex + 1 }] }),
    /Invalid/,
  );
});
test('live catch-up applies a complete verified delta and rejects a missing merge', async (t) => {
  const synthetic = { ...seed, events: [], safeBlock: 100, safeBlockHash: '0x' + 'c'.repeat(64), issued: 4 };
  const common = {
    status: 'available',
    chain: {
      target: 'sepolia',
      chainId: '11155111',
      safeThroughBlock: '115',
      safeBlockHash: '0x' + 'd'.repeat(64),
      safeBlockTimestamp: '2026-11-05T00:00:00Z',
    },
    identities: { genesis: seed.collection, staking: { proxy: '0x' + '2'.repeat(40) } },
    release: { id: seed.releaseId },
  };
  const event = {
    type: 'nft.merged',
    occurredAt: '2026-11-05T00:00:00Z',
    payload: {
      collection: seed.collection,
      custody: 'wallet',
      donorTokenId: '2',
      survivorTokenId: '1',
      level: 2,
    },
    source: {
      kind: 'chain',
      target: 'sepolia',
      chainId: '11155111',
      releaseId: seed.releaseId,
      contractAddress: seed.collection,
      blockNumber: '109',
      logIndex: '3',
      confirmationStatus: 'safe',
      transactionHash: '0x' + '7'.repeat(64),
    },
  };
  let feed = [event];
  t.mock.method(globalThis, 'fetch', async (url) =>
    Response.json(
      url.endsWith('/state')
        ? { ...common, nft: { issued: '4', burned: '1', live: '3' } }
        : { ...common, events: feed, nextCursor: null },
    ),
  );
  const result = await refreshIndex(synthetic);
  assert.equal(result.safeBlock, 115);
  assert.equal(result.burned, 1);
  assert.equal(result.events[0].donor, 2);
  feed = [];
  await assert.rejects(refreshIndex(synthetic), /Incomplete/);
  feed = [{ ...event, source: { ...event.source, contractAddress: '0x' + '9'.repeat(40) } }];
  await assert.rejects(refreshIndex(synthetic), /Unexpected/);
});
