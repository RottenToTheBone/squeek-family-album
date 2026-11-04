// Event layouts from the reviewed stream-game Sepolia deployment. The indexer
// cannot nominate a different emitter when confirming an event from its own feed.
export const SEPOLIA = {
  release: 'stream-game-sepolia-test-20261026-01',
  collection: '0xcb98349c134ab983da5bfd80527dfe2552bdb70f',
  staking: '0x4b67b739dfd832f4eac67a7aa3bc244fb74cea4f',
};
export const ARCHIVES = ['https://sepolia.gateway.tenderly.co', 'https://rpc.sepolia.ethpandaops.io'];
export const EVENT_TOPIC = {
  wallet: '0x8a9b1a009a32cc0082d2270e9033429b8e1aa3235e7b8198b013f603116a3c87',
  staking: '0x47dc7fa0b474cf75263255e0530e84606f909e3099ad0d06bd67883467333339',
};
export const hash32 = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');
const hex = (n) => '0x' + n.toString(16);
function quantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) return NaN;
  const n = Number(BigInt(value));
  return Number.isSafeInteger(n) ? n : NaN;
}
function checkHeader(header, block, hash) {
  if (!hash32(hash) || quantity(header?.number) !== block || lower(header.hash) !== lower(hash))
    throw new Error('Canonical block mismatch');
}

export function confirmMerge(proof, receipt, header) {
  const { merge } = proof;
  const blockHash = proof.blockHash ?? receipt?.blockHash;
  checkHeader(header, merge.block, blockHash);
  const tx = lower(merge.tx),
    block = merge.block;
  const common = (record) =>
    record &&
    lower(record.transactionHash) === tx &&
    quantity(record.blockNumber) === block &&
    lower(record.blockHash) === lower(blockHash);
  if (
    !common(receipt) ||
    quantity(receipt.status) !== 1 ||
    !Array.isArray(receipt.logs) ||
    Date.parse(merge.at) !== quantity(header.timestamp) * 1000
  )
    throw new Error('Merge receipt mismatch');
  const logs = receipt.logs.filter((item) => quantity(item.logIndex) === merge.logIndex);
  const log = logs[0];
  // Compact prebuilt manifests omit custody. Only the two pinned receipt
  // emitters are eligible; live API claims must also match this choice.
  const custody = proof.custody ?? (lower(log?.address) === SEPOLIA.staking ? 'staking' : 'wallet');
  const staked = custody === 'staking';
  if (
    logs.length !== 1 ||
    !common(log) ||
    log.removed === true ||
    !Object.hasOwn(EVENT_TOPIC, custody) ||
    lower(log.address) !== (staked ? SEPOLIA.staking : SEPOLIA.collection) ||
    !Array.isArray(log.topics) ||
    log.topics.length !== (staked ? 4 : 3) ||
    !log.topics.every(hash32) ||
    lower(log.topics[0]) !== EVENT_TOPIC[custody] ||
    typeof log.data !== 'string' ||
    !/^0x[0-9a-f]+$/i.test(log.data) ||
    log.data.length !== 2 + 64 * (staked ? 3 : 2)
  )
    throw new Error('Unexpected receipt log');
  const words = log.data
    .slice(2)
    .match(/.{64}/g)
    .map((word) => BigInt('0x' + word));
  if (
    staked &&
    (BigInt(log.topics[2]) !== BigInt(SEPOLIA.collection) || !/^0x0{24}[a-f0-9]{40}$/i.test(log.topics[1]))
  )
    throw new Error('Staked collection mismatch');
  const survivor = BigInt(log.topics[staked ? 3 : 1]);
  const donor = staked ? words[0] : BigInt(log.topics[2]);
  if (
    survivor !== BigInt(merge.survivor) ||
    donor !== BigInt(merge.donor) ||
    words[staked ? 1 : 0] !== BigInt(merge.level)
  )
    throw new Error('Onchain merge IDs or level differ');
}

async function batch(endpoint, calls) {
  const body = calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: i + 1, method, params }));
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Receipt RPC unavailable');
  const replies = await response.json();
  if (!Array.isArray(replies) || replies.length !== calls.length) throw new Error('Incomplete RPC batch');
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  return body.map((request) => {
    const reply = byId.get(request.id);
    if (reply?.jsonrpc !== '2.0' || reply.error || reply.result == null)
      throw new Error('Missing RPC result');
    return reply.result;
  });
}
const blockCall = (n) => ['eth_getBlockByNumber', [hex(n), false]];

export async function verifyMergeReceipts(proofs, seed, state, providers) {
  const through = Number(state.chain.safeThroughBlock);
  for (const endpoint of providers) {
    try {
      const supplyCall = (data) => ['eth_call', [{ to: SEPOLIA.collection, data }, hex(through)]];
      const [chain, previous, current, live, burned] = await batch(endpoint, [
        ['eth_chainId', []],
        blockCall(seed.safeBlock),
        blockCall(through),
        supplyCall('0x18160ddd'), // totalSupply()
        supplyCall('0xd89135cd'), // totalBurned()
      ]);
      if (quantity(chain) !== 11155111) throw new Error('Wrong RPC network');
      checkHeader(previous, seed.safeBlock, seed.safeBlockHash);
      checkHeader(current, through, state.chain.safeBlockHash);
      if (
        !hash32(live) ||
        !hash32(burned) ||
        quantity(live) !== Number(state.nft.live) ||
        quantity(burned) !== Number(state.nft.burned)
      )
        throw new Error('Onchain supply mismatch');
      if (Date.parse(state.chain.safeBlockTimestamp) !== quantity(current.timestamp) * 1000)
        throw new Error('Safe block time mismatch');
      for (let offset = 0; offset < proofs.length; offset += 8) {
        const group = proofs.slice(offset, offset + 8);
        const calls = group.flatMap(({ merge }) => [
          ['eth_getTransactionReceipt', [merge.tx]],
          blockCall(merge.block),
        ]);
        const results = await batch(endpoint, calls);
        group.forEach((proof, i) => confirmMerge(proof, results[2 * i], results[2 * i + 1]));
      }
      return;
    } catch {
      /* Retry the entire proof against the next independent archive. */
    }
  }
  throw new Error('No canonical RPC confirmed the merge delta');
}
