import { prepareIndex, tokenNumber } from './lineage.js';
import { contractPortrait, txLink } from './chain.js';
import { bundledPortrait } from './packed-art.js';
import { comparisonCard, comparisonLink } from './share.js';
import { CURRENT } from './receipts.js';

// All 9,999 originals were issued and no merges had occurred at this published checkpoint.
const firstCheckpoint = 12067109;
const $ = (id) => document.getElementById(id);
const number = (n) => n.toLocaleString('en-US');

export function compareUrl(keep, donor, at, language) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('release', CURRENT.release);
  url.searchParams.set('view', 'compare');
  if (keep != null) url.searchParams.set('keep', keep);
  if (donor != null) url.searchParams.set('donor', donor);
  if (at != null) url.searchParams.set('at', at);
  url.searchParams.set('lang', language);
  return url.href;
}

export function comparisonPanel({ tr, lang, recordUrl, openCard }) {
  let published, publishedIndex, latest, latestIndex;
  let pair, sample, message = [], generation = 0, edited = false, waiting = false;
  const messages = {
    id: ['Enter two whole IDs from 1 to 9,999.', '请输入两个 1 到 9,999 之间的整数编号。'],
    duplicate: ['Choose two different IDs.', '请选择两个不同的编号。'],
    burned: ['At least one ID was already burned at this block. Choose two surviving IDs.', '至少一个编号在这个区块已经销毁，请选择两只仍存续的 Squeek。'],
    newerBurn: ['A newer verified merge burned one of these IDs. Choose two surviving IDs.', '最新核验的合并记录显示其中一个编号已销毁，请选择两只仍存续的 Squeek。'],
    newerLevel: ['These IDs have newer verified levels. Try again when the published index updates.', '这些编号的等级已有新记录，请在发布索引更新后重试。'],
    level: ['These Squeeks must be at the same level.', '用于预览的两只 Squeek 必须同级。'],
    ceiling: ['These Squeeks have reached the collection’s maximum level.', '这两只 Squeek 已达到当前系列的最高等级。'],
    unavailable: ['The original portraits could not be verified. Retry the comparison.', '暂时无法核验原画，请重试。'],
    range: ['The selected block is outside the verified collection history.', '指定区块超出已核验的藏品历史。'],
    collection: ['Previews use the current collection. Open the current album to start one.', '预览适用于当前系列，请打开当前家谱进行对比。'],
    loading: ['Verifying both original portraits…', '正在核验两张原画…'],
    index: ['Reading the verified collection history…', '正在读取已核验的系列历史…'],
    failed: ['The collection history could not be verified. Reload to try again.', '当前系列历史暂时无法核验，请刷新重试。'],
  };
  const currentLanguage = () => lang() === 'zh';
  const inputs = ['compare-keep', 'compare-donor'];
  const currentRoute = () => new URL(location.href).searchParams;
  const isCurrent = () => [null, 'current', CURRENT.release].includes(currentRoute().get('release'));

  function status(key, error = false) {
    message = key ? messages[key] : [];
    $('compare-status').textContent = message.length ? tr(...message) : '';
    $('compare-status').classList.toggle('error', error);
    for (const id of inputs) $(id).setAttribute('aria-invalid', String(error && ['id', 'duplicate', 'burned', 'newerBurn', 'level', 'ceiling'].includes(key)));
  }
  function invalidate() {
    generation++;
    waiting = false;
    pair = null;
    $('compare-result').hidden = true;
    $('compare-share').disabled = true;
    for (const id of ['keep-art', 'donor-art']) $(id).removeAttribute('src');
    if ($('share-dialog').open) $('share-dialog').close();
    status(null);
  }
  function lineage(side) {
    const rows = document.createDocumentFragment();
    if (!side.history.length) {
      const row = document.createElement('li');
      row.textContent = '#' + side.id + tr(' · original', ' · 原始藏品');
      rows.append(row);
    }
    for (const { event } of side.history) {
      const row = document.createElement('li'), receipt = document.createElement('a');
      receipt.href = txLink(event.tx);
      receipt.target = '_blank';
      receipt.rel = 'noopener noreferrer';
      receipt.textContent = '#' + event.survivor + ' + #' + event.donor + ' → #' + event.survivor;
      receipt.setAttribute('aria-label', receipt.textContent + tr(' · View transaction', ' · 查看交易'));
      row.append(receipt);
      rows.append(row);
    }
    return rows;
  }
  function renderPair() {
    const { keep, donor, at, level } = pair;
    for (const [role, side] of [['keep', keep], ['donor', donor]]) {
      $(role + '-id').textContent = '#' + side.id;
      const img = $(role + '-art');
      img.src = side.url;
      img.alt = tr('Original portrait of Squeek #', 'Squeek 原画 #') + side.id;
      $(role + '-level').textContent = tr('Lv. ', '等级 ') + level + ' · ' + side.originals +
        tr(side.originals === 1 ? ' original' : ' originals', ' 张原画');
      $(role + '-family').href = recordUrl(side.id, side.stage, 'current');
      $(role + '-lineage').replaceChildren(lineage(side));
    }
    const changed = [keep, donor].some(side => latestIndex.absorbed.has(side.id) || latestIndex.family(side.id).root.level !== level);
    $('compare-status').textContent = tr('Verified at block ', '核验区块 ') + number(at) +
      (changed ? tr(' · This pair has changed since this preview.', ' · 此后这对藏品的链上状态已变化。') : '');
    $('compare-outcome').textContent = tr(
      'If merged, #' + keep.id + ' would keep its portrait and reach level ' + (level + 1) + '.',
      '若执行合并，#' + keep.id + ' 将保留原画并升至 ' + (level + 1) + ' 级。',
    );
    $('compare-share').disabled = false;
    $('compare-result').hidden = false;
  }
  function navigate(pair, method) {
    history[method]({}, '', compareUrl(pair.keep.id, pair.donor.id, pair.at, lang()));
  }
  function newerConflict(families) {
    if (latestIndex === publishedIndex) return null;
    if (families.some(({ root }) => latestIndex.absorbed.has(root.id))) return 'newerBurn';
    if (families.some(({ root }) => root.level !== latestIndex.family(root.id).root.level)) return 'newerLevel';
    return null;
  }
  async function resolve(rawKeep, rawDonor, rawAt, method) {
    invalidate();
    const ticket = generation;
    const keep = tokenNumber(rawKeep), donor = tokenNumber(rawDonor);
    if (!isCurrent()) return status('collection', true);
    if (!keep || !donor) return status('id', true);
    if (keep === donor) return status('duplicate', true);
    if (rawAt !== null && (!/^\d{1,15}$/.test(rawAt) || Number(rawAt) < firstCheckpoint)) return status('range', true);
    if (!published) {
      if (method === 'pushState') history.pushState({}, '', compareUrl(keep, donor, rawAt, lang()));
      waiting = true;
      return status('index');
    }
    const at = rawAt === null ? published.safeBlock : Number(rawAt);
    if (at > latest.safeBlock) { waiting = true; return status('range', true); }
    const historyIndex = at === published.safeBlock ? publishedIndex : at === latest.safeBlock ? latestIndex
      : prepareIndex({ ...latest, events: latest.events.filter(event => event.block <= at) });
    if (historyIndex.absorbed.has(keep) || historyIndex.absorbed.has(donor)) return status('burned', true);
    const families = [historyIndex.family(keep), historyIndex.family(donor)];
    const conflict = rawAt === null && newerConflict(families);
    if (conflict) return status(conflict, true);
    const level = families[0].root.level;
    if (level !== families[1].root.level) return status('level', true);
    if (level >= 10) return status('ceiling', true);
    status('loading');
    try {
      const sides = await Promise.all(families.map(async (family) => {
        const { id, key } = family.root;
        const record = published.portraits[id];
        const art = record ? await bundledPortrait(id, record, published.safeBlock)
          : await contractPortrait(id, at, latest, 'chain');
        const image = new Image();
        image.src = art.url;
        await image.decode();
        return { id, url: art.url, stage: key, originals: family.originals.length, history: family.history };
      }));
      if (ticket !== generation) return;
      const updatedConflict = rawAt === null && newerConflict(families);
      if (updatedConflict) return status(updatedConflict, true);
      pair = { keep: sides[0], donor: sides[1], level, at };
      $('compare-keep').value = keep;
      $('compare-donor').value = donor;
      navigate(pair, method);
      status(null);
      renderPair();
    } catch {
      if (ticket === generation) status('unavailable', true);
    }
  }
  function fromRoute() {
    edited = false;
    invalidate();
    const route = currentRoute();
    $('compare-keep').value = route.get('keep') ?? '';
    $('compare-donor').value = route.get('donor') ?? '';
    if (!isCurrent()) return status('collection', true);
    if (['release', 'keep', 'donor', 'at'].some(k => route.getAll(k).length > 1)) return status('id', true);
    if (route.has('keep') || route.has('donor') || route.has('at'))
      resolve(route.get('keep'), route.get('donor'), route.get('at'), 'replaceState');
  }
  function localize() {
    $('compare-back').href = recordUrl(null, null, 'current');
    $('compare-example').disabled = !sample;
    if (sample) $('compare-example').textContent = tr('Try ', '试试 ') + '#' + sample[0] + ' + #' + sample[1];
    if (pair) renderPair();
    else if (message.length) $('compare-status').textContent = tr(...message);
  }
  function setSnapshot(seed, index) {
    latest = seed;
    latestIndex = index;
    if (!published) {
      published = seed;
      publishedIndex = index;
    }
    const levels = new Map();
    sample = null;
    for (const id of new Set([942, 944, ...Object.keys(published.portraits).map(Number)])) {
      if (!published.portraits[id] || publishedIndex.absorbed.has(id) || latestIndex.absorbed.has(id)) continue;
      const level = publishedIndex.family(id).root.level;
      if (level >= 10 || level !== latestIndex.family(id).root.level) continue;
      if (levels.has(level)) { sample = [levels.get(level), id]; break; }
      levels.set(level, id);
    }
    if (waiting && !edited) fromRoute();
    localize();
  }
  for (const id of inputs) $(id).addEventListener('input', () => { edited = true; invalidate(); });
  $('compare-form').addEventListener('submit', (event) => {
    event.preventDefault();
    edited = false;
    resolve($('compare-keep').value, $('compare-donor').value, null, 'pushState');
  });
  $('compare-example').addEventListener('click', () => {
    if (!sample) return;
    $('compare-keep').value = sample[0];
    $('compare-donor').value = sample[1];
    edited = false;
    resolve(...sample, null, 'pushState');
  });
  $('compare-swap').addEventListener('click', () => {
    if (!pair) return;
    pair = { ...pair, keep: pair.donor, donor: pair.keep };
    $('compare-keep').value = pair.keep.id;
    $('compare-donor').value = pair.donor.id;
    navigate(pair, 'pushState');
    renderPair();
  });
  $('compare-share').addEventListener('click', () => {
    if (!pair) return;
    const captured = { ...pair, zh: currentLanguage() };
    const { keep, donor, at, zh } = captured;
    openCard({
      url: comparisonLink({ keep: keep.id, donor: donor.id, at, zh }),
      title: tr('Merge preview', '合并预览'), kind: tr('PREVIEW CARD', '预览卡'),
      alt: tr('Merge preview for ', '合并预览 ') + '#' + keep.id + ' + #' + donor.id,
      filename: 'squeek-current-preview-' + keep.id + '-' + donor.id + '.png',
      draw: () => comparisonCard(captured),
    });
  });
  return {
    fromRoute, setSnapshot, localize,
    unavailable() { invalidate(); status('failed', true); },
    changeLanguage() {
      const r = currentRoute();
      const url = new URL(location.pathname, location.origin);
      for (const key of ['release', 'view', 'keep', 'donor', 'at'])
        for (const value of r.getAll(key)) url.searchParams.append(key, value);
      url.searchParams.set('lang', lang());
      history.replaceState({}, '', url);
      localize();
    },
  };
}
