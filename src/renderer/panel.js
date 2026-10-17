/* Snap 控制台：页签切换 + 「截图 · 设置 · 说明」页。
 * 侧边栏页签支持拖动排序（顺序记在 localStorage）。
 * API 调试台由 apidebug.js 在第一次切到该页签时挂载。 */
'use strict';

const host = window.snapHost;
const $ = (id) => document.getElementById(id);
const TAB_KEY = 'snap.console.tab';
const ORDER_KEY = 'snap.console.navOrder';

function prettyHotkey(accel) {
  return String(accel || 'Control+Command+A')
    .replace(/CommandOrControl|Command|Cmd/gi, '⌘')
    .replace(/Control|Ctrl/gi, '⌃')
    .replace(/Alt|Option/gi, '⌥')
    .replace(/Shift/gi, '⇧')
    .split('+')
    .join(' ');
}

const VIEWS = ['cal', 'drafts', 'api', 'help'];
const mounted = { cal: false, drafts: false, api: false };

/* ---- 侧边栏自定义排序 ---- */

const nav = $('tabs');

function navButtons() {
  return [...nav.querySelectorAll('button[data-view]')];
}

function applyNavOrder() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); } catch { /* ignore */ }
  if (!Array.isArray(saved)) return;
  const byView = new Map(navButtons().map((b) => [b.dataset.view, b]));
  for (const view of saved) {
    const btn = byView.get(view);
    if (btn) {
      nav.appendChild(btn);
      byView.delete(view);
    }
  }
  // 旧顺序里没有的页签（如新版本新增）保持默认相对顺序补在末尾
  for (const btn of byView.values()) nav.appendChild(btn);
}

function saveNavOrder() {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(navButtons().map((b) => b.dataset.view)));
  } catch { /* private mode */ }
}

let suppressClickUntil = 0;

nav.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;

  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  // 指针捕获：快速拖到窗口外再松手也能收到 pointerup，不会留下挂着的监听
  try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }

  const onMove = (ev) => {
    if (!dragging) {
      // 手抖几像素不算拖动，避免误伤普通点击
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragging = true;
      btn.classList.add('dragging');
    }
    ev.preventDefault();
    const next = navButtons()
      .filter((b) => b !== btn)
      .find((b) => ev.clientY < b.getBoundingClientRect().top + b.offsetHeight / 2);
    if (next) nav.insertBefore(btn, next);
    else nav.appendChild(btn);
  };

  const finish = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    if (!dragging) return;
    btn.classList.remove('dragging');
    saveNavOrder();
    // 拖动结束后浏览器还会补一个 click，别让它触发页签切换
    suppressClickUntil = Date.now() + 250;
  };

  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
});

// 捕获阶段拦掉拖动末尾补发的 click
nav.addEventListener('click', (e) => {
  if (Date.now() >= suppressClickUntil) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// 键盘可达：页签获得焦点后 Alt+↑/↓ 移动
nav.addEventListener('keydown', (e) => {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  const sib = e.key === 'ArrowUp' ? btn.previousElementSibling : btn.nextElementSibling;
  if (!sib) return;
  e.preventDefault();
  if (e.key === 'ArrowUp') nav.insertBefore(btn, sib);
  else nav.insertBefore(sib, btn);
  saveNavOrder();
  btn.focus();
});

function showView(name) {
  if (!VIEWS.includes(name)) name = VIEWS[0];
  for (const b of document.querySelectorAll('#tabs button')) {
    b.classList.toggle('on', b.dataset.view === name);
  }
  for (const v of VIEWS) {
    const section = $(`view-${v}`);
    if (section) section.classList.toggle('on', v === name);
  }
  // 组件按需挂载：没进过的页签不构建 DOM
  if (name === 'cal' && !mounted.cal) {
    mounted.cal = true;
    // 挂在 window 上供自检/调试驱动（overlay 的 window.__snap 同款约定）
    window.__cal = window.SnapCalendar.mount($('cal-root'), host);
  }
  if (name === 'drafts' && !mounted.drafts) {
    mounted.drafts = true;
    window.__drafts = window.SnapDrafts.mount($('drafts-root'), host);
  }
  if (name === 'api' && !mounted.api) {
    mounted.api = true;
    window.SnapApiDebug.mount($('api-root'), host);
  }
  try { localStorage.setItem(TAB_KEY, name); } catch { /* private mode */ }
}

for (const btn of document.querySelectorAll('#tabs button')) {
  btn.addEventListener('click', () => showView(btn.dataset.view));
}

function renderPermissions(data) {
  const screenOk = data.screenStatus === 'granted';
  $('dot-screen').className = 'dot ' + (screenOk ? 'ok' : 'bad');
  $('status-screen').textContent = screenOk
    ? '已授权'
    : data.screenStatus === 'denied' ? '未授权（已被拒绝，请在系统设置里打开开关）'
      : '未授权';
  $('btn-screen').disabled = screenOk;

  $('dot-ax').className = 'dot ' + (data.axTrusted ? 'ok' : 'bad');
  $('status-ax').textContent = data.axTrusted
    ? '已授权，智能识别可精确到控件'
    : '未授权，智能识别仅到窗口级';
  $('btn-ax').disabled = !!data.axTrusted;

  if (!screenOk && (data.reason === 'permission' || data.reason === 'first-run')) {
    $('perm-note').innerHTML =
      '<b>首次使用：</b>请先在「系统设置 → 隐私与安全性 → 屏幕录制」里勾选 Snap，' +
      '然后重新启动本应用。授权前只能拍到桌面壁纸。';
  }
}

function renderSettings(s) {
  if (!s || s.ok === false) return;

  if (s.hotkey) {
    $('hotkey').textContent = prettyHotkey(s.hotkey);
  }

  $('chk-awake').checked = !!s.keepAwake;
  $('pill-awake').textContent = s.keepAwake ? '已开启' : '关闭';
  $('pill-awake').className = 'pill' + (s.keepAwake ? ' on' : '');

  const login = $('chk-login');
  login.checked = !!s.openAtLogin;
  login.disabled = !s.loginAvailable;

  const note = $('login-note');
  const btnItems = $('btn-login-items');
  if (!s.loginAvailable) {
    note.textContent = '打包成 .app 后可用（当前是开发模式运行）';
    btnItems.hidden = true;
  } else if (s.loginStatus === 'requires-approval') {
    note.textContent = '已加入登录项，但需要你在「系统设置 → 通用 → 登录项」中允许';
    btnItems.hidden = false;
  } else {
    note.textContent = s.openAtLogin
      ? '已开启：登录 macOS 后自动在后台运行'
      : '登录 macOS 后自动在后台运行，随时按快捷键截图';
    btnItems.hidden = true;
  }
}

host.onHelpInit((data) => {
  renderPermissions(data);
  renderSettings(data.settings);
});

$('chk-awake').addEventListener('change', async (e) => {
  renderSettings(await host.setSetting('keepAwake', e.target.checked));
});

$('chk-login').addEventListener('change', async (e) => {
  renderSettings(await host.setSetting('openAtLogin', e.target.checked));
});

$('btn-login-items').addEventListener('click', () => host.openLoginItems());
$('btn-screen').addEventListener('click', () => host.openPermission('screen'));
$('btn-ax').addEventListener('click', () => host.openPermission('ax'));

// help-init 只在窗口首次加载时推一次；重载窗口时用它兜底。
host.getSettings().then(renderSettings);
host.axTrusted().then((ok) => {
  if ($('status-ax').textContent !== '检查中…') return;
  $('dot-ax').className = 'dot ' + (ok ? 'ok' : 'bad');
  $('status-ax').textContent = ok ? '已授权，智能识别可精确到控件' : '未授权，智能识别仅到窗口级';
  $('btn-ax').disabled = !!ok;
});

// 默认停在日历；上次停在别的页签才切过去。这里必须走一次 showView，
// 否则默认页签的组件不会被挂载。
applyNavOrder();
let initial = VIEWS[0];
try { initial = localStorage.getItem(TAB_KEY) || VIEWS[0]; } catch { /* ignore */ }
showView(initial);
