import { svgImage } from './svg.js';

const rawBase = 'https://raw.githubusercontent.com/RottenToTheBone/squeek-family-album/main/dist/current-art/';
const packs = new Map();

async function limitedBytes(stream, max) {
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new Error('Portrait data exceeds its limit');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

async function read(url, max) {
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(12000) });
  if (!response.ok || !response.body) throw new Error('Original unavailable');
  return limitedBytes(response.body, max);
}

function pack(url) {
  if (!packs.has(url)) {
    if (packs.size >= 4) packs.delete(packs.keys().next().value);
    const item = read(url, 6_000_000).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
    packs.set(url, item);
    item.catch(() => { if (packs.get(url) === item) packs.delete(url); });
  }
  return packs.get(url);
}

async function original(bytes, id, record) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('') !== record.sha256)
    throw new Error('Original hash mismatch');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return { ...record, url: svgImage('data:image/svg+xml;base64,' + btoa(binary), id) };
}

export async function packedPortrait(id, record, safeBlock) {
  const path = 'current-packs/' + Math.floor(id / 128) + '.json';
  if (!Number.isInteger(id) || id < 1 || id > 9999 || !Number.isSafeInteger(safeBlock) ||
      record.pack !== path || record.file !== rawBase + id + '.svg' || !/^[0-9a-f]{64}$/.test(record.sha256))
    throw new Error('Invalid packed portrait');
  try {
    const group = await pack(path + '?b=' + safeBlock);
    const entry = group[id];
    if (typeof entry !== 'string' || entry.length > 1_400_000) throw new Error('Missing pack entry');
    const compressed = Uint8Array.from(atob(entry), (c) => c.charCodeAt(0));
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await original(await limitedBytes(stream, 1_000_000), id, record);
  } catch {
    // A raw checkout or an older browser can still open the exact original.
    for (const url of ['current-art/' + id + '.svg', record.file]) {
      try { return await original(await read(url, 1_000_000), id, record); } catch { /* Try the next source. */ }
    }
    throw new Error('No verified original available');
  }
}
