'use strict';

/**
 * Electron 44 replaced the classic synchronous clipboard image helpers
 * (`readImage` / `writeImage`) with the W3C-style async API:
 *
 *   clipboard.read()  -> ClipboardItem[]      (item.getType(mime) -> Blob)
 *   clipboard.write() -> ClipboardItem[]
 *
 * This adapter keeps the rest of the app on a simple image-in / image-out
 * contract.
 */

const { clipboard, nativeImage, ClipboardItem } = require('electron');

const IMAGE_TYPES = ['image/png', 'image/tiff', 'image/jpeg', 'image/webp', 'image/bmp'];

async function writeImage(image) {
  const size = image.getSize();
  if (!size.width || !size.height) return false;
  const blob = new Blob([image.toPNG()], { type: 'image/png' });
  await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return true;
}

async function writeImageFromDataURL(dataURL) {
  return writeImage(nativeImage.createFromDataURL(dataURL));
}

/** @returns {Promise<Electron.NativeImage|null>} */
async function readImage() {
  let items = [];
  try {
    items = await clipboard.read();
  } catch {
    return null;
  }
  for (const item of items) {
    const type = IMAGE_TYPES.find((t) => item.types.includes(t));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      if (!image.isEmpty()) return image;
    } catch {
      /* try the next representation */
    }
  }
  return null;
}

async function readText() {
  try {
    return await clipboard.readText();
  } catch {
    return '';
  }
}

async function writeText(text) {
  await clipboard.writeText(text);
}

module.exports = { writeImage, writeImageFromDataURL, readImage, readText, writeText };
