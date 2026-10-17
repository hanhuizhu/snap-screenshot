/* End-to-end self-test.
 *
 * Drives the real overlay with synthetic input events (webContents.sendInputEvent)
 * in demo mode — a synthetic "desktop" instead of a screen capture — so the whole
 * pipeline (smart detect → selection → adjust → 6 tools → undo → colour → copy →
 * save → pin → cancel) runs without OS permissions.
 *
 * Assertions are content-based: the exported/flattened image is sampled and each
 * tool has to provably change pixels in its own region. Screenshots of every stage
 * are written to build/test-out/.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { nativeImage, app } = require('electron');
const clip = require('./clipboard-image');

const OUT = process.env.SNAP_TEST_OUT || path.join(__dirname, '..', 'build', 'test-out');
const SAVE_PATH = process.env.SNAP_TEST_SAVE || path.join(OUT, 'saved.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(ctx) {
  const results = [];
  const record = (step, ok, detail) => {
    results.push({ step, ok, detail });
    if (!ok) process.exitCode = 1;
    console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? '  → ' + detail : ''}`);
  };
  const check = (step, cond, detail) => record(step, !!cond, detail);

  let fatal = null;
  main(ctx, record, check)
    .catch((err) => {
      fatal = err;
      record('selftest crashed', false, err && err.stack ? err.stack : String(err));
    })
    .finally(async () => {
      try {
        await finish(ctx, results, fatal);
      } catch (err) {
        console.error('[selftest] teardown failed', err);
        process.exit(1);
      }
    });
}

// --------------------------------------------------------------------- helpers

function mk(win) {
  const wc = win.webContents;
  return {
    state: () => wc.executeJavaScript('window.__snap.state()'),
    hit: (sel) => wc.executeJavaScript(`window.__snap.hitTarget(${JSON.stringify(sel)})`),
    js: (code) => wc.executeJavaScript(code),
    move: (x, y) => wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }),
    down: (x, y) => wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }),
    up: (x, y) => wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }),
    key: (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    },
  };
}

async function drag(d, x1, y1, x2, y2, steps = 10) {
  d.move(x1, y1);
  await sleep(15);
  d.down(x1, y1);
  await sleep(15);
  for (let i = 1; i <= steps; i++) {
    d.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
    await sleep(14);
  }
  d.up(x2, y2);
  await sleep(80);
}

async function click(d, x, y) {
  d.move(x, y);
  await sleep(20);
  d.down(x, y);
  await sleep(25);
  d.up(x, y);
  await sleep(90);
}

async function shoot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
}

async function overlayOf(ctx) {
  const s = ctx.session();
  if (!s) return null;
  return s.displays[0].win;
}

/** Open a capture and wait until the overlay is interactive. */
async function openCapture(ctx, record) {
  await ctx.startCapture();
  const win = await overlayOf(ctx);
  if (!win) return null;
  for (let i = 0; i < 120; i++) {
    try {
      const ready = await win.webContents.executeJavaScript(
        '!!window.__snap && !!window.__snap.state().imageSize'
      );
      if (ready) {
        await sleep(240);
        return win;
      }
    } catch {}
    await sleep(50);
  }
  record('overlay ready', false, 'timed out waiting for renderer');
  return win;
}

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const nearRect = (r, e, tol = 2) =>
  !!r && near(r.x, e.x, tol) && near(r.y, e.y, tol) && near(r.w, e.w, tol) && near(r.h, e.h, tol);
const sameRGB = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** RGB of an image pixel (NativeImage stores BGRA). */
function pixelAt(img, x, y) {
  const size = img.getSize();
  if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
  const bmp = img.toBitmap();
  const i = (y * size.width + x) * 4;
  return [bmp[i + 2], bmp[i + 1], bmp[i]];
}

/**
 * The overlay covers the whole screen, so the *physical* pointer can inject real
 * mouse events between a synthetic action and its assertion. Retry the action a
 * few times instead of failing on that interference.
 * @param {() => Promise<void>} action
 * @param {() => Promise<{ok: boolean, detail: string}>} verify
 */
async function attempt(check, name, action, verify, tries = 3) {
  let last = { ok: false, detail: 'not attempted' };
  for (let i = 0; i < tries; i++) {
    await action();
    last = await verify();
    if (last.ok) {
      check(name, true, `${last.detail}${i ? ` [attempt ${i + 1}]` : ''}`);
      return true;
    }
    if (i < tries - 1) await sleep(160);
  }
  check(name, false, `${last.detail} (gave up after ${tries} attempts)`);
  return false;
}

// --------------------------------------------------------------------- script

async function main(ctx, record, check) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.dirname(SAVE_PATH), { recursive: true });

  const savedText = await clip.readText();
  const savedImage = await clip.readImage();
  global.__clipboardBackup = { savedText, savedImage };

  // ---- 1. boot + frozen frame -------------------------------------------
  const win = await openCapture(ctx, record);
  if (!win) return;
  const d = mk(win);

  let st = await d.state();
  check('boot: frozen frame loaded', st.demo && st.imageSize && st.imageSize.w > 0,
    `image=${st.imageSize && st.imageSize.w}x${st.imageSize && st.imageSize.h} dip=${st.dip.w}x${st.dip.h} dpr=${st.dpr}`);
  check('boot: no selection yet', st.sel === null && st.toolbarVisible === false);
  check('boot: magnifier live at the cursor', st.magnifierVisible === true && st.pointerIn === true,
    `mag=${st.magnifierVisible} in=${st.pointerIn} mouse=${st.mouse.x},${st.mouse.y}`);

  // ---- 2. smart detect (window + element level) --------------------------
  await attempt(check, 'smart detect: window level', () => d.move(520, 440), async () => {
    await sleep(280);
    const s = await d.state();
    return {
      ok: !!s.hover && s.hover.w >= 600,
      detail: `hover=${JSON.stringify(s.hover)} mouse=${s.mouse.x},${s.mouse.y}`,
    };
  });

  await attempt(check, 'smart detect: element level (button, not window)',
    () => d.move(236, 167), async () => {
      await sleep(300);
      const s = await d.state();
      return { ok: nearRect(s.hover, { x: 170, y: 150, w: 132, h: 34 }, 3), detail: JSON.stringify(s.hover) };
    });
  await shoot(win, '01-smart-detect');

  // ---- 3. click to select the detected element ---------------------------
  await attempt(check, 'select: click picks the detected element',
    async () => { await d.move(236, 167); await sleep(200); await click(d, 236, 167); },
    async () => {
      const s = await d.state();
      return {
        ok: nearRect(s.roundedSel, { x: 170, y: 150, w: 132, h: 34 }, 3) && s.toolbarVisible,
        detail: JSON.stringify(s.roundedSel),
      };
    });
  st = await d.state();
  check('select: size chip shown', st.chip === '132 × 34', String(st.chip));
  await shoot(win, '02-selection-toolbar');

  // ---- 4. drag a handle to resize --------------------------------------
  await attempt(check, 'adjust: SE handle resize', () => drag(d, 302, 184, 402, 284, 8), async () => {
    const s = await d.state();
    return { ok: nearRect(s.roundedSel, { x: 170, y: 150, w: 232, h: 134 }, 3), detail: JSON.stringify(s.roundedSel) };
  });

  // ---- 5. move the selection from the inside ---------------------------
  await attempt(check, 'adjust: drag inside moves the selection',
    () => drag(d, 250, 220, 270, 240, 6), async () => {
      const s = await d.state();
      return { ok: nearRect(s.roundedSel, { x: 190, y: 170, w: 232, h: 134 }, 3), detail: JSON.stringify(s.roundedSel) };
    });

  // ---- 6. arrow-key nudge ---------------------------------------------
  await attempt(check, 'adjust: arrow nudge 1px', async () => {
    d.key('Right'); d.key('Right'); d.key('Right');
    await sleep(110);
  }, async () => {
    const s = await d.state();
    return { ok: near(s.roundedSel && s.roundedSel.x, 193, 1), detail: `x=${s.roundedSel && s.roundedSel.x}` };
  });

  // ---- 7. keyboard: ⌘A then Esc ----------------------------------------
  d.key('a', ['meta']);
  await sleep(160);
  st = await d.state();
  check('keys: ⌘A selects the full display',
    nearRect(st.roundedSel, { x: 0, y: 0, w: st.dip.w, h: st.dip.h }, 2),
    JSON.stringify(st.roundedSel));

  d.key('Escape');
  await sleep(160);
  st = await d.state();
  check('keys: Esc clears the selection but keeps the overlay',
    st.sel === null && ctx.session() !== null);

  // ---- 8. freehand selection over high-frequency content ----------------
  await attempt(check, 'select: freehand drag region', () => drag(d, 60, 560, 1360, 860, 8),
    async () => {
      const s = await d.state();
      return {
        ok: nearRect(s.roundedSel, { x: 60, y: 560, w: 1300, h: 300 }, 4),
        detail: JSON.stringify(s.roundedSel),
      };
    });
  st = await d.state();

  // ---- 9. the five drag-to-draw tools, verified against exported pixels --
  const regions = {
    rect: [300, 590, 520, 670],
    ellipse: [560, 590, 780, 670],
    arrow: [300, 700, 520, 780],
    pen: [560, 700, 800, 790],
    mosaic: [80, 610, 220, 735],
  };
  const minChanged = { rect: 1500, ellipse: 1500, arrow: 1200, pen: 1200, mosaic: 4000 };

  let expected = 0;
  for (const tool of ['rect', 'ellipse', 'arrow', 'pen', 'mosaic']) {
    const btn = await d.hit(`[data-tool="${tool}"]`);
    check(`toolbar: ${tool} button reachable`, !!btn && btn.x > 0, JSON.stringify(btn));
    if (!btn || !btn.x) continue;

    const [x1, y1, x2, y2] = regions[tool];
    await attempt(check, `tool: ${tool} draws and paints pixels`, async () => {
      const before = await d.state();
      if (before.tool !== tool) await click(d, btn.x, btn.y);   // click again would toggle it off
      await drag(d, x1, y1, x2, y2, 12);
    }, async () => {
      const s = await d.state();
      const diff = await d.js(`window.__snap.exportDiffCount(${x1}, ${y1}, ${x2 - x1}, ${y2 - y1})`);
      expected = s.opCount;
      return {
        ok: s.tool === tool && s.subVisible && diff && diff.changed > minChanged[tool],
        detail: `tool=${s.tool} ops=${s.opCount} changed=${diff && diff.changed}/${diff && diff.total}`,
      };
    });
    for (let i = 0; i < 2; i++) await sleep(60);
    if (['arrow', 'pen', 'mosaic'].includes(tool)) await shoot(win, `03-tool-${tool}`);
  }

  // ---- 10. mosaic really pixelates (block grid) -------------------------
  const b1 = await d.js('window.__snap.sampleBase(152, 672)');
  const b2 = await d.js('window.__snap.sampleBase(158, 678)');
  const r1 = await d.js('window.__snap.sampleRendered(152, 672)');
  const r2 = await d.js('window.__snap.sampleRendered(158, 678)');
  const e1 = await d.js('window.__snap.sampleExport(152, 672)');
  const e2 = await d.js('window.__snap.sampleExport(158, 678)');
  check('mosaic: two source pixels inside one block differ (content really is high-frequency)',
    !sameRGB(b1, b2), `${b1} vs ${b2}`);
  check('mosaic: both pixels render as the same block colour',
    sameRGB(r1, r2) && sameRGB(e1, e2), `rendered ${r1} / ${r2} · export ${e1} / ${e2}`);
  check('mosaic: block colour differs from the sharp source pixel',
    !sameRGB(e1, b1), `export=${e1} base=${b1}`);
  // the exported file must match what the overlay showed (not just be "some colour")
  check('mosaic: exported block colour matches the on-screen block colour',
    sameRGB(e1, r1), `export=${e1} rendered=${r1}`);
  const eNeighbour = await d.js('window.__snap.sampleExport(152, 686)');
  check('mosaic: the next block row is a different colour',
    !sameRGB(e1, eNeighbour), `${e1} vs ${eNeighbour}`);

  // ---- 11. text tool ----------------------------------------------------
  const tbtn = await d.hit('[data-tool="text"]');
  await click(d, tbtn.x, tbtn.y);
  st = await d.state();
  check('tool: text tool active', st.tool === 'text', `tool=${st.tool}`);

  await click(d, 900, 600);
  st = await d.state();
  check('tool: text editor opens on click', st.editorOpen === true && st.editorFocused === true,
    `open=${st.editorOpen} focused=${st.editorFocused}`);

  const typed = '微信同款截图 Snap 12.5pt';
  await Promise.race([win.webContents.insertText(typed), sleep(1500)]);
  await sleep(200);
  st = await d.state();
  if (st.editorLen !== typed.length) {
    await d.js(`window.__snap.setEditorText(${JSON.stringify(typed)})`);
    await sleep(120);
    const st2 = await d.state();
    check('tool: text lands in the editor (fallback path)', st2.editorLen === typed.length,
      `len=${st2.editorLen}`);
  } else {
    check('tool: text lands in the editor (IME path)', true, `len=${st.editorLen}`);
  }
  await shoot(win, '04-text-editing');

  d.key('Enter');
  await sleep(220);
  st = await d.state();
  const tdiff = await d.js('window.__snap.exportDiffCount(895, 595, 260, 40)');
  check('tool: text committed and rendered',
    st.editorOpen === false && st.opCount === expected + 1 && tdiff && tdiff.changed > 80,
    `ops=${st.opCount} editor=${st.editorOpen} changed=${tdiff && tdiff.changed}`);
  expected = st.opCount;

  // ---- 12. colour + stroke width ---------------------------------------
  check('style: sub-toolbar visible for the active tool', st.subVisible === true);
  const cyan = await d.hit('.swatch[data-color="#1677FF"]');
  check('style: colour swatch reachable', !!cyan && cyan.x > 0, JSON.stringify(cyan));
  await click(d, cyan.x, cyan.y);
  st = await d.state();
  check('style: colour switch', st.color.toUpperCase() === '#1677FF', st.color);

  const thick = await d.hit('.wbtn[data-width="11"]');
  await click(d, thick.x, thick.y);

  const rbtn = await d.hit('[data-tool="rect"]');
  await click(d, rbtn.x, rbtn.y);
  await drag(d, 900, 700, 1100, 800, 10);
  expected += 1;
  st = await d.state();
  const blue = await d.js('window.__snap.sampleExport(1000, 700)');
  check('style: new rect uses the picked colour',
    blue && blue[2] > 170 && blue[0] < 130 && st.opCount === expected,
    `export pixel=${blue} ops=${st.opCount}`);
  await shoot(win, '05-annotated-full');

  // ---- 13. undo / redo -------------------------------------------------
  d.key('z', ['meta']);
  await sleep(150);
  st = await d.state();
  check('undo: ⌘Z removes the last op', st.opCount === expected - 1 && st.redoCount === 1,
    `ops=${st.opCount} redo=${st.redoCount}`);

  d.key('z', ['meta', 'shift']);
  await sleep(150);
  st = await d.state();
  check('redo: ⇧⌘Z restores it', st.opCount === expected && st.redoCount === 0,
    `ops=${st.opCount}`);

  const redStroke = await d.js('window.__snap.sampleExport(400, 590)');
  const redBase = await d.js('window.__snap.sampleBase(400, 590)');
  check('annotations survive undo/redo in the export', !sameRGB(redStroke, redBase),
    `export=${redStroke} base=${redBase}`);

  // ---- 14. copy to clipboard -------------------------------------------
  const wanted = st.exportSize;
  const cbtn = await d.hit('[data-act="copy"]');
  await click(d, cbtn.x, cbtn.y);
  await sleep(700);
  const clipImg = await clip.readImage();
  const csize = clipImg ? clipImg.getSize() : { width: 0, height: 0 };
  check('copy: clipboard holds the selection at native resolution',
    csize.width === wanted.w && csize.height === wanted.h,
    `clipboard=${csize.width}x${csize.height} expected=${wanted.w}x${wanted.h}`);
  check('copy: overlay closed after copying', ctx.session() === null);
  if (csize.width) fs.writeFileSync(path.join(OUT, '07-clipboard-copy.png'), clipImg.toPNG());

  // ---- 15. save to file (⌘S) -------------------------------------------
  const win2 = await openCapture(ctx, record);
  if (win2) {
    const d2 = mk(win2);
    // start well outside any detected window so the drag is a free selection
    await drag(d2, 60, 560, 1360, 860, 8);
    await sleep(150);
    const s2a = await d2.state();
    check('save: region selected for the save test',
      nearRect(s2a.roundedSel, { x: 60, y: 560, w: 1300, h: 300 }, 4), JSON.stringify(s2a.roundedSel));

    // draw something so the written file has verifiable content
    const rb = await d2.hit('[data-tool="rect"]');
    await click(d2, rb.x, rb.y);
    await drag(d2, 150, 620, 350, 720, 8);
    await sleep(120);

    const s2 = await d2.state();
    const want2 = s2.exportSize;
    d2.key('s', ['meta']);
    await sleep(1200);
    const exists = fs.existsSync(SAVE_PATH);
    const saved = exists ? nativeImage.createFromPath(SAVE_PATH) : null;
    const sz = saved ? saved.getSize() : null;
    check('save: ⌘S writes a PNG at native resolution',
      exists && sz && sz.width === want2.w && sz.height === want2.h,
      `${exists ? `${sz.width}x${sz.height}` : 'missing'} expected=${want2.w}x${want2.h} → ${SAVE_PATH}`);

    const stroke = saved ? pixelAt(saved, (150 - 60) * 2, (620 - 560) * 2) : null;
    check('save: the written file contains the annotations',
      stroke && stroke[0] > 200 && stroke[1] < 140, `pixel on the rect stroke=${stroke}`);
    check('save: overlay closed after saving', ctx.session() === null);
  }

  // ---- 16. pin to screen ------------------------------------------------
  const win3 = await openCapture(ctx, record);
  if (win3) {
    const d3 = mk(win3);
    // outside any detected window, so the pin captures exactly 400x260
    await drag(d3, 60, 560, 460, 820, 8);
    await sleep(180);
    const pb = await d3.hit('[data-act="pin"]');
    await click(d3, pb.x, pb.y);
    await sleep(800);
    check('pin: pinned window created', ctx.pinCount() === 1, `pins=${ctx.pinCount()}`);
    check('pin: overlay closed after pinning', ctx.session() === null);
    if (ctx.pinCount() > 0) {
      const pinWin = ctx.pinWindows()[0];
      const bounds = pinWin.getBounds();
      check('pin: window matches the selection size', bounds.width === 400 && bounds.height === 260,
        `${bounds.width}x${bounds.height}`);
      await sleep(320);
      fs.writeFileSync(path.join(OUT, '08-pin.png'), (await pinWin.webContents.capturePage()).toPNG());
      pinWin.close();
      await sleep(250);
    }
  }

  // ---- 17. escape cancels, smart-detect toggle --------------------------
  const win4 = await openCapture(ctx, record);
  if (win4) {
    const d4 = mk(win4);
    d4.key('a');
    await sleep(150);
    let s4 = await d4.state();
    check('keys: A toggles smart detect off', s4.autoDetect === false);
    d4.key('a');
    await sleep(150);
    s4 = await d4.state();
    check('keys: A toggles smart detect on', s4.autoDetect === true);

    await drag(d4, 60, 560, 900, 780, 6);
    await sleep(150);
    s4 = await d4.state();
    check('cancel: selection exists before Esc', !!s4.sel);
    d4.key('Escape');
    await sleep(250);
    s4 = await d4.state();
    check('cancel: first Esc clears the selection', s4.sel === null && ctx.session() !== null);
    d4.key('Escape');
    await sleep(300);
    check('cancel: second Esc closes the overlay', ctx.session() === null);
  }

  record('screenshots written', true, OUT);
}

async function finish(ctx, results, fatal) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  const backup = global.__clipboardBackup;
  if (backup) {
    try {
      if (backup.savedImage) await clip.writeImage(backup.savedImage);
      else if (backup.savedText) await clip.writeText(backup.savedText);
    } catch {}
  }

  try { ctx.endSession(); } catch {}
  for (const w of ctx.pinWindows()) {
    try { w.close(); } catch {}
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'report.json'),
    JSON.stringify({ passed, failed, fatal: fatal ? String(fatal) : null, results }, null, 2)
  );
  console.log(`\n[selftest] ${passed} passed, ${failed} failed  →  ${OUT}`);
  setTimeout(() => app.exit(failed ? 1 : 0), 300);
}

module.exports = { run };
