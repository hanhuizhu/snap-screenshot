/* Pinned-screenshot window (贴图): drag to move, wheel to zoom, ⌘wheel for opacity. */
'use strict';

const host = window.snapHost;
const img = document.getElementById('img');
const tools = document.getElementById('tools');

let dataURL = null;
let drag = null;

host.onPinInit((data) => {
  dataURL = data.dataURL;
  img.src = data.dataURL;
});

tools.querySelectorAll('button').forEach((b) => {
  b.innerHTML = window.svgIcon(
    { copy: 'copy', save: 'save', close: 'close' }[b.dataset.act],
    16
  );
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = b.dataset.act;
    if (act === 'copy') {
      host.pinCopy(dataURL);
      flash('已复制到剪贴板');
    } else if (act === 'save') {
      host.pinSave(dataURL);
    } else {
      host.pinClose();
    }
  });
});

// --- drag the window ourselves: an app-region drag would swallow mouse events
img.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  const start = await host.pinDragStart();
  if (!start) return;
  drag = { sx: e.screenX, sy: e.screenY, ox: start.x, oy: start.y };
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  host.pinDragTo(drag.ox + (e.screenX - drag.sx), drag.oy + (e.screenY - drag.sy));
});

window.addEventListener('mouseup', () => { drag = null; });
window.addEventListener('blur', () => { drag = null; });

img.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.metaKey) {
    host.pinOpacity(e.deltaY < 0 ? 0.06 : -0.06);
  } else {
    host.pinZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }
}, { passive: false });

img.addEventListener('dblclick', () => host.pinClose());

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  host.pinMenu(dataURL);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || (e.metaKey && e.key.toLowerCase() === 'w')) {
    e.preventDefault();
    host.pinClose();
  } else if (e.metaKey && e.key.toLowerCase() === 'c') {
    e.preventDefault();
    host.pinCopy(dataURL);
    flash('已复制到剪贴板');
  } else if (e.metaKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    host.pinSave(dataURL);
  }
});

// show the bottom hint briefly the first time the window appears
setTimeout(() => {
  document.body.classList.add('show-hint');
  setTimeout(() => document.body.classList.remove('show-hint'), 2600);
}, 300);

let flashTimer = null;
function flash(msg) {
  const hint = document.getElementById('hint');
  hint.textContent = msg;
  document.body.classList.add('show-hint');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => document.body.classList.remove('show-hint'), 1200);
}
