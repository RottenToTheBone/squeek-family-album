import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const jsQrScript = createRequire(import.meta.url).resolve('jsqr');
const publicSite = 'https://squeek.machinepaystack.com/';

// Decode the pixels of the actual downloaded PNG independently of the site's encoder.
// Re-open its route against the candidate during pre-deploy tests and the public site in live tests.
export async function scanCard(page, png, expected, base) {
  const scanner = await page.context().newPage();
  try {
    await scanner.addScriptTag({ path: jsQrScript });
    const readings = await scanner.evaluate(async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      return [1, 0.65].map((scale) => {
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return window.jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data;
      });
    }, png.toString('base64'));
    assert.ok(readings[0], 'QR missing or unreadable in the full exported PNG');
    assert.equal(readings[1], readings[0], 'QR did not survive resizing to 65%');
    const link = new URL(readings[0]);
    assert.equal(link.origin + link.pathname, publicSite);
    assert.equal(link.username + link.password + link.hash, '');
    assert.deepEqual([...link.searchParams.keys()].sort(), Object.keys(expected).sort());
    for (const [name, value] of Object.entries(expected)) assert.equal(link.searchParams.get(name), String(value), name);
    return new URL(link.search, base).href;
  } finally {
    await scanner.close();
  }
}
