import { snapshotIndex, tokenNumber, treeRows } from './lineage.js';
import { livePortrait, lostPortrait, refreshIndex, txLink } from './chain.js';
import { familyCard } from './share.js';
import { packedPortrait } from './packed-art.js';
import { CURRENT, HISTORICAL, deploymentFor } from './receipts.js';
import { compareUrl, comparisonPanel } from './compare.js';
import { featuredReplay, replayUrl, replayPanel } from './replay.js';

const $ = (id) => document.getElementById(id);
const motionPreference = matchMedia('(prefers-reduced-motion: no-preference)');
function stopImageMotion(root) {
  for (const animation of root.getAnimations?.() ?? []) {
    if (animation.id === 'album-image') animation.cancel();
  }
}
motionPreference.addEventListener('change', () => {
  if (!motionPreference.matches) stopImageMotion(document);
});
function animateImage(image, from) {
  if (!motionPreference.matches || !image.animate) return;
  stopImageMotion(image);
  image.animate(
    [{ transform: from, opacity: 0.62 }, { transform: 'none', opacity: 1 }],
    { id: 'album-image', duration: 220, easing: 'cubic-bezier(.22,.7,.25,1)' },
  );
}
const staticCopy = [...document.querySelectorAll('[data-zh]')].map((el) => [el, el.textContent]);
const params = () => new URL(location.href).searchParams;
function routeEdition() {
  const route = params();
  const release = route.get('release');
  if (release === CURRENT.release) return 'current';
  if (release === HISTORICAL.release) return 'archive';
  // Links generated before the current collection launched belong to the historical collection.
  return release ?? (route.has('id') || route.has('stage') ? 'archive' : 'current');
}
const edition = routeEdition();
const getView = () => {
  const view = params().get('view');
  return view === 'compare' || view === 'replay' ? view : 'family';
};
const view = getView();
const historical = edition === 'archive';
const deployment = historical ? HISTORICAL : CURRENT;
// Pin the featured transaction stage even if its survivor merges again later.
const featured = historical
  ? { survivor: 8923, donor: 8925, stage: null }
  : { survivor: featuredReplay.survivor, donor: featuredReplay.donor, stage: 'm-' + featuredReplay.block + '-' + featuredReplay.logIndex };
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
  lookupPortrait,
  requestNo = 0,
  selectionNo = 0,
  shareNo = 0,
  shareBlob = '',
  shareUrl = '';
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
const panelOptions = { tr, lang: () => language, recordUrl, openCard, animateImage };
const panel = view === 'compare' ? comparisonPanel(panelOptions) : view === 'replay' ? replayPanel(panelOptions) : null;
if (panel) {
  for (const selector of ['.intro', '.record-bar', '#status', '#selection-status', '#workbench', '.ledger'])
    document.querySelector(selector).hidden = true;
  $(view + '-panel').hidden = false;
  document.querySelector('.skip').href = '#' + view + '-title';
  $(view + '-title').tabIndex = -1;
}
function localize() {
  document.documentElement.lang = language === 'zh' ? 'zh-Hans' : 'en';
  for (const [node, en] of staticCopy) node.textContent = tr(en, node.dataset.zh);
  $('lang').textContent = tr('中文', 'EN');
  $('lang').lang = tr('zh-Hans', 'en');
  $('lang').setAttribute('aria-label', tr('Switch to Chinese', 'Switch to English'));
  $('token-input').placeholder = tr('Token ID', 'NFT 编号');
  $('editions').setAttribute('aria-label', tr('Collection', '藏品版本'));
  $('history-example').href = recordUrl(8925, 'o-8925', 'archive');
  $('history-example').hidden = historical;
  $('compare-open').href = compareUrl(null, null, null, language);
  $('replay-open').href = replayUrl('after', language);
  if (panel) {
    const replay = view === 'replay';
    document.title = replay ? tr('Recover #7453 · Squeek Family Album', '找回 #7453 的原画 · 仓鼠家谱')
      : tr('Before the merge · Squeek Family Album', '合并前对比 · 仓鼠家谱');
    document.querySelector('.skip').textContent = replay ? tr('Skip to the merge replay', '跳到合并回放') : tr('Skip to comparison', '跳到合并预览');
    panel.localize();
  }
  $(historical ? 'archive-edition' : 'current-edition').setAttribute('aria-current', 'page');
  editionLinks();
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
function recordUrl(id, key, release = edition) {
  const url = new URL(location.origin);
  url.pathname = location.pathname;
  url.searchParams.set('release', release === 'archive' ? HISTORICAL.release : CURRENT.release);
  if (id != null) url.searchParams.set('id', id);
  if (key) url.searchParams.set('stage', key);
  url.searchParams.set('lang', language);
  return url.href;
}
function editionLinks(id = selected?.id ?? tokenNumber(params().get('id')) ?? featured.survivor) {
  $('current-edition').href = recordUrl(id, null, 'current');
  $('archive-edition').href = recordUrl(id, null, 'archive');
}
function setRoute(id, key, method = 'replaceState') {
  history[method]({}, '', recordUrl(id, key));
}
function renderFreshness() {
  if (!archive) return;
  $('freshness').textContent = (historical ? tr('Historical snapshot · ', '历史快照 · ') : tr('Index · ', '索引 · ')) + utc(archive.asOf);
  $('notes-data').textContent =
    archive.releaseId + ' · ' +
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
    const file = (historical ? 'art/' : 'current-art/') + id + '.svg';
    if (!historical && cached.pack) pending = packedPortrait(id, cached, archive.safeBlock);
    else pending = cached.file === file ? Promise.resolve({ ...cached, url: file })
      : Promise.reject(new Error('Wrong collection portrait'));
  } else if (burn) {
    pending = lostPortrait(id, burn, archive);
  } else {
    const observation = verifiedLive.get(id) ?? (lookupPortrait?.id === id ? lookupPortrait.result : null);
    const observedIndex = index;
    pending = observation
      ? Promise.resolve(observation)
      : livePortrait(id, archive).then((p) => {
          if (p.url && index === observedIndex) verifiedLive.set(id, p);
          return p;
        });
  }
  const value = pending
    .then((p) => {
      if (!p.url) throw new Error('Missing image');
      return p;
    })
    .catch((error) => {
      if (artPromises.get(id) === value) artPromises.delete(id);
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
    (historical ? tr('HISTORICAL', '历史藏品') : tr('CURRENT', '当前藏品')) + '  ·  SEPOLIA  ·  ' + String(family.root.id).padStart(5, '0');
  $('level-tag').textContent = tr('LEVEL ', '等级 ') + String(family.root.level).padStart(2, '0');
  const block = selectedArt?.block;
  $('art-source').textContent = block
    ? (dead ? tr('Pre-burn block ', '销毁前区块 ') : tr('Recorded at block ', '原画区块 ')) + fmt(block)
    : tr('Reading source…', '正在读取来源…');
  $('token-source').href = dead ? txLink(index.absorbed.get(id).tx)
    : 'https://sepolia.etherscan.io/nft/' + deployment.collection + '/' + id;
  $('plate-palette').textContent = selectedArt?.palette?.toUpperCase() || 'DOT GRID / SEPOLIA';
}
function setSelected(node, changeURL = true, reveal = false) {
  const userChangedNode = changeURL && selected?.key !== node.key;
  if (changeURL) {
    setRoute(node.id, node.key);
    $('token-input').value = node.id;
    if (!userChangedNode && selectedArt) {
      if (reveal) openPortrait();
      return;
    }
  }
  selected = node;
  editionLinks(node.id);
  selectedArt = null;
  const call = ++selectionNo;
  document.title = 'Squeek #' + node.id + ' · Family Album';
  stopImageMotion($('hero-art'));
  $('share').disabled = true;
  $('enlarge').disabled = true;
  $('hero-art').hidden = true;
  $('hero-art').removeAttribute('src');
  $('art-fallback').textContent = tr('Reading portrait…', '正在读取原画…');
  $('art-fallback').hidden = false;
  portraitHeader();
  for (const b of $('tree-stage').querySelectorAll('button'))
    b.setAttribute('aria-pressed', String(b.dataset.key === node.key));
  return artFor(node.id)
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
      if (userChangedNode) animateImage(reveal ? $('full-art') : img, 'translateY(5px)');
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
        !historical && archive.events.length === 0
          ? tr('This collection has no confirmed merges at the indexed block.', '截至索引区块，当前系列尚无已确认的合并。')
          : tr(
          'This original has no merges at the indexed block.',
          '截至索引区块，这只原始 Squeek 没有合并记录。',
          ),
      ),
    );
  drawTree();
}
function clearRecord() {
  for (const id of ['share-dialog', 'art-dialog']) if ($(id).open) $(id).close();
  document.title = 'Squeek Family Album — Squeekchain on Sepolia';
  family = null;
  lookupPortrait = null;
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
  if (!archive) {
    if (method) setRoute(id, key, method);
    $('token-input').value = id;
    if (notice !== 'seed') notice = 'loading';
    inputError = '';
    renderNotices();
    return;
  }
  const ticket = ++requestNo;
  const restoreShareFocus = selected?.id === id && document.activeElement === $('share');
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
      // Share one metadata result between this record and its thumbnail. An
      // incomplete response is always requested anew on the next lookup.
      if (live.url) verifiedLive.set(id, live);
      else lookupPortrait = { id, result: live };
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
  const portraitReady = setSelected(focus, false);
  renderFamily();
  if (restoreShareFocus) {
    await portraitReady;
    if (ticket === requestNo && selected === focus && document.activeElement === document.body)
      $('share').focus({ preventScroll: true });
  }
}
function navigateFromUrl() {
  if (!archive) return;
  const raw = params().get('id');
  const id = raw === null ? featured.survivor : tokenNumber(raw, archive.issued);
  editionLinks(id ?? featured.survivor);
  if (!id) {
    ++requestNo;
    clearRecord();
    notice = '';
    inputError = 'invalid';
    $('token-input').value = raw;
    renderNotices();
    return;
  }
  openRecord(id, params().get('stage') ?? (raw === null ? featured.stage : null), null);
}
$('lookup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = tokenNumber($('token-input').value, archive?.issued ?? 9999);
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
for (const role of ['survivor', 'donor']) {
  const button = $('example-' + role);
  const id = featured[role];
  button.textContent = '#' + id;
  button.addEventListener('click', () => openRecord(id, role === 'survivor' ? featured.stage : 'o-' + id, 'pushState'));
}
window.addEventListener('popstate', () => {
  if (routeEdition() !== edition || getView() !== view) { location.reload(); return; }
  const l = params().get('lang');
  if (['en', 'zh'].includes(l)) language = l;
  localize();
  if (panel) panel.fromRoute();
  else navigateFromUrl();
});
$('lang').addEventListener('click', () => {
  language = tr('zh', 'en');
  try {
    localStorage.setItem('squeek-album-language', language);
  } catch {}
  if (panel) {
    panel.changeLanguage();
    localize();
    return;
  }
  const incoming = params();
  const id = selected?.id ?? tokenNumber(incoming.get('id'), archive?.issued ?? 9999);
  const pendingStage = incoming.get('stage');
  const stage =
    selected?.key ??
    (id && (pendingStage === 'o-' + id || /^m-\d{1,16}-\d{1,12}$/.test(pendingStage)) ? pendingStage : null);
  setRoute(id, stage);
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
$('share').addEventListener('click', () => {
  if (!family || !selectedArt) return;
  const id = selected.id;
  const card = { selected, family, portrait: selectedArt, artFor, historical, deployment, zh: language === 'zh' };
  openCard({
    url: recordUrl(id, selected.key), title: tr('Family card', '家谱卡'), kind: tr('SHARE FAMILY CARD', '分享家谱卡'),
    alt: tr('Family card for Squeek #', 'Squeek 家谱卡 #') + id,
    filename: 'squeek-' + edition + '-family-' + id + '.png', draw: () => familyCard(card),
  });
});
async function openCard({ url, title, kind, alt, filename, draw }) {
  const ticket = ++shareNo;
  shareUrl = url;
  $('card-title').textContent = title;
  $('card-kind').textContent = kind;
  $('card-preview').hidden = true;
  $('save-card').hidden = true;
  $('card-status').textContent = tr('Drawing the original portraits…', '正在绘制家谱卡…');
  $('share-dialog').showModal();
  try {
    const blob = await draw();
    if (ticket !== shareNo || !$('share-dialog').open) return;
    if (shareBlob) URL.revokeObjectURL(shareBlob);
    shareBlob = URL.createObjectURL(blob);
    const preview = $('card-preview');
    preview.src = shareBlob;
    preview.alt = alt;
    $('save-card').href = shareBlob;
    $('save-card').download = filename;
    $('save-card').hidden = false;
    await preview.decode();
    if (ticket !== shareNo || !$('share-dialog').open) return;
    preview.hidden = false;
    $('card-status').textContent = '';
    animateImage(preview, 'translateY(7px)');
  } catch {
    if (ticket === shareNo)
      $('card-status').textContent = tr(
        'The card could not be drawn. You can still copy the record link.',
        '未能生成图片，可以复制档案链接。',
      );
  }
}
$('share-dialog').addEventListener('close', () => {
  if ($('share-dialog').open) return;
  shareNo++;
  shareUrl = '';
  if (shareBlob) {
    URL.revokeObjectURL(shareBlob);
    shareBlob = '';
  }
});
$('copy-link').addEventListener('click', async () => {
  const url = shareUrl;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    if (shareUrl === url) $('card-status').textContent = tr('Record link copied.', '档案链接已复制。');
  } catch {
    if (shareUrl === url) $('card-status').textContent = url;
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
if (panel) panel.fromRoute();
try {
  if (edition !== 'archive' && edition !== 'current') throw new Error('Unknown collection');
  const response = await fetch(historical ? './data/archive.json' : './data/current.json');
  if (!response.ok) throw new Error('Archive unavailable');
  const bundled = await response.json();
  if (deploymentFor(bundled) !== deployment) throw new Error('Wrong collection archive');
  index = snapshotIndex(bundled);
  archive = bundled;
  renderFreshness();
  if (panel) {
    if (!historical) panel.setSnapshot(archive, index);
  } else navigateFromUrl();
  // The replay is a fixed past event. Today's index cannot change it.
  if (!historical && view !== 'replay') refreshIndex(archive)
    .then(async (latest) => {
      const changed = latest.events.length !== archive.events.length;
      const nextIndex = changed ? snapshotIndex(latest) : index;
      // Keep the family and its artwork together until the open card is dismissed.
      const cardDialog = $('share-dialog');
      while (changed && !panel && cardDialog.open) {
        await new Promise(resolve => cardDialog.addEventListener('close', resolve, { once: true }));
      }
      archive = latest;
      index = nextIndex;
      connection = 'live';
      if (changed) {
        artPromises.clear();
        verifiedLive.clear();
        if (!panel) navigateFromUrl();
      }
      if (panel) panel.setSnapshot(archive, index);
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
  if (panel && edition === 'current') panel.unavailable();
}
