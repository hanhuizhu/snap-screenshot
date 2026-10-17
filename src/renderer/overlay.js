/* Snap overlay renderer — WeChat-style region capture. */
'use strict';

const host = window.snapHost;
const Ops = window.Ops;

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

const COLORS = ['#FA5151', '#FF8F1F', '#FFC300', '#07C160', '#1677FF', '#8A2BE2', '#FFFFFF', '#000000'];
const WIDTHS = [2, 4, 7, 11];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const TEXT_SIZE = 16;
const MOSAIC_BLOCK = 10;   // mosaic block size, DIP
const MAG_SIZE = 116;      // magnifier side, DIP
const MAG_ZOOM = 10;       // magnifier zoom (device px per source px)
const DIM = 'rgba(0,0,0,0.45)';

const S = {
  phase: 'idle',        // idle | select | ready | move | resize | draw
  sel: null,
  ops: [],
  redo: [],
  tool: null,
  color: COLORS[0],
  width: WIDTHS[1],
  mosaicWidth: 30,
  autoDetect: true,
  hover: null,
  locked: false,
  mouse: { x: -1, y: -1 },
  pointerIn: false,
  draft: null,
  drag: null,
  editor: null,
  dirty: true,
  init: null,
};

let DIPW = 0, DIPH = 0, DPR = 1;
let ORIGIN = { x: 0, y: 0 };
let MYID = null;
let IS_DEMO = false;
let IMG = null;
let MOSAIC = null;
let AX_OK = false;

const el = {
  stage: $('stage'), shot: $('shot'), fx: $('fx'),
  mag: $('mag'), maginfo: $('maginfo'), magswatch: $('magswatch'),
  maghex: $('maghex'), magpos: $('magpos'), magsize: $('magsize'),
  chip: $('sizechip'), toolbar: $('toolbar'), main: $('tb-main'), sub: $('tb-sub'),
  swatches: $('swatches'), widths: $('widths'), toast: $('toast'), measure: $('measure'),
};

const ctx = el.fx.getContext('2d');
let scratch = null;   // 1x1 canvas for colour sampling
let sampleCacheKey = null;
let sampleCache = null;

/** Colour of one source pixel, as { hex, rgb }. */
function sampleImagePixel(px, py) {
  if (!IMG) return null;
  try {
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratch.width = 1;
      scratch.height = 1;
      scratch.ctx = scratch.getContext('2d', { willReadFrequently: true });
    }
    const sg = scratch.ctx;
    sg.clearRect(0, 0, 1, 1);
    sg.drawImage(IMG, px, py, 1, 1, 0, 0, 1, 1);
    const d = sg.getImageData(0, 0, 1, 1).data;
    const rgb = [d[0], d[1], d[2]];
    return { rgb, hex: '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- utilities

function dirty() { S.dirty = true; }

function normRect(x0, y0, x1, y1) {
  const x = Math.min(x0, x1), y = Math.min(y0, y1);
  return { x, y, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

function clampRect(r) {
  const x = clamp(r.x, 0, Math.max(0, DIPW - r.w));
  const y = clamp(r.y, 0, Math.max(0, DIPH - r.h));
  return { x, y, w: Math.min(r.w, DIPW), h: Math.min(r.h, DIPH) };
}

function insideRect(r, x, y) {
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function handleRects(sel) {
  const { x, y, w, h } = sel;
  return {
    nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2],
    se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2],
  };
}

function hitHandle(x, y) {
  if (!S.sel || S.sel.w < 2 || S.sel.h < 2) return null;
  const hs = handleRects(S.sel);
  for (const k of HANDLES) {
    const [hx, hy] = hs[k];
    if (Math.abs(x - hx) <= 9 && Math.abs(y - hy) <= 9) return k;
  }
  return null;
}

function toast(msg, ms = 1600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => { el.toast.hidden = true; }, 220);
  }, ms);
}

// ---------------------------------------------------------------- demo frame

/** Synthetic "desktop" so the whole pipeline can be exercised without the
 *  screen-recording permission (self-test / demo mode). */
function demoImage() {
  const W = Math.round(DIPW * DPR), H = Math.round(DIPH * DPR);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.setTransform(DPR, 0, 0, DPR, 0, 0);

  const grad = g.createLinearGradient(0, 0, DIPW, DIPH);
  grad.addColorStop(0, '#1b2a4a');
  grad.addColorStop(0.5, '#4a3a6b');
  grad.addColorStop(1, '#7d3f58');
  g.fillStyle = grad;
  g.fillRect(0, 0, DIPW, DIPH);

  // menu bar
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 0, DIPW, 24);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.font = '12px system-ui, -apple-system, "PingFang SC", sans-serif';
  g.fillText('Finder   文件   编辑   显示   前往   窗口   帮助', 16, 16);
  g.fillText('09:41', DIPW - 52, 16);

  // a colourful photo-ish block (good for the magnifier / mosaic)
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `hsl(${(i * 6) % 360} 70% ${45 + (i % 5) * 6}%)`;
    g.fillRect(40 + i * 3, DIPH - 300, 3, 140);
  }
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = `hsl(${(i * 9) % 360} 80% 60%)`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(40, DIPH - 300 + i * 3.5);
    g.lineTo(40 + 180, DIPH - 300 + i * 3.5);
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = '10px "SF Mono", Menlo, monospace';
  g.fillText('RETINA PIXEL TEST 0123456789 精细文字测试', 240, DIPH - 140);

  // demo window, matching main.js demoRects()
  const wx = 120, wy = 90, ww = 620, wh = 400;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 30;
  g.shadowOffsetY = 12;
  g.fillStyle = '#ffffff';
  roundRect(g, wx, wy, ww, wh, 10);
  g.fill();
  g.restore();

  g.fillStyle = '#f2f2f4';
  roundRect(g, wx, wy, ww, 38, 10);
  g.fill();
  g.fillStyle = '#d9d9dd';
  g.fillRect(wx, wy + 28, ww, 10);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
    g.fillStyle = col;
    g.beginPath();
    g.arc(wx + 18 + i * 18, wy + 19, 6, 0, Math.PI * 2);
    g.fill();
  });
  g.fillStyle = '#1d1d1f';
  g.font = '13px system-ui, -apple-system, "PingFang SC", sans-serif';
  g.fillText('Snap 演示窗口', wx + 80, wy + 24);

  // sidebar
  g.fillStyle = '#fafafa';
  g.fillRect(wx + 1, wy + 38, 130, wh - 39);
  g.fillStyle = '#8e8e93';
  g.font = '12px system-ui, -apple-system, "PingFang SC", sans-serif';
  ['概览', '截图', '标注', '设置'].forEach((t, i) => {
    g.fillStyle = i === 1 ? '#1677FF' : '#6b6b70';
    g.fillText(t, wx + 20, wy + 70 + i * 28);
  });

  // two buttons — these are the AX-hit targets in demo mode
  const btn = (x, label, bg) => {
    g.fillStyle = bg;
    roundRect(g, x, wy + 60, 132, 34, 7);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '13px system-ui, -apple-system, "PingFang SC", sans-serif';
    g.textAlign = 'center';
    g.fillText(label, x + 66, wy + 82);
    g.textAlign = 'left';
  };
  btn(wx + 50, '确定', '#1677FF');
  btn(wx + 200, '取消', '#9aa0a6');

  g.fillStyle = '#1d1d1f';
  g.font = '13px system-ui, -apple-system, "PingFang SC", sans-serif';
  g.fillText('一段示例文字', wx + 50, wy + 132);

  g.strokeStyle = '#e4e4e8';
  g.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    g.moveTo(wx + 50, wy + 170 + i * 26);
    g.lineTo(wx + 50 + (i % 2 ? 420 : 500), wy + 170 + i * 26);
    g.stroke();
  }

  // dock
  g.fillStyle = 'rgba(255,255,255,0.25)';
  roundRect(g, DIPW / 2 - 210, DIPH - 62, 420, 52, 14);
  g.fill();
  for (let i = 0; i < 9; i++) {
    g.fillStyle = `hsl(${i * 40} 65% 58%)`;
    roundRect(g, DIPW / 2 - 200 + i * 46, DIPH - 54, 38, 38, 9);
    g.fill();
  }

  return c.toDataURL('image/png');
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------------------------------------------------------------- boot

async function boot() {
  const init = await host.ready();
  if (!init) return;

  S.init = init;
  MYID = init.displayId;
  DIPW = init.dip.w;
  DIPH = init.dip.h;
  DPR = window.devicePixelRatio || init.dpr || 1;
  ORIGIN = init.origin;
  IS_DEMO = !!init.demo;
  AX_OK = !!init.axTrusted;

  // Start from the real pointer position so the magnifier is live immediately.
  if (init.cursor) {
    const lx = init.cursor.x - ORIGIN.x;
    const ly = init.cursor.y - ORIGIN.y;
    if (lx >= 0 && ly >= 0 && lx <= DIPW && ly <= DIPH) {
      S.mouse = { x: lx, y: ly };
      S.pointerIn = true;
    }
  }

  el.fx.width = Math.round(DIPW * DPR);
  el.fx.height = Math.round(DIPH * DPR);
  el.fx.style.width = DIPW + 'px';
  el.fx.style.height = DIPH + 'px';

  const src = init.demo ? demoImage()
    : init.png ? URL.createObjectURL(new Blob([init.png], { type: 'image/png' }))
      : null;

  if (src) {
    IMG = await loadImage(src);
    el.shot.src = src;
    if (!init.demo) {
      // The capturer fits the frame into the requested size; map it 1:1 onto the
      // display rect (aspect ratios match, so this is a plain stretch).
      el.shot.style.width = DIPW + 'px';
      el.shot.style.height = DIPH + 'px';
    }
    MOSAIC = Ops.buildMosaicBase(IMG, DIPW, MOSAIC_BLOCK);
  } else {
    IMG = null;
  }

  buildToolbar();
  bindEvents();
  syncUndoButtons();
  dirty();

  await new Promise((r) => requestAnimationFrame(r));
  render();
  host.firstFrame();

  if (IS_DEMO) toast('演示模式：合成桌面（未申请屏幕录制权限）', 2600);
  else if (!AX_OK && S.autoDetect) toast('智能识别已降级为窗口级（辅助功能未授权）', 2200);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ---------------------------------------------------------------- rendering

function render() {
  if (!S.dirty) return;
  S.dirty = false;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.fx.width, el.fx.height);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  const hole = S.sel || (S.autoDetect && S.hover && S.phase === 'idle' ? S.hover : null);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, DIPW, DIPH);
  if (hole) ctx.rect(hole.x, hole.y, hole.w, hole.h);
  ctx.fillStyle = DIM;
  ctx.fill('evenodd');
  ctx.restore();

  if (S.hover && !S.sel && S.autoDetect) {
    ctx.save();
    ctx.strokeStyle = S.color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(S.hover.x + 0.5, S.hover.y + 0.5, Math.max(0, S.hover.w - 1), Math.max(0, S.hover.h - 1));
    ctx.restore();
  }

  if (S.sel && S.sel.w > 0 && S.sel.h > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(S.sel.x, S.sel.y, S.sel.w, S.sel.h);
    ctx.clip();
    const env = { mosaicBase: MOSAIC, dipW: DIPW, dipH: DIPH };
    for (const op of S.ops) Ops.drawOp(ctx, op, env);
    if (S.draft) Ops.drawOp(ctx, S.draft, env);
    ctx.restore();
    drawFrame(ctx);
  }

  positionChrome();
  if (S.pointerIn && !S.editor) drawMagnifier();
  else hideMagnifier();
}

function drawFrame(g) {
  const { x, y, w, h } = S.sel;
  g.save();
  g.strokeStyle = S.color;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  if ((S.phase === 'ready' || S.phase === 'resize') && w > 0 && h > 0) {
    const hs = handleRects(S.sel);
    const SZ = 7;
    g.fillStyle = S.color;
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.lineWidth = 1;
    for (const k of HANDLES) {
      const [hx, hy] = hs[k];
      g.beginPath();
      g.rect(Math.round(hx - SZ / 2) + 0.5, Math.round(hy - SZ / 2) + 0.5, SZ, SZ);
      g.fill();
      g.stroke();
    }
  }
  g.restore();
}

// ---------------------------------------------------------------- magnifier

function hideMagnifier() {
  if (!el.mag.hidden) {
    el.mag.hidden = true;
    el.maginfo.hidden = true;
  }
}

function drawMagnifier() {
  el.mag.hidden = false;
  el.maginfo.hidden = false;

  const d = Math.round(MAG_SIZE * DPR);
  if (el.mag.width !== d || el.mag.height !== d) {
    el.mag.width = d;
    el.mag.height = d;
  }
  const g = el.mag.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, d, d);

  const mx = clamp(Math.round(S.mouse.x), 0, DIPW - 1);
  const my = clamp(Math.round(S.mouse.y), 0, DIPH - 1);

  if (IMG) {
    const k = IMG.naturalWidth / DIPW;
    const srcSize = d / MAG_ZOOM;                 // source px shown
    const cx = (mx + 0.5) * k;
    const cy = (my + 0.5) * k;
    const sx = cx - srcSize / 2;
    const sy = cy - srcSize / 2;
    g.drawImage(IMG, sx, sy, srcSize, srcSize, 0, 0, d, d);

    // pixel grid, aligned to the captured pixels
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 1;
    const firstX = (Math.ceil(sx) - sx) * MAG_ZOOM;
    const firstY = (Math.ceil(sy) - sy) * MAG_ZOOM;
    g.beginPath();
    for (let gx = firstX; gx < d; gx += MAG_ZOOM) { g.moveTo(Math.round(gx) + 0.5, 0); g.lineTo(Math.round(gx) + 0.5, d); }
    for (let gy = firstY; gy < d; gy += MAG_ZOOM) { g.moveTo(0, Math.round(gy) + 0.5); g.lineTo(d, Math.round(gy) + 0.5); }
    g.stroke();

    // the exact pixel under the cursor + crosshair through it
    const px = (Math.floor(cx) - sx) * MAG_ZOOM;
    const py = (Math.floor(cy) - sy) * MAG_ZOOM;
    g.strokeStyle = S.color;
    g.lineWidth = 2;
    g.strokeRect(px, py, MAG_ZOOM, MAG_ZOOM);
    g.globalAlpha = 0.55;
    g.beginPath();
    g.moveTo(0, py + MAG_ZOOM / 2);
    g.lineTo(d, py + MAG_ZOOM / 2);
    g.moveTo(px + MAG_ZOOM / 2, 0);
    g.lineTo(px + MAG_ZOOM / 2, d);
    g.stroke();
    g.globalAlpha = 1;

    const key = `${Math.floor(cx)}:${Math.floor(cy)}`;
    if (key !== sampleCacheKey) {
      sampleCacheKey = key;
      sampleCache = sampleImagePixel(Math.floor(cx), Math.floor(cy));
    }
    if (sampleCache) {
      el.maghex.textContent = sampleCache.hex;
      el.magswatch.style.background = sampleCache.hex;
    } else {
      el.maghex.textContent = '—';
    }
  }

  el.magpos.textContent = `${mx}, ${my}`;
  if (S.sel) {
    el.magsize.hidden = false;
    el.magsize.textContent = `${Math.round(S.sel.w)} × ${Math.round(S.sel.h)}`;
  } else {
    el.magsize.hidden = true;
  }

  // place it near the cursor, flipping at the edges
  const w = MAG_SIZE;
  const h = MAG_SIZE + 26;
  let x = S.mouse.x + 22;
  let y = S.mouse.y + 22;
  if (x + w > DIPW - 8) x = S.mouse.x - 22 - w;
  if (y + h > DIPH - 8) y = S.mouse.y - 14 - h;
  x = clamp(x, 8, Math.max(8, DIPW - w - 8));
  y = clamp(y, 8, Math.max(8, DIPH - h - 8));
  el.mag.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  el.maginfo.style.transform = `translate(${Math.round(x)}px, ${Math.round(y + MAG_SIZE + 5)}px)`;
}

// ---------------------------------------------------------------- chrome (toolbar / chip)

function positionChrome() {
  const hasSel = !!S.sel && S.sel.w >= 2 && S.sel.h >= 2;
  if (!hasSel) {
    el.toolbar.hidden = true;
    el.chip.hidden = true;
    return;
  }

  el.sub.hidden = !annotationToolActive();
  el.toolbar.hidden = false;

  const tw = el.toolbar.offsetWidth;
  const th = el.toolbar.offsetHeight;
  let tx = clamp(S.sel.x, 6, Math.max(6, DIPW - tw - 6));
  let ty = S.sel.y + S.sel.h + 8;
  if (ty + th > DIPH - 6) {
    const above = S.sel.y - th - 8;
    ty = above >= 6 ? above : clamp(DIPH - th - 6, 6, DIPH);
  }
  el.toolbar.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;

  el.chip.hidden = false;
  el.chip.textContent = `${Math.round(S.sel.w)} × ${Math.round(S.sel.h)}`;
  const cw = el.chip.offsetWidth;
  const chh = el.chip.offsetHeight;
  let cx = clamp(S.sel.x, 2, Math.max(2, DIPW - cw - 2));
  let cy = S.sel.y - chh - 4;
  if (cy < 2) cy = clamp(S.sel.y + 4, 2, DIPH - chh - 2);
  el.chip.style.transform = `translate(${Math.round(cx)}px, ${Math.round(cy)}px)`;
}

function annotationToolActive() {
  return !!S.tool && ['rect', 'ellipse', 'arrow', 'pen', 'mosaic', 'text'].includes(S.tool);
}

function drawingToolActive() {
  return !!S.tool && ['rect', 'ellipse', 'arrow', 'pen', 'mosaic'].includes(S.tool);
}

// ---------------------------------------------------------------- toolbar

function buildToolbar() {
  el.main.querySelectorAll('.tbtn').forEach((b) => {
    const tool = b.dataset.tool;
    const act = b.dataset.act;
    b.innerHTML = window.svgIcon(tool ? toolIconName(tool) : act, tool === 'text' ? 21 : 20);
    if (tool) {
      b.addEventListener('click', () => selectTool(tool));
    } else {
      b.addEventListener('click', () => runAction(act));
    }
  });

  el.swatches.innerHTML = '';
  COLORS.forEach((c) => {
    const s = document.createElement('button');
    s.className = 'swatch';
    s.dataset.color = c;
    s.style.background = c;
    s.style.color = c;
    s.title = c;
    s.addEventListener('click', () => setColor(c));
    el.swatches.appendChild(s);
  });

  el.widths.innerHTML = '';
  WIDTHS.forEach((w) => {
    const b = document.createElement('button');
    b.className = 'wbtn';
    b.dataset.width = String(w);
    const dot = document.createElement('i');
    const size = clamp(w + 1, 3, 12);
    dot.style.width = size + 'px';
    dot.style.height = size + 'px';
    b.appendChild(dot);
    b.addEventListener('click', () => setWidth(w));
    el.widths.appendChild(b);
  });

  el.toolbar.addEventListener('mousedown', (e) => {
    if (S.editor) commitEditor();
    e.preventDefault();               // keep focus on the stage, never on a button
  });
  el.toolbar.addEventListener('contextmenu', (e) => e.preventDefault());

  syncToolbar();
}

function toolIconName(tool) {
  return tool;
}

function selectTool(tool) {
  S.tool = S.tool === tool ? null : tool;
  if (S.tool) {
    S.phase = 'ready';
    if (S.tool !== 'text' && S.editor) commitEditor();
  }
  syncToolbar();
  dirty();
}

function setColor(c) {
  S.color = c;
  syncToolbar();
  dirty();
}

function setWidth(w) {
  S.width = w;
  syncToolbar();
}

function syncToolbar() {
  el.main.querySelectorAll('.tbtn').forEach((b) => {
    if (b.dataset.tool) b.classList.toggle('on', b.dataset.tool === S.tool);
  });
  el.swatches.querySelectorAll('.swatch').forEach((s) => {
    s.classList.toggle('on', s.dataset.color.toUpperCase() === S.color.toUpperCase());
  });
  el.widths.querySelectorAll('.wbtn').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.width) === S.width);
  });
  document.documentElement.style.setProperty('--accent', S.color);

  // keep the size chip legible for light annotation colours
  const hex = S.color.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  el.chip.style.color = lum > 0.7 ? '#1d1d1f' : '#ffffff';
}

function syncUndoButtons() {
  const u = el.main.querySelector('[data-act="undo"]');
  const r = el.main.querySelector('[data-act="redo"]');
  if (u) u.disabled = S.ops.length === 0;
  if (r) r.disabled = S.redo.length === 0;
}

async function runAction(act) {
  if (act === 'undo') {
    if (S.ops.length) {
      S.redo.push(S.ops.pop());
      syncUndoButtons();
      dirty();
    }
    return;
  }
  if (act === 'redo') {
    if (S.redo.length) {
      S.ops.push(S.redo.pop());
      syncUndoButtons();
      dirty();
    }
    return;
  }
  if (act === 'cancel') { host.cancel(); return; }
  if (act === 'copy') {
    const ok = await doCopy();
    if (ok) host.cancel();
    return;
  }
  if (act === 'save') {
    const ok = await doSave();
    if (ok) host.cancel();
    return;
  }
  if (act === 'pin') {
    const ok = await doPin();
    if (ok) host.cancel();
  }
}

// ---------------------------------------------------------------- annotation ops

function pushOp(op) {
  S.ops.push(op);
  S.redo.length = 0;
  syncUndoButtons();
  dirty();
}

function commitEditor() {
  const ed = S.editor;
  if (!ed) return;
  S.editor = null;
  const text = ed.el.value;
  const pos = ed.pos;
  const editingOp = ed.op;
  ed.el.remove();
  if (text.trim()) {
    if (editingOp) {
      editingOp.text = text;
      editingOp.x = pos.x;
      editingOp.y = pos.y;
    } else {
      pushOp({ type: 'text', x: pos.x, y: pos.y, text, color: S.color, size: TEXT_SIZE });
    }
  } else if (editingOp) {
    S.ops = S.ops.filter((o) => o !== editingOp);
    syncUndoButtons();
  }
  dirty();
}

function cancelEditor() {
  const ed = S.editor;
  if (!ed) return;
  S.editor = null;
  ed.el.remove();
  dirty();
}

function openEditor(x, y, op) {
  if (S.editor) commitEditor();
  const ta = document.createElement('textarea');
  ta.id = 'editor';
  ta.spellcheck = false;
  ta.value = op ? op.text : '';
  ta.style.left = (x - 5) + 'px';
  ta.style.top = (y - 4) + 'px';
  ta.style.color = S.color;
  ta.style.font = `${TEXT_SIZE}px ${Ops.FONT_STACK}`;
  ta.style.lineHeight = `${TEXT_SIZE * Ops.TEXT_LINE_HEIGHT}px`;
  el.stage.appendChild(ta);
  autosizeEditor(ta);

  ta.addEventListener('input', () => autosizeEditor(ta));
  ta.addEventListener('mousedown', (e) => e.stopPropagation());
  ta.addEventListener('mouseup', (e) => e.stopPropagation());
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditor();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitEditor();
    }
  });
  ta.addEventListener('blur', () => commitEditor());
  ta.focus();

  S.editor = { el: ta, pos: { x, y }, op: op || null };
  dirty();
}

function autosizeEditor(ta) {
  const lines = ta.value.split('\n');
  const m = el.measure;
  m.style.font = `${TEXT_SIZE}px ${Ops.FONT_STACK}`;
  m.style.lineHeight = `${TEXT_SIZE * Ops.TEXT_LINE_HEIGHT}px`;
  let w = 0;
  for (const line of lines) {
    m.textContent = line || ' ';
    w = Math.max(w, m.getBoundingClientRect().width);
  }
  ta.style.width = Math.max(30, Math.ceil(w) + 12) + 'px';
  ta.style.height = Math.ceil(lines.length * TEXT_SIZE * Ops.TEXT_LINE_HEIGHT + 8) + 'px';
}

// ---------------------------------------------------------------- pointer

function localPoint(e) {
  return { x: e.clientX, y: e.clientY };
}

function bindEvents() {
  window.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  document.addEventListener('mouseleave', () => { S.pointerIn = false; dirty(); });
  document.addEventListener('mouseenter', () => { S.pointerIn = true; dirty(); });
  window.addEventListener('blur', () => { S.pointerIn = false; dirty(); });
  window.addEventListener('resize', () => {
    DIPW = window.innerWidth;
    DIPH = window.innerHeight;
    el.fx.width = Math.round(DIPW * DPR);
    el.fx.height = Math.round(DIPH * DPR);
    dirty();
  });
  window.snapHost.onOwner(onOwnerChanged);
}

function onOwnerChanged(id) {
  if (id === null || id === MYID) {
    S.locked = false;
  } else {
    S.locked = true;
    S.sel = null;
    S.hover = null;
    S.phase = 'idle';
  }
  dirty();
}

let hoverPending = false;
let hoverLast = 0;
const hoverCache = new Map();

function onMouseMove(e) {
  const p = localPoint(e);
  S.mouse = p;
  S.pointerIn = true;

  if (S.drag) {
    dragMove(p, e.shiftKey);
    dirty();
    return;
  }

  if (S.phase === 'draw' && S.draft) {
    drawMove(p, e.shiftKey);
    dirty();
    return;
  }

  updateCursor(p);
  updateHover(p);
  dirty();
}

function updateHover(p) {
  if (S.locked || S.sel || !S.autoDetect || S.phase !== 'idle') {
    if (S.hover) { S.hover = null; }
    return;
  }
  const key = `${Math.round(p.x / 3)}:${Math.round(p.y / 3)}`;
  if (hoverCache.has(key)) {
    S.hover = hoverCache.get(key);
    return;
  }
  // Never highlight something the pointer has already left while the hit-test
  // is still in flight.
  if (S.hover && !insideRect(S.hover, p.x, p.y)) S.hover = null;
  const now = performance.now();
  if (hoverPending || now - hoverLast < 40) return;
  hoverLast = now;
  hoverPending = true;
  host.hit(p.x + ORIGIN.x, p.y + ORIGIN.y).then((rect) => {
    hoverPending = false;
    if (!rect) {
      hoverCache.set(key, null);
      if (!S.sel) { S.hover = null; dirty(); }
      return;
    }
    const local = clampRect({ x: rect.x - ORIGIN.x, y: rect.y - ORIGIN.y, w: rect.w, h: rect.h });
    if (local.w < 2 || local.h < 2) {
      hoverCache.set(key, null);
      return;
    }
    if (hoverCache.size > 600) hoverCache.clear();
    hoverCache.set(key, local);
    if (!S.sel && S.phase === 'idle' && !S.locked) {
      S.hover = local;
      dirty();
    }
  });
}

function updateCursor(p) {
  let cur = 'crosshair';
  if (S.tool === 'text' && insideRect(S.sel, p.x, p.y)) {
    cur = 'text';
  } else if (S.sel) {
    const h = hitHandle(p.x, p.y);
    if (h && S.phase !== 'draw') {
      cur = (h === 'nw' || h === 'se') ? 'nwse-resize'
        : (h === 'ne' || h === 'sw') ? 'nesw-resize'
          : (h === 'n' || h === 's') ? 'ns-resize' : 'ew-resize';
    } else if (insideRect(S.sel, p.x, p.y) && !S.tool) {
      cur = 'move';
    }
  }
  if (document.body.style.cursor !== cur) document.body.style.cursor = cur;
}

function claim() {
  if (S.locked) return;
  host.claim().then((r) => {
    if (r && r.ok === false) S.locked = true;
  });
}

function onMouseDown(e) {
  if (e.button === 2) return;
  const p = localPoint(e);
  if (S.locked) return;
  if (el.toolbar.contains(e.target)) return;

  if (S.editor && !S.editor.el.contains(e.target)) {
    commitEditor();
  }

  // The overlay never needs the browser's default mousedown behaviour (focus
  // move, text selection) — it would steal focus from a just-opened text box.
  e.preventDefault();

  claim();

  const hs = S.sel && S.phase !== 'draw' ? hitHandle(p.x, p.y) : null;

  if (hs) {
    S.phase = 'resize';
    S.drag = { mode: 'resize', handle: hs, start: p, orig: { ...S.sel } };
    return;
  }

  // text is a click-to-place tool, not a drag-to-draw one
  if (S.sel && S.tool === 'text' && insideRect(S.sel, p.x, p.y)) {
    const hitOp = [...S.ops].reverse().find(
      (o) => o.type === 'text' && Ops.textHit(o, p.x, p.y)
    );
    if (hitOp) {
      // drag to reposition, plain click to edit
      S.phase = 'move';
      S.drag = { mode: 'textmove', op: hitOp, start: p, orig: { x: hitOp.x, y: hitOp.y }, moved: false };
      return;
    }
    openEditor(p.x, p.y, null);
    return;
  }

  if (S.sel && drawingToolActive() && insideRect(S.sel, p.x, p.y)) {
    startDraw(p);
    return;
  }

  if (S.sel && insideRect(S.sel, p.x, p.y)) {
    S.phase = 'move';
    S.drag = { mode: 'move', start: p, orig: { ...S.sel } };
    return;
  }

  if (S.hover && S.autoDetect) {
    // WeChat-style: hold still and release → select the hovered element;
    // press and drag past the slop → fresh lasso from the press point.
    S.drag = { mode: 'click-or-lasso', start: p };
    return;
  }

  // brand new selection: annotations belong to the old region, drop them
  S.ops.length = 0;
  S.redo.length = 0;
  S.draft = null;
  syncUndoButtons();
  S.phase = 'select';
  S.drag = { mode: 'select', anchor: p, start: p, orig: null };
  S.sel = { x: p.x, y: p.y, w: 0, h: 0 };
  dirty();
}

function onMouseUp(e) {
  if (e.button === 2) return;
  const p = localPoint(e);

  if (S.phase === 'draw') {
    finishDraw();
    dirty();
    return;
  }

  const d = S.drag;
  S.drag = null;

  if (!d) return;

  if (d.mode === 'click-or-lasso') {
    // released without crossing the slop → the plain click selects the hovered element
    if (S.hover) {
      S.sel = { x: S.hover.x, y: S.hover.y, w: S.hover.w, h: S.hover.h };
      S.hover = null;
      S.phase = 'ready';
    } else {
      S.phase = 'idle';
      host.release();
    }
    dirty();
    return;
  }

  if (d.mode === 'textmove') {
    if (!d.moved) openEditor(d.op.x, d.op.y, d.op);
    S.phase = 'ready';
    dirty();
    return;
  }

  if (d.mode === 'select') {
    const r = clampRect(normRect(d.anchor.x, d.anchor.y, p.x, p.y));
    if (r.w < 4 || r.h < 4) {
      S.sel = null;
      S.phase = 'idle';
      host.release();
      S.hover = null;
    } else {
      S.sel = r;
      S.phase = 'ready';
    }
  } else {
    S.phase = 'ready';
  }
  dirty();
}

function onContextMenu(e) {
  e.preventDefault();
  if (S.locked) return;
  if (S.phase === 'draw' && S.draft) {
    S.draft = null;
    S.phase = 'ready';
    dirty();
    return;
  }
  if (S.tool) {
    S.tool = null;
    syncToolbar();
    dirty();
    return;
  }
  if (S.sel) {
    S.sel = null;
    S.ops.length = 0;
    S.phase = 'idle';
    syncUndoButtons();
    host.release();
    dirty();
    return;
  }
  host.cancel();
}

function dragMove(p, shift) {
  const d = S.drag;
  if (d.mode === 'click-or-lasso') {
    if (Math.hypot(p.x - d.start.x, p.y - d.start.y) < 4) return;
    // crossed the slop: forget the hover and lasso freely from the press point
    S.hover = null;
    d.mode = 'select';
    d.anchor = d.start;
    S.sel = { x: d.anchor.x, y: d.anchor.y, w: 0, h: 0 };
  }
  if (d.mode === 'textmove') {
    d.op.x = d.orig.x + (p.x - d.start.x);
    d.op.y = d.orig.y + (p.y - d.start.y);
    d.moved = true;
    return;
  }
  if (d.mode === 'move') {
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    S.sel = clampRect({ x: d.orig.x + dx, y: d.orig.y + dy, w: d.orig.w, h: d.orig.h });
    S.phase = 'move';
    return;
  }
  if (d.mode === 'resize') {
    const o = d.orig;
    let { x, y, w, h } = o;
    const right = o.x + o.w;
    const bottom = o.y + o.h;
    const hd = d.handle;
    if (hd.includes('w')) { x = Math.min(p.x, right - 1); w = right - x; }
    if (hd.includes('e')) { w = Math.max(1, p.x - o.x); }
    if (hd.includes('n')) { y = Math.min(p.y, bottom - 1); h = bottom - y; }
    if (hd.includes('s')) { h = Math.max(1, p.y - o.y); }
    if (shift && (hd === 'nw' || hd === 'ne' || hd === 'se' || hd === 'sw')) {
      const size = Math.max(w, h);
      if (hd.includes('w')) x = right - size;
      if (hd.includes('n')) y = bottom - size;
      w = size;
      h = size;
    }
    S.sel = clampRect({ x, y, w, h });
    S.phase = 'resize';
    return;
  }
  // free selection
  let r = normRect(d.anchor.x, d.anchor.y, p.x, p.y);
  if (shift) {
    const side = Math.max(r.w, r.h);
    r = {
      x: p.x < d.anchor.x ? d.anchor.x - side : d.anchor.x,
      y: p.y < d.anchor.y ? d.anchor.y - side : d.anchor.y,
      w: side,
      h: side,
    };
  }
  S.sel = clampRect(r);
  S.phase = 'select';
}

// ---------------------------------------------------------------- drawing tools

function startDraw(p) {
  S.phase = 'draw';
  const t = S.tool;
  if (t === 'rect' || t === 'ellipse') {
    S.draft = {
      type: t, ax: p.x, ay: p.y,
      x: p.x, y: p.y, w: 0, h: 0, color: S.color, width: S.width,
    };
  } else if (t === 'arrow') {
    S.draft = { type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: S.color, width: S.width };
  } else if (t === 'pen') {
    S.draft = { type: 'pen', pts: [[p.x, p.y]], color: S.color, width: S.width };
  } else if (t === 'mosaic') {
    S.draft = { type: 'mosaic', pts: [[p.x, p.y]], size: S.mosaicWidth };
  }
}

function drawMove(p, shift) {
  const d = S.draft;
  if (!d) return;
  const last = d.pts ? d.pts[d.pts.length - 1] : null;

  if (d.type === 'rect' || d.type === 'ellipse') {
    let x1 = p.x, y1 = p.y;
    if (shift) {
      const side = Math.max(Math.abs(x1 - d.ax), Math.abs(y1 - d.ay));
      x1 = d.ax + (x1 < d.ax ? -side : side);
      y1 = d.ay + (y1 < d.ay ? -side : side);
    }
    const r = normRect(d.ax, d.ay, x1, y1);
    d.x = r.x;
    d.y = r.y;
    d.w = r.w;
    d.h = r.h;
  } else if (d.type === 'arrow') {
    let x2 = p.x, y2 = p.y;
    if (shift) {
      const dx = x2 - d.x1, dy = y2 - d.y1;
      const ang = Math.atan2(dy, dx);
      const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x2 = d.x1 + Math.cos(snapped) * len;
      y2 = d.y1 + Math.sin(snapped) * len;
    }
    d.x2 = x2;
    d.y2 = y2;
  } else if (d.pts) {
    if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 1) return;
    if (last) {
      const gap = Math.hypot(p.x - last[0], p.y - last[1]);
      const steps = Math.min(24, Math.floor(gap / 3));
      for (let i = 1; i <= steps; i++) {
        d.pts.push([last[0] + ((p.x - last[0]) * i) / steps, last[1] + ((p.y - last[1]) * i) / steps]);
      }
      d.pts.push([p.x, p.y]);
    } else {
      d.pts.push([p.x, p.y]);
    }
  }
}

function finishDraw() {
  const d = S.draft;
  S.draft = null;
  S.phase = 'ready';
  if (!d) return;

  if (d.type === 'rect' || d.type === 'ellipse') {
    delete d.ax;
    delete d.ay;
    if (d.w < 2 || d.h < 2) return;
  } else if (d.type === 'arrow') {
    if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 3) return;
  } else if (d.type === 'pen' || d.type === 'mosaic') {
    if (!d.pts.length) return;
  }
  pushOp(d);
}

// ---------------------------------------------------------------- keyboard

function onKeyDown(e) {
  const meta = e.metaKey || e.ctrlKey;

  if (e.key === 'Escape') {
    e.preventDefault();
    if (S.editor) { cancelEditor(); return; }
    if (S.phase === 'draw' && S.draft) { S.draft = null; S.phase = 'ready'; dirty(); return; }
    if (S.tool) { S.tool = null; syncToolbar(); dirty(); return; }
    if (S.sel) {
      S.sel = null;
      S.ops.length = 0;
      S.redo.length = 0;
      S.phase = 'idle';
      syncUndoButtons();
      host.release();
      dirty();
      return;
    }
    host.cancel();
    return;
  }

  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    runAction(e.shiftKey ? 'redo' : 'undo');
    return;
  }
  if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); runAction('copy'); return; }
  if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); runAction('save'); return; }
  if (meta && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    claim();
    S.sel = clampRect({ x: 0, y: 0, w: DIPW, h: DIPH });
    S.phase = 'ready';
    dirty();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (S.editor) commitEditor();
    runAction('copy');
    return;
  }

  if (!meta && (e.key === 'a' || e.key === 'A')) {
    S.autoDetect = !S.autoDetect;
    if (!S.autoDetect) S.hover = null;
    toast(S.autoDetect ? '智能识别：开' : '智能识别：关');
    dirty();
    return;
  }

  const step = e.shiftKey ? 10 : 1;
  const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (nudge) {
    e.preventDefault();
    if (!S.sel) return;
    S.sel = clampRect({ ...S.sel, x: S.sel.x + nudge[0], y: S.sel.y + nudge[1] });
    dirty();
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    S.autoDetect = !S.autoDetect;
    toast(S.autoDetect ? '智能识别：开（Tab / A 切换）' : '智能识别：关（Tab / A 切换）');
    dirty();
  }
}

// ---------------------------------------------------------------- export

function exportDataURL() {
  if (!S.sel || !IMG) return null;
  const canvas = Ops.compose({
    img: IMG,
    sel: S.sel,
    ops: S.ops,
    dipW: DIPW,
    dipH: DIPH,
    mosaicBase: MOSAIC,
  });
  return canvas.toDataURL('image/png');
}

async function doCopy() {
  const url = exportDataURL();
  if (!url) { toast('没有可复制的内容'); return false; }
  const res = await host.copy(url);
  if (!res || !res.ok) { toast('复制失败'); return false; }
  toast('已复制到剪贴板');
  return true;
}

async function doSave() {
  const url = exportDataURL();
  if (!url) { toast('没有可保存的内容'); return false; }
  const res = await host.save(url);
  if (!res || !res.ok) {
    if (res && res.canceled) return false;
    toast('保存失败');
    return false;
  }
  return true;
}

async function doPin() {
  const url = exportDataURL();
  if (!url) { toast('没有可贴图的内容'); return false; }
  const at = {
    x: ORIGIN.x + S.sel.x + S.sel.w / 2,
    y: ORIGIN.y + S.sel.y + S.sel.h / 2,
  };
  const res = await host.pin(url, at);
  return !!(res && res.ok);
}

// ---------------------------------------------------------------- rAF loop

function loop() {
  render();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- test hooks

window.__snap = {
  state() {
    return {
      phase: S.phase,
      sel: S.sel ? { x: S.sel.x, y: S.sel.y, w: S.sel.w, h: S.sel.h } : null,
      roundedSel: S.sel ? {
        x: Math.round(S.sel.x), y: Math.round(S.sel.y),
        w: Math.round(S.sel.w), h: Math.round(S.sel.h),
      } : null,
      ops: S.ops.map((o) => ({ type: o.type, color: o.color, size: o.pts ? o.pts.length : undefined })),
      opCount: S.ops.length,
      redoCount: S.redo.length,
      tool: S.tool,
      color: S.color,
      autoDetect: S.autoDetect,
      hover: S.hover ? { x: Math.round(S.hover.x), y: Math.round(S.hover.y), w: Math.round(S.hover.w), h: Math.round(S.hover.h) } : null,
      toolbarVisible: !el.toolbar.hidden,
      subVisible: !el.sub.hidden,
      toolbarRect: el.toolbar.hidden ? null : (() => {
        const r = el.toolbar.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })(),
      chip: el.chip.hidden ? null : el.chip.textContent,
      magnifierVisible: !el.mag.hidden,
      magnifierHex: el.maghex.textContent,
      magnifierPos: el.magpos.textContent,
      magnifierSize: el.magsize.hidden ? null : el.magsize.textContent,
      editorOpen: !!S.editor,
      editorLen: S.editor ? S.editor.el.value.length : 0,
      editorFocused: !!(S.editor && document.activeElement === S.editor.el),
      mouse: { x: Math.round(S.mouse.x), y: Math.round(S.mouse.y) },
      pointerIn: S.pointerIn,
      hoverCacheSize: hoverCache.size,
      dip: { w: DIPW, h: DIPH },
      dpr: DPR,
      imageSize: IMG ? { w: IMG.naturalWidth, h: IMG.naturalHeight } : null,
      demo: IS_DEMO,
      ax: AX_OK,
      locked: S.locked,
      exportSize: (() => {
        if (!S.sel || !IMG) return null;
        const k = IMG.naturalWidth / DIPW;
        return { w: Math.round(S.sel.w * k), h: Math.round(S.sel.h * k) };
      })(),
    };
  },
  /** centre point of a toolbar button, for synthetic clicks */
  hitTarget(selector) {
    const node = document.querySelector(selector);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  },
  setEditorText(text) {
    if (!S.editor) return false;
    S.editor.el.value = text;
    autosizeEditor(S.editor.el);
    dirty();
    return true;
  },
  commitEditor() { commitEditor(); return true; },

  /** pixel probes, in display-DIP coordinates (test diagnostics) */
  sampleBase(x, y) {
    if (!IMG) return null;
    const k = IMG.naturalWidth / DIPW;
    const s = sampleImagePixel(Math.floor(x * k), Math.floor(y * k));
    return s ? s.rgb : null;
  },
  sampleRendered(x, y) {
    const w = el.fx.width, h = el.fx.height;
    const px = clamp(Math.round(x * DPR), 0, w - 1);
    const py = clamp(Math.round(y * DPR), 0, h - 1);
    const d = ctx.getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  },
  sampleExport(x, y) {
    if (!S.sel || !IMG) return null;
    const canvas = Ops.compose({ img: IMG, sel: S.sel, ops: S.ops, dipW: DIPW, dipH: DIPH, mosaicBase: MOSAIC });
    const k = IMG.naturalWidth / DIPW;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const d = g.getImageData(
      clamp(Math.round((x - S.sel.x) * k), 0, canvas.width - 1),
      clamp(Math.round((y - S.sel.y) * k), 0, canvas.height - 1),
      1, 1
    ).data;
    return [d[0], d[1], d[2], d[3]];
  },

  /** How many pixels inside a DIP rect differ from the untouched frozen frame. */
  exportDiffCount(x, y, w, h) {
    if (!S.sel || !IMG) return null;
    const k = IMG.naturalWidth / DIPW;
    const canvas = Ops.compose({ img: IMG, sel: S.sel, ops: S.ops, dipW: DIPW, dipH: DIPH, mosaicBase: MOSAIC });
    const px = Math.round((x - S.sel.x) * k);
    const py = Math.round((y - S.sel.y) * k);
    const pw = Math.max(1, Math.round(w * k));
    const ph = Math.max(1, Math.round(h * k));
    if (px < 0 || py < 0 || px + pw > canvas.width || py + ph > canvas.height) {
      return { error: 'out of bounds' };
    }
    const ex = canvas.getContext('2d', { willReadFrequently: true }).getImageData(px, py, pw, ph).data;

    const b = document.createElement('canvas');
    b.width = pw;
    b.height = ph;
    const bg = b.getContext('2d', { willReadFrequently: true });
    bg.drawImage(IMG, x * k, y * k, w * k, h * k, 0, 0, pw, ph);
    const bs = bg.getImageData(0, 0, pw, ph).data;

    let n = 0;
    for (let i = 0; i < ex.length; i += 4) {
      if (Math.abs(ex[i] - bs[i]) + Math.abs(ex[i + 1] - bs[i + 1]) + Math.abs(ex[i + 2] - bs[i + 2]) > 12) n++;
    }
    return { changed: n, total: pw * ph };
  },
};

boot().catch((err) => {
  host.log('boot failed: ' + (err && err.stack ? err.stack : err));
});
requestAnimationFrame(loop);
