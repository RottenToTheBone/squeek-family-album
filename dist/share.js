async function imageAt(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

export async function familyCard({ selected, family, portrait, artFor, historical, deployment, zh }) {
  const canvas = document.createElement('canvas');
  canvas.width = 1120;
  canvas.height = 716;
  const c = canvas.getContext('2d');
  const ink = '#243126',
    muted = '#51634b';
  const mono = 'Consolas, monospace',
    serif = 'Georgia, "SimSun", serif';
  const word = (en, cn) => (zh ? cn : en);
  function text(s, x, y, size, font = mono, color = ink) {
    c.fillStyle = color;
    c.font = size + 'px ' + font;
    c.fillText(s, x, y);
  }
  c.fillStyle = '#f5f3ea';
  c.fillRect(0, 0, 1120, 716);
  c.fillStyle = ink;
  c.fillRect(32, 32, 1056, 3);
  text(historical ? word('SQUEEK  /  HISTORICAL COLLECTION', 'SQUEEK  /  历史藏品')
    : word('SQUEEK  /  CURRENT COLLECTION', 'SQUEEK  /  当前藏品'), 45, 71, 18);
  text('ETHEREUM SEPOLIA', 864, 71, 16);
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
      n + (n === 1 ? ' original' : ' originals') + '  /  ' + m + (m === 1 ? ' merge' : ' merges') + '  /  level ' + family.root.level,
      n + ' 只原始藏品  /  ' + m + ' 次合并  /  等级 ' + family.root.level,
    ),
    478,
    355,
    22,
  );
  c.fillStyle = '#bdc4ad';
  c.fillRect(478, 385, 583, 1);
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
  c.fillStyle = ink;
  c.fillRect(43, 640, 1034, 1);
  text('SQUEEK FAMILY ALBUM  /  ' + deployment.release, 43, 679, 16);
  text(word('FAMILY #', '家族 #') + family.root.id, 894, 679, 16);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG export unavailable'))),
      'image/png',
    ),
  );
}
