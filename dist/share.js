import { CURRENT, HISTORICAL } from './receipts.js';

const albumOrigin = 'https://squeek.machinepaystack.com/';
const ink = '#243126', muted = '#51634b', paper = '#f5f3ea';
const mono = 'Consolas, monospace', serif = 'Georgia, "SimSun", serif';

function tokenId(value) {
  if (!Number.isInteger(value) || value < 1 || value > 9999) throw new Error('Invalid card token');
  return String(value);
}

function publicLink(fields, zh) {
  const url = new URL(albumOrigin);
  url.search = new URLSearchParams({ ...fields, lang: zh ? 'zh' : 'en' });
  return url.href;
}

function familyLink(selected, release, zh) {
  const id = tokenId(selected.id);
  if (release !== CURRENT.release && release !== HISTORICAL.release) throw new Error('Unknown collection');
  if (selected.key !== 'o-' + id && !/^m-[1-9]\d{0,15}-(?:0|[1-9]\d{0,15})$/.test(selected.key))
    throw new Error('Invalid card stage');
  return publicLink({ release, id, stage: selected.key }, zh);
}

export function comparisonLink({ keep, donor, at, zh }) {
  if (keep === donor || !Number.isSafeInteger(at) || at < 1) throw new Error('Invalid comparison');
  return publicLink({ release: CURRENT.release, view: 'compare', keep: tokenId(keep), donor: tokenId(donor), at }, zh);
}

async function imageAt(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

function makeCard(zh) {
  const canvas = document.createElement('canvas');
  canvas.width = 1120;
  canvas.height = 716;
  const c = canvas.getContext('2d');
  const word = (en, cn) => (zh ? cn : en);
  function text(s, x, y, size, font = mono, color = ink) {
    c.fillStyle = color;
    c.font = size + 'px ' + font;
    c.fillText(s, x, y);
  }
  c.fillStyle = paper;
  c.fillRect(0, 0, 1120, 716);
  c.fillStyle = ink;
  c.fillRect(32, 32, 1056, 3);
  c.fillRect(43, 640, 1034, 1);
  return { canvas, c, text, word };
}

let encoderLoadFailures = 0;
async function drawCode(c, link, left, top, box) {
  // Some browsers cache a failed module request until its URL changes. Retry
  // only on the next explicit export so a temporary outage is recoverable.
  const moduleUrl = encoderLoadFailures ? './qr.js?retry=' + encoderLoadFailures : './qr.js';
  let encoder;
  try {
    encoder = await import(moduleUrl);
  } catch (error) {
    encoderLoadFailures++;
    throw error;
  }
  // Keep the four-module quiet zone and every module on an integer pixel grid.
  const { size, data } = encoder.encode(link, { ecc: 'M', boostEcc: true, border: 4 });
  const scale = Math.floor(box / size);
  if (scale < 4) throw new Error('Code does not fit on card');
  const x = 2 * Math.floor((left + (box - size * scale) / 2) / 2);
  const y = 2 * Math.floor((top + (box - size * scale) / 2) / 2);
  c.fillStyle = '#fff';
  c.fillRect(x, y, size * scale, size * scale);
  c.fillStyle = '#111';
  data.forEach((row, i) => row.forEach((dark, j) => {
    if (dark) c.fillRect(x + j * scale, y + i * scale, scale, scale);
  }));
}

function toPng(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG export unavailable'))),
      'image/png',
    ),
  );
}

export async function familyCard({ selected, family, portrait, artFor, historical, deployment, zh }) {
  const { canvas, c, text, word } = makeCard(zh);
  const link = familyLink(selected, deployment.release, zh);
  const collection = historical ? word('HISTORICAL COLLECTION', '历史藏品') : word('CURRENT COLLECTION', '当前藏品');
  text('SQUEEK  /  ' + collection + '  /  ETHEREUM SEPOLIA', 45, 71, 18);
  text(word('SCAN TO VIEW THIS STAGE', '扫码查看此家谱节点'), 828, 71, 16);
  await drawCode(c, link, 756, 74, 320);
  text(word('Family Album.', '仓鼠家谱'), 40, 161, 79, serif);
  c.fillStyle = '#26372b';
  c.fillRect(43, 200, 395, 415);
  const hero = await imageAt(portrait.url);
  c.drawImage(hero, 68, 224, 345, 345);
  text(
    (portrait.source === 'archive'
      ? word('RECOVERED  /  ', '已找回原画  /  ')
      : word('ORIGINAL  /  ', '链上原画  /  ')) +
      '#' +
      selected.id,
    69,
    596,
    16,
    mono,
    '#deedaa',
  );
  text(word('FAMILY OF #', '家族 #') + family.root.id, 475, 232, 19, mono, muted);
  text('#' + selected.id, 474, 303, 68, serif);
  const n = family.originals.length,
    m = family.history.length;
  text(
    word(
      n + (n === 1 ? ' original' : ' originals') + '  /  ' + m + (m === 1 ? ' merge' : ' merges'),
      n + ' 只原始藏品  /  ' + m + ' 次合并',
    ),
    478,
    344,
    18,
  );
  text(word('Level ', '等级 ') + family.root.level, 478, 373, 18, mono, muted);
  c.fillStyle = '#bdc4ad';
  c.fillRect(478, 400, 583, 1);
  text(word('ORIGINAL PORTRAITS', '原始画像'), 478, 420, 17, mono, muted);
  const leaves = family.originals.slice(0, 4);
  await Promise.all(
    leaves.map(async (node, i) => {
      const x = 478 + i * 141;
      try {
        const img = await imageAt((await artFor(node.id)).url);
        c.drawImage(img, x, 441, 112, 112);
      } catch {
        c.fillStyle = '#d9ddce';
        c.fillRect(x, 441, 112, 112);
        text('—', x + 38, 508, 30);
      }
      text('#' + node.id, x, 580, 17);
    }),
  );
  if (n > leaves.length)
    text(word('First four of ' + n + ' originals', '展示 ' + n + ' 只中的前四只'), 478, 610, 15, mono, muted);
  text('SQUEEK FAMILY ALBUM  /  ' + deployment.release, 43, 679, 16);
  text(word('FAMILY #', '家族 #') + family.root.id, 894, 679, 16);
  return toPng(canvas);
}

export async function comparisonCard({ keep, donor, level, at, zh }) {
  const link = comparisonLink({ keep: keep.id, donor: donor.id, at, zh });
  const [keepArt, donorArt] = await Promise.all([imageAt(keep.url), imageAt(donor.url)]);
  const { canvas, c, text, word } = makeCard(zh);
  text(word('SQUEEK  /  CURRENT COLLECTION', 'SQUEEK  /  当前藏品'), 45, 71, 18);
  text('ETHEREUM SEPOLIA', 874, 71, 16);
  text(word('Before the merge.', '合并之前'), 42, 164, 75, serif);
  text(word('MERGE PREVIEW', '合并预览'), 45, 210, 19, mono, muted);

  function drawPortrait(image, id, x, role, accent) {
    c.fillStyle = accent;
    c.fillRect(x - 24, 232, 288, 322);
    c.drawImage(image, x, 251, 240, 240);
    text(role, x, 530, 19, mono, paper);
    text('#' + id, x - 21, 610, 50, serif);
  }
  drawPortrait(keepArt, keep.id, 69, word('WOULD KEEP', '将保留'), '#293d2f');
  drawPortrait(donorArt, donor.id, 426, word('WOULD BURN', '将销毁'), '#6e4538');

  c.fillStyle = '#bdc4ad';
  c.fillRect(740, 232, 1, 375);
  text(word('SCAN TO OPEN PREVIEW', '扫码查看此预览'), 794, 210, 17, mono, muted);
  await drawCode(c, link, 756, 219, 320);
  text(word('Preview only', '预览 · 尚未合并'), 775, 570, 30, serif);
  text(word('Level ', '等级 ') + level + ' → ' + (level + 1), 775, 604, 22, mono, muted);
  text(word('Block ', '区块 ') + at, 775, 628, 17, mono, muted);
  text('SQUEEK FAMILY ALBUM  /  ' + CURRENT.release, 43, 679, 16);
  return toPng(canvas);
}
