import { readFile } from 'node:fs/promises';
import { snapshotIndex } from '../dist/lineage.js';
import { ARCHIVES, SEPOLIA, verifyMergeReceipts } from '../dist/receipts.js';

const path = process.argv[2] ?? new URL('../dist/data/archive.json', import.meta.url);
const seed = JSON.parse(await readFile(path, 'utf8'));
if (seed.releaseId !== SEPOLIA.release || seed.collection !== SEPOLIA.collection)
  throw new Error('Unexpected snapshot');
snapshotIndex(seed);
const state = {
  nft: { live: seed.live, burned: seed.burned },
  chain: {
    safeThroughBlock: seed.safeBlock,
    safeBlockHash: seed.safeBlockHash,
    safeBlockTimestamp: seed.asOf,
  },
};
await verifyMergeReceipts(
  seed.events.map((merge) => ({ merge })),
  seed,
  state,
  ARCHIVES,
);
console.log(
  'Confirmed ' + seed.events.length + ' merge logs at canonical Sepolia block ' + seed.safeBlock + '.',
);
