'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evenOutRows,
  visibleLen,
  allocateDurations,
  MIN_CUE_MS,
  MIN_GAP_MS,
} = require('../public/even');

const row = (start, end, text, locked = false) => ({ start, end, text, locked });
const dur = (r) => r.end - r.start;

test('visibleLen: 剥除字幕标记后计可见字符，至少为 1', () => {
  assert.equal(visibleLen('<i>你好</i>'), 2);
  assert.equal(visibleLen('{\\an8}abc'), 3);
  assert.equal(visibleLen('a b　c'), 3); // 空白不计
  assert.equal(visibleLen(''), 1);
  assert.equal(visibleLen('<i></i>'), 1);
});

test('allocateDurations: 总和精确、每份不低于最小值', () => {
  const durs = allocateDurations([1, 20], 1900, 400);
  assert.deepEqual(durs, [400, 1500]);
  const eq = allocateDurations([4, 4, 6], 3800, 400);
  assert.equal(eq.reduce((a, b) => a + b, 0), 3800);
  assert.ok(eq.every((d) => d >= 400));
  // 权重 6 的行应分得最多
  assert.ok(eq[2] > eq[0]);
});

test('evenOutRows: 以锁定行为边界按可见字数分配，行间留 100ms', () => {
  const rows = [
    row(0, 1000, '锁定行', true),
    row(1100, 1200, 'aaaa'),
    row(1300, 1400, 'bbbb'),
    row(1500, 1600, 'cccccc'),
    row(5000, 6000, '锁定行', true),
  ];
  const { applied, failures } = evenOutRows(rows);
  assert.deepEqual(failures, []);
  assert.deepEqual(applied, [{ from: 2, to: 4 }]);
  // 边界精确落在锁定行结束/开始
  assert.equal(rows[1].start, 1000);
  assert.equal(rows[3].end, 5000);
  // 行间间隔恰好 100ms，顺序不变
  assert.equal(rows[2].start - rows[1].end, MIN_GAP_MS);
  assert.equal(rows[3].start - rows[2].end, MIN_GAP_MS);
  // 4:4:6 分配 3800ms → 1086/1086/1628
  assert.deepEqual([dur(rows[1]), dur(rows[2]), dur(rows[3])], [1086, 1086, 1628]);
  // 锁定行未被改动
  assert.equal(rows[0].start, 0);
  assert.equal(rows[0].end, 1000);
  assert.equal(rows[4].start, 5000);
});

test('evenOutRows: 缺少锁定邻居时沿用该段原首行开始/末行结束', () => {
  const rows = [row(0, 400, 'a'), row(600, 2000, 'xxxxxxxxxxxxxxxxxxxx')];
  const { failures } = evenOutRows(rows);
  assert.deepEqual(failures, []);
  assert.equal(rows[0].start, 0); // 原首行开始
  assert.equal(rows[1].end, 2000); // 原末行结束
  // 短行被最短时长保护
  assert.equal(dur(rows[0]), MIN_CUE_MS);
  assert.equal(dur(rows[1]), 1500);
  assert.equal(rows[1].start - rows[0].end, MIN_GAP_MS);
});

test('evenOutRows: 单行区间占满整个容量', () => {
  const rows = [
    row(0, 1000, '锁', true),
    row(1200, 1300, 'abc'),
    row(3000, 4000, '锁', true),
  ];
  evenOutRows(rows);
  assert.equal(rows[1].start, 1000);
  assert.equal(rows[1].end, 3000);
});

test('evenOutRows: 容量不足的区间保留原时码并报告所需/可用时长', () => {
  const rows = [
    row(0, 500, '锁', true),
    row(600, 700, 'aa'),
    row(800, 900, 'bb'),
    row(1000, 1500, '锁', true),
  ];
  const { applied, failures } = evenOutRows(rows);
  assert.deepEqual(applied, []);
  assert.deepEqual(failures, [{ from: 2, to: 3, requiredMs: 900, availableMs: 500 }]);
  // 原时码不变
  assert.equal(rows[1].start, 600);
  assert.equal(rows[1].end, 700);
  assert.equal(rows[2].start, 800);
  assert.equal(rows[2].end, 900);
});

test('evenOutRows: 某区间失败不影响其他可行区间', () => {
  const rows = [
    row(0, 500, 'aaaa'), // 区间 A：无左锁定邻居，容量 1000
    row(1000, 1500, '锁', true),
    row(1600, 1700, 'aa'), // 区间 B：容量 500 < 900，失败
    row(1800, 1900, 'bb'),
    row(2000, 2500, '锁', true),
  ];
  const { applied, failures } = evenOutRows(rows);
  assert.deepEqual(applied, [{ from: 1, to: 1 }]);
  assert.deepEqual(failures, [{ from: 3, to: 4, requiredMs: 900, availableMs: 500 }]);
  // 区间 A 已重排：首行开始沿用原值，末行结束顶到锁定行开始
  assert.equal(rows[0].start, 0);
  assert.equal(rows[0].end, 1000);
  // 区间 B 保留原时码
  assert.equal(rows[2].start, 1600);
  assert.equal(rows[3].end, 1900);
});

test('evenOutRows: 全部锁定时不做任何改动', () => {
  const rows = [row(0, 1000, 'a', true), row(2000, 3000, 'b', true)];
  const { applied, failures } = evenOutRows(rows);
  assert.deepEqual(applied, []);
  assert.deepEqual(failures, []);
  assert.equal(rows[0].end, 1000);
  assert.equal(rows[1].start, 2000);
});

test('evenOutRows: 字幕标记不参与字数分配', () => {
  const rows = [
    row(0, 100, '<i>abcd</i>'), // 可见 4 字
    row(200, 300, '{\\an8}abcd'), // 可见 4 字
    row(2000, 3000, '锁', true),
  ];
  evenOutRows(rows);
  // 可见字数相同 → 均分 (2000 - 100) = 1900ms
  assert.equal(dur(rows[0]), 950);
  assert.equal(dur(rows[1]), 950);
  assert.equal(rows[0].start, 0);
  assert.equal(rows[1].end, 2000);
});
