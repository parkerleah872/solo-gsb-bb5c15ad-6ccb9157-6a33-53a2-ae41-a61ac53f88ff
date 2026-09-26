/**
 * 区间匀时：在锁定行之间重排未锁定行的时码。
 *
 * 规则：
 *   - 每段连续未锁定行构成一个区间；
 *   - 区间边界取前一锁定行的结束、后一锁定行的开始；
 *     缺少锁定邻居时沿用该段原首行开始 / 末行结束；
 *   - 仅重排未锁定行，按去除字幕标记后的可见字符数比例分配时长；
 *   - 单行至少 MIN_CUE_MS，行间至少 MIN_GAP_MS，保持原顺序，不越过锁定行；
 *   - 区间容量不足时保留该区间原时码，并报告行号与所需/可用时长。
 *
 * 浏览器中挂载为 window.EvenTiming，Node 中通过 module.exports 导出（供测试）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EvenTiming = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_CUE_MS = 400; // 单行最短时长
  const MIN_GAP_MS = 100; // 行间最小间隔

  /** 可见字符数：剥除 <i> 等标签与 {\an8} 类覆盖标签后，计非空白字符数（至少为 1）。 */
  function visibleLen(text) {
    const clean = String(text == null ? '' : text)
      .replace(/<[^>]*>/g, '')
      .replace(/\{[^}]*\}/g, '');
    let count = 0;
    for (const ch of clean) {
      if (!/\s/u.test(ch)) count++;
    }
    return Math.max(1, count);
  }

  /**
   * 把 total 毫秒按权重分成若干份，每份至少 min 毫秒，总和精确等于 total。
   * 先迭代把低于最小时长的行固定在 min，再对剩余行用最大余数法取整。
   * 调用前需保证 total >= n * min。
   */
  function allocateDurations(weights, total, min) {
    const durs = new Array(weights.length).fill(0);
    let free = weights.map((_, k) => k);
    let remaining = total;

    for (;;) {
      const wSum = free.reduce((s, k) => s + weights[k], 0);
      const stuck = free.filter((k) => remaining * weights[k] < min * wSum);
      if (!stuck.length) break;
      for (const k of stuck) {
        durs[k] = min;
        remaining -= min;
      }
      const stuckSet = new Set(stuck);
      free = free.filter((k) => !stuckSet.has(k));
      if (!free.length) return durs;
    }

    const wSum = free.reduce((s, k) => s + weights[k], 0);
    const raw = free.map((k) => (remaining * weights[k]) / wSum);
    const floors = raw.map((v) => Math.floor(v));
    free.forEach((k, t) => {
      durs[k] = floors[t];
    });
    let leftover = remaining - floors.reduce((a, b) => a + b, 0);
    const order = free
      .map((k, t) => ({ k, frac: raw[t] - floors[t] }))
      .sort((a, b) => b.frac - a.frac);
    for (let t = 0; t < order.length && leftover > 0; t++) {
      durs[order[t].k] += 1;
      leftover--;
    }
    return durs;
  }

  /**
   * 主入口：就地修改 rows 中未锁定行的 start/end（毫秒），锁定行保持不变。
   * rows: [{ start, end, text, locked }]
   * 返回 { applied: [{from,to}], failures: [{from,to,requiredMs,availableMs}] }，
   * from/to 为 1 起始的显示行号（含端点）。
   */
  function evenOutRows(rows, opts) {
    const minCue = (opts && opts.minCueMs) || MIN_CUE_MS;
    const minGap = (opts && opts.minGapMs) || MIN_GAP_MS;
    const applied = [];
    const failures = [];
    const n = rows.length;

    let i = 0;
    while (i < n) {
      if (rows[i].locked) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && !rows[j + 1].locked) j++;

      const seg = rows.slice(i, j + 1);
      const prev = i > 0 ? rows[i - 1] : null; // 若存在必为锁定行
      const next = j < n - 1 ? rows[j + 1] : null; // 若存在必为锁定行
      const leftBound = prev && Number.isFinite(prev.end) ? prev.end : seg[0].start;
      const rightBound =
        next && Number.isFinite(next.start) ? next.start : seg[seg.length - 1].end;
      const capacity = rightBound - leftBound;
      const required = seg.length * minCue + (seg.length - 1) * minGap;

      if (!Number.isFinite(capacity) || capacity < required) {
        failures.push({
          from: i + 1,
          to: j + 1,
          requiredMs: required,
          availableMs: Math.max(0, Number.isFinite(capacity) ? capacity : 0),
        });
      } else {
        const weights = seg.map((r) => visibleLen(r.text));
        const durs = allocateDurations(weights, capacity - (seg.length - 1) * minGap, minCue);
        let cursor = leftBound;
        seg.forEach((r, t) => {
          r.start = cursor;
          r.end = cursor + durs[t];
          cursor = r.end + minGap;
        });
        applied.push({ from: i + 1, to: j + 1 });
      }
      i = j + 1;
    }
    return { applied, failures };
  }

  return { evenOutRows, visibleLen, allocateDurations, MIN_CUE_MS, MIN_GAP_MS };
});
