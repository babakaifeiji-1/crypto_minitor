// 盯盘助手主程序：数据加载 / WebSocket 实时更新 / 图表 / 提醒
(() => {
  const LTF = "15m", HTF = "1h";
  const LTF_SEC = 900;
  const REST = "https://fapi.binance.com";
  const WS_URLS = ["wss://fstream.binance.com/market/stream", "wss://fstream.binance.com/stream"];
  const DEFAULT_SYMBOLS = [
    "BTCUSDT", "ETHUSDT",
    "SNDKUSDT", "MUUSDT", "SKHYNIXUSDT", "NVDAUSDT", "TSLAUSDT", "MSTRUSDT", "MRVLUSDT", "INTCUSDT", "CRCLUSDT", "GOOGLUSDT",
  ];
  const SYMBOLS_VER = 2; // 默认列表变更时递增，老用户会自动合并新默认品种
  const CN_NAMES = {
    BTCUSDT: "比特币", ETHUSDT: "以太坊", SOLUSDT: "SOL",
    MUUSDT: "美光", SNDKUSDT: "闪迪", SKHYNIXUSDT: "海力士", SKHYUSDT: "海力士ADR", SAMSUNGUSDT: "三星",
    NVDAUSDT: "英伟达", TSLAUSDT: "特斯拉", MSTRUSDT: "微策略", MRVLUSDT: "迈威尔", INTCUSDT: "英特尔", CRCLUSDT: "Circle",
    GOOGLUSDT: "谷歌", AAPLUSDT: "苹果", MSFTUSDT: "微软", AMZNUSDT: "亚马逊", METAUSDT: "Meta", AMDUSDT: "AMD", TSMUSDT: "台积电",
    AVGOUSDT: "博通", PLTRUSDT: "Palantir", COINUSDT: "Coinbase", HOODUSDT: "Robinhood", QQQUSDT: "纳指ETF", SPYUSDT: "标普ETF",
    SOXLUSDT: "半导体3x", WDCUSDT: "西部数据", SPCXUSDT: "SpaceX",
  };
  const MARKET_NAMES = { crypto: "加密货币", us: "美股", kr: "韩股", hk: "港股", other: "其他" };
  const TZ = -new Date().getTimezoneOffset() * 60; // 图表显示本地时间

  const store = {
    load(key, def) { try { const v = JSON.parse(localStorage.getItem("tm_" + key)); return v ?? def; } catch { return def; } },
    save(key, v) { localStorage.setItem("tm_" + key, JSON.stringify(v)); },
  };

  function initialSymbols() {
    const saved = store.load("symbols", null);
    if (!saved) return [...DEFAULT_SYMBOLS];
    if (store.load("symbolsVer", 1) < SYMBOLS_VER) {
      const merged = [...saved, ...DEFAULT_SYMBOLS.filter((s) => !saved.includes(s))];
      store.save("symbols", merged);
      store.save("symbolsVer", SYMBOLS_VER);
      return merged;
    }
    return saved;
  }

  const state = {
    symbols: initialSymbols(),
    params: { ...Strategy.DEFAULTS, ...store.load("params", {}) },
    market: {}, // sym -> crypto / us / kr / hk / other
    active: null,
    data: {},
    sound: false,
    feed: [],
    flashUntil: {}, // sym -> 时间戳，卡片闪烁
  };
  state.active = state.symbols[0];

  const $ = (id) => document.getElementById(id);
  const decimals = (p) => (p >= 1000 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : 6);
  const fmtPrice = (p) => (p == null || isNaN(p) ? "-" : p.toFixed(decimals(Math.abs(p))));
  const fmtPct = (p, base) => { const v = ((p - base) / base) * 100; return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`; };
  const fmtTime = (t) => {
    const d = new Date(t * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const sideTxt = (s) => (s > 0 ? "做多" : "做空");
  const sideCls = (s) => (s > 0 ? "long" : "short");
  const short = (sym) => sym.replace(/USDT$/, "");
  const nameOf = (sym) => `${short(sym)}${CN_NAMES[sym] ? " " + CN_NAMES[sym] : ""}`;
  const marketOf = (sym) => state.market[sym] ?? (sym === "BTCUSDT" || sym === "ETHUSDT" ? "crypto" : "us");
  const paramsFor = (sym) => ({ ...state.params, market: marketOf(sym) });

  // ---------------- 交易时段 ----------------
  function sessionOf(sym) {
    const m = marketOf(sym);
    if (m === "crypto") return null;
    const now = new Date();
    if (state.params.skipWeekend && Strategy.isWeekend(now / 1000)) return { txt: "周末休市 · 暂停出信号", cls: "off" };
    const tz = m === "kr" ? "Asia/Seoul" : m === "hk" ? "Asia/Hong_Kong" : "America/New_York";
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false, weekday: "short" }).formatToParts(now);
    const get = (t) => parts.find((x) => x.type === t).value;
    const mins = (+get("hour") % 24) * 60 + +get("minute");
    if (get("weekday") === "Sat" || get("weekday") === "Sun") return { txt: "正股休市", cls: "off" };
    if (m === "us") {
      if (mins >= 570 && mins < 960) return { txt: "美股盘中", cls: "on" };
      if (mins >= 240 && mins < 570) return { txt: "美股盘前", cls: "pre" };
      if (mins >= 960 && mins < 1200) return { txt: "美股盘后", cls: "pre" };
      return { txt: "美股夜盘", cls: "pre" };
    }
    if (m === "kr") return mins >= 540 && mins < 930 ? { txt: "韩股盘中", cls: "on" } : { txt: "韩股休市时段", cls: "pre" };
    if (m === "hk") return (mins >= 570 && mins < 720) || (mins >= 780 && mins < 960) ? { txt: "港股盘中", cls: "on" } : { txt: "港股休市时段", cls: "pre" };
    return null;
  }

  // ---------------- 数据 ----------------
  async function fetchJson(path) {
    const r = await fetch(REST + path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function fetchKlines(sym, interval, limit) {
    const arr = await fetchJson(`/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
    return arr.map((x) => ({ time: x[0] / 1000, open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] }));
  }

  // 合约类型（加密 / 美股 / 韩股…），以及美股成交量排行
  async function loadMeta() {
    try {
      const ei = await fetchJson("/fapi/v1/exchangeInfo");
      const map = { COIN: "crypto", INDEX: "crypto", EQUITY: "us", PREMARKET: "us", KR_EQUITY: "kr", HK_EQUITY: "hk" };
      const types = {};
      for (const s of ei.symbols) if (s.status === "TRADING") types[s.symbol] = map[s.underlyingType] ?? "other";
      state.allTypes = types;
      for (const sym of Object.keys(types)) state.market[sym] = types[sym];
      const t24 = await fetchJson("/fapi/v1/ticker/24hr");
      const hot = t24
        .filter((x) => ["us", "kr"].includes(types[x.symbol]))
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, 25);
      $("hotList").innerHTML = hot
        .map((x) => `<option value="${x.symbol}">${CN_NAMES[x.symbol] ?? ""} 24h成交 ${(x.quoteVolume / 1e6).toFixed(0)}M USDT</option>`)
        .join("");
    } catch (e) {
      console.warn("合约信息加载失败，按默认规则判断类型", e);
    }
  }

  async function loadSymbol(sym) {
    const [ltf, htf, h4, d1] = await Promise.all([
      fetchKlines(sym, LTF, 1500), fetchKlines(sym, HTF, 500), fetchKlines(sym, "4h", 300), fetchKlines(sym, "1d", 200),
    ]);
    const prev = state.data[sym];
    state.data[sym] = {
      ltf, htf, h4, d1, res: null, live: null, dirty: true, computedAt: 0,
      seen: prev?.seen ?? new Map(), exitAlerted: prev?.exitAlerted ?? new Set(), initialized: prev?.initialized ?? false,
    };
    recompute(sym);
  }

  function recompute(sym) {
    const d = state.data[sym];
    if (!d || d.ltf.length < 100) return;
    d.res = Strategy.run(d.ltf, d.htf, LTF_SEC, paramsFor(sym));
    d.computedAt = Date.now();
    // 大周期背景（只显示和统计，不影响信号）
    d.ctx = { h4: Strategy.trendSeries(d.h4, 14400), d1: Strategy.trendSeries(d.d1, 86400) };
    for (const sg of d.res.signals) {
      const t = sg.time + LTF_SEC;
      const a = Strategy.trendAt(d.ctx.d1, t), b = Strategy.trendAt(d.ctx.h4, t);
      sg.d1 = a ? (a.st === sg.side ? "同向" : "逆向") : null;
      sg.h4 = b ? (b.st === sg.side ? "同向" : "逆向") : null;
    }
    recordJournal(sym, d.res.signals);
    d.live = Strategy.liveState(d.res, d.ltf);
    d.exit = Strategy.exitWarning(d.res, d.ltf);
    const last = d.res.signals[d.res.signals.length - 1];
    d.lastStatus = last ? Strategy.signalStatus(last, d.res, d.ltf, LTF_SEC) : null;
    d.dirty = false;
    checkAlerts(sym);
  }

  // 本机信号日志：长期累积已平仓信号及其大周期分组，用于判断日线/4h过滤到底有没有用
  const journal = store.load("journal", {});
  let journalDirty = false;
  function recordJournal(sym, signals) {
    for (const sg of signals) {
      if (sg.r == null || !sg.d1 || !sg.h4) continue;
      const key = `${sym}|${sg.time}`;
      if (journal[key]) continue;
      journal[key] = { sym, t: sg.time, side: sg.side, r: +sg.r.toFixed(3), d1: sg.d1, h4: sg.h4 };
      journalDirty = true;
    }
  }
  setInterval(() => {
    if (!journalDirty) return;
    const keys = Object.keys(journal);
    if (keys.length > 5000) keys.sort((a, b) => journal[a].t - journal[b].t).slice(0, keys.length - 5000).forEach((k) => delete journal[k]);
    store.save("journal", journal);
    journalDirty = false;
  }, 10000);

  function upsertCandle(arr, c) {
    const last = arr[arr.length - 1];
    if (last && last.time === c.time) arr[arr.length - 1] = c;
    else if (!last || c.time > last.time) { arr.push(c); if (arr.length > 1600) arr.shift(); }
  }

  // ---------------- 提醒 ----------------
  function checkAlerts(sym) {
    const d = state.data[sym];
    const sigs = d.res.signals;
    const p = d.res.params;
    if (!d.initialized) {
      // 首次加载：历史信号不提醒，只记录状态
      sigs.forEach((s) => d.seen.set(s.time, { result: s.result, weak: true }));
      if (d.exit) d.exitAlerted.add(d.exit.time);
      d.initialized = true;
      return;
    }
    const nowSec = Date.now() / 1000;
    for (const s of sigs) {
      const prev = d.seen.get(s.time);
      const age = nowSec - (s.time + LTF_SEC);
      if (!prev) {
        d.seen.set(s.time, { result: s.result, weak: false });
        if (age > 2 * LTF_SEC) continue; // 太旧的（如参数调整后新出现的历史信号）不提醒
        const sess = sessionOf(sym);
        const ctxTxt = [s.d1 && `日线${s.d1}`, s.h4 && `4h${s.h4}`].filter(Boolean).join(" · ");
        notify({
          kind: sideCls(s.side), event: "signal", sym,
          title: `${s.side > 0 ? "🟢" : "🔴"} ${nameOf(sym)} ${sideTxt(s.side)}信号`,
          body: `${s.trigger} · ${s.score}分${sess ? " · " + sess.txt : ""}${ctxTxt ? "<br>大周期：" + ctxTxt : ""}<br>
            入场 <b>${fmtPrice(s.entry)}</b>，最多追到 ${fmtPrice(s.entry + s.side * p.maxChaseR * s.risk)}<br>
            止损 ${fmtPrice(s.sl)}（${fmtPct(s.sl, s.entry)}）· TP1 ${fmtPrice(s.tp1)}（${fmtPct(s.tp1, s.entry)}）<br>
            <span class="muted">${p.entryWindowBars * 15} 分钟内有效；价格回到 ${fmtPrice(s.entry)} ${s.side > 0 ? "下方" : "上方"}则放弃</span>`,
          feed: `<b class="${sideCls(s.side)}">${sideTxt(s.side)}</b> ${s.trigger} ${s.score}分 @ ${fmtPrice(s.entry)}`,
        });
        continue;
      }
      // 持仓事件：只针对近期信号
      if (prev.result !== s.result && age < p.runnerMaxBars * LTF_SEC) {
        if (s.result === "持仓中(已TP1)") {
          notify({
            kind: "info", event: "tp1", sym, title: `🎯 ${nameOf(sym)} 到达 TP1`,
            body: `${sideTxt(s.side)}单 TP1 ${fmtPrice(s.tp1)} 已到<br>平一半仓位，止损移到入场价 ${fmtPrice(s.entry)}，剩余仓位用移动止损跟踪`,
            feed: `<b class="long">TP1 到达</b> ${sideTxt(s.side)}单 → 平半仓、止损移保本`,
          });
        } else if (s.r != null) {
          const good = s.r > 0;
          notify({
            kind: good ? "info" : "exit", event: "close", sym, title: `${good ? "✅" : "❌"} ${nameOf(sym)} ${sideTxt(s.side)}单结束：${s.result}`,
            body: `结果约 ${s.r >= 0 ? "+" : ""}${s.r.toFixed(2)}R（已扣手续费）`,
            feed: `<b class="${good ? "long" : "short"}">${s.result}</b> ${sideTxt(s.side)}单 ${s.r >= 0 ? "+" : ""}${s.r.toFixed(2)}R`,
          });
        }
      }
      prev.result = s.result;
      // 信号走弱：入场窗口内价格回到信号价另一侧
      if (!prev.weak && age < (p.entryWindowBars + 1) * LTF_SEC) {
        const st = Strategy.signalStatus(s, d.res, d.ltf, LTF_SEC);
        if (st.code === "weak") {
          prev.weak = true;
          notify({
            kind: "exit", event: "weak", sym, title: `⚠️ ${nameOf(sym)} 信号走弱`,
            body: `价格回到信号价 ${fmtPrice(s.entry)} ${s.side > 0 ? "下方" : "上方"}<br>还没进场的先别进；已进场的按止损 ${fmtPrice(s.sl)} 执行`,
            feed: `<b class="wait">信号走弱</b> ${sideTxt(s.side)} @ ${fmtPrice(s.entry)}`,
          });
        }
      }
    }
    const ex = d.exit;
    if (ex && !d.exitAlerted.has(ex.time) && ex.time + LTF_SEC <= nowSec) {
      d.exitAlerted.add(ex.time);
      notify({
        kind: "exit", event: "exit", sym,
        title: `${nameOf(sym)} 趋势转弱提醒`,
        body: `${sideTxt(ex.side)}单：${ex.reason}，持仓的考虑减仓/收紧止损`,
        feed: `<b class="wait">趋势转弱</b> ${sideTxt(ex.side)}单 ${ex.reason}`,
      });
    }
  }

  let audioCtx = null;
  function beep(kind) {
    if (!state.sound || !audioCtx) return;
    const seq = kind === "long" ? [660, 880, 1100] : kind === "short" ? [1100, 880, 660] : kind === "info" ? [880, 1100] : [520, 400];
    seq.forEach((f, idx) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      const t0 = audioCtx.currentTime + idx * 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 0.17);
    });
  }

  let titleTimer = null;
  function notify({ kind, event, sym, title, body, feed }) {
    beep(kind);
    Push.send(event, title, body, sym);
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="close">✕</span><div class="t">${title}</div><div>${body}</div><div class="muted small">${fmtTime(Date.now() / 1000)}</div>`;
    el.onclick = (e) => { if (!e.target.classList.contains("close")) selectSymbol(sym); el.remove(); };
    $("toasts").prepend(el);
    setTimeout(() => el.remove(), 90000);
    state.feed.unshift({ sym, html: feed, t: Date.now() / 1000 });
    renderFeed();
    state.flashUntil[sym] = Date.now() + 8000;
    renderWatchlist();
    clearInterval(titleTimer);
    let n = 0;
    const orig = "盯盘助手 · 15m 趋势跟随";
    const tag = { long: "多", short: "空", info: "持仓", exit: "注意" }[kind];
    titleTimer = setInterval(() => {
      document.title = n++ % 2 ? orig : `【${tag}】${short(sym)}`;
      if (n > 20) { clearInterval(titleTimer); document.title = orig; }
    }, 800);
  }

  // ---------------- WebSocket ----------------
  let ws = null, wsUrlIdx = 0, wsRetry = 0, wsTimer = null, lastMsgAt = 0, downSince = 0;
  function connectWs() {
    if (ws) { ws.onclose = null; ws.close(); }
    const streams = state.symbols.flatMap((s) => [LTF, HTF, "4h", "1d"].map((iv) => `${s.toLowerCase()}@kline_${iv}`)).join("/");
    const url = `${WS_URLS[wsUrlIdx]}?streams=${streams}`;
    setConn("wait", "连接中");
    ws = new WebSocket(url);
    let gotData = false;
    ws.onmessage = (ev) => {
      if (!gotData) {
        gotData = true; wsRetry = 0; setConn("ok", "实时");
        if (downSince && Date.now() - downSince > 3 * 60000) {
          const mins = Math.round((Date.now() - downSince) / 60000);
          notify({ kind: "exit", event: "health", sym: state.active, title: "盯盘中断后已恢复", body: `行情连接中断了约 ${mins} 分钟，期间可能漏掉信号，请留意持仓。`, feed: `<b class="wait">连接恢复</b> 中断 ${mins} 分钟` });
        }
        downSince = 0;
      }
      const msg = JSON.parse(ev.data);
      const k = msg.data?.k;
      if (!k) return;
      const d = state.data[k.s];
      if (!d) return;
      const c = { time: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
      lastMsgAt = Date.now();
      const arr = { [LTF]: d.ltf, [HTF]: d.htf, "4h": d.h4, "1d": d.d1 }[k.i];
      if (arr) upsertCandle(arr, c);
      d.dirty = true;
      if (k.x) recompute(k.s); // K线收盘立刻计算信号
    };
    ws.onclose = () => {
      setConn("bad", "断线重连中");
      if (!downSince) downSince = lastMsgAt || Date.now();
      if (!gotData) wsUrlIdx = (wsUrlIdx + 1) % WS_URLS.length; // 换备用地址
      clearTimeout(wsTimer);
      wsTimer = setTimeout(async () => {
        await Promise.allSettled(state.symbols.map(loadSymbol)); // 补齐断线期间的K线
        connectWs();
      }, Math.min(30000, 2000 * 2 ** wsRetry++));
    };
    ws.onerror = () => ws.close();
  }
  function setConn(cls, txt) {
    $("conn").className = `conn ${cls}`;
    $("conn").querySelector("span").textContent = txt;
  }

  // ---------------- 图表 ----------------
  let chart, candle, vol, ema9S, ema21S, stUpS, stDnS, priceLines = [];
  function initChart() {
    chart = LightweightCharts.createChart($("chart"), {
      layout: { background: { color: "#0e1117" }, textColor: "#9aa3b5" },
      grid: { vertLines: { color: "#1a1f2a" }, horzLines: { color: "#1a1f2a" } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#262d3b" },
      timeScale: { borderColor: "#262d3b", timeVisible: true, secondsVisible: false, rightOffset: 8 },
      autoSize: true,
    });
    candle = chart.addCandlestickSeries({ upColor: "#26a69a", downColor: "#ef5350", borderVisible: false, wickUpColor: "#26a69a", wickDownColor: "#ef5350" });
    vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.18 } });
    const lineOpt = { lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    ema9S = chart.addLineSeries({ ...lineOpt, color: "#f5c542" });
    ema21S = chart.addLineSeries({ ...lineOpt, color: "#4c8dff" });
    stUpS = chart.addLineSeries({ ...lineOpt, color: "#26a69a", lineWidth: 2, lineStyle: 2 });
    stDnS = chart.addLineSeries({ ...lineOpt, color: "#ef5350", lineWidth: 2, lineStyle: 2 });
  }

  // 大周期方向：取当前（含未收盘）K线的 Supertrend
  function ctxNow(d) {
    const last = (arr) => { const x = arr?.[arr.length - 1]; return x?.ok ? x : null; };
    return { d1: last(d.ctx?.d1), h4: last(d.ctx?.h4), h1: d.live?.trend ?? 0 };
  }
  const arrow = (v) => (v > 0 ? '<span class="long">↑</span>' : v < 0 ? '<span class="short">↓</span>' : '<span class="muted">→</span>');
  function phaseOf(c) {
    if (!c.d1 || !c.h4 || !c.h1) return null;
    if (c.h1 === c.h4.st && c.h4.st === c.d1.st) return { txt: "全周期同向 · 趋势较成熟", cls: "muted" };
    if (c.h1 !== c.h4.st) return { txt: "1h 已转向、4h 未跟上 · 可能是趋势早期", cls: "wait" };
    return { txt: "1h/4h 与日线相反 · 日线级别的回调或反弹", cls: "wait" };
  }

  const stars = (l) => (l.strength >= 5 ? "★★★" : l.strength >= 3 ? "★★" : "★");

  // 当前价格上下最近的几个支撑压力位（用最后一根已收盘K线计算）
  function keyLevels(d, n = 3) {
    const k = d.ltf, res = d.res;
    let i = k.length - 1;
    if (k[i].time + LTF_SEC > Date.now() / 1000) i--;
    const lv = res.levelsAt(i), price = k[k.length - 1].close, atr = res.ind.atr[i];
    const near = lv.filter((l) => Math.abs(l.price - price) <= 6 * atr);
    const above = near.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, n);
    const below = near.filter((l) => l.price <= price).sort((a, b) => b.price - a.price).slice(0, n);
    return { above, below, price };
  }

  let chartSym = null, chartKey = "";
  const chartKeyOf = (d) => {
    const last = d.res.signals[d.res.signals.length - 1];
    return `${state.active}|${d.ltf.length}|${d.res.signals.length}|${last?.result}|${last?.trailSl}|${d.lastStatus?.code}`;
  };

  function renderChart() {
    const sym = state.active, d = state.data[sym];
    if (!d?.res) return;
    const k = d.ltf, ind = d.res.ind, T = (t) => t + TZ;
    const prec = decimals(k[k.length - 1].close);
    candle.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 10 ** -prec } });
    candle.setData(k.map((x) => ({ time: T(x.time), open: x.open, high: x.high, low: x.low, close: x.close })));
    vol.setData(k.map((x) => ({ time: T(x.time), value: x.volume, color: x.close >= x.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)" })));
    const line = (arr) => k.map((x, i) => (isNaN(arr[i]) ? { time: T(x.time) } : { time: T(x.time), value: arr[i] }));
    ema9S.setData(line(ind.ema9));
    ema21S.setData(line(ind.ema21));
    stUpS.setData(k.map((x, i) => (ind.st.dir[i] === 1 ? { time: T(x.time), value: ind.st.line[i] } : { time: T(x.time) })));
    stDnS.setData(k.map((x, i) => (ind.st.dir[i] === -1 ? { time: T(x.time), value: ind.st.line[i] } : { time: T(x.time) })));

    const markers = d.res.signals.map((s) => ({
      time: T(s.time),
      position: s.side > 0 ? "belowBar" : "aboveBar",
      color: s.side > 0 ? "#26a69a" : "#ef5350",
      shape: s.side > 0 ? "arrowUp" : "arrowDown",
      text: `${s.side > 0 ? "多" : "空"}${s.score}`,
    }));
    if (d.exit) markers.push({ time: T(d.exit.time), position: d.exit.side > 0 ? "aboveBar" : "belowBar", color: "#f5a623", shape: "circle", text: "弱" });
    markers.sort((a, b) => a.time - b.time);
    candle.setMarkers(markers);

    priceLines.forEach((pl) => candle.removePriceLine(pl));
    priceLines = [];
    const add = (price, color, title, style = 2, width = 1) =>
      priceLines.push(candle.createPriceLine({ price, color, title, lineWidth: width, lineStyle: style, axisLabelVisible: true }));

    // 支撑压力位
    const kl = keyLevels(d);
    kl.above.forEach((l) => add(l.price, "rgba(239,83,80,.55)", `压力${stars(l)}${l.tags.length ? " " + l.tags.join("/") : ""}`, 1, l.strength >= 5 ? 2 : 1));
    kl.below.forEach((l) => add(l.price, "rgba(38,166,154,.55)", `支撑${stars(l)}${l.tags.length ? " " + l.tags.join("/") : ""}`, 1, l.strength >= 5 ? 2 : 1));

    // 日线关键位（紫色，较粗）
    const pxNow = k[k.length - 1].close, atrNow = ind.atr[ind.atr.length - 1];
    const dLv = Levels.daily(d.d1, Date.now() / 1000).filter((l) => Math.abs(l.price - pxNow) <= 15 * atrNow);
    [...dLv.filter((l) => l.price > pxNow).sort((a, b) => a.price - b.price).slice(0, 2),
     ...dLv.filter((l) => l.price <= pxNow).sort((a, b) => b.price - a.price).slice(0, 2)]
      .forEach((l) => add(l.price, "rgba(179,136,255,.75)", l.price > pxNow ? "日线压力" : "日线支撑", 0, 2));

    // 当前信号 / 持仓
    const last = d.res.signals[d.res.signals.length - 1], st = d.lastStatus;
    if (last && st && st.code !== "done" && st.code !== "expired") {
      add(last.entry, "#c9d1e0", "信号价", 0);
      if (st.code === "manage") {
        add(st.stop, "#f5a623", "移动止损", 0, 2);
      } else {
        add(last.sl, "#ef5350", "止损", 0, 2);
        add(last.tp1, "#26a69a", "TP1", 0, 2);
        if (st.code === "go") add(st.chaseLimit, "#f5a623", "最多追到", 3);
      }
    } else if (last && st?.code === "expired" && last.r == null) {
      add(last.sl, "#ef5350", "止损(持仓者)", 2);
      add(last.tp1, "#26a69a", "TP1(持仓者)", 2);
    }

    if (chartSym !== sym) {
      const bars = matchMedia("(max-width: 900px)").matches ? 80 : 160;
      chart.timeScale().setVisibleLogicalRange({ from: k.length - bars, to: k.length + 8 });
      chartSym = sym;
    }
    chartKey = chartKeyOf(d);
  }

  // ---------------- 面板渲染 ----------------
  const STATUS_UI = {
    go: { icon: "✅", cls: "st-go" },
    weak: { icon: "⚠️", cls: "st-weak" },
    chased: { icon: "⛔", cls: "st-chased" },
    expired: { icon: "⌛", cls: "st-muted" },
    manage: { icon: "🎯", cls: "st-manage" },
    done: { icon: "", cls: "st-muted" },
  };

  function statusBadge(sig, st, compact) {
    const ui = STATUS_UI[st.code];
    let txt = `${ui.icon} ${sideTxt(sig.side)} · ${st.label}`;
    if (st.code === "go") txt += ` · 还剩${st.minLeft}分钟`;
    return `<div class="badge ${ui.cls}">${txt}</div>`;
  }

  function renderWatchlist() {
    let html = "", lastGroup = null;
    const order = { crypto: 0, us: 1, kr: 2, hk: 3, other: 4 };
    const syms = [...state.symbols].sort((a, b) => (order[marketOf(a)] ?? 9) - (order[marketOf(b)] ?? 9));
    for (const sym of syms) {
      const g = marketOf(sym);
      if (g !== lastGroup) { html += `<div class="group">${MARKET_NAMES[g] ?? g}</div>`; lastGroup = g; }
      const d = state.data[sym];
      const L = d?.live;
      if (!L) {
        html += `<div class="card" data-sym="${sym}"><div class="row"><span class="sym">${short(sym)}<span class="cn">${CN_NAMES[sym] ?? ""}</span></span></div><div class="status muted">${d?.error ?? "加载中…"}</div><span class="del" data-del="${sym}">✕</span></div>`;
        continue;
      }
      const k = d.ltf;
      const ref = k[Math.max(0, k.length - 97)].open;
      const chg = ((L.price - ref) / ref) * 100; // 24h
      const last = d.res.signals[d.res.signals.length - 1];
      const st = d.lastStatus;
      const sess = sessionOf(sym);
      const bar = (sc, color) => `<div class="bar"><div style="width:${sc}%;background:${color}"></div></div>`;
      const activeSig = last && st && !["done", "expired"].includes(st.code);
      const flash = (state.flashUntil[sym] ?? 0) > Date.now() ? "flash" : "";
      html += `<div class="card tone-${L.tone} ${sym === state.active ? "active" : ""} ${flash}" data-sym="${sym}">
        <span class="del" data-del="${sym}" title="移除">✕</span>
        <div class="row"><span class="sym">${short(sym)}<span class="cn">${CN_NAMES[sym] ?? ""}</span></span>
          <span class="price num">${fmtPrice(L.price)}</span></div>
        <div class="row"><span class="status ${L.tone === "flat" ? "muted" : L.tone}">${L.status}${L.htfStrong ? " ·强" : ""}</span>
          <span class="num small ${chg >= 0 ? "long" : "short"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span></div>
        <div class="tf-row">${(() => { const c = ctxNow(d); return `<span>日${arrow(c.d1?.st ?? 0)}</span><span>4h${arrow(c.h4?.st ?? 0)}</span><span>1h${arrow(c.h1)}</span>`; })()}
          ${sess ? `<span class="sess sess-${sess.cls}">${sess.txt}</span>` : ""}</div>
        <div class="bars"><span class="long">多</span>${bar(L.long.score, "var(--long)")}<span class="num">${L.long.score}</span>
          <span class="short">空</span>${bar(L.short.score, "var(--short)")}<span class="num">${L.short.score}</span></div>
        ${activeSig ? statusBadge(last, st, true) : ""}
        ${!activeSig && L.forming ? `<div class="forming">⏳ 预警：${sideTxt(L.forming.side)}（${L.forming.trigger}）正在形成，收盘才算</div>` : ""}
        ${last && !activeSig ? `<div class="last">上次：<span class="${sideCls(last.side)}">${sideTxt(last.side)}</span> ${fmtTime(last.time)} · ${last.result ?? ""}</div>` : ""}
      </div>`;
    }
    setHtml("watchlist", html);
  }

  // 内容没变就不重建 DOM（避免每秒重绘打断点击和动画）
  const htmlCache = {};
  function setHtml(id, html) {
    if (htmlCache[id] === html) return;
    htmlCache[id] = html;
    $(id).innerHTML = html;
  }

  function adviceFor(sig, st, p) {
    const side = sig.side, dir = side > 0 ? "下方" : "上方";
    switch (st.code) {
      case "go":
        return `现价 ${fmtPrice(st.price)}（已走 ${st.prog.toFixed(2)}R），可以直接市价进。<br>
          最多追到 <b>${fmtPrice(st.chaseLimit)}</b>，超过就别追；入场窗口还剩 ${st.minLeft} 分钟。<br>
          <span class="muted">不建议挂低价等回踩：回测里回踩成交的多是失败单，走掉的反而是好单。</span>`;
      case "weak":
        return `价格回到信号价${dir}，回测中这种情况胜率明显下降。<br>还没进场的<b>先别进</b>；已进场的按止损 ${fmtPrice(sig.sl)} 执行，不要扛单。`;
      case "chased":
        return `价格已经走了 ${st.prog.toFixed(1)}R，现在进盈亏比太差，<b>别追</b>，等下一个信号。<br>已进场的：继续按止损 ${fmtPrice(sig.sl)} / TP1 ${fmtPrice(sig.tp1)} 执行。`;
      case "expired":
        return `入场窗口已过，未进场的不要再进。<br>已进场的：止损 ${fmtPrice(sig.sl)}，TP1 ${fmtPrice(sig.tp1)}。`;
      case "manage":
        return `TP1 已到。持仓者：已平一半，剩余仓位止损跟在 <b>${fmtPrice(st.stop)}</b>（吊灯移动止损，${p.trailAtr} 倍 ATR）。<br>未进场的不要追。`;
      default:
        return `这一单已结束：${sig.result}${sig.r != null ? `（${sig.r >= 0 ? "+" : ""}${sig.r.toFixed(2)}R，已扣费）` : ""}。等下一个信号。`;
    }
  }

  function renderSide() {
    const sym = state.active, d = state.data[sym];
    const sess = sessionOf(sym);
    $("chartTitle").innerHTML = `${short(sym)} <span class="muted small">${CN_NAMES[sym] ?? ""} · ${MARKET_NAMES[marketOf(sym)]}永续 · 15m${sess ? " · " + sess.txt : ""}</span>`;
    if (!d?.live) { setHtml("liveScore", `<span class="muted">${d?.error ?? "加载中…"}</span>`); return; }
    const L = d.live, p = d.res.params;

    // 最新信号 + 操作建议
    const last = d.res.signals[d.res.signals.length - 1], st = d.lastStatus;
    if (!last) setHtml("lastSignal", '<span class="muted">近期暂无信号</span>');
    else {
      const stopSrc = last.behind && Math.abs(last.sl - last.behind.price) < 1.2 * last.risk && p.srStop ? `${last.side > 0 ? "支撑" : "压力"}位外` : "结构位外";
      const ahead = last.ahead && isFinite(last.roomR) ? `${last.side > 0 ? "前方压力" : "前方支撑"} ${fmtPrice(last.ahead.price)}（${last.roomR.toFixed(1)}R）` : "";
      setHtml("lastSignal", `<div class="sig-box">
        <div class="title ${sideCls(last.side)}">${sideTxt(last.side)} · ${last.trigger} · ${last.score}分</div>
        <div class="muted small" style="margin-bottom:6px">${fmtTime(last.time)} 收盘确认</div>
        ${statusBadge(last, st, false)}
        <div class="advice">${adviceFor(last, st, p)}</div>
        <div class="levels num">
          <span class="muted">信号价</span><span>${fmtPrice(last.entry)}</span><span></span>
          <span class="short">止损</span><span>${fmtPrice(last.sl)}</span><span class="muted">${fmtPct(last.sl, last.entry)} · ${stopSrc}</span>
          <span class="long">TP1 (1R)</span><span>${fmtPrice(last.tp1)}</span><span class="muted">${fmtPct(last.tp1, last.entry)} · 平一半</span>
          <span class="long">剩余半仓</span><span>移动止损</span><span class="muted">${p.trailAtr}×ATR 跟踪</span>
        </div>
        ${ahead ? `<div class="muted small" style="margin-top:4px">${ahead}</div>` : ""}
        ${d.exit && d.exit.i > last.i && st.code !== "done" ? `<div class="warn">● 趋势转弱：${d.exit.reason}（${fmtTime(d.exit.time)}）</div>` : ""}
      </div>`);
    }

    // 大周期背景
    const c = ctxNow(d), ph = phaseOf(c);
    const tfLine = (name, x) => x
      ? `<div class="tf-line"><span>${name}</span><span>Supertrend ${arrow(x.st)}</span><span>EMA20/50 ${arrow(x.stack)}</span><span>价格${x.px20 > 0 ? "在EMA20上" : "在EMA20下"}</span></div>`
      : `<div class="tf-line"><span>${name}</span><span class="muted">数据不足</span></div>`;
    const dl = Levels.daily(d.d1, Date.now() / 1000), px = d.ltf[d.ltf.length - 1].close;
    const dAbove = dl.filter((l) => l.price > px).sort((a, b) => a.price - b.price).slice(0, 2);
    const dBelow = dl.filter((l) => l.price <= px).sort((a, b) => b.price - a.price).slice(0, 2);
    const dRow = (l, cls, label) => `<div class="lv-row"><span class="${cls}">${label}</span><span class="num">${fmtPrice(l.price)}</span><span class="muted num">${fmtPct(l.price, px)}</span><span class="muted small">${l.touches}次</span></div>`;
    setHtml("bigPicture",
      tfLine("日线", c.d1) + tfLine("4h", c.h4) +
      `<div class="tf-line"><span>1h</span><span>趋势 ${arrow(c.h1)}</span><span class="muted">（信号方向过滤用的就是它）</span></div>` +
      (ph ? `<div class="phase ${ph.cls}">${ph.txt}</div>` : "") +
      `<div class="sub-h">日线关键位（近 90 天摆动点 + 近 7 日高低）</div>` +
      ([...dAbove].reverse().map((l) => dRow(l, "short", "日线压力")).join("") +
        dBelow.map((l) => dRow(l, "long", "日线支撑")).join("") || '<span class="muted small">数据不足</span>') +
      `<div class="muted small" style="margin-top:4px">仅供参考，不参与信号判定。回测显示把日线/4h 方向当硬过滤并不稳定，见下方「大周期分组统计」持续观察。</div>`);

    // 关键价位
    const kl = keyLevels(d, 3);
    const lvRow = (l, cls, label) => `<div class="lv-row"><span class="${cls}">${label} ${stars(l)}</span><span class="num">${fmtPrice(l.price)}</span><span class="muted num">${fmtPct(l.price, kl.price)}</span><span class="muted small">${l.tags.join("/") || l.touches + "次触及"}</span></div>`;
    setHtml("keyLevels",
      [...kl.above].reverse().map((l) => lvRow(l, "short", "压力")).join("") +
      `<div class="lv-row lv-now"><span>现价</span><span class="num">${fmtPrice(kl.price)}</span><span></span><span></span></div>` +
      kl.below.map((l) => lvRow(l, "long", "支撑")).join("") +
      `<div class="muted small" style="margin-top:4px">由 15m / 1h 摆动高低点和昨日高低点聚类而来，★ 越多被测试次数越多。止损会放在支撑/压力区外侧。</div>`);

    // 实时共振
    const col = (side, sc) => `<div class="score-col"><div class="head ${sideCls(side)}"><span>${sideTxt(side)}</span><span class="num">${sc.score}/100</span></div>
      ${sc.items.map((it) => `<div class="check ${it.ok ? "ok" : ""}"><span>${it.label}</span><span class="num">+${it.pts}</span></div>`).join("")}</div>`;
    setHtml("liveScore", `<div class="score-cols">${col(1, L.long)}${col(-1, L.short)}</div>
      <div class="muted small" style="margin-top:6px">阈值 ${state.params.scoreThreshold} 分；还需满足 ADX≥${p.minAdx}、1h Supertrend 同向，并出现回踩确认或放量突破，K线收盘才算信号</div>`);

    setHtml("indicatorBar", [
      ["1h趋势", L.trend > 0 ? '<span class="long">向上</span>' : L.trend < 0 ? '<span class="short">向下</span>' : '<span class="muted">震荡</span>'],
      ["RSI", L.rsi.toFixed(1)],
      ["ADX", L.adx.toFixed(1)],
      ["MACD柱", `<span class="${L.macdHist >= 0 ? "long" : "short"}">${fmtPrice(L.macdHist)}</span>`],
      ["量比", `${L.volRatio.toFixed(2)}x`],
      ["ATR", `${fmtPrice(L.atr)} (${L.atrPct.toFixed(2)}%)`],
      ["手续费/止损", `${((p.feePct / 100) / (L.atrPct / 100) / 1.2).toFixed(2)}R`],
    ].map(([k, v]) => `<span class="muted">${k}<b class="num" style="color:var(--text)">${v}</b></span>`).join(""));

    // 大周期分组统计：本机累计的全部品种已平仓信号
    const all = Object.values(journal);
    const grp = (f) => {
      const a = all.filter(f);
      if (!a.length) return `<span class="muted">-</span><span></span><span></span>`;
      const w = a.filter((x) => x.r > 0).length, R = a.reduce((s2, x) => s2 + x.r, 0) / a.length;
      return `<span class="num">${a.length}</span><span class="num">${((w / a.length) * 100).toFixed(0)}%</span><span class="num ${R > 0 ? "long" : "short"}">${R >= 0 ? "+" : ""}${R.toFixed(2)}R</span>`;
    };
    const since = all.length ? fmtTime(Math.min(...all.map((x) => x.t))).slice(0, 5) : "-";
    setHtml("ctxStats", `<div class="ctx-grid">
        <span class="muted">分组</span><span class="muted">笔数</span><span class="muted">胜率</span><span class="muted">每笔</span>
        <span>日线 同向</span>${grp((x) => x.d1 === "同向")}
        <span>日线 逆向</span>${grp((x) => x.d1 === "逆向")}
        <span>4h 同向</span>${grp((x) => x.h4 === "同向")}
        <span>4h 逆向</span>${grp((x) => x.h4 === "逆向")}
        <span>全部</span>${grp(() => true)}
      </div>
      <div class="bt-note">全部品种、本机自 ${since} 起累计（已扣费）。每组积累到 200 笔以上，差距仍然稳定，再考虑把它加入过滤条件。</div>`);

    const bt = d.res.bt, pct = (x) => (isNaN(x) ? "-" : (x * 100).toFixed(0) + "%");
    $("btRange").textContent = `（近 ${Math.round((d.ltf.length * 15) / 60 / 24)} 天 · ${bt.total} 笔）`;
    setHtml("backtest", `<div class="stats">
        <div class="stat"><div class="v ${bt.winRate >= 0.55 ? "long" : bt.winRate < 0.45 ? "short" : ""}">${pct(bt.winRate)}</div><div class="k">胜率</div></div>
        <div class="stat"><div class="v ${bt.avgR > 0 ? "long" : "short"}">${isNaN(bt.avgR) ? "-" : bt.avgR.toFixed(2) + "R"}</div><div class="k">每笔(扣费后)</div></div>
        <div class="stat"><div class="v">${pct(bt.tp2Rate)}</div><div class="k">移动止盈获利</div></div>
        <div class="stat"><div class="v">${bt.closed}</div><div class="k">已平仓</div></div>
        <div class="stat"><div class="v">${isNaN(bt.avgFeeR) ? "-" : bt.avgFeeR.toFixed(2) + "R"}</div><div class="k">每笔手续费</div></div>
        <div class="stat"><div class="v ${bt.totalR >= 0 ? "long" : "short"}">${bt.totalR.toFixed(1)}R</div><div class="k">累计</div></div>
      </div>
      <div class="bt-note">规则：信号收盘价入场；TP1(1R) 平一半、止损移保本，剩余半仓 ${p.trailAtr}×ATR 移动止损；同根K线同时碰到止损和止盈按止损算。手续费占止损 >${p.maxFeeR}R 的信号不发${p.market !== "crypto" ? "，股票周末不发" : ""}。已扣手续费 ${p.feePct}%，未计滑点和资金费率。${bt.open ? `另有 ${bt.open} 笔持仓中。` : ""}</div>`);
  }

  function renderFeed() {
    $("feed").innerHTML = state.feed.length
      ? state.feed.map((f) => `<div class="item" data-sym="${f.sym}"><span class="muted num">${fmtTime(f.t)}</span> <b>${short(f.sym)}</b> ${f.html}</div>`).join("")
      : '<span class="muted">打开页面后出现的新信号、TP1、止损等事件会记录在这里</span>';
  }

  function renderAll() {
    renderWatchlist();
    renderSide();
    renderChart();
  }

  function selectSymbol(sym) {
    state.active = sym;
    renderAll();
    if (matchMedia("(max-width: 900px)").matches) $("chartSection").scrollIntoView({ behavior: "smooth" });
  }

  // ---------------- 交互 ----------------
  function bindUi() {
    $("watchlist").addEventListener("click", (e) => {
      const del = e.target.dataset.del;
      if (del) { removeSymbol(del); e.stopPropagation(); return; }
      const card = e.target.closest(".card");
      if (card) selectSymbol(card.dataset.sym);
    });
    $("feed").addEventListener("click", (e) => { const it = e.target.closest(".item"); if (it) selectSymbol(it.dataset.sym); });

    const th = $("threshold");
    th.value = state.params.scoreThreshold;
    $("thresholdVal").textContent = th.value;
    th.oninput = () => { $("thresholdVal").textContent = th.value; };
    th.onchange = () => { state.params.scoreThreshold = +th.value; paramsChanged(); };
    $("feePct").value = state.params.feePct;
    $("feePct").onchange = (e) => { const v = parseFloat(e.target.value); if (v >= 0) { state.params.feePct = v; paramsChanged(); } };
    $("strictHtf").checked = state.params.strictHtf;
    $("strictHtf").onchange = (e) => { state.params.strictHtf = e.target.checked; paramsChanged(); };

    $("soundBtn").onclick = () => {
      state.sound = !state.sound;
      if (state.sound) {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
        beep("long");
      }
      $("soundBtn").textContent = state.sound ? "🔔 声音已开启" : "🔇 点击开启声音";
      $("soundBtn").classList.toggle("on", state.sound);
    };

    bindPushUi();
    $("menuBtn").onclick = () => document.querySelector(".controls").classList.toggle("open");

    $("addForm").onsubmit = async (e) => {
      e.preventDefault();
      const sym = $("addInput").value.trim().toUpperCase().split(/\s/)[0];
      if (!sym || state.symbols.includes(sym)) { $("addInput").value = ""; return; }
      try {
        await fetchKlines(sym, LTF, 1);
      } catch {
        alert(`找不到合约 ${sym}，请确认是币安U本位永续合约代码（如 SOLUSDT、NVDAUSDT）`);
        return;
      }
      state.symbols.push(sym);
      store.save("symbols", state.symbols);
      store.save("symbolsVer", SYMBOLS_VER);
      $("addInput").value = "";
      await loadSymbol(sym).catch(() => {});
      connectWs();
      selectSymbol(sym);
    };
  }

  function bindPushUi() {
    const m = $("pushModal");
    const fill = () => {
      const c = Push.config;
      $("pTok").value = c.token; $("pChat").value = c.chatId; $("pEnabled").checked = c.enabled;
      $("pUrl").value = c.pageUrl || (location.protocol.startsWith("http") ? location.href.replace(/#.*$/, "") : "");
      document.querySelectorAll("[data-ev]").forEach((el) => (el.checked = !!c.events[el.dataset.ev]));
      updatePushBtn();
    };
    const collect = () => {
      const events = {};
      document.querySelectorAll("[data-ev]").forEach((el) => (events[el.dataset.ev] = el.checked));
      return { token: $("pTok").value.trim(), chatId: $("pChat").value.trim(), enabled: $("pEnabled").checked, pageUrl: $("pUrl").value.trim(), events };
    };
    const msg = (t, ok) => { $("pMsg").textContent = t; $("pMsg").className = ok ? "long" : "short"; };
    $("pushBtn").onclick = () => { fill(); msg("", true); m.classList.add("open"); };
    $("pClose").onclick = () => m.classList.remove("open");
    m.onclick = (e) => { if (e.target === m) m.classList.remove("open"); };
    $("pDetect").onclick = async () => {
      try { msg("获取中…", true); const r = await Push.detectChatId($("pTok").value.trim()); $("pChat").value = r.id; msg(`已获取：${r.name} (${r.id})`, true); }
      catch (e) { msg(e.message, false); }
    };
    $("pTest").onclick = async () => {
      try { msg("发送中…", true); await Push.test($("pTok").value.trim(), $("pChat").value.trim()); msg("发送成功，看看手机", true); }
      catch (e) { msg(`发送失败：${e.message}（家里电脑需要能访问 Telegram）`, false); }
    };
    $("pSave").onclick = () => { Push.save(collect()); updatePushBtn(); msg("已保存", true); setTimeout(() => m.classList.remove("open"), 600); };
    fill();
  }
  function updatePushBtn() {
    const on = Push.ready();
    $("pushBtn").textContent = on ? "📱 推送中" : "📱 手机推送";
    $("pushBtn").classList.toggle("on", on);
  }

  function removeSymbol(sym) {
    if (state.symbols.length <= 1) return;
    state.symbols = state.symbols.filter((s) => s !== sym);
    delete state.data[sym];
    store.save("symbols", state.symbols);
    store.save("symbolsVer", SYMBOLS_VER);
    if (state.active === sym) state.active = state.symbols[0];
    connectWs();
    renderAll();
  }

  function paramsChanged() {
    store.save("params", { scoreThreshold: state.params.scoreThreshold, strictHtf: state.params.strictHtf, feePct: state.params.feePct });
    state.symbols.forEach((s) => state.data[s]?.ltf?.length && recompute(s));
    renderAll();
  }

  // ---------------- 启动 ----------------
  async function main() {
    initChart();
    bindUi();
    renderFeed();
    renderAll();
    const want = decodeURIComponent(location.hash.slice(1)).toUpperCase();
    if (want && state.symbols.includes(want)) state.active = want;
    window.addEventListener("hashchange", () => {
      const s2 = decodeURIComponent(location.hash.slice(1)).toUpperCase();
      if (state.symbols.includes(s2)) selectSymbol(s2);
    });
    await loadMeta();
    renderAll();
    await Promise.all(state.symbols.map((s) => loadSymbol(s).catch((err) => {
      state.data[s] = { ltf: [], htf: [], error: `加载失败：${err.message}` };
    })));
    renderAll();
    connectWs();
    Push.send("health", "✅ 盯盘助手已启动", `正在监控 ${state.symbols.length} 个品种：${state.symbols.map(short).join("、")}`, null);
    // 每秒刷新：实时价格、信号状态
    const isMobile = matchMedia("(max-width: 900px)").matches;
    const otherEvery = isMobile ? 6000 : 2000; // 非当前品种的重算间隔（K线收盘时仍会立即计算）
    let lastTick = Date.now();
    setInterval(() => {
      // 电脑睡眠检测：定时器停了很久说明机器睡过
      const gap = Date.now() - lastTick;
      lastTick = Date.now();
      if (gap > 3 * 60000) {
        const mins = Math.round(gap / 60000);
        notify({ kind: "exit", event: "health", sym: state.active, title: "电脑刚从睡眠中恢复", body: `约 ${mins} 分钟没有盯盘，期间的信号可能漏掉了。请在系统设置里把「睡眠」改为「从不」。`, feed: `<b class="wait">睡眠恢复</b> 中断 ${mins} 分钟` });
      }
      for (const s of state.symbols) {
        const dd = state.data[s];
        if (dd?.dirty && (s === state.active || Date.now() - dd.computedAt > otherEvery)) recompute(s);
      }
      renderWatchlist();
      renderSide();
      const d = state.data[state.active];
      if (!d?.res) return;
      if (chartKeyOf(d) !== chartKey) renderChart();
      else {
        // 只更新最后一根，避免整图重绘
        const x = d.ltf[d.ltf.length - 1], T = x.time + TZ;
        candle.update({ time: T, open: x.open, high: x.high, low: x.low, close: x.close });
        vol.update({ time: T, value: x.volume, color: x.close >= x.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)" });
      }
    }, 1000);
  }

  main();
})();
