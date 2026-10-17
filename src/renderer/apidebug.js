/* API debugger.
 *
 * The main process owns the actual request (ipcMain 'snap:api-send'), so this
 * file only assembles a request spec and renders what comes back:
 *
 *   spec = { method, url, headers, body, contentType, timeoutMs, followRedirects }
 *
 * Query params, auth and {{variables}} are folded in here — the proxy
 * deliberately knows nothing about them.
 *
 * Loaded by both panel.html (console tab 2) and api.html (standalone window).
 */
'use strict';

(function (G) {
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const STORE_KEY = 'snap.api.v1';
  const HISTORY_MAX = 60;
  const NO_BODY = new Set(['GET', 'HEAD']);

  // ------------------------------------------------------------------ helpers

  /** {{name}} → value, for every enabled variable. Unknown names are left alone. */
  function substitute(input, vars) {
    if (input == null) return '';
    return String(input).replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole
    );
  }

  function enabledVars(list) {
    const out = {};
    for (const row of list || []) {
      const k = String(row.k || '').trim();
      if (!k || row.on === false) continue;
      out[k] = String(row.v == null ? '' : row.v);
    }
    return out;
  }

  function activeRows(list) {
    return (list || []).filter((r) => r.on !== false && String(r.k || '').trim() !== '');
  }

  function blankRow() { return { k: '', v: '', on: true }; }

  function fmtSize(n) {
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function clampTimeout(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 30000;
    return Math.max(1000, Math.min(120000, Math.round(n)));
  }

  function utf8ToBase64(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Text only if it decodes cleanly; NUL bytes or a rash of U+FFFD mean binary. */
  function decodeText(bytes) {
    if (!bytes || !bytes.length) return '';
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return null;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    let bad = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++;
    if (text.length && bad / text.length > 0.02) return null;
    return text;
  }

  function statusClass(status) {
    if (!Number.isFinite(status)) return 'err';
    if (status < 300) return 's2';
    if (status < 400) return 's3';
    if (status < 500) return 's4';
    return 's5';
  }

  function extForMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('json')) return 'json';
    if (m.includes('png')) return 'png';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('gif')) return 'gif';
    if (m.includes('webp')) return 'webp';
    if (m.includes('pdf')) return 'pdf';
    if (m.includes('zip')) return 'zip';
    if (m.includes('html')) return 'html';
    if (m.includes('xml')) return 'xml';
    if (m.startsWith('text/')) return 'txt';
    return 'bin';
  }

  /**
   * Turn editor state into the spec the proxy expects, plus a readable preview
   * of exactly what will go on the wire.
   * @returns {{spec?: object, preview: string, error?: string}}
   */
  function buildRequest(S) {
    const vars = enabledVars(S.env);
    const rawUrl = substitute(String(S.url || '').trim(), vars);
    if (!rawUrl) return { preview: '', error: '请填写请求 URL' };

    let parsed;
    try { parsed = new URL(rawUrl); } catch { return { preview: '', error: 'URL 不合法' }; }
    if (!/^https?:$/.test(parsed.protocol)) return { preview: '', error: '仅支持 http / https' };

    const pairs = activeRows(S.params).map((r) => [
      encodeURIComponent(substitute(r.k, vars)),
      encodeURIComponent(substitute(r.v, vars)),
    ]);
    if (pairs.length) {
      const qs = pairs.map(([k, v]) => `${k}=${v}`).join('&');
      parsed.search = parsed.search ? `${parsed.search.slice(1)}&${qs}` : qs;
    }
    const finalUrl = parsed.toString();

    const headers = {};
    for (const r of activeRows(S.headers)) {
      const name = substitute(r.k, vars).trim();
      if (name) headers[name] = substitute(r.v, vars);
    }

    if (S.authMode === 'bearer' && String(S.bearer || '').trim()) {
      headers.Authorization = `Bearer ${substitute(S.bearer, vars).trim()}`;
    } else if (S.authMode === 'basic') {
      const user = substitute(S.basicUser, vars);
      const pass = substitute(S.basicPass, vars);
      if (user || pass) headers.Authorization = `Basic ${utf8ToBase64(`${user}:${pass}`)}`;
    }

    const method = String(S.method || 'GET').toUpperCase();
    let body = null;
    let contentType = '';
    if (!NO_BODY.has(method)) {
      if (S.bodyMode === 'json') {
        body = substitute(S.json, vars);
        contentType = 'application/json';
      } else if (S.bodyMode === 'form') {
        body = activeRows(S.form)
          .map((r) => `${encodeURIComponent(substitute(r.k, vars))}=${encodeURIComponent(substitute(r.v, vars))}`)
          .join('&');
        contentType = 'application/x-www-form-urlencoded';
      } else if (S.bodyMode === 'raw') {
        body = substitute(S.raw, vars);
        contentType = String(S.rawType || '').trim() || 'text/plain';
      }
      if (body === '') body = null;
    }

    const spec = {
      method,
      url: finalUrl,
      headers,
      body,
      contentType,
      timeoutMs: clampTimeout(S.timeoutMs),
      followRedirects: S.followRedirects !== false,
    };
    return { spec, preview: previewText(spec, S) };
  }

  function previewText(spec, S) {
    const lines = [`${spec.method} ${spec.url}`];
    const hs = Object.entries(spec.headers);
    lines.push('', `Headers (${hs.length})`);
    lines.push(...(hs.length ? hs.map(([k, v]) => `  ${k}: ${v}`) : ['  —']));
    if (spec.body != null) {
      const shown = spec.body.length > 4000
        ? `${spec.body.slice(0, 4000)}\n… (共 ${spec.body.length} 字节)`
        : spec.body;
      lines.push('', `Body · ${spec.contentType}`, shown);
    }
    if (S.authMode !== 'none') {
      lines.push('', `Auth · ${S.authMode === 'bearer' ? 'Bearer' : 'Basic'}（已并入 Authorization 头）`);
    }
    if (NO_BODY.has(spec.method)) lines.push('', '注：GET / HEAD 不发送请求体');
    lines.push('', `超时 ${spec.timeoutMs}ms · ${spec.followRedirects ? '跟随重定向' : '不跟随重定向'}`);
    return lines.join('\n');
  }

  /** Pretty JSON as a highlighted DOM fragment (built with textContent, no innerHTML). */
  function highlightJson(text) {
    const frag = document.createDocumentFragment();
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      if (m[1] !== undefined) {
        span.className = m[2] ? 'j-key' : 'j-str';
        span.textContent = m[1];
        frag.appendChild(span);
        if (m[2]) frag.appendChild(document.createTextNode(m[2]));
      } else if (m[3] !== undefined) {
        span.className = 'j-lit';
        span.textContent = m[3];
        frag.appendChild(span);
      } else {
        span.className = 'j-num';
        span.textContent = m[4];
        frag.appendChild(span);
      }
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
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

  function initialState() {
    return {
      method: 'GET',
      url: '',
      params: [blankRow()],
      headers: [blankRow()],
      bodyMode: 'none',
      json: '{\n  "hello": "world"\n}',
      form: [blankRow()],
      raw: '',
      rawType: 'text/plain',
      authMode: 'none',
      bearer: '',
      basicUser: '',
      basicPass: '',
      env: [blankRow()],
      timeoutMs: 30000,
      followRedirects: true,
      reqTab: 'params',
      respTab: 'body',
    };
  }

  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  function saveStore(patch) {
    const next = { ...loadStore(), ...patch };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
    return next;
  }

  // -------------------------------------------------------------------- mount

  function mount(root, host) {
    const store = loadStore();
    const S = { ...initialState(), ...(store.draft || {}) };
    // A list with no rows has nothing to type into.
    for (const key of ['params', 'headers', 'form', 'env']) {
      if (!Array.isArray(S[key]) || !S[key].length) S[key] = [blankRow()];
    }
    S.timeoutMs = clampTimeout(S.timeoutMs);
    S.reqTab = 'params';
    S.respTab = 'body';

    let history = Array.isArray(store.history) ? store.history : [];
    let favorites = Array.isArray(store.favorites) ? store.favorites : [];
    let lastBytes = null;
    let lastResult = null;
    let sending = false;

    const persistDraft = () => saveStore({ draft: S });

    // ---- top bar ---------------------------------------------------------

    const methodSel = el('select', {
      class: 'method', onchange: (e) => { S.method = e.target.value; after(); },
    }, METHODS.map((m) => el('option', { value: m, text: m, selected: m === S.method })));

    const urlInput = el('input', {
      class: 'url', type: 'text', spellcheck: 'false',
      placeholder: 'https://api.example.com/v1/users', value: S.url,
      oninput: (e) => { S.url = e.target.value; after(); },
    });

    const sendBtn = el('button', { class: 'send', text: '发送', onclick: () => send() });

    const timeoutInput = el('input', {
      class: 'num', type: 'number', min: '1000', max: '120000', step: '1000',
      value: String(S.timeoutMs),
      oninput: (e) => { S.timeoutMs = clampTimeout(e.target.value); persistDraft(); },
      onblur: (e) => { e.target.value = String(clampTimeout(S.timeoutMs)); },
    });

    const redirectChk = el('input', {
      type: 'checkbox', checked: S.followRedirects,
      onchange: (e) => { S.followRedirects = e.target.checked; after(); },
    });

    const bar = el('div', { class: 'bar' }, [methodSel, urlInput, sendBtn]);
    const meta = el('div', { class: 'meta' }, [
      el('label', {}, ['超时', timeoutInput, 'ms']),
      el('label', {}, [redirectChk, '跟随重定向']),
      el('span', { class: 'grow' }),
      el('button', { class: 'ghost', text: '历史 / 收藏', onclick: () => toggleDrawer() }),
    ]);

    // ---- request tabs ----------------------------------------------------

    const REQ_TABS = [
      ['params', 'Params'],
      ['headers', 'Headers'],
      ['body', 'Body'],
      ['auth', 'Auth'],
      ['env', '变量'],
      ['preview', '预览'],
    ];
    const reqTabs = el('div', { class: 'tabs' });
    const tabBtns = {};
    for (const [id, label] of REQ_TABS) {
      const badge = el('span', { class: 'badge', hidden: true });
      const btn = el('button', {
        class: id === S.reqTab ? 'on' : '', 'data-tab': id,
        onclick: () => { S.reqTab = id; syncReqTabs(); },
      }, [label, badge]);
      tabBtns[id] = { btn, badge };
      reqTabs.appendChild(btn);
    }

    // ---- request panes ---------------------------------------------------

    const panes = el('div', { class: 'panes' });
    const pane = (name) => el('div', { class: 'pane', 'data-pane': name });
    const paramsPane = pane('params');
    const headersPane = pane('headers');
    const bodyPane = pane('body');
    const authPane = pane('auth');
    const envPane = pane('env');
    const previewPane = pane('preview');
    const previewPre = el('pre', { class: 'preview' });
    previewPane.appendChild(previewPre);
    panes.append(paramsPane, headersPane, bodyPane, authPane, envPane, previewPane);

    const paramsEd = kvEditor(S.params, paramsPane, { keyPh: '参数名', valPh: '值', addLabel: '+ 添加参数', onChange: after });
    const headersEd = kvEditor(S.headers, headersPane, { keyPh: 'Header', valPh: '值', addLabel: '+ 添加 Header', onChange: after });
    const envEd = kvEditor(S.env, envPane, { keyPh: '变量名', valPh: '值', addLabel: '+ 添加变量', onChange: after });
    envPane.insertBefore(
      el('p', { class: 'hint', text: '在 URL、参数、Header、Body、Auth 里用 {{变量名}} 引用，发送前替换。' }),
      envPane.firstChild
    );

    // body
    const bodySeg = el('div', { class: 'seg' });
    for (const [id, label] of [['none', '无'], ['json', 'JSON'], ['form', '表单'], ['raw', '原文']]) {
      bodySeg.appendChild(el('button', {
        class: S.bodyMode === id ? 'on' : '', 'data-bm': id,
        onclick: () => { S.bodyMode = id; renderBody(); after(); },
      }, label));
    }

    const jsonArea = el('textarea', {
      spellcheck: 'false', placeholder: '{ "key": "value" }', value: S.json,
      oninput: (e) => { S.json = e.target.value; validateJson(); after(); },
    });
    const jsonErr = el('div', { class: 'err', hidden: true });
    const jsonBox = el('div', {}, [jsonArea, jsonErr]);

    const rawType = el('input', {
      class: 'ct', type: 'text', placeholder: 'Content-Type', value: S.rawType,
      oninput: (e) => { S.rawType = e.target.value; after(); },
    });
    const rawArea = el('textarea', {
      spellcheck: 'false', placeholder: '原文请求体', value: S.raw,
      oninput: (e) => { S.raw = e.target.value; after(); },
    });
    const rawBox = el('div', {}, [el('div', { class: 'ctrow' }, [rawType]), rawArea]);

    const formBox = el('div');
    const formEd = kvEditor(S.form, formBox, { keyPh: '字段', valPh: '值', addLabel: '+ 添加字段', onChange: after });

    bodyPane.append(bodySeg, jsonBox, formBox, rawBox);

    // auth
    const authSel = el('select', {
      class: 'method',
      onchange: (e) => { S.authMode = e.target.value; renderAuth(); after(); },
    }, [['none', '无'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth']]
      .map(([v, l]) => el('option', { value: v, text: l, selected: v === S.authMode })));
    const authFields = el('div', { class: 'authbox' });
    authPane.append(
      el('div', { class: 'authrow' }, [el('span', { class: 'lbl', text: '类型' }), authSel]),
      authFields
    );

    // ---- response --------------------------------------------------------

    const statusEl = el('span', { class: 'status', text: '未发送' });
    const respMeta = el('span', { class: 'muted' });
    const copyBtn = el('button', { class: 'ghost', text: '复制', hidden: true, onclick: () => copyResponse() });
    const exportBtn = el('button', { class: 'ghost', text: '导出二进制', hidden: true, onclick: () => exportBinary() });
    const respHead = el('div', { class: 'resp-head' }, [
      statusEl, respMeta, el('span', { class: 'grow' }), copyBtn, exportBtn,
    ]);

    const respTabs = el('div', { class: 'tabs' });
    const respTabBtns = {};
    for (const [id, label] of [['body', '响应体'], ['headers', '响应头']]) {
      const btn = el('button', {
        class: id === S.respTab ? 'on' : '',
        onclick: () => { S.respTab = id; syncRespTabs(); },
      }, label);
      respTabBtns[id] = btn;
      respTabs.appendChild(btn);
    }

    const respBody = el('div', { class: 'resp-body empty', text: '填好请求后点「发送」；⌘⏎ 也可以。' });
    const resp = el('div', { class: 'resp' }, [respHead, respTabs, respBody]);

    // ---- drawer ----------------------------------------------------------

    const drawerBody = el('div', { class: 'drawer-body' });
    const drawer = el('aside', { class: 'drawer', hidden: true }, [
      el('div', { class: 'drawer-head' }, [
        el('span', { class: 'grow', text: '历史 / 收藏' }),
        el('button', {
          class: 'ghost', text: '清空历史',
          onclick: () => { history = []; saveStore({ history }); renderDrawer(); toast('历史已清空'); },
        }),
        el('button', { class: 'ghost', text: '关闭', onclick: () => toggleDrawer(false) }),
      ]),
      drawerBody,
    ]);

    const toastEl = el('div', { class: 'toast' });

    root.append(bar, meta, reqTabs, panes, resp, drawer, toastEl);

    // ---- behaviour -------------------------------------------------------

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('on');
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toastEl.classList.remove('on'), 1600);
    }

    /** After any edit: refresh dependent views, then persist the draft. */
    function after() {
      syncBadges();
      if (S.reqTab === 'preview') refreshPreview();
      persistDraft();
    }

    function syncReqTabs() {
      for (const [id, { btn }] of Object.entries(tabBtns)) btn.classList.toggle('on', id === S.reqTab);
      for (const p of panes.children) p.classList.toggle('on', p.dataset.pane === S.reqTab);
      if (S.reqTab === 'preview') refreshPreview();
    }

    function syncRespTabs() {
      for (const [id, btn] of Object.entries(respTabBtns)) btn.classList.toggle('on', id === S.respTab);
      renderResponse();
    }

    function syncBadges() {
      const counts = {
        params: activeRows(S.params).length,
        headers: activeRows(S.headers).length,
        env: activeRows(S.env).length,
        body: S.bodyMode === 'none' ? 0 : 1,
        auth: S.authMode === 'none' ? 0 : 1,
      };
      for (const [id, { badge }] of Object.entries(tabBtns)) {
        const n = counts[id] || 0;
        badge.hidden = !n;
        badge.textContent = String(n);
      }
    }

    function refreshPreview() {
      const { preview, error } = buildRequest(S);
      previewPre.textContent = error ? `⚠️ ${error}` : preview;
    }

    function validateJson() {
      const text = String(S.json || '').trim();
      let bad = false;
      if (S.bodyMode === 'json' && text) {
        try { JSON.parse(text); } catch { bad = true; }
      }
      jsonArea.classList.toggle('bad', bad);
      jsonErr.hidden = !bad;
      jsonErr.textContent = bad ? 'JSON 语法有误，发送前请先修正' : '';
      return !bad;
    }

    function renderBody() {
      for (const b of bodySeg.children) b.classList.toggle('on', b.dataset.bm === S.bodyMode);
      jsonBox.hidden = S.bodyMode !== 'json';
      formBox.hidden = S.bodyMode !== 'form';
      rawBox.hidden = S.bodyMode !== 'raw';
      validateJson();
    }

    function renderAuth() {
      authFields.textContent = '';
      if (S.authMode === 'bearer') {
        authFields.appendChild(el('div', { class: 'row' }, [
          el('span', { class: 'lbl', text: 'Token' }),
          el('input', {
            type: 'text', placeholder: 'token', spellcheck: 'false', value: S.bearer,
            oninput: (e) => { S.bearer = e.target.value; after(); },
          }),
        ]));
      } else if (S.authMode === 'basic') {
        authFields.append(
          el('div', { class: 'row' }, [
            el('span', { class: 'lbl', text: '用户名' }),
            el('input', {
              type: 'text', placeholder: '用户名', spellcheck: 'false', value: S.basicUser,
              oninput: (e) => { S.basicUser = e.target.value; after(); },
            }),
          ]),
          el('div', { class: 'row' }, [
            el('span', { class: 'lbl', text: '密码' }),
            el('input', {
              type: 'password', placeholder: '密码', value: S.basicPass,
              oninput: (e) => { S.basicPass = e.target.value; after(); },
            }),
          ])
        );
      } else {
        authFields.appendChild(el('p', { class: 'hint', text: '不使用认证。' }));
      }
    }

    // ---- send ------------------------------------------------------------

    function snapshotRequest() {
      return {
        method: S.method, url: S.url,
        params: S.params.map((r) => ({ ...r })),
        headers: S.headers.map((r) => ({ ...r })),
        bodyMode: S.bodyMode, json: S.json,
        form: S.form.map((r) => ({ ...r })),
        raw: S.raw, rawType: S.rawType,
        authMode: S.authMode, bearer: S.bearer,
        basicUser: S.basicUser, basicPass: S.basicPass,
        env: S.env.map((r) => ({ ...r })),
      };
    }

    function restoreRequest(snap) {
      if (!snap) return;
      Object.assign(S, snap);
      for (const key of ['params', 'headers', 'form', 'env']) {
        if (!Array.isArray(S[key]) || !S[key].length) S[key] = [blankRow()];
      }
      methodSel.value = S.method;
      urlInput.value = S.url || '';
      paramsEd.set(S.params);
      headersEd.set(S.headers);
      envEd.set(S.env);
      formEd.set(S.form);
      jsonArea.value = S.json || '';
      rawArea.value = S.raw || '';
      rawType.value = S.rawType || '';
      renderBody();
      renderAuth();
      after();
      syncReqTabs();
    }

    function pushHistory(spec, result) {
      const entry = {
        ts: Date.now(),
        method: spec.method,
        url: spec.url,
        status: result && result.ok ? result.status : 0,
        request: snapshotRequest(),
      };
      const dup = history[0];
      if (dup && dup.url === entry.url && dup.method === entry.method) history.shift();
      history.unshift(entry);
      if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
      saveStore({ history });
      if (!drawer.hidden) renderDrawer();
    }

    async function send() {
      if (sending) return;
      if (!validateJson()) {
        S.reqTab = 'body';
        syncReqTabs();
        toast('JSON 语法有误');
        return;
      }
      const { spec, error } = buildRequest(S);
      if (error || !spec) {
        lastResult = null;
        lastBytes = null;
        statusEl.className = 'status err';
        statusEl.textContent = '请求未发出';
        respMeta.textContent = error || '';
        respBody.className = 'resp-body empty';
        respBody.textContent = error || '';
        copyBtn.hidden = true;
        exportBtn.hidden = true;
        toast(error || '请求不合法');
        return;
      }

      sending = true;
      sendBtn.disabled = true;
      sendBtn.textContent = '发送中…';
      statusEl.className = 'status';
      statusEl.textContent = '…';
      respMeta.textContent = '';
      try {
        const res = await host.apiSend(spec);
        renderResult(res);
        pushHistory(spec, res);
      } catch (err) {
        renderResult({ ok: false, error: String((err && err.message) || err) });
      } finally {
        sending = false;
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
      }
    }

    function renderResult(res) {
      lastResult = res || null;
      lastBytes = null;
      exportBtn.hidden = true;
      copyBtn.hidden = true;

      if (!res || res.ok !== true) {
        statusEl.className = 'status err';
        statusEl.textContent = '请求失败';
        respMeta.textContent = [res && res.error, res && res.timeMs != null ? `${res.timeMs} ms` : '']
          .filter(Boolean).join(' · ');
      } else {
        statusEl.className = `status ${statusClass(res.status)}`;
        statusEl.textContent = `${res.status} ${res.statusText || ''}`.trim();
        const bits = [`${res.timeMs} ms`, fmtSize(res.size)];
        if (res.mime) bits.push(res.mime.split(';')[0]);
        if (res.redirected) bits.push('已跟随重定向');
        respMeta.textContent = bits.filter(Boolean).join(' · ');

        const bytes = base64ToBytes(res.bodyB64);
        lastBytes = bytes;
        if (decodeText(bytes) == null) exportBtn.hidden = false;
      }
      renderResponse();
    }

    /** Single source of truth for the response area: re-renders whichever
     *  sub-tab is active, so switching tabs never loses the other one. */
    function renderResponse() {
      respBody.textContent = '';

      if (S.respTab === 'headers') {
        const headers = lastResult && lastResult.ok ? lastResult.headers : null;
        if (!headers || !Object.keys(headers).length) {
          respBody.className = 'resp-body empty';
          respBody.textContent = '暂无响应头';
          return;
        }
        respBody.className = 'resp-body';
        const table = el('table', { class: 'htab' });
        for (const [k, vals] of Object.entries(headers)) {
          for (const v of [].concat(vals)) {
            table.appendChild(el('tr', {}, [el('td', { text: k }), el('td', { text: String(v) })]));
          }
        }
        respBody.appendChild(table);
        return;
      }

      if (!lastResult) {
        respBody.className = 'resp-body empty';
        respBody.textContent = '填好请求后点「发送」；⌘⏎ 也可以。';
        return;
      }
      if (lastResult.ok !== true) {
        respBody.className = 'resp-body empty';
        respBody.textContent = lastResult.error || '未知错误';
        return;
      }

      const text = decodeText(lastBytes || new Uint8Array(0));
      if (text == null) {
        respBody.className = 'resp-body empty';
        respBody.textContent = `二进制内容 · ${fmtSize(lastBytes.length)}\n\n点右上角「导出二进制」保存。`;
        return;
      }
      if (!text) {
        respBody.className = 'resp-body empty';
        respBody.textContent = '（空响应体）';
        return;
      }

      copyBtn.hidden = false;
      respBody.className = 'resp-body';
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          respBody.appendChild(highlightJson(JSON.stringify(JSON.parse(trimmed), null, 2)));
          return;
        } catch { /* not JSON after all — fall through to plain text */ }
      }
      respBody.textContent = text;
    }

    function copyResponse() {
      const text = respBody.textContent || '';
      navigator.clipboard.writeText(text).then(
        () => toast('已复制响应'),
        () => toast('复制失败')
      );
    }

    function exportBinary() {
      if (!lastBytes) return;
      const mime = lastResult && lastResult.mime ? String(lastResult.mime) : '';
      const blob = new Blob([lastBytes], { type: mime || 'application/octet-stream' });
      const href = URL.createObjectURL(blob);
      const a = el('a', { href, download: `response.${extForMime(mime)}` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 5000);
    }

    // ---- drawer ----------------------------------------------------------

    function toggleDrawer(force) {
      const show = force === undefined ? drawer.hidden : force;
      drawer.hidden = !show;
      if (show) renderDrawer();
    }

    function renderDrawer() {
      drawerBody.textContent = '';
      const section = (title, list) => {
        drawerBody.appendChild(el('div', { class: 'group-title', text: title }));
        if (!list.length) {
          drawerBody.appendChild(el('div', { class: 'none', text: '暂无' }));
          return;
        }
        for (const entry of list) {
          const isFav = favorites.some((f) => f.ts === entry.ts && f.url === entry.url);
          drawerBody.appendChild(el('div', {
            class: 'item', title: entry.url,
            onclick: () => { restoreRequest(entry.request); toggleDrawer(false); },
          }, [
            el('span', { class: 'm', text: entry.method }),
            el('span', { class: 'u', text: entry.url }),
            el('button', {
              class: `act star${isFav ? ' on' : ''}`, text: isFav ? '★' : '☆', title: '收藏',
              onclick: (e) => { e.stopPropagation(); toggleFavorite(entry); },
            }),
            el('button', {
              class: 'act del', text: '✕', title: '删除',
              onclick: (e) => {
                e.stopPropagation();
                const i = list.indexOf(entry);
                if (i >= 0) list.splice(i, 1);
                saveStore({ history, favorites });
                renderDrawer();
              },
            }),
          ]));
        }
      };
      section('收藏', favorites);
      section('历史', history);
    }

    function toggleFavorite(entry) {
      const i = favorites.findIndex((f) => f.ts === entry.ts && f.url === entry.url);
      if (i >= 0) favorites.splice(i, 1);
      else favorites.unshift({ ...entry });
      saveStore({ favorites });
      renderDrawer();
      toast(i >= 0 ? '已取消收藏' : '已收藏');
    }

    // ---- keyboard --------------------------------------------------------

    root.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      } else if (e.key === 'Escape' && !drawer.hidden) {
        e.preventDefault();
        toggleDrawer(false);
      }
    });

    // ---- first paint -----------------------------------------------------

    syncReqTabs();
    renderBody();
    renderAuth();
    syncBadges();
    syncRespTabs();

    return { state: S, buildRequest: () => buildRequest(S), send, restoreRequest };
  }

  /**
   * Editable key/value list. Typing mutates the model in place (never re-renders,
   * so the caret stays put); only add / remove / toggle rebuild the rows.
   */
  function kvEditor(list, container, { keyPh, valPh, addLabel, onChange }) {
    const box = el('div', { class: 'kv' });
    const addBtn = el('button', {
      class: 'add', text: addLabel,
      onclick: () => { list.push(blankRow()); render(); onChange(); },
    });
    container.append(box, addBtn);

    function render() {
      box.textContent = '';
      list.forEach((row, i) => {
        const off = row.on === false;
        box.appendChild(el('div', { class: 'row' }, [
          el('input', {
            type: 'checkbox', checked: !off, title: '启用',
            onchange: (e) => { row.on = e.target.checked; render(); onChange(); },
          }),
          el('input', {
            class: `kv key${off ? ' off' : ''}`, type: 'text', spellcheck: 'false',
            placeholder: keyPh, value: row.k || '',
            oninput: (e) => { row.k = e.target.value; onChange(); },
          }),
          el('input', {
            class: `kv${off ? ' off' : ''}`, type: 'text', spellcheck: 'false',
            placeholder: valPh, value: row.v == null ? '' : String(row.v),
            oninput: (e) => { row.v = e.target.value; onChange(); },
          }),
          el('button', {
            class: 'del', text: '✕', title: '删除',
            onclick: () => {
              list.splice(i, 1);
              if (!list.length) list.push(blankRow());
              render();
              onChange();
            },
          }),
        ]));
      });
    }

    render();
    return {
      set: (next) => { list.length = 0; list.push(...next); render(); },
      render,
    };
  }

  G.SnapApiDebug = {
    mount, substitute, buildRequest, fmtSize, decodeText, highlightJson, initialState, clampTimeout,
  };
})(typeof window !== 'undefined' ? window : globalThis);
