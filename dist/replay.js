import { txLink } from './chain.js';
import { bundledPortrait } from './packed-art.js';
import { CURRENT } from './receipts.js';
import { replayCard, replayLink } from './share.js';

// Archive reads of tokenURI at this merge pin the images even if the snapshot advances.
export const featuredReplay = {
  survivor: 7458, donor: 7453, level: 2, block: 12076748, logIndex: 87,
  tx: '0xe2035a8e291cc04c0c4c6f3c7598190022205d0fb65345e7f8074f32e0dcdb85',
  at: '2026-11-06T13:06:24.000Z',
};
const originalDigests = {
  7453: '2a696ab65c79cbf1fe3b2e93d168cc2c285dc8f51de8e3b9f8c3ead3cdb3c76e',
  7458: 'af637fff17a0b16cea68f2a7f14f3455d3ff6675d0c3bbb252582811c135c80e',
};
const stage = 'm-' + featuredReplay.block + '-' + featuredReplay.logIndex;
const $ = id => document.getElementById(id);
const blockNumber = block => block.toLocaleString('en-US');

export function replayUrl(phase, language) {
  const url = new URL(location.pathname, location.origin);
  url.search = new URLSearchParams({ release: CURRENT.release, view: 'replay', event: stage, phase, lang: language });
  return url.href;
}

function selectedPhase() {
  const route = new URL(location.href).searchParams;
  if (['view', 'release', 'event', 'phase', 'lang'].some(key => route.getAll(key).length > 1)) return null;
  if (route.has('lang') && !['en', 'zh'].includes(route.get('lang'))) return null;
  if (route.get('view') !== 'replay' || !['current', CURRENT.release].includes(route.get('release')) || route.get('event') !== stage)
    return null;
  const phase = route.get('phase') ?? 'after';
  return ['before', 'after'].includes(phase) ? phase : null;
}

async function verifiedMerge(seed, index) {
  const { donor, survivor, block } = featuredReplay;
  const event = index.absorbed.get(donor);
  if (seed.releaseId !== CURRENT.release || seed.collection !== CURRENT.collection ||
      !event || Object.entries(featuredReplay).some(([key, value]) => event[key] !== value))
    throw new Error('Featured merge missing from the verified collection');
  async function original(id) {
    const record = seed.portraits[id];
    if (record?.sha256 !== originalDigests[id] || (id === donor && record.block !== block - 1))
      throw new Error('Featured original does not match the archive');
    const { url } = await bundledPortrait(id, record, seed.safeBlock);
    const art = new Image();
    art.src = url;
    await art.decode();
    return { id, url };
  }
  const [lost, keep] = await Promise.all([original(donor), original(survivor)]);
  return { event, donor: lost, keep };
}

export function replayPanel({ tr, lang, recordUrl, openCard, animateImage }) {
  let record, pendingSnapshot, failed = false, request = 0;
  const headingText = document.querySelector('.replay-heading .lede');

  function localize() {
    const phase = selectedPhase();
    $('replay-back').href = recordUrl(null, null, 'current');
    $('replay-history').href = recordUrl(8925, 'o-8925', 'archive');
    $('replay-switch').setAttribute('aria-label', tr('Replay phase', '回放阶段'));
    $('replay-result').hidden = !record || !phase || failed;
    $('replay-share').disabled = $('replay-result').hidden || phase !== 'after';
    $('replay-status').classList.toggle('error', failed || !phase);
    headingText.hidden = !phase || failed;
    $('replay-title').textContent = !phase || failed ? tr('Merge replay', '合并回放')
      : tr('Recover #7453’s original portrait', '找回 #7453 的原画');
    if (!phase) {
      $('replay-status').textContent = tr('This link does not identify a recorded merge. Open the featured replay from the album.',
        '这个链接未指向可回放的合并记录，请返回家谱打开首页示例。');
      return;
    }
    if (failed || !record) {
      $('replay-status').textContent = failed
        ? tr('The merge or its original portraits could not be verified. Reload to try again.', '暂时无法核验这笔合并或它的原画，请刷新重试。')
        : tr('Checking the recorded merge and its two portraits…', '正在核验合并记录和两张原画…');
      return;
    }
    $('replay-status').textContent = '';
    const { event, donor, keep } = record;
    const after = phase === 'after';
    $('replay-before').setAttribute('aria-pressed', String(!after));
    $('replay-after').setAttribute('aria-pressed', String(after));
    $('replay-phase-block').textContent = tr('Block ', '区块 ') + blockNumber(after ? event.block : event.block - 1);
    $('replay-donor-state').textContent = after ? tr('Burned · recovered', '已销毁 · 原画已找回') : tr('Level 1 · live', '1 级 · 存续');
    $('replay-survivor-state').textContent = after ? tr('Level 2 · survived', '2 级 · 已保留') : tr('Level 1 · live', '1 级 · 存续');
    $('replay-donor-note').textContent = after
      ? tr('Its last portrait, from block ', '原画取自销毁前的区块 ') + blockNumber(event.block - 1) + tr('.', '。')
      : tr('An original Squeek, still held under its own ID.', '合并前，这张原画仍属于独立编号 #7453。');
    $('replay-survivor-note').textContent = after
      ? tr('The same portrait, now with two originals in its family.', '原画保持不变，家谱中已有两张原画。')
      : tr('Its original portrait, one block before the merge.', '合并前一个区块，#7458 仍是 1 级原始藏品。');
    $('replay-donor-art').alt = tr('Original onchain portrait of Squeek #7453, recovered before its burn', 'Squeek #7453 销毁前的链上原画');
    $('replay-survivor-art').alt = tr('Original onchain portrait of surviving Squeek #7458', '保留编号 #7458 的 Squeek 链上原画');
    $('replay-original').href = donor.url;
    $('replay-family').href = recordUrl(keep.id, after ? stage : 'o-' + keep.id, 'current');
    $('replay-receipt').href = txLink(event.tx);
    const time = event.at.slice(0, 10) + ' ' + event.at.slice(11, 16) + ' UTC';
    $('replay-receipt-meta').textContent = time + tr(' · Block ', ' · 区块 ') + blockNumber(event.block) + tr(' · Log ', ' · 日志 ') + event.logIndex;
    $('replay-tx').textContent = event.tx;
    $('replay-next').hidden = after;
    $('replay-share').hidden = !after;
    $('replay-card-note').hidden = !after;
  }

  function fromRoute() {
    if ($('share-dialog').open) $('share-dialog').close();
    localize();
    if (pendingSnapshot && selectedPhase()) loadSnapshot();
  }
  function changePhase(phase) {
    if (!record || phase === selectedPhase()) return;
    history.pushState({}, '', replayUrl(phase, lang()));
    fromRoute();
    animateImage($('replay-donor-art'), 'translateY(5px)');
  }
  $('replay-before').addEventListener('click', () => changePhase('before'));
  $('replay-after').addEventListener('click', () => changePhase('after'));
  $('replay-next').addEventListener('click', () => {
    changePhase('after');
    $('replay-after').focus();
  });
  $('replay-share').addEventListener('click', () => {
    if (!record || selectedPhase() !== 'after') return;
    const captured = { ...record, zh: lang() === 'zh' };
    openCard({
      url: replayLink(captured), title: tr('Merge keepsake', '合并纪念卡'), kind: tr('RECORDED MERGE', '链上合并记录'),
      alt: tr('Merge keepsake with both original portraits, #7453 and #7458', '#7453 与 #7458 两张原画的合并纪念卡'),
      filename: 'squeek-merge-7458-7453-' + captured.event.block + '.png', draw: () => replayCard(captured),
    });
  });
  function unavailable() {
    ++request;
    pendingSnapshot = null;
    record = null;
    failed = true;
    fromRoute();
  }
  async function loadSnapshot() {
    const ticket = ++request;
    const { seed, index } = pendingSnapshot;
    pendingSnapshot = null;
    try {
      const verified = await verifiedMerge(seed, index);
      if (ticket !== request) return;
      record = verified;
      failed = false;
      $('replay-donor-art').src = verified.donor.url;
      $('replay-survivor-art').src = verified.keep.url;
      localize();
    } catch {
      if (ticket === request) unavailable();
    }
  }
  return {
    localize, fromRoute, unavailable,
    setSnapshot(seed, index) {
      pendingSnapshot = { seed, index };
      fromRoute();
    },
    changeLanguage() {
      const url = new URL(location.href);
      if (selectedPhase()) {
        url.searchParams.set('lang', lang());
        history.replaceState({}, '', url);
      }
      fromRoute();
    },
  };
}
