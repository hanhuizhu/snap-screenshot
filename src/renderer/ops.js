/* Annotation model + rendering.
 *
 * Ops are stored in *display-DIP* coordinates, so the very same list renders
 * into the on-screen canvas (scaled by devicePixelRatio) and into the exported
 * PNG (scaled by image-pixels-per-DIP). No resolution-specific maths anywhere.
 *
 * op shapes:
 *   { type:'rect'|'ellipse', x, y, w, h, color, width }
 *   { type:'arrow', x1, y1, x2, y2, color, width }
 *   { type:'pen', pts:[[x,y],…], color, width }
 *   { type:'mosaic', pts:[[x,y],…], size }
 *   { type:'text', x, y, text, color, size }
 */
window.Ops = (function () {
  const FONT_STACK = 'system-ui, -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif';
  const TEXT_LINE_HEIGHT = 1.35;

  let measureCtx = null;
  function measurer() {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    return measureCtx;
  }

  /** Bounding box of a multi-line text op, in DIP. */
  function textBox(op) {
    const ctx = measurer();
    ctx.font = `${op.size}px ${FONT_STACK}`;
    const lines = String(op.text).split('\n');
    let w = 0;
    for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
    return { w, h: lines.length * op.size * TEXT_LINE_HEIGHT };
  }

  function textHit(op, x, y, pad = 4) {
    const box = textBox(op);
    return x >= op.x - pad && x <= op.x + box.w + pad &&
           y >= op.y - pad && y <= op.y + box.h + pad;
  }

  // -------------------------------------------------------------- drawing bits

  /** Smooth polyline through the given points (quadratic midpoint smoothing). */
  function polyPath(ctx, pts) {
    if (!pts.length) return false;
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) return true;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
    return true;
  }

  /** Union of circles around every point — the mosaic brush footprint. */
  function brushPath(ctx, pts, r) {
    for (const [x, y] of pts) {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  function drawArrow(ctx, op) {
    const { x1, y1, x2, y2, color, width } = op;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.5) return;
    const head = Math.min(Math.max(13, width * 4.4), Math.max(6, len * 0.55));
    const spread = Math.PI / 7.2;
    const baseX = x2 - Math.cos(angle) * head * 0.82;
    const baseY = y2 - Math.sin(angle) * head * 0.82;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(baseX, baseY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(angle - spread) * head, y2 - Math.sin(angle - spread) * head);
    ctx.lineTo(x2 - Math.cos(angle + spread) * head, y2 - Math.sin(angle + spread) * head);
    ctx.closePath();
    ctx.fill();
  }

  function drawText(ctx, op) {
    ctx.fillStyle = op.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `${op.size}px ${FONT_STACK}`;
    const lines = String(op.text).split('\n');
    const step = op.size * TEXT_LINE_HEIGHT;
    lines.forEach((line, i) => ctx.fillText(line, op.x, op.y + i * step));
  }

  function mosaicBounds(op, r) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of op.pts) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return { x: x0 - r, y: y0 - r, w: (x1 - x0) + r * 2, h: (y1 - y0) + r * 2 };
  }

  /**
   * @param env {{mosaicBase: HTMLCanvasElement|null, dipW:number, dipH:number}}
   */
  function drawOp(ctx, op, env) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    switch (op.type) {
      case 'rect':
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.strokeRect(op.x, op.y, op.w, op.h);
        break;

      case 'ellipse': {
        const rx = Math.abs(op.w) / 2;
        const ry = Math.abs(op.h) / 2;
        if (rx < 0.5 || ry < 0.5) break;
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.beginPath();
        ctx.ellipse(op.x + op.w / 2, op.y + op.h / 2, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'arrow':
        drawArrow(ctx, op);
        break;

      case 'pen': {
        if (!op.pts.length) break;
        ctx.strokeStyle = op.color;
        ctx.fillStyle = op.color;
        ctx.lineWidth = op.width;
        if (op.pts.length === 1) {
          ctx.beginPath();
          ctx.arc(op.pts[0][0], op.pts[0][1], op.width / 2, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        ctx.beginPath();
        polyPath(ctx, op.pts);
        ctx.stroke();
        break;
      }

      case 'mosaic': {
        const base = env && env.mosaicBase;
        if (!base || !op.pts.length) break;
        const r = op.size / 2;
        ctx.beginPath();
        brushPath(ctx, op.pts, r);
        ctx.clip();

        // Map only the brush bbox, 1:1 in source pixels, to keep the block grid
        // aligned to the screen and the blit cheap.
        const b = mosaicBounds(op, r);
        const kx = base.width / env.dipW;
        const ky = base.height / env.dipH;
        ctx.drawImage(
          base,
          b.x * kx, b.y * ky, b.w * kx, b.h * ky,
          b.x, b.y, b.w, b.h
        );
        break;
      }

      case 'text':
        drawText(ctx, op);
        break;
    }

    ctx.restore();
  }

  // -------------------------------------------------------------- composition

  /** Pixelated copy of the frozen frame, blocks ≈ blockDip DIP wide. */
  function buildMosaicBase(img, dipW, blockDip) {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (!W || !H) return null;
    const k = W / dipW;                       // image px per DIP
    const G = Math.max(3, Math.round(blockDip * k));
    const sw = Math.ceil(W / G);
    const sh = Math.ceil(H / G);

    const small = document.createElement('canvas');
    small.width = sw;
    small.height = sh;
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(img, 0, 0, sw, sh);

    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.drawImage(small, 0, 0, sw, sh, 0, 0, sw * G, sh * G);
    return out;
  }

  /**
   * Flatten base frame + annotations into a canvas at native capture resolution.
   * @returns {HTMLCanvasElement}
   */
  function compose({ img, sel, ops, dipW, dipH, mosaicBase }) {
    const k = img.naturalWidth / dipW;
    // The frozen frame has the display's aspect ratio, so the height in DIP is
    // implied when the caller does not pass it. Mosaic geometry depends on it.
    const h = dipH || (dipW * img.naturalHeight) / img.naturalWidth;
    const W = Math.max(1, Math.round(sel.w * k));
    const H = Math.max(1, Math.round(sel.h * k));
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sel.x * k, sel.y * k, sel.w * k, sel.h * k, 0, 0, W, H);
    ctx.save();
    ctx.setTransform(k, 0, 0, k, -sel.x * k, -sel.y * k);
    const env = { mosaicBase, dipW, dipH: h };
    for (const op of ops) drawOp(ctx, op, env);
    ctx.restore();
    return out;
  }

  return {
    FONT_STACK,
    TEXT_LINE_HEIGHT,
    drawOp,
    polyPath,
    brushPath,
    textBox,
    textHit,
    buildMosaicBase,
    compose,
  };
})();
