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

// The code sits in the hamster's white belly. All ink detail stays outside its quiet zone.
function drawHamster(c, center, top) {
  const fur = '#cb9560', outline = '#5d4938', pink = '#e7a68c', face = '#fff';
  c.save();
  c.translate(center, top);
  c.lineWidth = 3;
  c.lineJoin = c.lineCap = 'round';
  function shape(path, fill, stroke = outline) {
    const p = new Path2D(path);
    if (fill) { c.fillStyle = fill; c.fill(p); }
    if (stroke) { c.strokeStyle = stroke; c.stroke(p); }
  }
  function oval(x, y, w, h, fill, tilt = 0) {
    c.beginPath();
    c.ellipse(x, y, w, h, tilt, 0, 2 * Math.PI);
    c.fillStyle = fill;
    c.fill();
  }
  function bothSides(draw) {
    for (const direction of [1, -1]) {
      c.save();
      c.scale(direction, 1);
      draw();
      c.restore();
    }
  }
  bothSides(() => {
    shape('M 77,-44 C 71,-77 94,-85 107,-77 C 128,-66 126,-46 112,-32 Z', fur);
    oval(101, -60, 14, 15, pink, 0.35);
  });
  const body = 'M 0,-60 C 58,-62 103,-50 126,-29 C 152,-28 168,-11 169,12 ' +
    'C 179,53 188,123 188,192 C 189,251 185,291 172,315 ' +
    'C 157,337 110,336 64,331 Q 0,342 -64,331 C -110,336 -157,337 -172,315 ' +
    'C -185,291 -189,251 -188,192 C -188,123 -179,53 -169,12 ' +
    'C -168,-11 -152,-28 -126,-29 C -103,-50 -58,-62 0,-60 Z';
  shape(body, fur);
  // A continuous white muzzle and belly hide the square edge of the code.
  shape('M 0,-35 C 18,-42 37,-30 58,-19 C 80,-9 124,-20 146,-12 ' +
    'Q 168,-9 169,17 C 173,90 173,241 167,301 Q 166,323 146,325 ' +
    'C 73,330 -73,330 -146,325 Q -166,323 -167,301 C -173,241 -173,90 -169,17 ' +
    'Q -168,-9 -146,-12 C -124,-20 -80,-9 -58,-19 C -37,-30 -18,-42 0,-35 Z', face, null);
  bothSides(() => {
    oval(47, -37, 6.5, 7.5, '#302b26');
    oval(45.5, -40, 1.8, 1.8, face);
    oval(81, -25, 12, 4, pink, -0.12);
    shape('M 99,-17 l 28,-4 M 101,-11 l 30,2', null);
    shape('M 183,99 C 173,87 162,91 163,105 Q 164,119 176,125', pink);
    shape('M 91,334 C 93,327 106,324 116,325 C 129,325 139,332 138,338 ' +
      'Q 137,344 129,344 L 99,344 Q 88,344 91,334 Z', pink);
    shape('M 113,343 l 1,-5 M 125,343 l 1,-5', null);
  });
  shape('M -8,-30 Q -9,-34 -4,-34 Q 0,-33 4,-34 Q 9,-34 8,-30 L 2,-24 Q 0,-22 -2,-24 Z', '#794b42', null);
  shape('M 0,-24 v 4 Q -4,-15 -9,-19 M 0,-20 Q 4,-15 9,-19', null);
  c.restore();
}

let encoderLoadFailures = 0;
async function drawCode(c, link, center, top) {
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
  const box = 320, scale = Math.floor(box / size);
  if (scale < 4) throw new Error('Code does not fit on card');
  const x = 2 * Math.floor((center - size * scale / 2) / 2);
  const y = 2 * Math.floor((top + (box - size * scale) / 2) / 2);
  drawHamster(c, center, top);
  c.fillStyle = '#fff';
  c.fillRect(x, y, size * scale, size * scale);
  c.fillStyle = '#292622';
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
  await drawCode(c, link, 916, 128);
  c.textAlign = 'center';
  text(word('SCAN TO VIEW THIS STAGE', '扫码查看此家谱节点'), 916, 487, 16, mono, muted);
  c.textAlign = 'left';
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
  const originals = word(n + (n === 1 ? ' original' : ' originals'), n + ' 只原始藏品');
  const merges = word(m + (m === 1 ? ' merge' : ' merges'), m + ' 次合并');
  const counts = originals + ' / ' + merges;
  c.font = '18px ' + mono;
  const wrapCounts = c.measureText(counts).width > 228;
  text(wrapCounts ? originals : counts, 478, 341, 18);
  if (wrapCounts) text(merges, 478, 364, 18);
  text(word('Level ', '等级 ') + family.root.level, 478, wrapCounts ? 391 : 374, 18, mono, muted);
  c.fillStyle = '#bdc4ad';
  c.fillRect(478, 400, 227, 1);
  text(word('ORIGINAL PORTRAITS', '原始画像'), 478, 467, 17, mono, muted);
  const leaves = family.originals.slice(0, 4);
  await Promise.all(
    leaves.map(async (node, i) => {
      const x = 478 + i * 141;
      try {
        const img = await imageAt((await artFor(node.id)).url);
        c.drawImage(img, x, 501, 86, 86);
      } catch {
        c.fillStyle = '#d9ddce';
        c.fillRect(x, 501, 86, 86);
        text('—', x + 28, 556, 30);
      }
      text('#' + node.id, x, 608, 17);
    }),
  );
  if (n > leaves.length)
    text(word('First four of ' + n + ' originals', '展示 ' + n + ' 只中的前四只'), 478, 628, 15, mono, muted);
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
  c.fillRect(722, 232, 1, 375);
  c.textAlign = 'center';
  text(word('SCAN TO OPEN PREVIEW', '扫码查看此预览'), 916, 105, 17, mono, muted);
  c.textAlign = 'left';
  await drawCode(c, link, 916, 199);
  text(word('Preview only', '预览 · 尚未合并'), 775, 574, 30, serif);
  text(word('Level ', '等级 ') + level + ' → ' + (level + 1), 775, 604, 22, mono, muted);
  text(word('Block ', '区块 ') + at, 775, 628, 17, mono, muted);
  text('SQUEEK FAMILY ALBUM  /  ' + CURRENT.release, 43, 679, 16);
  return toPng(canvas);
}
