import { readFile } from 'node:fs/promises';
import { snapshotIndex } from '../dist/lineage.js';
import { ARCHIVES, CURRENT, HISTORICAL, deploymentFor, verifyMergeReceipts } from '../dist/receipts.js';

const targets = process.argv[2] ? [[process.argv[2], null]] : [
  [new URL('../dist/data/current.json', import.meta.url), CURRENT],
  [new URL('../dist/data/archive.json', import.meta.url), HISTORICAL],
];
for (const [path, expected] of targets) {
  const seed = JSON.parse(await readFile(path, 'utf8'));
  const deployment = deploymentFor(seed);
  if (expected && deployment !== expected) throw new Error('Wrong deployment in snapshot');
  snapshotIndex(seed);
  const state = {
    nft: { live: seed.live, burned: seed.burned },
    chain: { safeThroughBlock: seed.safeBlock, safeBlockHash: seed.safeBlockHash, safeBlockTimestamp: seed.asOf },
  };
  await verifyMergeReceipts(seed.events.map((merge) => ({ merge })), seed, state, ARCHIVES);
  console.log(deployment.release, 'confirmed', seed.events.length, 'merge logs at Sepolia block', seed.safeBlock);
}
