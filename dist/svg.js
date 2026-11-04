const namespace = 'http://www.w3.org/2000/svg';
const elements = new Set(
  'svg title desc metadata defs g path rect circle ellipse polygon polyline line symbol use'.split(' '),
);
const attributes = new Set(
  (
    'id fill stroke stroke-width x y x1 x2 y1 y2 cx cy r rx ry width height aria-label ' +
    'opacity href role color transform d points viewBox fill-rule'
  ).split(' '),
);
const paint = /^(?:none|currentColor|#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8})$/i;
const fragment = /^#[A-Za-z0-9_.:-]+$/;

// Preview, PNG, standalone download and the offline publisher all accept the
// renderer's passive SVG subset. Preserve its original bytes after validation.
export function svgImage(uri, id) {
  if (typeof uri !== 'string' || uri.length > 2_000_000) throw new Error('No original SVG');
  const comma = uri.indexOf(','),
    header = uri.slice(0, comma).toLowerCase();
  if (comma < 0 || !/^data:image\/svg\+xml(?:;charset=utf-8)?(?:;base64)?$/.test(header))
    throw new Error('Unexpected SVG encoding');
  const payload = uri.slice(comma + 1);
  let bytes;
  if (header.endsWith(';base64')) {
    bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  if (!bytes.length || bytes.length > 1_000_000) throw new Error('Invalid SVG size');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0') || text.includes('<!') || text.includes('<?'))
    throw new Error('Unexpected XML markup');
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml'),
    root = doc.documentElement;
  if (
    root.namespaceURI !== namespace ||
    root.localName !== 'svg' ||
    root.querySelector(':scope > title')?.textContent !== 'Squeek #' + id
  )
    throw new Error('Unexpected SVG token');
  for (const node of doc.getElementsByTagName('*')) {
    if (node.namespaceURI !== namespace || !elements.has(node.localName))
      throw new Error('Unexpected SVG element');
    for (const attr of node.attributes) {
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      const { name, value } = attr;
      if (
        attr.namespaceURI ||
        !attributes.has(name) ||
        /\\|url\s*\(/i.test(value) ||
        (name === 'href' && !fragment.test(value)) ||
        (['fill', 'stroke', 'color'].includes(name) && !paint.test(value))
      )
        throw new Error('Unexpected SVG attribute');
    }
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384)
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return 'data:image/svg+xml;base64,' + btoa(binary);
}
