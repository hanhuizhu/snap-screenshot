/* Help / permission window. */
'use strict';

const host = window.snapHost;
const $ = (id) => document.getElementById(id);

function prettyHotkey(accel) {
  return String(accel || 'Control+Command+A')
    .replace(/CommandOrControl|Command|Cmd/gi, '⌘')
    .replace(/Control|Ctrl/gi, '⌃')
    .replace(/Alt|Option/gi, '⌥')
    .replace(/Shift/gi, '⇧')
    .split('+')
    .join(' ');
}

host.onHelpInit((data) => {
  const hk = prettyHotkey(data.hotkey);
  $('hotkey').textContent = hk;
  $('hotkey2').textContent = hk;

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

  if (!screenOk && data.reason === 'first-run') {
    $('perm-note').innerHTML =
      '<b>首次使用：</b>请先在「系统设置 → 隐私与安全性 → 屏幕录制」里勾选 Snap（或 Electron），' +
      '然后重新启动本应用。授权前只能拍到桌面壁纸。';
  }

  renderSettings(data.settings);
});

function renderSettings(s) {
  if (!s) return;
  const awake = $('chk-awake');
  awake.checked = !!s.keepAwake;
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

$('chk-awake').addEventListener('change', async (e) => {
  renderSettings(await host.setSetting('keepAwake', e.target.checked));
});

$('chk-login').addEventListener('change', async (e) => {
  renderSettings(await host.setSetting('openAtLogin', e.target.checked));
});

$('btn-login-items').addEventListener('click', () => host.openLoginItems());
$('btn-screen').addEventListener('click', () => host.openPermission('screen'));
$('btn-ax').addEventListener('click', () => host.openPermission('ax'));
$('shot-now').addEventListener('click', () => host.capture());
