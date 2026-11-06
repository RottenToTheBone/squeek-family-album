import { readFile } from 'node:fs/promises';
import { snapshotIndex } from '../dist/lineage.js';
import { ARCHIVES, CURRENT, HISTORICAL, deploymentFor, verifyMergeReceipts } from '../dist/receipts.js';

const since = process.argv[2] === '--since' ? JSON.parse(await readFile(process.argv[3], 'utf8')) : null;
const targets = process.argv[2] && !since ? [[process.argv[2], null]] : [
  [new URL('../dist/data/current.json', import.meta.url), CURRENT],
  [new URL('../dist/data/archive.json', import.meta.url), HISTORICAL],
];
for (const [path, expected] of targets) {
  const seed = JSON.parse(await readFile(path, 'utf8'));
  const deployment = deploymentFor(seed);
  if (expected && deployment !== expected) throw new Error('Wrong deployment in snapshot');
  snapshotIndex(seed);
  let prior = seed;
  let events = seed.events;
  if (since && deployment === CURRENT) {
    snapshotIndex(since);
    if (deploymentFor(since) !== CURRENT || since.safeBlock > seed.safeBlock ||
        since.events.length > events.length ||
        !since.events.every((event, i) => JSON.stringify(event) === JSON.stringify(events[i])))
      throw new Error('Verified history was rewritten');
    prior = since;
    events = events.slice(since.events.length);
    if (events.some((event) => event.block <= since.safeBlock)) throw new Error('Merge precedes checkpoint');
  }
  const state = {
    nft: { live: seed.live, burned: seed.burned },
    chain: { safeThroughBlock: seed.safeBlock, safeBlockHash: seed.safeBlockHash, safeBlockTimestamp: seed.asOf },
  };
  await verifyMergeReceipts(events.map((merge) => ({ merge })), prior, state, ARCHIVES, 3);
  console.log(deployment.release, 'confirmed', events.length, 'merge logs;', seed.events.length, 'total at block', seed.safeBlock);
}
