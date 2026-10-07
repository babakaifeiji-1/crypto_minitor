// 支撑 / 压力位：纯K线摆动高低点 + 前一日高低点，聚类成价格区
// 严格无未来函数：在第 i 根K线上只使用当时已确认的摆动点
const Levels = (() => {
  // 摆动点：第 j 根的高点是前后 n 根中最高 → 摆动高点，要等到 j+n 根收盘才确认
  function pivots(k, n, barSec, weight, src) {
    const out = [];
    for (let j = n; j < k.length - n; j++) {
      let isH = true, isL = true;
      for (let m = j - n; m <= j + n; m++) {
        if (m === j) continue;
        if (k[m].high >= k[j].high) isH = false;
        if (k[m].low <= k[j].low) isL = false;
      }
      const confirmTime = k[j + n].time + barSec;
      if (isH) out.push({ price: k[j].high, time: k[j].time, confirmTime, type: "H", weight, src });
      if (isL) out.push({ price: k[j].low, time: k[j].time, confirmTime, type: "L", weight, src });
    }
    return out;
  }

  // 按 UTC 日统计的日内高低点（用前一天的，作为强位置）
  function dailyHL(k) {
    const days = new Map();
    for (const x of k) {
      const d = Math.floor(x.time / 86400);
      const v = days.get(d);
      if (!v) days.set(d, { high: x.high, low: x.low });
      else { v.high = Math.max(v.high, x.high); v.low = Math.min(v.low, x.low); }
    }
    return days;
  }

  // 预计算：返回一个上下文，之后可以对任意时间点查询当时的价位
  function prepare(ltfK, htfK) {
    const all = [...pivots(ltfK, 5, 900, 1, "15m"), ...pivots(htfK, 3, 3600, 2, "1h")];
    all.sort((a, b) => a.confirmTime - b.confirmTime);
    return { pivots: all, daily: dailyHL(ltfK), cache: new Map() };
  }

  // 第 i 根K线收盘时可见的价位区（聚类后），tol 为合并距离（价格单位）
  function at(ctx, closeTime, tol) {
    const key = closeTime;
    if (ctx.cache.has(key)) return ctx.cache.get(key);
    const pts = [];
    for (const p of ctx.pivots) {
      if (p.confirmTime > closeTime) break;
      const age = closeTime - p.time;
      if (p.src === "15m" && age > 3 * 86400) continue; // 15m 摆动点看 3 天
      if (p.src === "1h" && age > 10 * 86400) continue; // 1h 摆动点看 10 天
      pts.push(p);
    }
    const prevDay = ctx.daily.get(Math.floor(closeTime / 86400) - 1);
    if (prevDay) {
      pts.push({ price: prevDay.high, type: "H", weight: 2, src: "昨高" });
      pts.push({ price: prevDay.low, type: "L", weight: 2, src: "昨低" });
    }
    pts.sort((a, b) => a.price - b.price);
    const levels = [];
    let cur = null;
    for (const p of pts) {
      if (cur && p.price - cur.maxP <= tol) {
        cur.sumPW += p.price * p.weight; cur.strength += p.weight; cur.touches++; cur.maxP = p.price;
        if (p.src === "昨高" || p.src === "昨低") cur.tags.add(p.src);
      } else {
        cur = { sumPW: p.price * p.weight, strength: p.weight, touches: 1, minP: p.price, maxP: p.price, tags: new Set() };
        if (p.src === "昨高" || p.src === "昨低") cur.tags.add(p.src);
        levels.push(cur);
      }
    }
    const out = levels
      .map((l) => ({ price: l.sumPW / l.strength, strength: l.strength, touches: l.touches, lo: l.minP, hi: l.maxP, tags: [...l.tags] }))
      .filter((l) => l.strength >= 2); // 至少一个 1h 摆动点 / 两次 15m 触及 / 昨日高低
    if (ctx.cache.size > 5000) ctx.cache.clear();
    ctx.cache.set(key, out);
    return out;
  }

  // 价格上方最近的压力 / 下方最近的支撑（gap 以外）
  function nearest(levels, price, gap) {
    let res = null, sup = null;
    for (const l of levels) {
      if (l.price > price + gap && (!res || l.price < res.price)) res = l;
      if (l.price < price - gap && (!sup || l.price > sup.price)) sup = l;
    }
    return { res, sup };
  }

  // 日线级别关键位：日线摆动点（左右各 2 天）聚类，看近 90 天；只用已收盘的日K
  // 仅用于显示，不参与止损计算
  function daily(d1k, nowSec) {
    const k = d1k.filter((x) => x.time + 86400 <= nowSec);
    if (k.length < 10) return [];
    const recent = k.slice(-90);
    const pts = [];
    const n = 2;
    for (let j = n; j < recent.length - n; j++) {
      let isH = true, isL = true;
      for (let m = j - n; m <= j + n; m++) {
        if (m === j) continue;
        if (recent[m].high >= recent[j].high) isH = false;
        if (recent[m].low <= recent[j].low) isL = false;
      }
      if (isH) pts.push(recent[j].high);
      if (isL) pts.push(recent[j].low);
    }
    // 近 7 日高低点
    const lastWeek = k.slice(-7);
    pts.push(Math.max(...lastWeek.map((x) => x.high)), Math.min(...lastWeek.map((x) => x.low)));
    const tr = recent.slice(-14).map((x) => x.high - x.low);
    const tol = (tr.reduce((a, b) => a + b, 0) / tr.length) * 0.25;
    pts.sort((a, b) => a - b);
    const out = [];
    for (const p of pts) {
      const cur = out[out.length - 1];
      if (cur && p - cur.hi <= tol) { cur.sum += p; cur.touches++; cur.hi = p; }
      else out.push({ sum: p, touches: 1, lo: p, hi: p });
    }
    return out.map((c) => ({ price: c.sum / c.touches, touches: c.touches, lo: c.lo, hi: c.hi }));
  }

  return { prepare, at, nearest, daily };
})();
