#!/usr/bin/env node
/* Renders the app icon (build/AppIcon.iconset + build/AppIcon.png) with a canvas.
 * Run through Electron: node_modules/.bin/electron scripts/make-icon.js
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');
const ICONSET = path.join(OUT, 'AppIcon.iconset');
const SIZE = 1024;

const DRAW = `
(canvasSize) => {
  const c = document.createElement('canvas');
  c.width = canvasSize;
  c.height = canvasSize;
  const g = c.getContext('2d');
  const S = canvasSize;
  const u = S / 1024;                       // design units

  // --- background tile -----------------------------------------------------
  const pad = 84 * u;
  const r = 200 * u;
  const grad = g.createLinearGradient(pad, pad, S - pad, S - pad);
  grad.addColorStop(0, '#3B82F6');
  grad.addColorStop(0.55, '#5B6BF5');
  grad.addColorStop(1, '#8B5CF6');
  g.save();
  g.beginPath();
  roundRect(g, pad, pad, S - pad * 2, S - pad * 2, r);
  g.shadowColor = 'rgba(20,20,60,0.35)';
  g.shadowBlur = 34 * u;
  g.shadowOffsetY = 12 * u;
  g.fillStyle = grad;
  g.fill();
  g.restore();

  // soft highlight
  g.save();
  g.beginPath();
  roundRect(g, pad, pad, S - pad * 2, S - pad * 2, r);
  g.clip();
  const hl = g.createLinearGradient(0, pad, 0, S * 0.6);
  hl.addColorStop(0, 'rgba(255,255,255,0.22)');
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hl;
  g.fillRect(0, 0, S, S);
  g.restore();

  // --- capture frame (four corner brackets) -------------------------------
  const cx0 = 268 * u, cy0 = 268 * u, cx1 = S - 268 * u, cy1 = S - 268 * u;
  const arm = 150 * u, lw = 58 * u;
  g.strokeStyle = '#FFFFFF';
  g.lineWidth = lw;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const corners = [
    [cx0, cy0, 1, 1], [cx1, cy0, -1, 1], [cx0, cy1, 1, -1], [cx1, cy1, -1, -1],
  ];
  for (const [x, y, dx, dy] of corners) {
    g.beginPath();
    g.moveTo(x + dx * arm, y);
    g.lineTo(x + dx * lw * 0.5, y);            // rounded corner
    g.quadraticCurveTo(x, y, x, y + dy * lw * 0.5);
    g.lineTo(x, y + dy * arm);
    g.stroke();
  }

  // --- centre shutter dot --------------------------------------------------
  const cc = S / 2;
  g.beginPath();
  g.arc(cc, cc, 84 * u, 0, Math.PI * 2);
  g.fillStyle = '#FA5151';
  g.fill();
  g.beginPath();
  g.arc(cc, cc, 84 * u, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 24 * u;
  g.stroke();

  return c.toDataURL('image/png');
}

function roundRect(g, x, y, w, h, r) {
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const script = `(() => { const draw = ${DRAW}; return draw(${SIZE}); })()`;
  const dataURL = await win.webContents.executeJavaScript(script);

  const base = nativeImage.createFromDataURL(dataURL);
  fs.mkdirSync(ICONSET, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'AppIcon.png'), base.toPNG());

  const variants = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, size] of variants) {
    const png = base.resize({ width: size, height: size, quality: 'best' }).toPNG();
    fs.writeFileSync(path.join(ICONSET, name), png);
  }
  console.log('icon PNGs written to', ICONSET);
  app.exit(0);
});
