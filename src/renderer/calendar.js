/* Snap calendar — a local, text-only calendar with 日/周/月/年 views.
 *
 * Every record is just «a date + some text» and lives in
 * userData/calendar.json (see main.js): no times, no system calendar, no
 * EventKit and therefore no extra permission.
 *
 * Right-click is the fast path: date cells offer 新建记录/粘贴, record cards
 * offer 编辑/复制/粘贴/删除.
 *
 * The pure date/text helpers are exported on window.SnapCalendar so
 * scripts/test-calendar-logic.js can exercise them without a DOM.
 */
'use strict';

(function (G) {
  // ---------------------------------------------------------------- constants

  const WEEK_START = 0;              // 0 = 周日，与系统日历一致
  const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
  const MONTH_ITEM_MAX = 3;          // 月视图每格最多显示几条，超出折叠成「+N」
  const COLORS = ['#1677ff', '#ff453a', '#ff9f0a', '#30d158', '#bf5af2', '#5ac8fa', '#8e8e93'];
  const DEFAULT_COLOR = COLORS[0];

  // Intl 的农历日永远是阿拉伯数字（8日 / 21日），拿不到「十七」「廿一」，
  // 所以日名走这张对照表，月名/闰月/年名才用 Intl。
  const LUNAR_DAYS = [
    '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
    '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
    '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
  ];

  // ---------------------------------------------------------------- date math

  const pad2 = (n) => String(n).padStart(2, '0');

  /** Local, timezone-free day key — the calendar's primary index. */
  function ymd(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function parseYmd(s) {
    const [y, m, d] = String(s || '').split('-').map(Number);
    if (!y || !m || !d) return new Date(NaN);
    return new Date(y, m - 1, d);
  }

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function atNoon(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  /** 某年某月（m 从 1 开始）的天数。 */
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

  /** Sunday-based week start (WEEK_START). */
  function startOfWeek(d) {
    const x = startOfDay(d);
    return addDays(x, -(((x.getDay() - WEEK_START) % 7 + 7) % 7));
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function isToday(d) { return sameDay(d, new Date()); }

  /** Always 6×7 so the grid doesn't jump height between months. */
  function monthGrid(date) {
    const start = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      cells.push({ date: day, key: ymd(day), inMonth: day.getMonth() === date.getMonth() });
    }
    return cells;
  }

  // ---------------------------------------------------------------- lunar

  const lunarMonthFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long' });
  const lunarDayFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { day: 'numeric' });
  const lunarYearFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { year: 'numeric' });

  /**
   * @returns {{month: string, day: string, dayNum: number, year: string}}
   *   month 带闰前缀（闰六月），year 是干支（丙午）——注意 ICU 的
   *   relatedYear 给的是公历年号，干支在 yearName 里。
   */
  function lunar(date) {
    const d = atNoon(date);
    const dayPart = lunarDayFmt.formatToParts(d).find((p) => p.type === 'day');
    const dayNum = Number(dayPart ? dayPart.value : 0);
    const yearPart = lunarYearFmt.formatToParts(d).find((p) => p.type === 'yearName');
    return {
      month: lunarMonthFmt.format(d),
      day: LUNAR_DAYS[dayNum - 1] || '',
      dayNum,
      year: yearPart ? yearPart.value : '',
    };
  }

  /** 月视图格子角上那行：初一显示月份名，其余显示日名。 */
  function lunarShort(date) {
    const l = lunar(date);
    return l.dayNum === 1 ? l.month : l.day;
  }

  // ---------------------------------------------------------------- records

  function recordColor(rec) {
    return (rec && rec.color) || DEFAULT_COLOR;
  }

  /**
   * 一条记录的正文。兼容旧版数据：以前日程把内容拆成 title / notes，
   * 现在统一合并成 text，时间字段直接忽略。
   */
  function recordText(rec) {
    if (!rec) return '';
    if (typeof rec.text === 'string' && rec.text.trim()) return rec.text;
    if (rec.kind === 'event') {
      return [rec.title, rec.notes]
        .filter((s) => typeof s === 'string' && s.trim())
        .join('\n');
    }
    return typeof rec.text === 'string' ? rec.text : '';
  }

  /** 卡片上显示的标题 = 第一行非空文字。 */
  function recordTitle(rec) {
    for (const line of recordText(rec).split('\n')) {
      const t = line.trim();
      if (t) return t;
    }
    return '（空记录）';
  }

  /** 同一天内的显示顺序：先写的在上。 */
  function compareRecords(a, b) {
    return (a.createdAt || 0) - (b.createdAt || 0);
  }

  function sortDayRecords(list) {
    return [...list].sort(compareRecords);
  }

  /** 新记录只保留「日期 + 文字 + 颜色」，其余旧字段在读写时自然丢掉。 */
  function normalizeRecord(rec) {
    if (!rec || typeof rec !== 'object' || !rec.id || !rec.date) return null;
    return {
      id: rec.id,
      date: rec.date,
      text: recordText(rec),
      color: recordColor(rec),
      createdAt: Number(rec.createdAt) || 0,
      updatedAt: Number(rec.updatedAt) || 0,
    };
  }

  /** 复制一条记录到另一天：新 id，文字/颜色照搬（源记录不变）。 */
  function copyRecord(rec, targetKey, id) {
    return {
      id: id || newId(),
      date: targetKey,
      text: recordText(rec),
      color: recordColor(rec),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /** 「复制到」的快捷目标：明天 / 后天 / 下周同天。 */
  function copyShortcuts(rec) {
    const base = parseYmd(rec && rec.date);
    if (Number.isNaN(base.getTime())) return [];
    return [
      ['明天', ymd(addDays(base, 1))],
      ['后天', ymd(addDays(base, 2))],
      ['下周同天', ymd(addDays(base, 7))],
    ];
  }

  /** 文字 / 日期的模糊匹配（大小写不敏感）。 */
  function matchesQuery(rec, q) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return true;
    const hay = `${recordText(rec)}\n${rec.date || ''}`.toLowerCase();
    return hay.includes(needle);
  }

  function searchRecords(records, q) {
    return (records || [])
      .filter((r) => matchesQuery(r, q))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || compareRecords(a, b));
  }

  /** ymd → 当天的记录数组（已排序）。 */
  function recordsByDay(records) {
    const map = new Map();
    for (const rec of records || []) {
      if (!rec || !rec.date) continue;
      if (!map.has(rec.date)) map.set(rec.date, []);
      map.get(rec.date).push(rec);
    }
    for (const list of map.values()) list.sort(compareRecords);
    return map;
  }

  // ---------------------------------------------------------------- titles

  function formatTitle(view, cursor) {
    const y = cursor.getFullYear();
    const m = cursor.getMonth() + 1;
    if (view === 'year') return `${y}年`;
    if (view === 'month') return `${y}年${m}月`;
    if (view === 'day') return `${y}年${m}月${cursor.getDate()}日 ${WEEKDAY_NAMES[cursor.getDay()]}`;
    const start = startOfWeek(cursor);
    const end = addDays(start, 6);
    if (start.getFullYear() !== end.getFullYear()) {
      return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 – ${end.getFullYear()}年${end.getMonth() + 1}月${end.getDate()}日`;
    }
    return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`;
  }

  // ---------------------------------------------------------------- dom helper

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.setAttribute('style', v);
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

  function newId() {
    return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function emptyStore() { return { version: 1, records: [] }; }

  // -------------------------------------------------------------------- mount

  function mount(root, host) {
    let store = emptyStore();
    let view = 'month';                       // day | week | month | year
    let cursor = startOfDay(new Date());
    let showLunar = true;
    let query = '';
    let editing = null;                       // {rec, isNew}
    let copyDate = null;                      // 「复制到」里手选的日期
    let clipboard = null;                     // 右键「复制」的记录快照（窗口内有效）
    let saveTimer = null;

    // ---- persistence -----------------------------------------------------

    async function load() {
      try {
        const data = await host.calendarLoad();
        const raw = Array.isArray(data && data.records) ? data.records : [];
        store = { version: 1, records: raw.map(normalizeRecord).filter(Boolean) };
      } catch {
        store = emptyStore();
      }
      render();
    }

    /** 写盘：离散操作（保存/删除）立即写，连续操作合并到 400ms 后。 */
    function persist(immediate) {
      clearTimeout(saveTimer);
      const write = () => {
        host.calendarSave(store).then((res) => {
          if (res && res.ok === false) toast(`保存失败：${res.error}`);
        }).catch(() => {});
      };
      if (immediate) write();
      else saveTimer = setTimeout(write, 400);
    }

    function upsert(rec) {
      const i = store.records.findIndex((r) => r.id === rec.id);
      if (i >= 0) store.records[i] = rec;
      else store.records.push(rec);
    }

    function removeRecord(id) {
      store.records = store.records.filter((r) => r.id !== id);
    }

    // ---- chrome ----------------------------------------------------------

    const viewSeg = el('div', { class: 'cal-seg' });
    for (const [id, label] of [['day', '日'], ['week', '周'], ['month', '月'], ['year', '年']]) {
      viewSeg.appendChild(el('button', {
        class: 'cal-viewbtn', 'data-view': id, text: label,
        onclick: () => setView(id),
      }));
    }

    const titleEl = el('div', { class: 'cal-title' });
    const searchInput = el('input', {
      class: 'cal-search', type: 'search', placeholder: '搜索记录', spellcheck: 'false',
      oninput: (e) => { query = e.target.value; renderSearch(); },
    });
    const searchBox = el('div', { class: 'cal-searchbox', hidden: true });

    const lunarBtn = el('button', {
      class: 'cal-ghost on', text: '农历', title: '显示/隐藏农历',
      onclick: () => {
        showLunar = !showLunar;
        lunarBtn.classList.toggle('on', showLunar);
        render();
      },
    });

    const bar = el('div', { class: 'cal-bar' }, [
      viewSeg,
      el('button', { class: 'cal-new', text: '+ 新建', title: '新建记录（⌘N）· 右键任意日期也能新建', onclick: () => openEditor(null, cursor) }),
      titleEl,
      el('div', { class: 'cal-spacer' }),
      el('div', { class: 'cal-nav' }, [
        el('button', { class: 'cal-ghost', text: '‹', title: '上一页', onclick: () => step(-1) }),
        el('button', { class: 'cal-ghost', text: '今天', onclick: () => goToday() }),
        el('button', { class: 'cal-ghost', text: '›', title: '下一页', onclick: () => step(1) }),
      ]),
      lunarBtn,
      el('div', { class: 'cal-searchwrap' }, [searchInput, searchBox]),
    ]);

    const body = el('div', { class: 'cal-body' });
    const modalHost = el('div', { class: 'cal-modalhost' });
    const toastEl = el('div', { class: 'cal-toast' });
    const menuEl = el('div', { class: 'cal-menu', hidden: true });

    root.append(bar, body, modalHost, toastEl, menuEl);

    function toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('on');
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toastEl.classList.remove('on'), 1800);
    }

    // ---- context menu ----------------------------------------------------

    let menuReturnFocus = null;

    function closeMenu() {
      if (menuEl.hidden) return;
      menuEl.hidden = true;
      menuEl.textContent = '';
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onMenuKeydown, true);
      if (menuReturnFocus && menuReturnFocus.isConnected) menuReturnFocus.focus();
      menuReturnFocus = null;
    }

    function onDocPointerDown(e) {
      if (!menuEl.contains(e.target)) closeMenu();
    }

    function onMenuKeydown(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }

    /** head 是菜单顶部那行说明；items 里 '-' 表示分隔线。 */
    function openMenu(x, y, head, items) {
      closeMenu();
      menuReturnFocus = document.activeElement;
      menuEl.textContent = '';
      if (head) menuEl.appendChild(el('div', { class: 'cal-menu-head', text: head, title: head }));
      for (const item of items) {
        if (!item) continue;
        if (item === '-') { menuEl.appendChild(el('div', { class: 'cal-menu-sep' })); continue; }
        menuEl.appendChild(el('button', {
          class: `cal-menu-item${item.danger ? ' danger' : ''}`,
          text: item.label,
          onclick: (e) => {
            e.stopPropagation();
            closeMenu();
            item.run();
          },
        }));
      }
      menuEl.hidden = false;
      // 先放到左上角量尺寸，再按窗口边界夹住，免得贴边时被裁掉
      menuEl.style.left = '0px';
      menuEl.style.top = '0px';
      const box = menuEl.getBoundingClientRect();
      const pad = 8;
      menuEl.style.left = `${Math.max(pad, Math.min(x, window.innerWidth - box.width - pad))}px`;
      menuEl.style.top = `${Math.max(pad, Math.min(y, window.innerHeight - box.height - pad))}px`;
      const first = menuEl.querySelector('.cal-menu-item');
      if (first) first.focus();
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('keydown', onMenuKeydown, true);
    }

    // 菜单开着时页面滚动/窗口缩放，直接收起，避免菜单和内容错位
    root.addEventListener('scroll', () => closeMenu(), true);
    window.addEventListener('resize', () => closeMenu());

    function dayHead(key) {
      const d = parseYmd(key);
      return Number.isNaN(d.getTime()) ? String(key) : formatTitle('day', d);
    }

    function copyRecordToClipboard(rec) {
      clipboard = { ...rec };
      toast(`已复制「${recordTitle(rec)}」`);
    }

    function pasteClipboard(targetKey) {
      if (!clipboard) return;
      upsert(copyRecord(clipboard, targetKey));
      persist(true);
      render();
      toast(`已粘贴到 ${dayHead(targetKey)}`);
    }

    function deleteRecord(rec) {
      removeRecord(rec.id);
      persist(true);
      render();
      toast('已删除');
    }

    /** 空白日期：新建，或把剪贴板里的记录贴到这一天。 */
    function openDateMenu(x, y, key) {
      const items = [{ label: '新建记录', run: () => openEditor(null, key) }];
      if (clipboard) {
        items.push('-', { label: `粘贴「${recordTitle(clipboard)}」`, run: () => pasteClipboard(key) });
      }
      openMenu(x, y, dayHead(key), items);
    }

    /** 记录本身：编辑 / 复制 / 粘贴到当天 / 删除。 */
    function openRecordMenu(x, y, rec) {
      const items = [
        { label: '编辑', run: () => openEditor(rec) },
        { label: '复制', run: () => copyRecordToClipboard(rec) },
      ];
      if (clipboard) {
        items.push({ label: `粘贴到 ${dayHead(rec.date)}`, run: () => pasteClipboard(rec.date) });
      }
      items.push('-', { label: '删除', danger: true, run: () => deleteRecord(rec) });
      openMenu(x, y, recordTitle(rec), items);
    }

    // ---- navigation ------------------------------------------------------

    function setView(next) {
      view = next;
      for (const b of viewSeg.children) b.classList.toggle('on', b.dataset.view === next);
      render();
    }

    function step(dir) {
      if (view === 'day') cursor = addDays(cursor, dir);
      else if (view === 'week') cursor = addDays(cursor, dir * 7);
      else if (view === 'month') cursor = addMonths(cursor, dir);
      else cursor = new Date(cursor.getFullYear() + dir, cursor.getMonth(), 1);
      render();
    }

    function goToday() {
      cursor = startOfDay(new Date());
      render();
    }

    function goTo(dateKey, nextView) {
      const d = parseYmd(dateKey);
      if (!Number.isNaN(d.getTime())) cursor = startOfDay(d);
      if (nextView) view = nextView;
      setView(view);
    }

    // ---- editor ----------------------------------------------------------

    function blankRecord(dateKey) {
      // dateKey 可能传进来的是 Date（例如从 cursor 直接新建），统一存成 ymd
      // 字符串，否则记录不会出现在日历格子里（分桶按字符串键）。
      const key = dateKey instanceof Date ? ymd(dateKey) : (dateKey || ymd(cursor));
      return {
        id: newId(),
        date: key,
        text: '',
        color: DEFAULT_COLOR,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    function openEditor(rec, dateKey) {
      editing = rec
        ? { rec: { ...rec }, isNew: false }
        : { rec: blankRecord(dateKey), isNew: true };
      copyDate = null;
      renderModal({ focus: true });
    }

    function closeEditor() {
      editing = null;
      modalHost.textContent = '';
    }

    function commitEditor() {
      if (!editing) return;
      const rec = editing.rec;
      rec.text = String(rec.text || '').trim();
      if (!rec.text) { toast('内容不能为空'); return; }
      rec.updatedAt = Date.now();
      upsert(rec);
      persist(true);
      closeEditor();
      render();
    }

    function deleteEditing() {
      if (!editing) return;
      const rec = editing.rec;
      if (!editing.isNew) removeRecord(rec.id);
      persist(true);
      closeEditor();
      render();
      toast('已删除');
    }

    /**
     * 把当前记录复制到另一天。还没保存过的新记录会先落盘，这样
     * 「今天新建 → 复制到另外几天」可以一步走完，复制完对话框不关，
     * 方便连着复制到好几天。
     */
    function doCopy(targetKey) {
      if (!editing || !targetKey) return;
      const rec = editing.rec;
      if (!String(rec.text || '').trim()) { toast('内容不能为空'); return; }
      if (editing.isNew) {
        rec.updatedAt = Date.now();
        upsert(rec);
        editing.isNew = false;
        persist(true);
      }
      upsert(copyRecord(rec, targetKey));
      persist(true);
      render();
      renderModal();
      toast(`已复制到 ${targetKey}`);
    }

    function renderModal({ focus = false } = {}) {
      modalHost.textContent = '';
      if (!editing) return;
      const rec = editing.rec;

      const fields = el('div', { class: 'cal-fields' });

      fields.appendChild(el('label', { class: 'cal-field' }, [
        el('span', { text: '日期' }),
        el('input', {
          class: 'cal-input', type: 'date', value: rec.date,
          oninput: (e) => { if (e.target.value) rec.date = e.target.value; },
        }),
      ]));

      fields.appendChild(el('label', { class: 'cal-field cal-block' }, [
        el('span', { text: '内容' }),
        el('textarea', {
          class: 'cal-input cal-notes', placeholder: '记一笔…', value: rec.text || '',
          oninput: (e) => { rec.text = e.target.value; },
        }),
      ]));

      const swatches = el('div', { class: 'cal-swatches' });
      for (const c of COLORS) {
        swatches.appendChild(el('button', {
          class: `cal-swatch${rec.color === c ? ' on' : ''}`,
          style: `background:${c}`, title: c,
          onclick: () => { rec.color = c; renderModal(); },
        }));
      }
      fields.appendChild(el('div', { class: 'cal-field cal-inline' }, [el('span', { text: '颜色' }), swatches]));

      const copyRow = el('div', { class: 'cal-field cal-copy' }, [
        el('span', { text: '复制到' }),
        el('div', { class: 'cal-copybody' }, [
          el('div', { class: 'cal-copyquick' }, [
            ...copyShortcuts(rec).map(([label, key]) => el('button', {
              class: 'cal-ghost', text: label, title: key,
              onclick: () => doCopy(key),
            })),
          ]),
          el('div', { class: 'cal-copycustom' }, [
            el('input', {
              class: 'cal-input', type: 'date',
              value: copyDate || ymd(addDays(parseYmd(rec.date), 1)),
              oninput: (e) => { copyDate = e.target.value; },
            }),
            el('button', {
              class: 'cal-ghost', text: '复制',
              onclick: () => doCopy(copyDate || ymd(addDays(parseYmd(rec.date), 1))),
            }),
          ]),
        ]),
      ]);

      const dialog = el('div', { class: 'cal-dialog' }, [
        el('div', { class: 'cal-dialog-head' }, [
          el('div', { class: 'cal-dialog-title', text: editing.isNew ? '新建记录' : '编辑记录' }),
          el('div', { class: 'cal-spacer' }),
          el('button', { class: 'cal-ghost', text: '✕', title: '关闭（Esc）', onclick: () => closeEditor() }),
        ]),
        fields,
        copyRow,
        el('div', { class: 'cal-dialog-foot' }, [
          editing.isNew ? null : el('button', { class: 'cal-danger', text: '删除', onclick: () => deleteEditing() }),
          el('div', { class: 'cal-spacer' }),
          el('button', { class: 'cal-ghost', text: '取消', onclick: () => closeEditor() }),
          el('button', { class: 'cal-primary', text: '保存', title: '⌘⏎', onclick: () => commitEditor() }),
        ]),
      ]);

      const backdrop = el('div', {
        class: 'cal-backdrop',
        onclick: (e) => { if (e.target === backdrop) closeEditor(); },
      }, [dialog]);

      modalHost.appendChild(backdrop);
      if (focus) {
        const focusTarget = dialog.querySelector('textarea.cal-input') || dialog.querySelector('input.cal-input');
        if (focusTarget) focusTarget.focus();
      }
    }

    // ---- rendering -------------------------------------------------------

    /** 月视图的小条：只显示第一行文字。 */
    function itemChip(rec) {
      return el('div', {
        class: 'cal-item',
        style: `--c:${recordColor(rec)}`,
        title: recordText(rec).trim() || '（空记录）',
        onclick: (e) => { e.stopPropagation(); openEditor(rec); },
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openRecordMenu(e.clientX, e.clientY, rec);
        },
      }, [
        el('span', { class: 'cal-dot' }),
        el('span', { class: 'cal-item-text', text: recordTitle(rec) }),
      ]);
    }

    /** 周/日视图的卡片：显示完整文字（多行自动换行）。 */
    function entryCard(rec) {
      const text = recordText(rec).trim() || '（空记录）';
      return el('div', {
        class: 'cal-entry',
        style: `--c:${recordColor(rec)}`,
        title: text,
        onclick: (e) => { e.stopPropagation(); openEditor(rec); },
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openRecordMenu(e.clientX, e.clientY, rec);
        },
      }, [el('div', { class: 'cal-entry-text', text })]);
    }

    function dayNumberCell(day, { muted }) {
      const today = isToday(day);
      const cell = el('div', {
        class: `cal-cell${muted ? ' out' : ''}${today ? ' today' : ''}`,
        'data-key': ymd(day),
      });

      const head = el('div', { class: 'cal-cellhead' }, [
        showLunar ? el('span', { class: 'cal-lunar', text: lunarShort(day) }) : el('span', { class: 'cal-lunar' }),
        el('span', { class: 'cal-spacer' }),
        el('span', { class: 'cal-daynum', text: String(day.getDate()) }),
      ]);
      cell.appendChild(head);
      return cell;
    }

    function renderMonth(map) {
      const wrap = el('div', { class: 'cal-month' });

      const head = el('div', { class: 'cal-weekhead' });
      for (const n of WEEKDAY_NAMES) head.appendChild(el('div', { class: 'cal-weekname', text: n }));
      wrap.appendChild(head);

      const grid = el('div', { class: 'cal-grid' });
      for (const c of monthGrid(cursor)) {
        const cell = dayNumberCell(c.date, { muted: !c.inMonth });
        const list = sortDayRecords(map.get(c.key) || []);

        const items = el('div', { class: 'cal-items' });
        for (const rec of list.slice(0, MONTH_ITEM_MAX)) items.appendChild(itemChip(rec));
        if (list.length > MONTH_ITEM_MAX) {
          items.appendChild(el('div', {
            class: 'cal-more', text: `+${list.length - MONTH_ITEM_MAX} 更多`,
            onclick: (e) => { e.stopPropagation(); goTo(c.key, 'day'); },
          }));
        }
        cell.appendChild(items);

        if (!c.inMonth) cell.classList.add('dim');
        cell.addEventListener('click', () => {
          goTo(c.key, 'day');
        });
        cell.addEventListener('dblclick', () => openEditor(null, c.key));
        cell.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openDateMenu(e.clientX, e.clientY, c.key);
        });
        grid.appendChild(cell);
      }
      wrap.appendChild(grid);
      return wrap;
    }

    function renderYear(map) {
      const wrap = el('div', { class: 'cal-year' });
      for (let m = 0; m < 12; m++) {
        const first = new Date(cursor.getFullYear(), m, 1);
        const box = el('div', { class: 'cal-mini' });
        box.appendChild(el('div', {
          class: 'cal-mini-title', text: `${m + 1}月`,
          onclick: () => { cursor = first; setView('month'); },
        }));

        const head = el('div', { class: 'cal-mini-head' });
        for (const n of WEEKDAY_SHORT) head.appendChild(el('span', { text: n }));
        box.appendChild(head);

        const cells = el('div', { class: 'cal-mini-grid' });
        for (const c of monthGrid(first)) {
          const day = c.date;
          const has = (map.get(c.key) || []).length > 0;
          const cell = el('div', {
            class: `cal-mini-cell${c.inMonth ? '' : ' out'}${isToday(day) ? ' today' : ''}${has ? ' has' : ''}`,
            'data-key': c.key,
            text: String(day.getDate()),
            onclick: () => goTo(c.key, 'day'),
            oncontextmenu: (e) => {
              e.preventDefault();
              openDateMenu(e.clientX, e.clientY, c.key);
            },
          });
          cells.appendChild(cell);
        }
        box.appendChild(cells);
        wrap.appendChild(box);
      }
      return wrap;
    }

    function renderWeek(map) {
      const start = startOfWeek(cursor);
      const days = [];
      for (let i = 0; i < 7; i++) days.push(addDays(start, i));

      const wrap = el('div', { class: 'cal-week' });

      const head = el('div', { class: 'cal-week-days' });
      for (const day of days) {
        head.appendChild(el('div', {
          class: `cal-week-day${isToday(day) ? ' today' : ''}`,
          onclick: () => goTo(ymd(day), 'day'),
          oncontextmenu: (e) => {
            e.preventDefault();
            openDateMenu(e.clientX, e.clientY, ymd(day));
          },
        }, [
          el('span', { class: 'cal-week-dayname', text: WEEKDAY_NAMES[day.getDay()] }),
          el('span', { class: 'cal-week-daynum', text: String(day.getDate()) }),
          showLunar ? el('span', { class: 'cal-week-lunar', text: lunarShort(day) }) : null,
        ]));
      }

      const body = el('div', { class: 'cal-week-body' });
      for (const day of days) {
        const key = ymd(day);
        const list = sortDayRecords(map.get(key) || []);
        const col = el('div', {
          class: `cal-week-col${isToday(day) ? ' today' : ''}`,
          'data-key': key,
          onclick: (e) => { if (e.target === col) openEditor(null, key); },
          oncontextmenu: (e) => {
            if (e.target !== col) return;
            e.preventDefault();
            openDateMenu(e.clientX, e.clientY, key);
          },
        });
        for (const rec of list) col.appendChild(entryCard(rec));
        body.appendChild(col);
      }

      wrap.append(head, body);
      return wrap;
    }

    function renderDay(map) {
      const key = ymd(cursor);
      const list = sortDayRecords(map.get(key) || []);
      const l = lunar(cursor);

      const wrap = el('div', { class: 'cal-day' });
      wrap.appendChild(el('div', { class: 'cal-day-head' }, [
        el('div', { class: 'cal-day-big', text: `${cursor.getMonth() + 1}月${cursor.getDate()}日` }),
        el('div', {
          class: 'cal-day-sub',
          text: `${cursor.getFullYear()}年 ${WEEKDAY_NAMES[cursor.getDay()]}${showLunar ? ` · 农历${l.month}${l.day}` : ''} · ${list.length} 条`,
        }),
      ]));

      const listBox = el('div', {
        class: 'cal-day-list',
        onclick: (e) => { if (e.target === listBox) openEditor(null, key); },
        oncontextmenu: (e) => {
          if (e.target !== listBox) return;
          e.preventDefault();
          openDateMenu(e.clientX, e.clientY, key);
        },
      });

      if (!list.length) {
        listBox.appendChild(el('div', { class: 'cal-day-empty', text: '这天还没有记录，点击空白处写一条' }));
      } else {
        for (const rec of list) listBox.appendChild(entryCard(rec));
      }

      wrap.appendChild(listBox);
      return wrap;
    }

    function renderSearch() {
      searchBox.textContent = '';
      const q = query.trim();
      if (!q) { searchBox.hidden = true; return; }
      const hits = searchRecords(store.records, q).slice(0, 40);
      searchBox.hidden = false;
      searchBox.appendChild(el('div', { class: 'cal-searchhead', text: hits.length ? `找到 ${hits.length} 条` : '没有匹配的记录' }));
      for (const rec of hits) {
        searchBox.appendChild(el('div', {
          class: 'cal-searchhit',
          style: `--c:${recordColor(rec)}`,
          onclick: () => {
            goTo(rec.date, 'day');
            searchInput.value = '';
            query = '';
            renderSearch();
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            openRecordMenu(e.clientX, e.clientY, rec);
          },
        }, [
          el('span', { class: 'cal-dot' }),
          el('span', { class: 'cal-searchdate', text: rec.date }),
          el('span', { class: 'cal-item-text', text: recordTitle(rec) }),
        ]));
      }
    }

    function render() {
      titleEl.textContent = formatTitle(view, cursor);
      const map = recordsByDay(store.records);
      body.textContent = '';
      if (view === 'month') body.appendChild(renderMonth(map));
      else if (view === 'year') body.appendChild(renderYear(map));
      else if (view === 'week') body.appendChild(renderWeek(map));
      else body.appendChild(renderDay(map));
      renderSearch();
    }

    // ---- keyboard --------------------------------------------------------

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (editing) { e.preventDefault(); closeEditor(); }
        else if (query) { e.preventDefault(); searchInput.value = ''; query = ''; renderSearch(); }
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 'Enter' && editing) { e.preventDefault(); commitEditor(); return; }
      if (meta && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); openEditor(null, cursor); return; }
      if (editing || !meta) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    });

    // ---- first paint -----------------------------------------------------

    setView('month');
    load();
    host.calendarPath().then((p) => { if (p) root.dataset.storePath = p; }).catch(() => {});

    return {
      state: () => ({ view, cursor: ymd(cursor), records: store.records.length, query, editing: !!editing }),
      goTo, setView, openEditor, commitEditor, closeEditor, render,
      store: () => store,
    };
  }

  G.SnapCalendar = {
    mount,
    // pure helpers, exercised by scripts/test-calendar-logic.js
    ymd, parseYmd, startOfDay, addDays, addMonths, startOfWeek, daysInMonth, monthGrid, sameDay,
    lunar, lunarShort, LUNAR_DAYS,
    recordText, recordTitle, recordColor, normalizeRecord, sortDayRecords, recordsByDay,
    compareRecords, copyRecord, copyShortcuts,
    matchesQuery, searchRecords, formatTitle, emptyStore,
    COLORS, WEEKDAY_NAMES, WEEKDAY_SHORT, MONTH_ITEM_MAX,
  };
})(typeof window !== 'undefined' ? window : globalThis);
