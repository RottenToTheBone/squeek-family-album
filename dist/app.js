import { prepareIndex, tokenNumber, treeRows } from './lineage.js';
import { livePortrait, lostPortrait, refreshIndex, tokenLink, txLink } from './chain.js';
import { familyCard } from './share.js';

const $ = (id) => document.getElementById(id);
const staticCopy = [...document.querySelectorAll('[data-zh]')].map((el) => [el, el.textContent]);
const params = () => new URL(location.href).searchParams;
let language = params().get('lang');
if (!['en', 'zh'].includes(language)) {
  try {
    language = localStorage.getItem('squeek-album-language');
  } catch {
    /* Optional preference. */
  }
}
language = language === 'zh' ? 'zh' : 'en';
const tr = (en, zh) => (language === 'zh' ? zh : en);
const fmt = (n) => Number(n).toLocaleString('en-US');
const utc = (iso) => iso.replace('T', ' ').slice(0, 16) + ' UTC';
let archive,
  index,
  family,
  selected,
  selectedArt,
  requestNo = 0,
  selectionNo = 0,
  shareNo = 0,
  shareBlob = '';
let connection = 'bundled',
  notice = '',
  inputError = '';
const artPromises = new Map(),
  verifiedLive = new Map();
const statuses = {
  loading: () => tr('Reading the token record…', '正在查询编号…'),
  offline: () =>
    tr(
      'The live index is unavailable. This family is shown at the archive time below.',
      '实时索引暂时不可用。当前家谱以页底的档案时间为准。',
    ),
  unknown: () =>
    tr(
      'This token is outside the local portrait collection. Its live record could not be verified. Try again or open a sample.',
      '本地没有这个编号的原画，实时记录也未能核验。请重试或打开示例。',
    ),
  incomplete: () =>
    tr(
      'This token has newer merges than the verified index. A complete family cannot be shown yet.',
      '这个编号有更新的合并记录，暂时无法展示完整家谱。',
    ),
  seed: () =>
    tr(
      'The local archive could not be read. Reload the page to try again.',
      '无法读取本地档案，请重新加载。',
    ),
};
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
function renderNotices() {
  $('status').textContent = notice
    ? statuses[notice]()
    : connection === 'offline' && family
      ? statuses.offline()
      : '';
  $('search-error').textContent =
    inputError === 'invalid'
      ? tr('Enter a whole token ID from 1 to ', '请输入 1 到 ') +
        fmt(archive?.issued ?? 9999) +
        tr('.', ' 之间的整数编号。')
      : '';
  $('token-input').setAttribute('aria-invalid', String(!!inputError));
}
function localize() {
  document.documentElement.lang = language === 'zh' ? 'zh-Hans' : 'en';
  for (const [node, en] of staticCopy) node.textContent = tr(en, node.dataset.zh);
  $('lang').textContent = tr('中文', 'EN');
  $('lang').lang = tr('zh-Hans', 'en');
  $('lang').setAttribute('aria-label', tr('Switch to Chinese', 'Switch to English'));
  $('token-input').placeholder = tr('Token ID', 'NFT 编号');
  $('enlarge').setAttribute('aria-label', tr('Enlarge original portrait', '放大原始画像'));
  $('tree-viewport').setAttribute(
    'aria-label',
    tr('Interactive Squeek family tree', '可点选的 Squeek 合并家谱'),
  );
  for (const b of document.querySelectorAll('[data-close]'))
    b.setAttribute('aria-label', tr('Close dialog', '关闭窗口'));
  renderNotices();
  renderFreshness();
}
function setRoute(id, key, method = 'replaceState') {
  const url = new URL(location.href);
  url.searchParams.set('id', id);
  if (key) url.searchParams.set('stage', key);
  else url.searchParams.delete('stage');
  url.searchParams.set('lang', language);
  history[method]({}, '', url);
}
function renderFreshness() {
  if (!archive) return;
  $('freshness').textContent = tr('Index · ', '索引 · ') + utc(archive.asOf);
  $('notes-data').textContent =
    tr('Sepolia · ', 'Sepolia 测试网 · ') +
    fmt(archive.issued) +
    tr(' issued · ', ' 只已发行 · ') +
    archive.events.length +
    tr(' verified merges · block ', ' 次已核验合并 · 区块 ') +
    fmt(archive.safeBlock) +
    ' · ' +
    utc(archive.asOf);
}
function artFor(id) {
  if (artPromises.has(id)) return artPromises.get(id);
  const cached = archive.portraits[id],
    burn = index.absorbed.get(id);
  let pending;
  if (cached && (!burn || (cached.source === 'archive' && Number(cached.block) === burn.block - 1))) {
    pending = Promise.resolve({ ...cached, url: cached.file });
  } else if (burn) {
    pending = lostPortrait(id, burn, archive);
  } else {
    pending = verifiedLive.has(id)
      ? Promise.resolve(verifiedLive.get(id))
      : livePortrait(id, archive).then((p) => {
          verifiedLive.set(id, p);
          return p;
        });
  }
  const value = pending
    .then((p) => {
      if (!p.url) throw new Error('Missing image');
      return p;
    })
    .catch((error) => {
      artPromises.delete(id);
      throw error;
    });
  artPromises.set(id, value);
  return value;
}
function portraitHeader() {
  if (!selected) return;
  const id = selected.id,
    dead = index.absorbed.has(id);
  $('selected-id').textContent = '#' + id;
  $('art-state').textContent = dead ? tr('BURNED', '已销毁') : tr('SURVIVING', '仍存续');
  $('art-state').classList.toggle('lost', dead);
  $('plate-type').textContent = dead
    ? tr('RECOVERED PORTRAIT', '已找回的原画')
    : tr('ONCHAIN PORTRAIT', '链上原画');
  $('plate-no').textContent = 'PL. ' + String(id).padStart(5, '0');
  $('record-code').textContent =
    tr('SEPOLIA TESTNET', 'SEPOLIA 测试网') + '  ·  ' + String(family.root.id).padStart(5, '0');
  $('level-tag').textContent = tr('LEVEL ', '等级 ') + String(family.root.level).padStart(2, '0');
  const block = selectedArt?.block;
  $('art-source').textContent = block
    ? (dead ? tr('Pre-burn block ', '销毁前区块 ') : tr('Recorded at block ', '原画区块 ')) + fmt(block)
    : tr('Reading source…', '正在读取来源…');
  $('token-source').href = dead ? txLink(index.absorbed.get(id).tx) : tokenLink(id);
  $('plate-palette').textContent = selectedArt?.palette?.toUpperCase() || 'DOT GRID / SEPOLIA';
}
function setSelected(node, changeURL = true, reveal = false) {
  selected = node;
  selectedArt = null;
  const call = ++selectionNo;
  if (changeURL) setRoute(node.id, node.key);
  $('share').disabled = true;
  $('enlarge').disabled = true;
  $('hero-art').hidden = true;
  $('hero-art').removeAttribute('src');
  $('art-fallback').textContent = tr('Reading portrait…', '正在读取原画…');
  $('art-fallback').hidden = false;
  portraitHeader();
  for (const b of $('tree-stage').querySelectorAll('button'))
    b.setAttribute('aria-pressed', String(b.dataset.key === node.key));
  artFor(node.id)
    .then(async (art) => {
      if (call !== selectionNo) return;
      const img = $('hero-art');
      img.src = art.url;
      await img.decode();
      if (call !== selectionNo) return;
      selectedArt = art;
      img.alt = tr('Original onchain portrait of Squeek #', 'Squeek 链上原画 #') + node.id;
      img.hidden = false;
      $('art-fallback').hidden = true;
      $('enlarge').disabled = false;
      $('share').disabled = false;
      portraitHeader();
      $('selection-status').textContent = img.alt + ' · ' + $('art-state').textContent;
      if (reveal) openPortrait();
    })
    .catch(() => {
      if (call !== selectionNo) return;
      $('art-fallback').textContent = tr('Original portrait unavailable', '原始画像暂时不可用');
      $('art-source').textContent = tr('Portrait data unavailable', '暂无可核验的原画');
    });
}
const SVG = 'http://www.w3.org/2000/svg';
function drawTree() {
  if (!family) return;
  const vp = $('tree-viewport'),
    stage = $('tree-stage'),
    levels = family.root.level;
  const beforeFocus = stage.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const compact = vp.clientWidth < 430,
    width = Math.max(vp.clientWidth, levels * (compact ? 91 : 125) + 8);
  const { placed, rows } = treeRows(family.root);
  const step = compact ? 50 : 53,
    height = rows * step + 37,
    col = width / levels;
  const nw = Math.min(compact ? 88 : 132, col * (levels === 1 ? 0.86 : 0.8)),
    nh = compact ? 35 : 40;
  const x = (k) => (k - 0.5) * col,
    y = (r) => 29 + step * (r + 0.5);
  stage.style.width = width + 'px';
  stage.style.height = height + 'px';
  stage.replaceChildren();
  const lines = document.createElementNS(SVG, 'svg');
  lines.classList.add('tree-connect');
  lines.setAttribute('width', width);
  lines.setAttribute('height', height);
  lines.setAttribute('aria-hidden', 'true');
  stage.append(lines);
  for (let level = 1; level <= levels; level++) {
    const text =
      level === 1 ? tr('ORIGINALS', '原始藏品') : tr('LEVEL ', '等级 ') + String(level).padStart(2, '0');
    const heading = el('span', 'tree-col', text);
    heading.style.left = x(level) + 'px';
    stage.append(heading);
  }
  for (const p of placed) {
    const px = x(p.node.level),
      py = y(p.row);
    for (const child of p.children) {
      const lx = x(child.node.level) + nw / 2,
        ly = y(child.row),
        rx = px - nw / 2,
        mid = (lx + rx) / 2;
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', 'M ' + lx + ' ' + ly + ' H ' + mid + ' V ' + py + ' H ' + rx);
      lines.append(path);
    }
    const n = p.node,
      lost = index.absorbed.has(n.id);
    const button = el('button', 'tree-node');
    button.type = 'button';
    button.dataset.key = n.key;
    button.dataset.id = n.id;
    const label =
      '#' +
      n.id +
      ', ' +
      tr('level ', '等级 ') +
      n.level +
      ', ' +
      (lost ? tr('burned ID', '编号已销毁') : tr('surviving ID', '编号仍存续'));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(n.key === selected?.key));
    Object.assign(button.style, {
      left: px - nw / 2 + 'px',
      top: py - nh / 2 + 'px',
      width: nw + 'px',
      height: nh + 'px',
    });
    const thumb = el('span', 'thumb', '·');
    thumb.setAttribute('aria-hidden', 'true');
    artFor(n.id)
      .then((art) => {
        if (!thumb.isConnected) return;
        const img = el('img');
        img.alt = '';
        img.src = art.url;
        thumb.replaceChildren(img);
      })
      .catch(() => {});
    const detail = el('span');
    detail.append(el('span', 'node-id', '#' + n.id));
    const meta = el('span', 'node-meta');
    meta.append(el('i', 'dot ' + (lost ? 'burned' : 'live')), el('span', '', 'LV.' + n.level));
    detail.append(meta);
    button.append(thumb, detail);
    button.addEventListener('click', () => setSelected(n, true, matchMedia('(max-width:690px)').matches));
    stage.append(button);
    if (beforeFocus === n.key) button.focus({ preventScroll: true });
  }
}
function renderFamily() {
  $('f-originals').textContent = family.originals.length;
  $('f-merges').textContent = family.history.length;
  $('f-level').textContent = String(family.root.level).padStart(2, '0');
  const ledger = $('ledger-body');
  ledger.replaceChildren();
  for (const row of family.history) {
    const e = row.event,
      wrap = el('div', 'ledger-row'),
      main = el('div', 'ledger-main');
    main.append(
      el(
        'span',
        'ledger-name',
        '#' + e.survivor + ' + #' + e.donor + ' → #' + e.survivor + '  ·  Lv.' + e.level,
      ),
    );
    main.append(el('span', 'ledger-meta', utc(e.at) + '  ·  ' + tr('Block ', '区块 ') + fmt(e.block)));
    const link = el('a', 'source-link', tr('Transaction ↗', '查看交易 ↗'));
    link.href = txLink(e.tx);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', tr('View merge transaction at block ', '查看合并交易，区块 ') + e.block);
    wrap.append(main, link);
    ledger.append(wrap);
  }
  if (!family.history.length)
    ledger.append(
      el(
        'p',
        'empty-ledger',
        tr(
          'This original has no merges at the indexed block.',
          '截至索引区块，这只原始 Squeek 没有合并记录。',
        ),
      ),
    );
  drawTree();
}
function clearRecord() {
  family = null;
  selected = null;
  selectedArt = null;
  selectionNo++;
  $('tree-stage').replaceChildren();
  $('tree-stage').style.height = '';
  $('tree-stage').style.width = '';
  $('ledger-body').replaceChildren();
  $('hero-art').hidden = true;
  $('hero-art').removeAttribute('src');
  $('art-fallback').hidden = false;
  $('art-fallback').textContent = '—';
  for (const id of [
    'selected-id',
    'level-tag',
    'f-originals',
    'f-merges',
    'f-level',
    'plate-no',
    'record-code',
  ])
    $(id).textContent = '—';
  $('art-source').textContent = '';
  $('art-state').textContent = '';
  $('token-source').removeAttribute('href');
  $('plate-palette').textContent = 'DOT GRID / SEPOLIA';
  $('plate-type').textContent = tr('ONCHAIN PORTRAIT', '链上原画');
  $('share').disabled = true;
  $('enlarge').disabled = true;
}
async function openRecord(id, key, method) {
  if (!archive) return;
  const ticket = ++requestNo;
  clearRecord();
  inputError = '';
  notice = '';
  $('token-input').value = id;
  renderNotices();
  if (method) setRoute(id, key, method);
  let resolved = index.family(id);
  if (!archive.portraits[id] && !resolved.history.length) {
    notice = 'loading';
    renderNotices();
    try {
      const live = verifiedLive.get(id) ?? (await livePortrait(id, archive));
      if (ticket !== requestNo) return;
      verifiedLive.set(id, live);
      resolved = index.family(id);
      if (!resolved.history.length && (live.burned || live.level !== 1)) {
        notice = 'incomplete';
        renderNotices();
        return;
      }
    } catch {
      if (ticket === requestNo) {
        notice = 'unknown';
        renderNotices();
      }
      return;
    }
  }
  if (ticket !== requestNo) return;
  family = resolved;
  const focus =
    family.nodes.find((n) => n.key === key && n.id === id) ??
    family.nodes.find((n) => n.id === id) ??
    family.root;
  notice = '';
  renderNotices();
  setSelected(focus, false);
  renderFamily();
  document.title = 'Squeek #' + id + ' · Family Album';
}
function navigateFromUrl() {
  if (!archive) return;
  const raw = params().get('id');
  const id = raw === null ? 8923 : tokenNumber(raw, archive.issued);
  if (!id) {
    ++requestNo;
    clearRecord();
    notice = '';
    inputError = 'invalid';
    $('token-input').value = raw;
    renderNotices();
    return;
  }
  openRecord(id, params().get('stage'), null);
}
$('lookup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!archive) return;
  const id = tokenNumber($('token-input').value, archive.issued);
  if (!id) {
    inputError = 'invalid';
    renderNotices();
    $('token-input').focus();
    return;
  }
  openRecord(id, null, 'pushState');
});
$('token-input').addEventListener('input', () => {
  if (inputError) {
    inputError = '';
    renderNotices();
  }
});
for (const button of document.querySelectorAll('[data-open]'))
  button.addEventListener('click', () => openRecord(Number(button.dataset.open), null, 'pushState'));
window.addEventListener('popstate', () => {
  const l = params().get('lang');
  if (['en', 'zh'].includes(l)) language = l;
  localize();
  navigateFromUrl();
});
$('lang').addEventListener('click', () => {
  language = tr('zh', 'en');
  try {
    localStorage.setItem('squeek-album-language', language);
  } catch {}
  const url = new URL(location.href);
  url.searchParams.set('lang', language);
  history.replaceState({}, '', url);
  localize();
  if (family) {
    renderFamily();
    if (selected) setSelected(selected, false);
  }
});
$('notes').addEventListener('click', () => $('notes-dialog').showModal());
for (const b of document.querySelectorAll('[data-close]'))
  b.addEventListener('click', () => b.closest('dialog').close());
for (const d of document.querySelectorAll('dialog'))
  d.addEventListener('click', (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
function openPortrait() {
  if (!selectedArt) return;
  $('full-art').src = selectedArt.url;
  $('full-art').alt = $('hero-art').alt;
  $('art-modal-title').textContent = 'SQUEEK #' + selected.id + ' / SEPOLIA';
  $('full-art-source').textContent = $('art-state').textContent + ' · ' + $('art-source').textContent;
  $('save-svg').href = selectedArt.url;
  $('save-svg').download = 'squeek-' + selected.id + '.svg';
  $('art-dialog').showModal();
}
$('enlarge').addEventListener('click', openPortrait);
$('share').addEventListener('click', async () => {
  if (!family || !selectedArt) return;
  const ticket = ++shareNo,
    id = selected.id;
  $('card-preview').hidden = true;
  $('save-card').hidden = true;
  $('card-status').textContent = tr('Drawing the original portraits…', '正在绘制家谱卡…');
  $('share-dialog').showModal();
  try {
    const blob = await familyCard({ selected, family, portrait: selectedArt, artFor, zh: language === 'zh' });
    if (ticket !== shareNo || !$('share-dialog').open) return;
    if (shareBlob) URL.revokeObjectURL(shareBlob);
    shareBlob = URL.createObjectURL(blob);
    $('card-preview').src = shareBlob;
    $('card-preview').alt = tr('Family card for Squeek #', 'Squeek 家谱卡 #') + id;
    $('card-preview').hidden = false;
    $('save-card').href = shareBlob;
    $('save-card').download = 'squeek-family-' + id + '.png';
    $('save-card').hidden = false;
    $('card-status').textContent = '';
  } catch {
    if (ticket === shareNo)
      $('card-status').textContent = tr(
        'The card could not be drawn. You can still copy the record link.',
        '未能生成图片，可以复制档案链接。',
      );
  }
});
$('share-dialog').addEventListener('close', () => {
  shareNo++;
  if (shareBlob) {
    URL.revokeObjectURL(shareBlob);
    shareBlob = '';
  }
});
$('copy-link').addEventListener('click', async () => {
  const url = new URL(location.href);
  url.searchParams.set('id', selected.id);
  url.searchParams.set('stage', selected.key);
  url.searchParams.set('lang', language);
  try {
    await navigator.clipboard.writeText(url.href);
    $('card-status').textContent = tr('Record link copied.', '档案链接已复制。');
  } catch {
    $('card-status').textContent = url.href;
  }
});
let lastWidth = 0;
new ResizeObserver((entries) => {
  const w = entries[0].contentRect.width;
  if (w !== lastWidth) {
    lastWidth = w;
    drawTree();
  }
}).observe($('tree-viewport'));
localize();
try {
  const response = await fetch('./data/archive.json');
  if (!response.ok) throw new Error('Archive unavailable');
  archive = await response.json();
  if (archive.schemaVersion !== 1 || archive.chainId !== 11155111) throw new Error('Unsupported archive');
  index = prepareIndex(archive);
  renderFreshness();
  navigateFromUrl();
  refreshIndex(archive)
    .then((latest) => {
      const changed = latest.events.length !== archive.events.length;
      archive = latest;
      connection = 'live';
      if (changed) {
        index = prepareIndex(archive);
        artPromises.clear();
        verifiedLive.clear();
        navigateFromUrl();
      }
      renderFreshness();
      renderNotices();
    })
    .catch(() => {
      connection = 'offline';
      renderNotices();
    });
} catch {
  notice = 'seed';
  renderNotices();
}
