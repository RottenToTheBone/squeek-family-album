import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prepareIndex, snapshotIndex, tokenNumber, treeRows, validUtc } from '../dist/lineage.js';
import { refreshIndex } from '../dist/chain.js';
import { confirmMerge, CURRENT, EVENT_TOPIC, HISTORICAL } from '../dist/receipts.js';

const root = new URL('../dist/', import.meta.url);
const seed = JSON.parse(await readFile(new URL('data/archive.json', root), 'utf8'));
const idx = snapshotIndex(seed);
const time = '2026-11-05T00:00:00.000Z';
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const hex = (n) => '0x' + n.toString(16);
const historical = (survivor, donor, level, block) => ({
  survivor,
  donor,
  level,
  block,
  logIndex: 1,
  tx: '0x' + word(block),
  at: time,
});
const example = [historical(8923, 8924, 2, 10), historical(8925, 8926, 2, 11), historical(8923, 8925, 3, 12)];

test('accepted token input stays within the issued range', () => {
  for (const v of ['1', '#8925', ' 008923 ', '9999']) assert.ok(tokenNumber(v, 9999));
  for (const v of ['', '#', '-4', '1.2', '1e2', '0', '10000', '0x12', '12cats'])
    assert.equal(tokenNumber(v, 9999), null);
});
test('a burned donor resolves to the complete surviving family in leaf order', () => {
  const frozen = prepareIndex({ issued: 9999, events: example });
  const f = frozen.family(8925);
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
    frozen.family(1).originals.map((n) => n.id),
    [1],
  );
  assert.equal(frozen.family(1).history.length, 0);
});
test('future merges may extend or consume either example without invalidating the archive', () => {
  const later = [
    ...example,
    historical(1, 2, 2, 13),
    historical(3, 4, 2, 14),
    historical(1, 3, 3, 15),
    historical(1, 8923, 4, 16),
  ];
  const family = prepareIndex({ issued: 9999, events: later }).family(8925);
  assert.equal(family.root.id, 1);
  assert.equal(family.root.level, 4);
  assert.equal(family.originals.length, 8);
});
test('invalid and impossible UTC dates never enter a family tree', () => {
  for (const x of [null, '', 'tomorrow', '2026-02-30T00:00:00Z', '2026-11-05T25:00:00Z']) {
    assert.equal(validUtc(x), false);
    assert.throws(() => prepareIndex({ issued: 9999, events: [{ ...example[0], at: x }] }));
  }
  for (const x of [time, '2026-11-05T00:00:00Z', '2024-02-29T23:59:59.10Z']) assert.equal(validUtc(x), true);
});
test('a published snapshot counts distinct canonical logs through its own safe block', () => {
  const record = example[0];
  const fixture = {
    schemaVersion: 1,
    chainId: 11155111,
    issued: 9999,
    burned: 2,
    live: 9997,
    asOf: time,
    safeBlock: 11,
  };
  assert.doesNotThrow(() => snapshotIndex({ ...fixture, events: example.slice(0, 2) }));
  assert.throws(() => snapshotIndex({ ...fixture, events: [record, record] }), /snapshot/);
  assert.throws(
    () => snapshotIndex({ ...fixture, events: [record, { ...example[1], block: 12 }] }),
    /snapshot/,
  );
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
test('live catch-up requires a complete, correctly dated delta and independent RPC receipts', async (t) => {
  const synthetic = { ...seed, releaseId: CURRENT.release, collection: CURRENT.collection, events: [], safeBlock: 100, safeBlockHash: '0x' + 'c'.repeat(64), issued: 4 };
  const common = {
    status: 'available',
    chain: {
      target: 'sepolia',
      chainId: '11155111',
      safeThroughBlock: '115',
      safeBlockHash: '0x' + 'd'.repeat(64),
      safeBlockTimestamp: time,
    },
    schemaVersion: 3,
    deployment: {
      releaseId: CURRENT.release, target: 'sepolia', chainId: 11155111,
      components: { collection: { address: CURRENT.collection }, staking: { address: CURRENT.staking } },
    },
    release: { id: CURRENT.release },
  };
  const event = {
    type: 'nft.merged',
    occurredAt: '2026-11-05T00:00:00Z',
    payload: {
      collection: CURRENT.collection,
      custody: 'wallet',
      donorTokenId: '2',
      survivorTokenId: '1',
      level: 2,
    },
    source: {
      kind: 'chain',
      target: 'sepolia',
      chainId: '11155111',
      releaseId: CURRENT.release,
      contractAddress: CURRENT.collection,
      blockNumber: '109',
      blockHash: '0x' + 'a'.repeat(64),
      logIndex: '3',
      confirmationStatus: 'safe',
      transactionHash: '0x' + '7'.repeat(64),
    },
  };
  let feed = [event];
  const timestamp = hex(Date.parse(time) / 1000);
  const receipt = {
    transactionHash: event.source.transactionHash,
    blockHash: event.source.blockHash,
    blockNumber: hex(109),
    status: '0x1',
  };
  const walletLog = {
    ...receipt,
    logIndex: '0x3',
    address: CURRENT.collection,
    removed: false,
    topics: [EVENT_TOPIC.wallet, '0x' + word(1), '0x' + word(2)],
    data: '0x' + word(2) + word(100),
  };
  const header = { hash: receipt.blockHash, number: receipt.blockNumber, timestamp };
  let rpcAttempts = 0;
  let reportedBurns = 1;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options?.method !== 'POST')
      return Response.json(
        url.endsWith('/state')
          ? {
              ...common,
              nft: { issued: '4', burned: String(reportedBurns), live: String(4 - reportedBurns) },
            }
          : { ...common, schemaVersion: 4, events: feed, nextCursor: null },
      );
    const batch = JSON.parse(options.body);
    rpcAttempts++;
    return Response.json(
      batch
        .map(({ id, method, params }) => {
          let result;
          if (method === 'eth_chainId') result = '0xaa36a7';
          if (method === 'eth_call') result = '0x' + word(params[0].data === '0x18160ddd' ? 3 : 1);
          if (method === 'eth_getTransactionReceipt') result = { ...receipt, logs: [walletLog] };
          if (method === 'eth_getBlockByNumber')
            result = {
              number: params[0],
              timestamp,
              hash: {
                '0x64': synthetic.safeBlockHash,
                '0x73': common.chain.safeBlockHash,
                '0x6d': header.hash,
              }[params[0]],
            };
          return { id, jsonrpc: '2.0', result };
        })
        .reverse(),
    );
  });
  const result = await refreshIndex(synthetic);
  assert.equal(result.safeBlock, 115);
  assert.equal(result.burned, 1);
  assert.equal(result.events[0].donor, 2);
  assert.ok(rpcAttempts >= 2);
  reportedBurns = 0;
  await assert.rejects(refreshIndex(synthetic), /canonical RPC/);
  reportedBurns = 1;
  feed = [{ ...event, payload: { ...event.payload, survivorTokenId: '3' } }];
  await assert.rejects(refreshIndex(synthetic), /canonical RPC/);
  for (const occurredAt of [null, '2026-02-30T00:00:00Z']) {
    feed = [{ ...event, occurredAt }];
    await assert.rejects(refreshIndex(synthetic), /Unexpected/);
  }
  feed = [];
  await assert.rejects(refreshIndex(synthetic), /Incomplete/);
  feed = [{ ...event, source: { ...event.source, contractAddress: '0x' + '9'.repeat(40) } }];
  await assert.rejects(refreshIndex(synthetic), /Unexpected/);
  const merge = { ...historical(1, 2, 2, 109), tx: event.source.transactionHash, logIndex: 3 };
  const proof = { merge, custody: 'staking', blockHash: header.hash };
  const stakingLog = {
    ...walletLog,
    address: CURRENT.staking,
    topics: [EVENT_TOPIC.staking, '0x' + word(123), '0x' + word(CURRENT.collection), '0x' + word(1)],
    data: '0x' + word(2) + word(2) + word(200),
  };
  assert.doesNotThrow(() => confirmMerge(proof, { ...receipt, logs: [stakingLog] }, header, CURRENT));
  for (const changed of [
    { address: CURRENT.collection },
    { logIndex: '0x4' },
    { removed: true },
    { blockHash: synthetic.safeBlockHash },
    { topics: [EVENT_TOPIC.wallet, ...stakingLog.topics.slice(1)] },
    { data: '0x' + word(3) + word(2) + word(200) },
  ]) {
    assert.throws(() => confirmMerge(proof, { ...receipt, logs: [{ ...stakingLog, ...changed }] }, header, CURRENT));
  }
  assert.throws(() => confirmMerge(proof, { ...receipt, status: '0x0', logs: [stakingLog] }, header, CURRENT));
  assert.throws(() =>
    confirmMerge(proof, { ...receipt, logs: [stakingLog] }, { ...header, hash: synthetic.safeBlockHash }, CURRENT),
  );
  assert.throws(() => confirmMerge(proof, { ...receipt, logs: [stakingLog] }, header, HISTORICAL));
  await assert.rejects(refreshIndex(seed), /Historical snapshot/);
  common.schemaVersion = 2;
  await assert.rejects(refreshIndex(synthetic), /Release mismatch/);
  common.schemaVersion = 3;
  common.deployment.components.staking.address = HISTORICAL.staking;
  await assert.rejects(refreshIndex(synthetic), /Release mismatch/);
});
