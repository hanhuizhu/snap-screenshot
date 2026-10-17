/* Snap drafts — a plain notepad: a list of text drafts on the left, one big
 * textarea on the right, autosaved to userData/drafts.json (see main.js).
 *
 * There is no separate title field: like 备忘录, the first non-empty line is the
 * title shown in the list.
 *
 * Pure helpers are exported on window.SnapDrafts for scripts/test-drafts-logic.js.
 */
'use strict';

(function (G) {
  const TITLE_MAX = 26;
  const SAVE_DELAY = 500;

  // ------------------------------------------------------------------ helpers

  /** 列表里显示的标题 = 第一行非空文本。 */
  function draftTitle(draft) {
    const lines = String((draft && draft.text) || '').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t) return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
    }
    return '无标题';
  }

  /** 最近改的排前面。 */
  function sortDrafts(list) {
    return [...(list || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** 字数：不含空白字符，中文场景下比 length 更符合直觉。 */
  function charCount(text) {
    return String(text || '').replace(/\s+/g, '').length;
  }

  function newId() {
    return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function blankDraft() {
    return { id: newId(), text: '', createdAt: Date.now(), updatedAt: Date.now() };
  }

  /** 相对时间：刚刚 / N 分钟前 / 今天 HH:MM / M月D日 */
  function shortTime(ts, now = Date.now()) {
    if (!ts) return '';
    const d = new Date(ts);
    const diff = now - ts;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    const today = new Date(now);
    const sameDay = d.getFullYear() === today.getFullYear()
      && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    const p = (n) => String(n).padStart(2, '0');
    if (sameDay) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // -------------------------------------------------------------------- mount

  function mount(root, host) {
    let drafts = [];
    let currentId = null;
    let saveTimer = null;
    let saveState = 'saved';        // saved | dirty | saving | error

    // ---- DOM -------------------------------------------------------------

    const listBox = el('div', { class: 'drafts-items' });
    const list = el('aside', { class: 'drafts-list' }, [
      el('div', { class: 'drafts-listhead' }, [
        el('button', { class: 'drafts-new', text: '+ 新建', title: '新建草稿（⌘N）', onclick: () => addDraft() }),
      ]),
      listBox,
    ]);

    const area = el('textarea', {
      class: 'drafts-text', spellcheck: 'false', placeholder: '在这里记点东西…',
      oninput: onInput,
    });

    const countEl = el('span', { class: 'drafts-count' });
    const stateEl = el('span', { class: 'drafts-state' });
    const pathEl = el('span', { class: 'drafts-path', hidden: true });

    // ---- 共享（局域网只读页面 + 二维码） ---------------------------------

    const shareQr = el('img', { class: 'drafts-share-qr', alt: '二维码' });
    const shareUrl = el('code', { class: 'drafts-share-url' });
    const shareNote = el('div', { class: 'drafts-share-note' });
    const shareBox = el('div', { class: 'drafts-share', hidden: true }, [
      el('div', { class: 'drafts-share-qrbox' }, [shareQr]),
      el('div', { class: 'drafts-share-info' }, [
        el('div', { class: 'drafts-share-title', text: '手机扫码查看草稿' }),
        shareUrl,
        el('div', { class: 'drafts-share-actions' }, [
          el('button', { class: 'drafts-ghost', text: '复制地址', onclick: () => copyShareUrl() }),
          el('button', { class: 'drafts-ghost', text: '停止共享', onclick: () => stopShare() }),
        ]),
        shareNote,
      ]),
    ]);

    const shareBtn = el('button', {
      class: 'drafts-share-btn', text: '共享',
      title: '起一个局域网地址，手机扫码看这些草稿',
      onclick: () => toggleShare(),
    });

    let shareUrlText = '';

    async function showShare(info) {
      shareUrlText = (info && info.url) || '';
      shareBox.hidden = false;
      shareBtn.textContent = '共享中';
      shareBtn.classList.add('on');
      shareUrl.textContent = shareUrlText;
      shareNote.textContent = '同一局域网内可访问，内容只读；手机页面每 5 秒自动刷新。';
      shareQr.removeAttribute('src');
      try {
        const qr = await host.qrcode(shareUrlText);
        if (qr && qr.ok && qr.png) shareQr.src = `data:image/png;base64,${qr.png}`;
        else shareNote.textContent = `二维码生成失败（${(qr && qr.error) || '未知原因'}），可以直接在手机上输入上面的地址。`;
      } catch {
        shareNote.textContent = '二维码生成失败，可以直接在手机上输入上面的地址。';
      }
    }

    function hideShare() {
      shareBox.hidden = true;
      shareBtn.textContent = '共享';
      shareBtn.classList.remove('on');
      shareQr.removeAttribute('src');
    }

    async function toggleShare() {
      if (!shareBox.hidden) { stopShare(); return; }
      shareBtn.disabled = true;
      try {
        const info = await host.draftsShareStart();
        if (info && info.ok && info.running) await showShare(info);
        else shareNote.textContent = '';
      } finally {
        shareBtn.disabled = false;
      }
    }

    async function stopShare() {
      try { await host.draftsShareStop(); } catch { /* 关不掉也把界面收起来 */ }
      hideShare();
    }

    function copyShareUrl() {
      if (!shareUrlText) return;
      navigator.clipboard.writeText(shareUrlText).then(
        () => { shareNote.textContent = '地址已复制'; },
        () => { shareNote.textContent = '复制失败，请手动选择上面的地址'; }
      );
    }

    const editor = el('section', { class: 'drafts-editor' }, [
      shareBox,
      area,
      el('footer', { class: 'drafts-foot' }, [
        countEl,
        stateEl,
        el('span', { class: 'drafts-grow' }),
        pathEl,
        shareBtn,
        el('button', { class: 'drafts-del', text: '删除', onclick: () => deleteCurrent() }),
      ]),
    ]);

    root.append(list, editor);

    // ---- state -----------------------------------------------------------

    const byId = (id) => drafts.find((d) => d.id === id) || null;
    const current = () => byId(currentId);

    function renderState() {
      stateEl.textContent = {
        saved: '已保存', dirty: '未保存', saving: '保存中…', error: '保存失败',
      }[saveState] || '';
      stateEl.className = `drafts-state s-${saveState}`;
      countEl.textContent = `${charCount(area.value)} 字`;
    }

    function renderList() {
      listBox.textContent = '';
      for (const draft of sortDrafts(drafts)) {
        const active = draft.id === currentId;
        listBox.appendChild(el('div', {
          class: `drafts-item${active ? ' on' : ''}`,
          'data-id': draft.id,
          title: draftTitle(draft),
          onclick: () => select(draft.id),
        }, [
          el('div', { class: 'drafts-item-title', text: draftTitle(draft) }),
          el('div', { class: 'drafts-item-time', text: shortTime(draft.updatedAt) }),
          el('button', {
            class: 'drafts-item-del', text: '✕', title: '删除',
            onclick: (e) => { e.stopPropagation(); remove(draft.id); },
          }),
        ]));
      }
    }

    function select(id) {
      const draft = byId(id);
      if (!draft) return;
      currentId = id;
      area.value = draft.text || '';
      renderList();
      renderState();
      area.focus();
    }

    function addDraft() {
      const draft = blankDraft();
      drafts.push(draft);
      select(draft.id);
      saveState = 'dirty';
      renderState();
      area.focus();
    }

    function remove(id) {
      drafts = drafts.filter((d) => d.id !== id);
      if (!drafts.length) drafts.push(blankDraft());
      if (!byId(currentId)) select(sortDrafts(drafts)[0].id);
      else renderList();
      saveState = 'dirty';
      renderState();
      save(true);
    }

    function deleteCurrent() {
      const draft = current();
      if (!draft) return;
      if (!String(draft.text || '').trim() && drafts.length > 1) {
        remove(draft.id);
        return;
      }
      draft.text = '';
      draft.updatedAt = Date.now();
      area.value = '';
      renderState();
      save(true);
    }

    function onInput() {
      const draft = current();
      if (!draft) return;
      draft.text = area.value;
      draft.updatedAt = Date.now();
      saveState = 'dirty';
      renderState();
      save(false);
    }

    function save(immediate) {
      clearTimeout(saveTimer);
      const write = () => {
        saveState = 'saving';
        renderState();
        host.draftsSave({ drafts }).then((res) => {
          if (res && res.ok === false) {
            saveState = 'error';
          } else {
            saveState = 'saved';
            if (res && res.path) {
              pathEl.hidden = false;
              pathEl.textContent = res.path.replace(/^.*\//, '');
              pathEl.title = res.path;
            }
          }
          renderState();
          renderList();
        }).catch(() => {
          saveState = 'error';
          renderState();
        });
      };
      if (immediate) write();
      else saveTimer = setTimeout(write, SAVE_DELAY);
    }

    // ---- load ------------------------------------------------------------

    async function load() {
      let list = [];
      try {
        const data = await host.draftsLoad();
        list = Array.isArray(data && data.drafts) ? data.drafts.filter((d) => d && typeof d.text === 'string') : [];
      } catch { /* 读不到就当作空 */ }
      if (!list.length) list = [blankDraft()];
      drafts = list;
      select(sortDrafts(drafts)[0].id);
      renderState();
    }

    // ---- keyboard --------------------------------------------------------

    root.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        addDraft();
      }
    });

    // ---- first paint -----------------------------------------------------

    renderList();
    renderState();
    load();
    host.draftsPath().then((p) => {
      if (!p) return;
      pathEl.hidden = false;
      pathEl.textContent = p.replace(/^.*\//, '');
      pathEl.title = p;
    }).catch(() => {});
    // 服务端在主进程里，窗口重载后可能还开着，界面要跟着恢复
    host.draftsShareStatus().then((info) => {
      if (info && info.running) showShare(info);
    }).catch(() => {});

    return {
      state: () => ({ count: drafts.length, currentId, saveState, chars: charCount(area.value) }),
      drafts: () => drafts,
      addDraft, select, remove, save,
    };
  }

  G.SnapDrafts = { mount, draftTitle, sortDrafts, charCount, blankDraft, shortTime, TITLE_MAX };
})(typeof window !== 'undefined' ? window : globalThis);
