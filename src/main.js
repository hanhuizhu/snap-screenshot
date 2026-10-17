'use strict';

const {
  app, BrowserWindow, globalShortcut, desktopCapturer, screen, ipcMain,
  clipboard, nativeImage, dialog, shell, systemPreferences, Tray, Menu, Notification,
  powerSaveBlocker,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const HelperClient = require('./helper-client');
const clip = require('./clipboard-image');
const settings = require('./settings');

const ROOT = path.join(__dirname, '..');
const DEFAULT_HOTKEY = 'Control+Command+A';
let HOTKEY = process.env.SNAP_HOTKEY || DEFAULT_HOTKEY;
const TEST = process.env.SNAP_SELFTEST === '1';
const DEMO = process.env.SNAP_DEMO === '1' || TEST;
const TEST_SAVE_PATH = process.env.SNAP_TEST_SAVE || null;
const PRELOAD = path.join(__dirname, 'preload.js');

/** @type {{displays: Array<{win:BrowserWindow, display:any, init:any}>, owner:number|null}|null} */
let session = null;
let helper = null;
let tray = null;
let helpWin = null;
let helpShownThisLaunch = false;
const pinWindows = new Set();
let apiWin = null;

// ---------------------------------------------------------------- api debugger window

function showApiWindow() {
  if (apiWin && !apiWin.isDestroyed()) {
    apiWin.show();
    apiWin.focus();
    return apiWin;
  }
  apiWin = new BrowserWindow({
    width: 1180,
    height: 820,
    title: 'Snap · API 调试台',
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  apiWin.loadFile(path.join(__dirname, 'renderer', 'api.html'));
  apiWin.once('ready-to-show', () => apiWin.show());
  apiWin.on('closed', () => { apiWin = null; });
  return apiWin;
}

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function log(...args) {
  if (TEST || process.env.SNAP_DEBUG) console.log('[snap]', ...args);
}

// ------------------------------------------------------ native helper (AX / windows)

function startHelper() {
  if (DEMO) return null;
  const bin = path.join(ROOT, 'build', 'winsnap');
  if (!fs.existsSync(bin)) {
    log('helper binary missing, smart-detect will fall back to plain selection');
    return null;
  }
  try {
    helper = new HelperClient(bin, { selfPid: process.pid, log });
  } catch (err) {
    log('helper failed to start:', err.message);
    helper = null;
  }
  return helper;
}

// ---------------------------------------------------------------- permissions

function screenPermission() {
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

function axPermission() {
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return false;
  }
}

function openPermissionPane(which) {
  const url = which === 'screen'
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
  shell.openExternal(url);
}

// ---------------------------------------------------------------- capture session

function pickSource(sources, display) {
  const wanted = String(display.id);
  let src = sources.find((s) => s.display_id && s.display_id === wanted);
  if (src) return src;

  // Fall back to matching by aspect/size ratio.
  const target = display.size.width / display.size.height;
  let best = null;
  let bestErr = Infinity;
  for (const s of sources) {
    const size = s.thumbnail.getSize();
    if (!size.width || !size.height) continue;
    const err = Math.abs(size.width / size.height - target) / target;
    if (err < bestErr) { bestErr = err; best = s; }
  }
  if (best && bestErr < 0.05) return best;
  return sources[0] || null;
}

async function grabScreens(displays) {
  const out = new Map();
  if (DEMO) return out;

  const single = displays.length === 1;
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const thumbnailSize = single
    ? {
        width: Math.round(displays[0].size.width * displays[0].scaleFactor),
        height: Math.round(displays[0].size.height * displays[0].scaleFactor),
      }
    : { width: maxW, height: maxH };

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
    fetchWindowIcons: false,
  });

  for (const d of displays) {
    const src = pickSource(sources, d);
    if (!src) continue;
    const thumb = src.thumbnail;
    const size = thumb.getSize();
    if (!size.width || !size.height) continue;
    out.set(d.id, thumb.toPNG());
  }
  return out;
}

async function startCapture() {
  if (session) { endSession(); return; }

  // Windows first, pixels second: dimming the screen should not wait for the
  // (slow) full-screen capture; the frozen frame streams into the overlay.
  const displays = screen.getAllDisplays();
  const cursor = screen.getCursorScreenPoint();
  const created = [];
  for (const display of displays) {
    const init = {
      displayId: display.id,
      displayCount: displays.length,
      origin: { x: display.bounds.x, y: display.bounds.y },
      dip: { w: display.size.width, h: display.size.height },
      dpr: display.scaleFactor,
      cursor: { x: cursor.x, y: cursor.y },
      demo: DEMO,
      axTrusted: axPermission(),
      hotkey: HOTKEY,
      png: null, // 冻结画面稍后经 snap:png 推送（demo 模式由渲染端合成）
    };
    const win = createOverlayWindow(display, init);
    created.push({ win, display, init });
  }

  const primary = screen.getDisplayNearestPoint(cursor);
  session = { displays: created, owner: null, activeDisplayId: primary.id };

  // Give the display that owns the pointer (the one the user is looking at) a
  // chance to grab keyboard focus once it is on screen.
  const active = created.find((d) => d.display.id === primary.id) || created[0];
  if (!active) { endSession(); return; }
  active.win.once('show', () => {
    try { app.focus({ steal: true }); } catch {}
    active.win.focus();
  });

  // The heart of the perceived latency: only the dim+chrome waits on window
  // boot; the frame itself arrives whenever the capturer is done.
  grabScreens(displays)
    .then(async (images) => {
      if (!session) return;                       // user already quit the session
      for (const d of session.displays) {
        if (d.win.isDestroyed()) continue;
        const png = images.get(d.display.id) || null;
        d.init.png = png;
        d.win.webContents.send('snap:png', png);
      }
    })
    .catch((err) => log('capture failed:', err));

  // Nag about the missing screen-recording permission once per launch, not on
  // every attempt (the overlay must keep keyboard focus for Esc).
  if (!DEMO && screenPermission() !== 'granted' && !helpShownThisLaunch) {
    helpShownThisLaunch = true;
    showHelp('permission');
  }
  return session;
}

function createOverlayWindow(display, init) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    enableLargerThanScreen: true,
    acceptFirstMouse: true,
    roundedCorners: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch {}
  win.setFullScreenable(false);
  win.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  return win;
}

function endSession() {
  if (!session) return;
  const wins = session.displays.map((d) => d.win);
  session = null;
  for (const w of wins) {
    try {
      if (!w.isDestroyed()) w.destroy();
    } catch {}
  }
}

// ---------------------------------------------------------------- pin windows

function pinZoom(win, factor) {
  if (win.isDestroyed()) return;
  const b = win.getBounds();
  const ratio = win.__snapAspect || (b.width / b.height);
  let w = Math.round(b.width * factor);
  let h = Math.round(w / ratio);
  w = Math.max(24, Math.min(8000, w));
  h = Math.max(24, Math.min(8000, h));
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const bounds = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h };
  win.setBounds(bounds, false);
}

function createPin(dataURL, at) {
  const img = nativeImage.createFromDataURL(dataURL);
  const size = img.getSize();
  if (!size.width || !size.height) return null;

  const dpr = screen.getDisplayNearestPoint(at || screen.getCursorScreenPoint()).scaleFactor;
  const w = Math.max(24, Math.round(size.width / dpr));
  const h = Math.max(24, Math.round(size.height / dpr));
  const area = at || screen.getCursorScreenPoint();
  const dispB = screen.getDisplayNearestPoint(area).workArea;
  const x = Math.round(area.x - w / 2);
  const y = Math.round(area.y - h / 2);

  const win = new BrowserWindow({
    x: Math.min(Math.max(x, dispB.x + 8), dispB.x + dispB.width - w - 8),
    y: Math.min(Math.max(y, dispB.y + 8), dispB.y + dispB.height - h - 8),
    width: w,
    height: h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: false,
    acceptFirstMouse: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  win.__snapAspect = w / h;
  win.__snapDataURL = dataURL;
  win.setAlwaysOnTop(true, 'floating');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch {}
  try { win.setAspectRatio(w / h); } catch {}
  win.loadFile(path.join(__dirname, 'renderer', 'pin.html'));
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('snap:pin-init', { dataURL, w, h, dpr });
  });

  win.on('closed', () => pinWindows.delete(win));
  pinWindows.add(win);
  return win;
}

// ---------------------------------------------------------------- tray

function trayIcon() {
  const N = 32;
  const buf = Buffer.alloc(N * N * 4, 0);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    const i = (y * N + x) * 4;
    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
  };
  const T = 3, L = 12, M = 4;
  const corners = [
    [M, M, 1, 1], [N - 1 - M, M, -1, 1],
    [M, N - 1 - M, 1, -1], [N - 1 - M, N - 1 - M, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    for (let i = 0; i < L; i++) {
      for (let t = 0; t < T; t++) {
        set(cx + dx * i, cy + dy * t);
        set(cx + dx * t, cy + dy * i);
      }
    }
  }
  for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) set(16 + dx, 16 + dy);
  const img = nativeImage.createFromBitmap(buf, { width: N, height: N });
  img.setTemplateImage(true);
  return img;
}

function loginItemAvailable() {
  return app.isPackaged || process.execPath.includes('.app/Contents/MacOS');
}

// ---------------------------------------------------------------- launch at login

/** macOS 13+ reports a richer status ('enabled' | 'requires-approval' | …). */
function loginItemState() {
  if (!loginItemAvailable()) {
    return { available: false, openAtLogin: false, status: 'unavailable' };
  }
  let cur = {};
  try {
    cur = app.getLoginItemSettings();
  } catch {}
  return {
    available: true,
    openAtLogin: !!cur.openAtLogin,
    status: cur.status || (cur.openAtLogin ? 'enabled' : 'not-registered'),
    wasOpenedAtLogin: !!cur.wasOpenedAtLogin,
  };
}

function setOpenAtLogin(on) {
  settings.set('openAtLogin', !!on);
  if (!loginItemAvailable()) return loginItemState();
  try {
    app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true });
  } catch (err) {
    log('setLoginItemSettings failed:', err.message);
  }
  return loginItemState();
}

/** Re-assert the stored preference on every launch (self-heals after updates). */
function restoreLoginItem() {
  const st = loginItemState();
  if (!st.available) return st;
  // macOS refuses login-item registration for bundles outside /Applications
  // (and logs an error if we try), so only re-assert from a normal install.
  if (!app.getPath('exe').startsWith('/Applications/')) return st;
  const wanted = !!settings.get('openAtLogin', false);
  if (wanted !== st.openAtLogin) {
    try {
      app.setLoginItemSettings({ openAtLogin: wanted, openAsHidden: true });
    } catch {}
  }
  return loginItemState();
}

// ---------------------------------------------------------------- keep awake

let powerBlockerId = null;

function keepAwakeActive() {
  return powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId);
}

function applyKeepAwake(on) {
  if (on && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!on && powerBlockerId !== null) {
    try {
      if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
    } catch {}
    powerBlockerId = null;
  }
  return keepAwakeActive();
}

function toggleKeepAwake(on) {
  settings.set('keepAwake', !!on);
  const active = applyKeepAwake(!!on);
  refreshTray();
  return { keepAwake: !!on, active, blocker: powerBlockerId };
}

let trayMenu = null;

function refreshTray() {
  if (!tray) return;
  const screenOk = screenPermission() === 'granted';
  const axOk = axPermission();
  const login = loginItemState();
  const awake = keepAwakeActive();

  const loginLabel = !login.available
    ? '开机自动启动（打包后可用）'
    : login.status === 'requires-approval'
      ? '开机自动启动（需在系统设置的“登录项”里允许）'
      : '开机自动启动';

  const menu = Menu.buildFromTemplate([
    { label: '打开控制台…', click: () => showHelp('manual') },
    { type: 'separator' },
    {
      label: '保持屏幕常亮（不息屏）',
      type: 'checkbox',
      checked: awake,
      click: (item) => toggleKeepAwake(item.checked),
    },
    {
      label: loginLabel,
      type: 'checkbox',
      checked: login.openAtLogin,
      enabled: login.available,
      click: (item) => {
        const st = setOpenAtLogin(item.checked);
        if (item.checked && st.status === 'requires-approval') {
          try {
            new Notification({
              title: 'Snap 截图',
              body: '已加入登录项，还需要在「系统设置 → 通用 → 登录项」中允许。',
            }).show();
          } catch {}
        }
        refreshTray();
      },
    },
    { type: 'separator' },
    {
      label: screenOk ? '✅ 屏幕录制权限已授权' : '⚠️ 屏幕录制权限未授权（点击去授权）',
      enabled: !screenOk,
      click: () => openPermissionPane('screen'),
    },
    {
      label: axOk ? '✅ 智能识别（辅助功能）已授权' : '⚠️ 智能识别（辅助功能）未授权（点击去授权）',
      enabled: !axOk,
      click: () => openPermissionPane('ax'),
    },
    { type: 'separator' },
    { label: '使用说明 / 设置…', click: () => showHelp('manual') },
    { label: '退出 Snap', click: () => { app.exit(0); } },
  ]);
  // 微信同款交互：左键直接拉起截屏，右键才弹出菜单。
  trayMenu = menu;
  tray.setToolTip(`Snap 截图  ${HOTKEY}${awake ? '  · 屏幕常亮' : ''}`);
}

// ---------------------------------------------------------------- help window

/** 控制台默认尺寸：够放下 API 调试台的请求/响应两栏，又不会在 1440×900 上顶格。 */
const PANEL_SIZE = { width: 1080, height: 760 };

/**
 * 记住控制台的位置与大小。存下来的矩形只有仍与某块显示器相交时才复用，
 * 否则拔掉外接屏后窗口会跑到看不见的地方。
 */
function savedPanelBounds() {
  const b = settings.get('panelBounds', null);
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  if (b.width < 480 || b.height < 360) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x
      && b.y < a.y + a.height && b.y + b.height > a.y;
  });
  return visible ? b : null;
}

function rememberPanelBounds(win) {
  if (!win) return;
  let b;
  let maximized = false;
  let fullscreen = false;
  try {
    maximized = win.isMaximized();
    fullscreen = win.isFullScreen();
    // 最大化/全屏下要取「还原后」的矩形，否则会把铺满屏幕的尺寸当成默认大小
    b = maximized || fullscreen ? win.getNormalBounds() : win.getBounds();
  } catch {
    return;                       // window is already gone
  }
  if (!b.width || !b.height) return;
  settings.set('panelBounds', {
    x: b.x, y: b.y, width: b.width, height: b.height, maximized, fullscreen,
  });
}

/**
 * 窗口几何一变就防抖记一次。不能只挂在 close 上：渲染进程自己调
 * window.close() 时 Electron 只发 closed、不发 close，那条路径会漏记。
 */
function watchPanelBounds(win) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => rememberPanelBounds(win), 400);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, save);
}

/** 总面板：所有面向用户的操作入口（设置/说明/API 调试台标签页）。 */
function showHelp(reason) {
  if (helpWin && !helpWin.isDestroyed()) {
    helpWin.show();
    helpWin.focus();
    return helpWin;
  }
  const saved = savedPanelBounds();
  helpWin = new BrowserWindow({
    width: saved ? saved.width : PANEL_SIZE.width,
    height: saved ? saved.height : PANEL_SIZE.height,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    title: 'Snap 控制台',
    resizable: true,
    minimizable: false,
    maximizable: true,
    fullscreenable: true,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  watchPanelBounds(helpWin);
  helpWin.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  helpWin.webContents.once('did-finish-load', () => {
    helpWin.webContents.send('snap:help-init', {
      hotkey: HOTKEY,
      reason,
      screenStatus: screenPermission(),
      axTrusted: axPermission(),
      settings: settingsSnapshot(),
    });
  });
  helpWin.once('ready-to-show', () => {
    helpWin.show();
    // 全屏要等窗口可见后才生效；最大化可以在隐藏时设，但放一起更清楚
    if (saved && saved.fullscreen) helpWin.setFullScreen(true);
    else if (saved && saved.maximized) helpWin.maximize();
    helpWin.focus();
  });
  helpWin.on('close', () => rememberPanelBounds(helpWin));
  helpWin.on('closed', () => { helpWin = null; });
  return helpWin;
}

// ---------------------------------------------------------------- ipc

function windowToDisplay(win) {
  if (!session) return null;
  return session.displays.find((d) => d.win === win) || null;
}

function demoRects(display) {
  const o = display.bounds;
  return [
    { x: o.x + 120, y: o.y + 90, w: 620, h: 400, source: 'window', owner: 'Demo 窗口', pid: 1 },
    { x: o.x + 170, y: o.y + 150, w: 132, h: 34, source: 'ax', role: 'AXButton', title: '确定' },
    { x: o.x + 320, y: o.y + 150, w: 132, h: 34, source: 'ax', role: 'AXButton', title: '取消' },
    { x: o.x + 170, y: o.y + 220, w: 400, h: 26, source: 'ax', role: 'AXStaticText', title: '一段示例文字' },
  ];
}

ipcMain.handle('snap:ready', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const d = windowToDisplay(win);
  if (!d) return null;
  return d.init;
});

ipcMain.on('snap:first-frame', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.show();
  if (session) {
    const d = windowToDisplay(win);
    if (d) {
      try { app.focus({ steal: true }); } catch {}
      win.focus();
    }
  }
});

ipcMain.handle('snap:claim', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const d = windowToDisplay(win);
  if (!session || !d) return { ok: false };
  if (session.owner !== null && session.owner !== d.display.id) return { ok: false };
  session.owner = d.display.id;
  for (const other of session.displays) {
    if (other === d) continue;
    if (!other.win.isDestroyed()) other.win.webContents.send('snap:owner', d.display.id);
  }
  return { ok: true };
});

ipcMain.handle('snap:release', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const d = windowToDisplay(win);
  if (!session || !d) return { ok: false };
  if (session.owner === d.display.id) {
    session.owner = null;
    for (const other of session.displays) {
      if (other === d) continue;
      if (!other.win.isDestroyed()) other.win.webContents.send('snap:owner', null);
    }
  }
  return { ok: true };
});

ipcMain.handle('snap:hit', async (e, { x, y }) => {
  if (DEMO) {
    const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
    const inside = demoRects(display).filter(
      (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
    );
    if (!inside.length) return null;
    // most specific (smallest) element wins
    inside.sort((a, b) => a.w * a.h - b.w * b.h);
    return inside[0];
  }
  if (!helper) return null;
  const res = await helper.hit(x, y);
  return res || null;
});

ipcMain.handle('snap:copy', async (e, dataURL) => {
  const img = nativeImage.createFromDataURL(dataURL);
  const size = img.getSize();
  if (!size.width || !size.height) return { ok: false, error: 'empty image' };
  try {
    await clip.writeImage(img);
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
  return { ok: true, size };
});

ipcMain.handle('snap:save', async (e, dataURL) => {
  const img = nativeImage.createFromDataURL(dataURL);
  const size = img.getSize();
  if (!size.width || !size.height) return { ok: false, error: 'empty image' };

  let filePath = TEST_SAVE_PATH;
  if (!filePath) {
    const dir = app.getPath('pictures');
    const res = await dialog.showSaveDialog({
      title: '保存截图',
      defaultPath: path.join(dir, `Snap截图_${stamp()}.png`),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    filePath = res.filePath;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, img.toPNG());
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
  if (!TEST) shell.showItemInFolder(filePath);
  return { ok: true, filePath, size };
});

ipcMain.handle('snap:pin', (e, { dataURL, at }) => {
  const win = createPin(dataURL, at);
  return { ok: !!win };
});

ipcMain.handle('snap:cancel', () => {
  endSession();
  return { ok: true };
});

ipcMain.handle('snap:ax-trusted', () => axPermission());

ipcMain.handle('snap:open-permission', (e, which) => {
  openPermissionPane(which);
  return { ok: true };
});

ipcMain.handle('snap:help', (e, reason) => {
  showHelp(reason || 'manual');
  return { ok: true };
});

// ---------------------------------------------------------------- api proxy

// 这些头由 fetch / Electron 决定，转发自定义值会被拒或产生歧义
const HOP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'origin', 'referer', 'user-agent', 'cookie', 'accept-encoding',
]);
const API_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

ipcMain.handle('snap:api-send', async (_e, spec) => {
  const t0 = Date.now();
  try {
    const method = String(spec.method || 'GET').toUpperCase();
    if (!API_METHODS.has(method)) return { ok: false, error: `不支持的方法 ${method}` };

    let url;
    try { url = new URL(String(spec.url || '')); } catch { url = null; }
    if (!url || !/^https?:$/.test(url.protocol)) return { ok: false, error: 'URL 不合法（仅支持 http/https）' };

    const headers = { 'user-agent': 'snap-apidebug/1.0' };
    for (const [k, v] of Object.entries(spec.headers || {})) {
      const name = String(k).trim();
      if (!name || HOP_HEADERS.has(name.toLowerCase())) continue;
      headers[name] = String(v);
    }

    let body;
    if (!['GET', 'HEAD'].includes(method) && spec.body != null && spec.body !== '') {
      const ct = String(spec.contentType || '');
      if (ct && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = ct;
      }
      body = String(spec.body);
    }

    const timeoutMs = Math.min(120000, Number(spec.timeoutMs) || 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(url, {
        method,
        headers,
        body,
        redirect: spec.followRedirects === false ? 'manual' : 'follow',
        signal: controller.signal,
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const outHeaders = {};
      r.headers.forEach((v, k) => {
        if (k === 'set-cookie') return;
        (outHeaders[k] = outHeaders[k] || []).push(v);
      });
      return {
        ok: true,
        status: r.status,
        statusText: r.statusText || '',
        headers: outHeaders,
        size: buf.length,
        timeMs: Date.now() - t0,
        redirected: r.redirected,
        finalUrl: r.url,
        bodyB64: buf.toString('base64'),
        mime: r.headers.get('content-type') || '',
      };
    } catch (err) {
      const aborted = err.name === 'AbortError';
      return {
        ok: false,
        error: aborted ? `请求超时（${timeoutMs}ms，可在右上角调整）` : String((err.cause && err.cause.message) || err.message || err),
        timeMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
    } catch (err) {
    return { ok: false, error: String(err && err.message), timeMs: Date.now() - t0 };
  }
});

// 截图只由全局快捷键拉起：刻意不提供任何 IPC/点击入口。

// ---------------------------------------------------------------- json stores

// 日历记录、草稿都是用户长期累积的真数据，所以存成 userData 下可读可备份的
// JSON，而不是 localStorage。写入走「临时文件 + rename」，中途失败不会留半个文件。

function storeFile(name) {
  return path.join(app.getPath('userData'), name);
}

/** 读一个 { version, <key>: [...] } 形状的 store；读不动就改名留档，绝不静默丢数据。 */
function readJsonStore(file, key) {
  const empty = () => ({ version: 1, [key]: [] });
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw[key])) throw new Error('bad shape');
    return { version: raw.version || 1, [key]: raw[key] };
  } catch (err) {
    if (err && err.code === 'ENOENT') return empty();
    const backup = `${file}.corrupt-${stamp()}`;
    try {
      fs.renameSync(file, backup);
      log('store unreadable, kept as', backup);
    } catch {}
    return empty();
  }
}

function writeJsonStore(file, key, data) {
  const list = data && Array.isArray(data[key]) ? data[key] : [];
  const payload = JSON.stringify({ version: 1, [key]: list }, null, 2);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
    return { ok: true, path: file, bytes: payload.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ------------------------------------------------------------------- calendar

const calendarFile = () => storeFile('calendar.json');

ipcMain.handle('snap:calendar-load', () => readJsonStore(calendarFile(), 'records'));
ipcMain.handle('snap:calendar-save', (_e, data) => writeJsonStore(calendarFile(), 'records', data));
ipcMain.handle('snap:calendar-path', () => calendarFile());

// --------------------------------------------------------------------- drafts

const draftsFile = () => storeFile('drafts.json');

ipcMain.handle('snap:drafts-load', () => readJsonStore(draftsFile(), 'drafts'));
ipcMain.handle('snap:drafts-save', (_e, data) => writeJsonStore(draftsFile(), 'drafts', data));
ipcMain.handle('snap:drafts-path', () => draftsFile());

// ------------------------------------------------- 草稿共享（局域网只读页面）

// 手机扫码看草稿：本机起一个只读 HTTP 服务，地址里带一段随机 token，
// 免得同网段的人靠扫端口就能翻到内容。只在用户点「共享」时开着。

let shareServer = null;      // { server, port, token, url, host }

/** 找一个像样的局域网 IPv4：跳过虚拟/隧道网卡，优先私有网段。 */
function lanAddress() {
  const skip = /^(utun|bridge|awdl|llw|gif|stf|anpi|lo)/;
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      found.push({ name, address: info.address });
    }
  }
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return found.find((f) => isPrivate(f.address)) || found[0] || null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 手机上看的那张只读页面。每 5 秒自动刷新，编辑草稿后手机上会跟着更新。 */
function sharePage(drafts) {
  const cards = drafts.length
    ? drafts.map((d) => {
      const text = String(d.text || '');
      const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || '无标题';
      return `<article><h2>${escapeHtml(firstLine)}</h2><pre>${escapeHtml(text)}</pre></article>`;
    }).join('\n')
    : '<p class="empty">还没有草稿</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta http-equiv="refresh" content="5" />
<title>Snap 草稿</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 16px 14px 40px; font: 15px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
         background: #fbfbfd; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #1e1e20; color: #e8e8ea; } article { background: #2a2a2d !important; border-color: #38383c !important; } }
  header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px; }
  h1 { font-size: 19px; margin: 0; }
  .muted { color: #86868b; font-size: 13px; }
  article { background: #fff; border: 1px solid #e6e6ea; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
  article h2 { font-size: 15px; margin: 0 0 6px; }
  article pre { margin: 0; white-space: pre-wrap; word-break: break-word;
                font: 14px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
  .empty { color: #86868b; }
</style></head>
<body>
  <header><h1>Snap 草稿</h1><span class="muted">只读 · ${drafts.length} 条</span></header>
  ${cards}
</body></html>`;
}

function shareInfo() {
  if (!shareServer) return { ok: true, running: false };
  return { ok: true, running: true, url: shareServer.url, host: shareServer.host, port: shareServer.port };
}

function stopShare() {
  if (!shareServer) return { ok: true, running: false };
  try { shareServer.server.close(); } catch {}
  log('drafts share stopped');
  shareServer = null;
  return { ok: true, running: false };
}

function startShare() {
  if (shareServer) return shareInfo();
  const token = crypto.randomBytes(8).toString('hex');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('只读');
      return;
    }
    // 路径必须带 token，否则一律 404（不暴露这里在跑什么）
    if (url.pathname.replace(/^\/+|\/+$/g, '') !== token) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const { drafts } = readJsonStore(draftsFile(), 'drafts');
    if (url.searchParams.get('json') === '1') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(drafts, null, 2));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(sharePage(drafts));
  });

  return new Promise((resolve) => {
    server.on('error', (err) => {
      log('drafts share failed:', err.message);
      resolve({ ok: false, error: String(err.message || err) });
    });
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address();
      const lan = lanAddress();
      const host = lan ? lan.address : '127.0.0.1';
      shareServer = { server, port, token, host, url: `http://${host}:${port}/${token}/` };
      log('drafts share listening on', shareServer.url);
      resolve(shareInfo());
    });
  });
}

ipcMain.handle('snap:drafts-share-start', () => startShare());
ipcMain.handle('snap:drafts-share-stop', () => stopShare());
ipcMain.handle('snap:drafts-share-status', () => shareInfo());

/** 二维码交给原生 helper（CoreImage），渲染层只拿 base64。 */
ipcMain.handle('snap:qrcode', async (_e, text) => {
  if (!helper) return { ok: false, error: '原生 helper 未运行' };
  const png = await helper.qrcode(text);
  return png ? { ok: true, png } : { ok: false, error: '二维码生成失败' };
});

// ---------------------------------------------------------------- settings ipc

function settingsSnapshot() {
  const login = loginItemState();
  return {
    keepAwake: keepAwakeActive(),
    keepAwakeWanted: !!settings.get('keepAwake', false),
    openAtLogin: login.openAtLogin,
    loginStatus: login.status,
    loginAvailable: login.available,
    wasOpenedAtLogin: !!login.wasOpenedAtLogin,
    hotkey: HOTKEY,
    settingsPath: settings.__file || null,
  };
}

ipcMain.handle('snap:get-settings', () => settingsSnapshot());

ipcMain.handle('snap:set-setting', (e, { key, value }) => {
  if (key === 'keepAwake') {
    toggleKeepAwake(value);
    return settingsSnapshot();
  }
  if (key === 'openAtLogin') {
    setOpenAtLogin(value);
    refreshTray();
    return settingsSnapshot();
  }
  return { ok: false, error: 'unknown setting' };
});

ipcMain.handle('snap:open-login-items', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
  return { ok: true };
});

ipcMain.on('snap:log', (e, msg) => log('[renderer]', msg));

ipcMain.on('snap:pin-close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('snap:pin-drag-start', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
});

ipcMain.on('snap:pin-drag-to', (e, pos) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  win.setPosition(Math.round(pos.x), Math.round(pos.y), false);
});

ipcMain.on('snap:pin-copy', async (e, dataURL) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const src = dataURL || (win && win.__snapDataURL);
  if (src) await clip.writeImageFromDataURL(src);
});

ipcMain.on('snap:pin-save', async (e, dataURL) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const src = dataURL || (win && win.__snapDataURL);
  if (!src) return;
  const img = nativeImage.createFromDataURL(src);
  const res = await dialog.showSaveDialog({
    window: win && !win.isDestroyed() ? win : undefined,
    title: '保存图片',
    defaultPath: path.join(app.getPath('pictures'), `Snap贴图_${stamp()}.png`),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (!res.canceled && res.filePath) fs.writeFileSync(res.filePath, img.toPNG());
});

ipcMain.on('snap:pin-zoom', (e, factor) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) pinZoom(win, factor);
});

ipcMain.on('snap:pin-opacity', (e, delta) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const cur = typeof win.getOpacity() === 'number' ? win.getOpacity() : 1;
  win.setOpacity(Math.min(1, Math.max(0.15, cur + delta)));
});

ipcMain.on('snap:pin-menu', (e, dataURL) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: '复制到剪贴板',
      click: async () => {
        const src = dataURL || win.__snapDataURL;
        if (src) await clip.writeImageFromDataURL(src);
      },
    },
    {
      label: '保存为文件…',
      click: async () => {
        const src = dataURL || win.__snapDataURL;
        if (!src) return;
        const img = nativeImage.createFromDataURL(src);
        const res = await dialog.showSaveDialog({
          title: '保存图片',
          defaultPath: path.join(app.getPath('pictures'), `Snap贴图_${stamp()}.png`),
          filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        });
        if (!res.canceled && res.filePath) fs.writeFileSync(res.filePath, img.toPNG());
      },
    },
    { type: 'separator' },
    { label: '关闭贴图', click: () => win.close() },
  ]);
  menu.popup({ window: win });
});

// ---------------------------------------------------------------- lifecycle

function registerHotkey() {
  const ok = globalShortcut.register(HOTKEY, () => {
    startCapture();
  });
  if (!ok) {
    log(`hotkey ${HOTKEY} registration FAILED`);
    try {
      new Notification({
        title: 'Snap 截图',
        body: `快捷键 ${HOTKEY} 被其他程序占用，请修改 SNAP_HOTKEY 环境变量。`,
      }).show();
    } catch {}
  }
  return ok;
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => showHelp('manual'));

  app.whenReady().then(async () => {
    try { app.setActivationPolicy('accessory'); } catch {}
    if (app.dock) app.dock.hide();

    HOTKEY = process.env.SNAP_HOTKEY || settings.get('hotkey', DEFAULT_HOTKEY) || DEFAULT_HOTKEY;

    startHelper();
    registerHotkey();
    restoreLoginItem();
    applyKeepAwake(!!settings.get('keepAwake', false));

    try {
      tray = new Tray(trayIcon());
      refreshTray();
      // 左键打开总面板；截图只由全局快捷键拉起。
      tray.on('click', () => showHelp('manual'));
      tray.on('right-click', () => {
        if (trayMenu) tray.popUpContextMenu(trayMenu);
      });
    } catch (err) {
      log('tray failed:', err.message);
    }

    if (!TEST && screenPermission() !== 'granted' && !helpShownThisLaunch) {
      helpShownThisLaunch = true;
      setTimeout(() => showHelp('first-run'), 800);
    }

    if (TEST) {
      const selftest = require('./selftest');
      selftest.run({
        startCapture,
        endSession,
        session: () => session,
        pinCount: () => pinWindows.size,
        pinWindows: () => [...pinWindows],
        screen,
        app,
        helper: () => helper,
      });
    }

    if (process.env.SNAP_PANEL === '1') showHelp('manual');
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (helper) helper.dispose();
    stopShare();
    // 从托盘「退出」时不会走窗口的 close 事件，这里补一次尺寸记忆。
    if (helpWin && !helpWin.isDestroyed()) rememberPanelBounds(helpWin);
  });

  // Tray utility: keep running even with no windows open.
  app.on('window-all-closed', () => {});
}

module.exports = { startCapture, endSession };
