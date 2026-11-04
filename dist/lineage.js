export function tokenNumber(value, limit = 9999) {
  const match = String(value ?? '')
    .trim()
    .match(/^#?0*([1-9]\d{0,4})$/);
  const id = match ? Number(match[1]) : 0;
  return id >= 1 && id <= limit ? id : null;
}

export function eventKey(event) {
  return event.tx + ':' + event.logIndex;
}

export function prepareIndex(archive) {
  const stages = new Map();
  const absorbed = new Map();
  const seen = new Map();
  const positions = new Set();
  const leaf = (id) => ({ id, level: 1, key: 'o-' + id, children: [], event: null });
  const events = [...archive.events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const event of events) {
    const { survivor, donor, level } = event;
    const key = eventKey(event);
    const position = event.block + ':' + event.logIndex;
    if (seen.has(key)) {
      const prior = seen.get(key);
      if (['block', 'survivor', 'donor', 'level', 'at'].some((field) => prior[field] !== event[field]))
        throw new Error('Conflicting merge at ' + key);
      continue;
    }
    if (
      !Number.isSafeInteger(event.block) ||
      event.block < 1 ||
      !Number.isSafeInteger(event.logIndex) ||
      event.logIndex < 0 ||
      !/^0x[0-9a-f]{64}$/i.test(event.tx) ||
      positions.has(position) ||
      !Number.isInteger(survivor) ||
      !Number.isInteger(donor) ||
      !tokenNumber(survivor, archive.issued) ||
      !tokenNumber(donor, archive.issued) ||
      survivor === donor ||
      absorbed.has(donor) ||
      absorbed.has(survivor)
    ) {
      throw new Error('Invalid token history at ' + key);
    }
    const left = stages.get(survivor) ?? leaf(survivor);
    const right = stages.get(donor) ?? leaf(donor);
    if (left.level !== right.level || level !== left.level + 1) {
      throw new Error('Incomplete merge history at ' + key);
    }
    const stage = {
      id: survivor,
      level,
      key: 'm-' + event.block + '-' + event.logIndex,
      children: [left, right],
      event,
    };
    stages.set(survivor, stage);
    absorbed.set(donor, event);
    seen.set(key, event);
    positions.add(position);
  }
  return {
    absorbed,
    family(id) {
      let rootId = id;
      while (absorbed.has(rootId)) rootId = absorbed.get(rootId).survivor;
      const root = stages.get(rootId) ?? leaf(rootId);
      const nodes = [];
      const visit = (node) => {
        nodes.push(node);
        node.children.forEach(visit);
      };
      visit(root);
      return {
        root,
        nodes,
        originals: nodes.filter((n) => !n.event),
        history: nodes
          .filter((n) => n.event)
          .sort((a, b) => b.event.block - a.event.block || b.event.logIndex - a.event.logIndex),
      };
    },
  };
}

// Row positions follow the original leaves, so the two parents of every merge stay adjacent.
export function treeRows(root) {
  let leafRow = 0;
  const placed = [];
  function visit(node) {
    const children = node.children.map(visit);
    const row = children.length ? (children[0].row + children[1].row) / 2 : leafRow++;
    const item = { node, row, children };
    placed.push(item);
    return item;
  }
  visit(root);
  return { placed, rows: leafRow };
}
