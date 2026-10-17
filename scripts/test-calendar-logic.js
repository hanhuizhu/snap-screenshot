#!/usr/bin/env node
/* Regression tests for the calendar's pure logic (no DOM needed).
 *
 *   npm run test:calendar
 *
 * The lunar assertions use dates taken from a real macOS Calendar month grid,
 * so they pin the behaviour that the UI is supposed to reproduce.
 */
'use strict';

require('../src/renderer/calendar.js');
const C = globalThis.SnapCalendar;

let passed = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || 'value'}: got ${a}, want ${b}`);
}

function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected truthy');
}

const d = (y, m, day) => new Date(y, m - 1, day);

// ---------------------------------------------------------------- date math

console.log('\n日期计算');

t('ymd / parseYmd 往返一致', () => {
  eq(C.ymd(d(2026, 10, 17)), '2026-10-17');
  eq(C.ymd(d(2026, 1, 5)), '2026-01-05');
  eq(C.ymd(C.parseYmd('2026-10-17')), '2026-10-17');
});

t('parseYmd 对坏输入返回 Invalid Date', () => {
  ok(Number.isNaN(C.parseYmd('').getTime()));
  ok(Number.isNaN(C.parseYmd('2026-10').getTime()));
});

t('startOfWeek 以周日为一周起点', () => {
  // 2026-10-17 是周六，本周起点应为 10-11（周日）
  eq(C.ymd(C.startOfWeek(d(2026, 10, 17))), '2026-10-11');
  eq(C.ymd(C.startOfWeek(d(2026, 10, 11))), '2026-10-11', '周日自身');
  eq(C.ymd(C.startOfWeek(d(2026, 10, 12))), '2026-10-11', '周一归到前一个周日');
  eq(C.ymd(C.startOfWeek(d(2026, 10, 18))), '2026-10-18', '下一个周日是新一周');
});

t('addDays / addMonths 跨月跨年正确', () => {
  eq(C.ymd(C.addDays(d(2026, 10, 31), 1)), '2026-11-01');
  eq(C.ymd(C.addDays(d(2027, 1, 1), -1)), '2026-12-31');
  eq(C.ymd(C.addMonths(d(2026, 1, 31), 1)), '2026-02-01');
  eq(C.ymd(C.addMonths(d(2026, 12, 15), 1)), '2027-01-01');
});

t('daysInMonth 2024/2026 二月与 30 天月份', () => {
  eq(C.daysInMonth(2024, 2), 29, '2024-02');
  eq(C.daysInMonth(2026, 2), 28, '2026-02');
  eq(C.daysInMonth(2026, 4), 30, '2026-04');
  eq(C.daysInMonth(2026, 12), 31, '2026-12');
});

// ---------------------------------------------------------------- month grid

console.log('\n月网格');

t('月网格恒为 6×7 = 42 格', () => {
  eq(C.monthGrid(d(2026, 10, 17)).length, 42);
  eq(C.monthGrid(d(2026, 2, 1)).length, 42);
});

t('月网格起止与系统日历一致（2026 年 10 月：9/27 – 11/7）', () => {
  const cells = C.monthGrid(d(2026, 10, 17));
  eq(cells[0].key, '2026-09-27', '首格');
  eq(cells[41].key, '2026-11-07', '末格');
  eq(cells[0].inMonth, false);
  eq(cells[41].inMonth, false);
});

t('月网格完整覆盖当月每一天且 inMonth 正确', () => {
  const cells = C.monthGrid(d(2026, 10, 17));
  const inMonth = cells.filter((c) => c.inMonth).map((c) => Number(c.key.slice(-2)));
  eq(inMonth.length, 31, '当月天数');
  eq(inMonth[0], 1);
  eq(inMonth[30], 31);
});

t('跨年月份（2026 年 1 月）首格落在上一年', () => {
  const cells = C.monthGrid(d(2026, 1, 15));
  eq(cells[0].key, '2025-12-28');
});

// ---------------------------------------------------------------- lunar

console.log('\n农历');

t('农历日名：与系统日历截图逐日核对', () => {
  eq(C.lunar(d(2026, 9, 27)).day, '十七', '2026-09-27');
  eq(C.lunar(d(2026, 10, 1)).day, '廿一', '2026-10-01');
  eq(C.lunar(d(2026, 10, 17)).day, '初八', '2026-10-17');
  eq(C.lunar(d(2026, 10, 27)).day, '十八', '2026-10-27');
  eq(C.lunar(d(2027, 2, 6)).day, '三十', '2027-02-06');
});

t('农历月名与干支年名', () => {
  eq(C.lunar(d(2026, 10, 17)).month, '九月');
  eq(C.lunar(d(2026, 10, 1)).month, '八月');
  eq(C.lunar(d(2027, 2, 6)).month, '腊月');
  eq(C.lunar(d(2026, 10, 17)).year, '丙午');
});

t('日号在 1..30 且日名表一一对应', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const day = C.addDays(d(2026, 1, 1), i);
    const l = C.lunar(day);
    ok(l.dayNum >= 1 && l.dayNum <= 30, `${C.ymd(day)} dayNum=${l.dayNum}`);
    eq(l.day, C.LUNAR_DAYS[l.dayNum - 1], `${C.ymd(day)} 日名`);
    seen.add(l.dayNum);
  }
  ok(seen.size >= 29, `一年内应覆盖 29/30 个日号，实际 ${seen.size}`);
});

t('初一显示月份名，其余显示日名', () => {
  let firstDayFound = null;
  for (let i = 0; i < 90; i++) {
    const day = C.addDays(d(2026, 9, 1), i);
    if (C.lunar(day).dayNum === 1) { firstDayFound = day; break; }
  }
  ok(firstDayFound, '应能找到农历初一');
  eq(C.lunarShort(firstDayFound), C.lunar(firstDayFound).month);
  const other = C.addDays(firstDayFound, 1);
  eq(C.lunarShort(other), C.lunar(other).day);
});

// ---------------------------------------------------------------- records

console.log('\n记录模型');

const note = (over) => Object.assign({
  id: 'x', date: '2026-10-17', text: '买牛奶', color: '#1677ff',
  createdAt: 1000, updatedAt: 1000,
}, over);

t('normalizeRecord：旧日程的标题/备注合并成正文，时间字段丢掉', () => {
  const rec = C.normalizeRecord({
    id: 'a', kind: 'event', date: '2026-10-17', title: '周会', notes: '带数据',
    start: '15:30', end: '16:30', allDay: false, color: '#ff453a', createdAt: 5,
  });
  eq(rec, {
    id: 'a', date: '2026-10-17', text: '周会\n带数据', color: '#ff453a',
    createdAt: 5, updatedAt: 0,
  });
});

t('normalizeRecord：旧备忘只留文字', () => {
  const rec = C.normalizeRecord({ id: 'n', kind: 'note', date: '2026-10-18', text: '记一笔' });
  eq(rec.text, '记一笔');
  eq(rec.date, '2026-10-18');
  eq(rec.color, C.COLORS[0], '没颜色时用默认色');
});

t('normalizeRecord：坏数据返回 null', () => {
  eq(C.normalizeRecord(null), null);
  eq(C.normalizeRecord({}), null);
  eq(C.normalizeRecord({ id: 'x' }), null);
  eq(C.normalizeRecord({ date: '2026-10-17' }), null);
});

t('recordTitle 取第一行非空文字，空记录有兜底', () => {
  eq(C.recordTitle({ text: '第一行\n第二行' }), '第一行');
  eq(C.recordTitle({ text: '\n\n  今天  ' }), '今天');
  eq(C.recordTitle({ text: '   ' }), '（空记录）');
  eq(C.recordTitle(null), '（空记录）');
});

t('同日排序按创建时间（先写的在上）', () => {
  const list = [
    note({ id: 'b', createdAt: 20 }),
    note({ id: 'a', createdAt: 10 }),
    note({ id: 'c', createdAt: 30 }),
  ];
  eq(C.sortDayRecords(list).map((r) => r.id), ['a', 'b', 'c']);
});

t('recordsByDay 分桶：每条记录只落在自己那一天', () => {
  const map = C.recordsByDay([
    note({ id: 'a', date: '2026-10-17' }),
    note({ id: 'b', date: '2026-10-18' }),
    note({ id: 'c', date: '2026-10-17', createdAt: 2000 }),
  ]);
  eq((map.get('2026-10-17') || []).map((r) => r.id), ['a', 'c']);
  eq((map.get('2026-10-18') || []).map((r) => r.id), ['b']);
  eq(map.get('2026-10-19'), undefined);
});

// ---------------------------------------------------------------- copy

console.log('\n复制记录');

t('copyRecord：换 id 与日期，文字与颜色照搬，源记录不变', () => {
  const src = note({ id: 'a', text: '周会\n带数据', color: '#ff453a', createdAt: 5 });
  const copy = C.copyRecord(src, '2026-10-20', 'new-id');
  eq(copy.id, 'new-id');
  eq(copy.date, '2026-10-20');
  eq(copy.text, '周会\n带数据');
  eq(copy.color, '#ff453a');
  eq(src.date, '2026-10-17', '源记录日期');
  eq(src.id, 'a', '源记录 id');
  ok(copy.createdAt >= src.createdAt);
  ok(!('start' in copy) && !('end' in copy), '不应再带时间字段');
});

t('copyRecord：不传 id 时自动生成新的', () => {
  const src = note({ id: 'a' });
  const copy = C.copyRecord(src, '2026-10-20');
  ok(copy.id && copy.id !== 'a', `新 id 应不同，得到 ${copy.id}`);
});

t('复制出来的记录会出现在目标那一天', () => {
  const src = note({ id: 'a' });
  const copy = C.copyRecord(src, '2026-10-20');
  const map = C.recordsByDay([src, copy]);
  eq((map.get('2026-10-17') || []).map((r) => r.id), ['a']);
  eq((map.get('2026-10-20') || []).map((r) => r.id), [copy.id]);
});

t('copyShortcuts：明天 / 后天 / 下周同天', () => {
  eq(C.copyShortcuts(note({ date: '2026-10-17' })), [
    ['明天', '2026-10-18'],
    ['后天', '2026-10-19'],
    ['下周同天', '2026-10-24'],
  ]);
});

t('copyShortcuts：跨月与跨年', () => {
  eq(C.copyShortcuts(note({ date: '2026-10-31' }))[0], ['明天', '2026-11-01']);
  eq(C.copyShortcuts(note({ date: '2026-12-31' }))[0], ['明天', '2027-01-01']);
});

t('copyShortcuts：日期非法时返回空', () => {
  eq(C.copyShortcuts({ date: '' }), []);
  eq(C.copyShortcuts({}), []);
});

// ---------------------------------------------------------------- search

console.log('\n搜索与标题');

t('搜索匹配文字与日期，忽略大小写', () => {
  const list = [
    note({ id: 'a', text: 'Kickoff Meeting' }),
    note({ id: 'b', text: '周会\n讨论 ROI' }),
    note({ id: 'n', date: '2026-10-18', text: '买牛奶' }),
  ];
  eq(C.searchRecords(list, 'kickoff').map((r) => r.id), ['a']);
  eq(C.searchRecords(list, 'roi').map((r) => r.id), ['b']);
  eq(C.searchRecords(list, '牛奶').map((r) => r.id), ['n']);
  eq(C.searchRecords(list, '2026-10-17').map((r) => r.id), ['a', 'b']);
  eq(C.searchRecords(list, '').length, 3);
  eq(C.searchRecords(list, 'zzz').length, 0);
});

t('搜索结果按日期排序', () => {
  const list = [
    note({ id: 'late', date: '2026-10-20', text: 'x' }),
    note({ id: 'early', date: '2026-10-02', text: 'x' }),
  ];
  eq(C.searchRecords(list, 'x').map((r) => r.id), ['early', 'late']);
});

t('标题：各视图', () => {
  eq(C.formatTitle('year', d(2026, 10, 17)), '2026年');
  eq(C.formatTitle('month', d(2026, 10, 17)), '2026年10月');
  eq(C.formatTitle('day', d(2026, 10, 17)), '2026年10月17日 周六');
  // 2026-10-17 是周六，本周为周日 10-11 起
  eq(C.formatTitle('week', d(2026, 10, 17)), '2026年10月11日 – 10月17日');
});

t('标题：跨月与跨年的一周', () => {
  // 2026-10-01 是周四，本周为 9/27（周日）– 10/3（周六）
  eq(C.formatTitle('week', d(2026, 10, 1)), '2026年9月27日 – 10月3日');
  // 2027-01-01 是周五，本周为 2026/12/27 – 2027/1/2
  eq(C.formatTitle('week', d(2027, 1, 1)), '2026年12月27日 – 2027年1月2日');
});

// ---------------------------------------------------------------- summary

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
