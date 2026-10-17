#!/usr/bin/env node
/* Regression tests for the drafts (草稿) pure logic.
 *
 *   npm run test:drafts
 */
'use strict';

require('../src/renderer/drafts.js');
const D = globalThis.SnapDrafts;

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

console.log('\n标题');

t('取第一行非空文本', () => {
  eq(D.draftTitle({ text: '跟供应商对账\n顺丰单号待确认' }), '跟供应商对账');
  eq(D.draftTitle({ text: '\n\n  买牛奶  \n还有鸡蛋' }), '买牛奶');
});

t('空内容显示「无标题」', () => {
  eq(D.draftTitle({ text: '' }), '无标题');
  eq(D.draftTitle({ text: '   \n\t  ' }), '无标题');
  eq(D.draftTitle({}), '无标题');
  eq(D.draftTitle(null), '无标题');
});

t('过长标题截断加省略号', () => {
  const long = 'x'.repeat(D.TITLE_MAX + 10);
  const got = D.draftTitle({ text: long });
  eq(got.length, D.TITLE_MAX + 1, '长度');
  ok(got.endsWith('…'), '应以省略号结尾');
  // 恰好等于上限时不截断
  const exact = 'y'.repeat(D.TITLE_MAX);
  eq(D.draftTitle({ text: exact }), exact);
});

console.log('\n排序与字数');

t('按 updatedAt 倒序，且不改原数组', () => {
  const list = [
    { id: 'a', text: 'a', updatedAt: 100 },
    { id: 'c', text: 'c', updatedAt: 300 },
    { id: 'b', text: 'b', updatedAt: 200 },
  ];
  const before = list.map((d) => d.id);
  eq(D.sortDrafts(list).map((d) => d.id), ['c', 'b', 'a']);
  eq(list.map((d) => d.id), before, '原数组顺序');
});

t('缺 updatedAt 时排最后而不是报错', () => {
  const list = [{ id: 'a', updatedAt: 5 }, { id: 'b' }];
  eq(D.sortDrafts(list).map((d) => d.id), ['a', 'b']);
  eq(D.sortDrafts(null), []);
  eq(D.sortDrafts(undefined), []);
});

t('字数不含空白', () => {
  eq(D.charCount('hello world'), 10);
  eq(D.charCount('你好 世界'), 4);
  eq(D.charCount('a\nb\tc  d'), 4);
  eq(D.charCount(''), 0);
  eq(D.charCount(null), 0);
});

console.log('\n新建与时间');

t('blankDraft 形状完整且 id 唯一', () => {
  const a = D.blankDraft();
  const b = D.blankDraft();
  eq(a.text, '');
  ok(typeof a.id === 'string' && a.id.length > 1, 'id');
  ok(a.createdAt > 0 && a.updatedAt > 0, '时间戳');
  ok(a.id !== b.id, 'id 应唯一');
});

t('相对时间：刚刚 / 分钟 / 当天 / 更早', () => {
  const now = new Date(2026, 9, 17, 15, 30, 0).getTime();
  eq(D.shortTime(now - 10 * 1000, now), '刚刚');
  eq(D.shortTime(now - 5 * 60 * 1000, now), '5 分钟前');
  eq(D.shortTime(new Date(2026, 9, 17, 9, 5).getTime(), now), '09:05');
  eq(D.shortTime(new Date(2026, 9, 14, 9, 5).getTime(), now), '10月14日');
  eq(D.shortTime(0, now), '');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
