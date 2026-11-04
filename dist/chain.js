import { eventKey, snapshotIndex, validUtc } from './lineage.js';
import { ARCHIVES, hash32, SEPOLIA, verifyMergeReceipts } from './receipts.js';
import { svgImage } from './svg.js';

export const API = 'https://api.squeekchain.com/v1';
export const txLink = (hash) => 'https://sepolia.etherscan.io/tx/' + hash;
export const tokenLink = (id) => API + '/squeeks/' + id;

async function json(url, options = {}, timeout = 7000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function sameRelease(payload, seed) {
  return (
    payload?.status === 'available' &&
    payload.chain?.target === 'sepolia' &&
    Number(payload.chain.chainId) === seed.chainId &&
    payload.release?.id === seed.releaseId &&
    payload.identities?.genesis?.toLowerCase() === seed.collection.toLowerCase()
  );
}

// Apply only a complete contiguous interval above the bundled safe block. Leave the snapshot intact on any failure.
export async function refreshIndex(seed) {
  const state = await json(API + '/economy/state');
  if (
    !sameRelease(state, seed) ||
    seed.releaseId !== SEPOLIA.release ||
    seed.collection.toLowerCase() !== SEPOLIA.collection ||
    state.identities.staking?.proxy?.toLowerCase() !== SEPOLIA.staking
  )
    throw new Error('Release mismatch');
  const through = Number(state.chain.safeThroughBlock);
  if (!Number.isSafeInteger(through) || through < seed.safeBlock) throw new Error('Stale projection');
  const expected = Number(state.nft.burned);
  const issued = Number(state.nft.issued),
    live = Number(state.nft.live);
  if (
    issued !== seed.issued ||
    !Number.isInteger(expected) ||
    issued !== expected + live ||
    (through === seed.safeBlock && state.chain.safeBlockHash !== seed.safeBlockHash)
  )
    throw new Error('Unmatched snapshot');
  const asOf = state.chain.safeBlockTimestamp;
  if (!validUtc(asOf) || !hash32(state.chain.safeBlockHash)) throw new Error('Invalid safe block');
  const updatedStats = {
    asOf,
    safeBlock: through,
    safeBlockHash: state.chain.safeBlockHash,
    issued,
    burned: expected,
    live,
  };
  if (expected === seed.events.length) {
    await verifyMergeReceipts([], seed, state, ARCHIVES);
    return { ...seed, ...updatedStats };
  }
  const extra = new Map();
  const cursors = new Set();
  let cursor = '';
  for (let page = 0; page < 12; page++) {
    const params = new URLSearchParams({ category: 'players', limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const feed = await json(API + '/events?' + params);
    if (!sameRelease(feed, seed) || !Array.isArray(feed.events)) throw new Error('Incomplete feed');
    let boundary = false;
    for (const item of feed.events) {
      const src = item.source;
      if (src?.kind !== 'chain') continue;
      const block = Number(src.blockNumber);
      if (block <= seed.safeBlock) {
        boundary = true;
        continue;
      }
      if (block > through || item.type !== 'nft.merged') continue;
      const p = item.payload;
      const contract =
        p.custody === 'wallet'
          ? seed.collection
          : p.custody === 'staking'
            ? state.identities.staking?.proxy
            : '';
      if (
        !contract ||
        p.collection.toLowerCase() !== seed.collection.toLowerCase() ||
        src.contractAddress?.toLowerCase() !== contract.toLowerCase() ||
        !hash32(src.blockHash) ||
        !validUtc(item.occurredAt) ||
        src.releaseId !== seed.releaseId ||
        src.target !== 'sepolia' ||
        Number(src.chainId) !== seed.chainId ||
        !['safe', 'finalized'].includes(src.confirmationStatus) ||
        !/^0x[0-9a-f]{64}$/i.test(src.transactionHash)
      )
        throw new Error('Unexpected merge');
      const m = {
        survivor: Number(p.survivorTokenId),
        donor: Number(p.donorTokenId),
        level: Number(p.level),
        block,
        logIndex: Number(src.logIndex),
        tx: src.transactionHash,
        at: item.occurredAt,
      };
      const key = eventKey(m);
      const proof = { merge: m, blockHash: src.blockHash.toLowerCase(), custody: p.custody };
      if (extra.has(key) && JSON.stringify(extra.get(key)) !== JSON.stringify(proof))
        throw new Error('Conflicting merge');
      extra.set(key, proof);
    }
    if (boundary || !feed.nextCursor) {
      const proofs = [...extra.values()];
      const updated = { ...seed, ...updatedStats, events: [...seed.events, ...proofs.map((p) => p.merge)] };
      if (updated.events.length !== expected) throw new Error('Incomplete burn coverage');
      snapshotIndex(updated);
      await verifyMergeReceipts(proofs, seed, state, ARCHIVES);
      return updated;
    }
    if (cursors.has(feed.nextCursor)) throw new Error('Repeated cursor');
    cursor = feed.nextCursor;
    cursors.add(cursor);
  }
  throw new Error('Snapshot needs a full refresh');
}

export async function livePortrait(id, seed) {
  const info = await json(tokenLink(id));
  if (!sameRelease(info, seed) || Number(info.tokenId) !== id)
    throw new Error('Token projection unavailable');
  if (info.metadata && info.metadata.status !== 'pending' && info.metadata.name !== 'Squeek #' + id)
    throw new Error('Portrait mismatch');
  if (info.metadata?.imageDataUri && info.metadata.name !== 'Squeek #' + id)
    throw new Error('Portrait mismatch');
  const url = info.metadata?.imageDataUri ? svgImage(info.metadata.imageDataUri, id) : '';
  const palette = info.metadata?.attributes?.find((t) => t.traitType === 'Palette')?.value ?? '';
  return {
    url,
    palette,
    level: Number(info.level),
    burned: info.custody?.burned === true,
    block: Number(info.metadata?.refreshedAtBlock ?? info.chain.safeThroughBlock),
    source: 'chain',
  };
}

function tokenMetadata(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-f]+$/i.test(hex) || hex.length > 4_000_000)
    throw new Error('Invalid URI result');
  const offset = Number(BigInt('0x' + hex.slice(2, 66))) * 2 + 2;
  if (offset !== 66) throw new Error('Invalid ABI offset');
  const length = Number(BigInt('0x' + hex.slice(offset, offset + 64)));
  const start = offset + 64;
  if (!Number.isSafeInteger(length) || length < 1 || start + length * 2 > hex.length)
    throw new Error('Invalid URI size');
  const raw = hex.slice(start, start + length * 2);
  const bytes = Uint8Array.from(raw.match(/../g), (byte) => parseInt(byte, 16));
  const uri = new TextDecoder().decode(bytes);
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:application/json') || comma < 0) throw new Error('Invalid NFT metadata');
  const jsonText = uri.slice(0, comma).includes(';base64')
    ? atob(uri.slice(comma + 1))
    : decodeURIComponent(uri.slice(comma + 1));
  return JSON.parse(jsonText);
}
export async function lostPortrait(id, event, seed) {
  const block = event.block - 1;
  for (const rpc of ARCHIVES) {
    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          { to: seed.collection, data: '0xc87b56dd' + id.toString(16).padStart(64, '0') },
          '0x' + block.toString(16),
        ],
      };
      const reply = await json(
        rpc,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        9000,
      );
      const info = tokenMetadata(reply.result);
      if (info.name !== 'Squeek #' + id) throw new Error('Portrait mismatch');
      const url = svgImage(info.image ?? info.image_data, id);
      const palette = info.attributes?.find((t) => t.trait_type === 'Palette')?.value ?? '';
      return { url, palette, block, source: 'archive' };
    } catch {
      /* Continue with the independent archive. */
    }
  }
  throw new Error('Archive unavailable');
}
