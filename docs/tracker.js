/*!
 * Daily Akari Tracker（非公式）
 *
 * Daily Akari（https://dailyakari.com/）のクリア状況とクリアタイムを記録する補助ツール。
 * ブックマークレットから読み込まれ、DA のページの中だけで動作する。
 * 記録は DA のオリジンの localStorage（キーの接頭辞 "dat."）にだけ保存し、外部へは送信しない。
 * DA 本体の保存データは読み取るだけで、書き込まない。
 *
 * 仕様は SPEC.md を参照（コメント中の「SPEC 6.3」などは章番号）。
 */
(() => {
  'use strict';

  const VERSION = '0.6.0';
  const APP = 'dailyakari-tracker';
  const SCHEMA = 1;

  // ---- 起動条件（SPEC 6.1） ----
  if (!/(^|\.)dailyakari\.com$/.test(location.hostname)) {
    if (confirm('Daily Akari Tracker は Daily Akari（dailyakari.com）のページで実行してください。\n\nDaily Akari を開きますか？')) {
      location.href = 'https://dailyakari.com/';
    }
    return;
  }
  // 読み込み中にもう一度ブックマークレットを押した場合などの二重起動を防ぐ
  if (window.__dat) return;

  // ---- 定数 ----
  const KEY = { data: 'dat.data', list: 'dat.list', ui: 'dat.ui', log: 'dat.log', broken: 'dat.data.broken' };
  const DA_COMPLETION = 'archiveCompletion';
  const DA_SAVE = 'user://dailyakari.save';
  const V01_KEY = /^akariTracker(List|Code|Part.*)?$/;
  const DAY0 = Date.UTC(2025, 0, 6);   // No.1 の日付（月曜）
  const LIST_TTL = 12 * 3600 * 1000;    // 一覧の自動更新の間隔（SPEC 6.6）
  const PAGE_INTERVAL = 400;            // 一覧のページを取得する間隔（ミリ秒）
  const AUTHOR_MIN = 8;                 // 作問者フィルタに載せる作問数の下限 N（SPEC 5.8）
  const LOG_MAX = 40;
  const BACK_TO_CLOSE = true;           // 「戻る」でオーバーレイを閉じる（SPEC 5.1。DA の遷移と干渉したら false にする）
  const SPA_NAV = true;                 // プレイボタンでサイト内遷移する（SPEC 6.5。うまくいかなければ false にする）
  const OTHER = '\u0000other';          // 作問者フィルタの「その他」

  const DIFFS = [
    { k: '?', name: '不明', cls: 'x' },
    { k: 'VE', name: 'とても簡単', cls: 've' },
    { k: 'E', name: '簡単', cls: 'e' },
    { k: 'M', name: '普通', cls: 'm' },
    { k: 'H', name: '難しい', cls: 'h' },
    { k: 'VH', name: 'とても難しい', cls: 'vh' },
    { k: 'UH', name: '極めて難しい', cls: 'uh' },
  ];
  const diffOf = d => DIFFS[d] || DIFFS[0];
  const LAMPS = [['n', '－', '#8b949e', '未クリア'], ['c', '🎯', 'var(--lamp-c)', 'クリア'], ['p', '🌟', 'var(--lamp-p)', 'パーフェクト']];
  // 表の列: [キー, 見出し, クラス]。画面では「ランプ」を「クリア状況」と書く
  const COLS = [['no', 'No.', ''], ['date', '日付', ''], ['diff', '難易度', 'ct'], ['author', '作問者', ''], ['lamp', 'クリア状況', 'r'], ['best', 'ベスト', 'r'], ['last', '最終プレイ日', '']];
  const SORT_KEYS = {
    no: r => r.n,
    date: r => r.n,
    diff: r => r.d,
    author: r => r.author.toLowerCase(),
    lamp: r => (r.acc == null ? -1 : r.acc),
    best: r => (r.best ? r.best.ms : null),
    last: r => r.last || null,
  };
  const SORT_FIRST_DIR = { no: -1, date: -1, diff: 1, author: 1, lamp: -1, best: 1, last: -1 };

  // ---- 小物 ----
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad = v => String(v).padStart(2, '0');
  const nowISO = () => new Date().toISOString();
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  class UserError extends Error { }

  const WD = '日月火水木金土';
  function ymdOfNo(n) {
    const t = new Date(DAY0 + (n - 1) * 864e5);
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  }
  function parseDateKey(s) {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? [y, mo, d] : null;
  }
  function fmtYmd([y, m, d]) {
    return `${pad(y % 100)}/${pad(m)}/${pad(d)}(${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
  }
  // 端末の時刻での日付（と時刻）
  function fmtDay(ms) {
    const t = new Date(ms);
    return fmtYmd([t.getFullYear(), t.getMonth() + 1, t.getDate()]);
  }
  function fmtStamp(ms) {
    const t = new Date(ms);
    return `${fmtDay(ms)} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  function localDayKey() {
    const t = new Date();
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  }
  // 2025-01-06 からの日数 + 1（SPEC 6.2 の最後の手段）
  function fallbackNo() {
    const t = new Date();
    return Math.floor((Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) - DAY0) / 864e5) + 1;
  }
  // タイムの表記（SPEC 5.2）。秒未満は切り捨て
  function fmtTime(ms) {
    if (!(ms >= 0)) return '';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  }
  // 通知の timeResult（"m:ss"。1 時間以上は "h:mm:ss" と仮定）を秒にする
  function parseTime(text) {
    const m = /^(?:(\d+):)?(\d+):(\d{1,2})(?:\.\d+)?$/.exec(String(text == null ? '' : text).trim());
    return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
  }
  function toAcc(v) {
    if (v == null || v === '' || typeof v === 'boolean') return null;
    const x = Number(v);
    return isFinite(x) ? Math.min(1, Math.max(0, x)) : null;
  }
  const accFrom = v => toAcc(isObj(v) ? v.acc : v);
  // 正確さの % は切り捨て（99.6% を 100% と表示しない）
  const pct = a => Math.floor(a * 100 + 1e-9);
  const lampOf = a => (a == null ? 'n' : a >= 1 ? 'p' : 'c');
  const lampText = a => (a == null ? '－' : a >= 1 ? '🌟' : `🎯${pct(a)}%`);
  const dispTime = a => (a.ms > 0 ? fmtTime(a.ms) : a.text || '');
  const splitAuthors = s => s.split(/\s+\+\s+/).map(x => x.trim()).filter(Boolean);

  // ---- 状態 ----
  const state = {
    daily: null,          // { n, day }。/dailypuzzle で得た当日の番号と、取得した日
    listBusy: false,
    pidTried: new Set(),  // 一覧を更新しても番号が分からなかった puzzleId
    gapTried: new Set(),  // /archivepuzzle で補完を試みた番号
    expectPop: null,      // × などで閉じたときの history.back() を待つ関数
  };
  let list = null;        // dat.list
  let ui = null;          // dat.ui
  let logBuf = [];        // dat.log
  let model = null;       // 表示用に組み立てたデータ（変更があれば作り直す）
  let pidIndex = null;
  let els = null;         // UI の要素
  let isOpen = false;     // 閉じている間は描画しない（開いたときに描き直す）
  let backPushed = false, backUrl = '';

  // ---- localStorage ----
  function readJSON(key) {
    try {
      const s = localStorage.getItem(key);
      return s == null ? null : JSON.parse(s);
    } catch (e) {
      return null;
    }
  }
  function writeJSON(key, v) {
    try {
      localStorage.setItem(key, JSON.stringify(v));
      return true;
    } catch (e) {
      report(e, 'データの保存');
      return false;
    }
  }

  // dat.data（SPEC 7.1）。別のタブの書き込みを消さないよう、変更のたびに読み直す
  function loadData() {
    let raw = null, d = null;
    try { raw = localStorage.getItem(KEY.data); } catch (e) { /* 読めなければ空として扱う */ }
    if (raw != null) {
      try { d = JSON.parse(raw); } catch (e) { d = null; }
      if (!isObj(d)) {
        // 壊れたデータは上書きする前に退避しておく
        try { localStorage.setItem(KEY.broken, raw); } catch (e) { /* 退避できなくても続ける */ }
        d = null;
      }
    }
    if (!d) d = { schema: SCHEMA, attempts: {}, completion: {} };
    if (typeof d.schema !== 'number') d.schema = SCHEMA;
    if (!isObj(d.attempts)) d.attempts = {};
    if (!isObj(d.completion)) d.completion = {};
    return d;
  }
  function updateData(fn) {
    const d = loadData();
    const r = fn(d);
    writeJSON(KEY.data, d);
    invalidate();
    return r;
  }

  // dat.list（SPEC 6.6, 7.1）。complete は全ページを取得し終えたかどうか
  function emptyList() {
    return { fetchedAt: 0, complete: false, items: {} };
  }
  function loadList() {
    const l = readJSON(KEY.list);
    if (!isObj(l) || !isObj(l.items)) return emptyList();
    return { fetchedAt: Number(l.fetchedAt) || 0, complete: !!l.complete, items: l.items };
  }
  function saveList() {
    writeJSON(KEY.list, list);
    pidIndex = null;
    invalidate();
  }

  // dat.ui
  function defaultUI() {
    return {
      tab: 's', lastTab: 's',
      filter: { d: [], l: [], a: '', u: false },
      sort: { k: 'no', dir: -1 },
      qdesc: true,
      qpack: false,                     // 問題選択を詰めて並べる（false = 曜日ごと）
      fold: { sum: true, det: false },  // クリア状況の「サマリー」「詳細」を開いているか
      scroll: { s: 0, q: 0, set: 0 },
      sel: { s: 0, q: 0 },
    };
  }
  function loadUI() {
    const u = defaultUI(), v = readJSON(KEY.ui);
    if (!isObj(v)) return u;
    if (['s', 'q', 'set'].includes(v.tab)) u.tab = v.tab;
    if (['s', 'q'].includes(v.lastTab)) u.lastTab = v.lastTab;
    const f = isObj(v.filter) ? v.filter : {};
    if (Array.isArray(f.d)) u.filter.d = f.d.filter(x => Number.isInteger(x) && x >= 1 && x <= 6);
    if (Array.isArray(f.l)) u.filter.l = f.l.filter(x => ['n', 'c', 'p'].includes(x));
    if (typeof f.a === 'string') u.filter.a = f.a;
    u.filter.u = !!f.u;
    if (isObj(v.sort) && SORT_KEYS[v.sort.k]) u.sort = { k: v.sort.k, dir: v.sort.dir < 0 ? -1 : 1 };
    if (typeof v.qdesc === 'boolean') u.qdesc = v.qdesc;
    if (typeof v.qpack === 'boolean') u.qpack = v.qpack;
    for (const k of ['sum', 'det']) {
      if (isObj(v.fold) && typeof v.fold[k] === 'boolean') u.fold[k] = v.fold[k];
    }
    for (const t of ['s', 'q', 'set']) {
      if (isObj(v.scroll) && v.scroll[t] >= 0) u.scroll[t] = Number(v.scroll[t]);
    }
    for (const t of ['s', 'q']) {
      if (isObj(v.sel) && Number.isInteger(v.sel[t])) u.sel[t] = v.sel[t];
    }
    return u;
  }
  let uiTimer = 0;
  function saveUI(now) {
    clearTimeout(uiTimer);
    if (now) writeJSON(KEY.ui, ui);
    else uiTimer = setTimeout(() => writeJSON(KEY.ui, ui), 300);
  }

  // dat.log（受信した通知と、ツールの動作の記録。不具合を調べるときに開発者ツールで見る）
  function loadLog() {
    const v = readJSON(KEY.log);
    return Array.isArray(v) ? v.slice(-LOG_MAX) : [];
  }
  let logTimer = 0;
  function addLog(e) {
    e.t = nowISO();
    const last = logBuf[logBuf.length - 1];
    // loadProgress のように続けて届く同じ種類の通知は 1 件にまとめる
    if (e.k === 'msg' && !e.clear && last && last.k === 'msg' && !last.clear && last.type === e.type) {
      last.n = (last.n || 1) + 1;
      last.t = e.t;
      last.path = e.path;
      last.data = e.data;
    } else {
      logBuf.push(e);
      if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
    }
    clearTimeout(logTimer);
    logTimer = setTimeout(() => {
      try { localStorage.setItem(KEY.log, JSON.stringify(logBuf)); } catch (err) { /* ログは保存できなくてもよい */ }
    }, 1000);
  }

  // 処理ごとの例外はここに集め、ツール全体は止めない（SPEC 9 章）
  const errAt = {};
  function report(err, where, quiet) {
    const msg = String((err && err.message) || err).slice(0, 200);
    addLog({ k: 'err', where, msg });
    try { console.warn('[Daily Akari Tracker]', where, err); } catch (e) { /* なにもしない */ }
    if (quiet) return;
    const now = Date.now();
    if (now - (errAt[where] || 0) < 10000) return;
    errAt[where] = now;
    toast(`⚠ ${where}に失敗しました（${msg}）`, { warn: true, ms: 6000 });
  }

  // ---- DA のデータ（読み取りのみ） ----
  function readDACompletion() {
    const v = readJSON(DA_COMPLETION);
    return isObj(v) ? v : {};
  }
  // DA の archiveCompletion と、他の端末からインポートした分を合わせ、正確さの高い方を採る（SPEC 5.3）
  function completionMerged(data) {
    const out = {};
    for (const src of [readDACompletion(), data.completion]) {
      for (const k of Object.keys(src)) {
        const a = accFrom(src[k]);
        if (a != null && (out[k] == null || a > out[k])) out[k] = a;
      }
    }
    return out;
  }
  function readSave() {
    const v = readJSON(DA_SAVE);
    return isObj(v) ? v : null;
  }
  // ゲームの保存データから、クリア済みでタイムのあるエントリを取り出す
  function saveEntries() {
    const save = readSave(), out = [];
    if (!save) return out;
    for (const date of Object.keys(save)) {
      const byPid = save[date];
      if (!isObj(byPid)) continue;
      for (const pid of Object.keys(byPid)) {
        const e = byPid[pid];
        if (!isObj(e) || !e.solved) continue;
        const ms = Math.round(Number(e.elapsedMsecs));
        if (!(ms > 0)) continue;
        out.push({ date, pid: String(pid), ms, acc: toAcc(e.accuracy) });
      }
    }
    return out;
  }
  const saveSig = c => `${c.date}|${c.pid}|${c.ms}`;

  // ---- 挑戦記録 ----
  // live の保存データなし（秒単位）と v01 は、ミリ秒が分からない記録
  const isPrecise = a => !/^(live|v01)\|/.test(String(a.sig));
  const accEq = (x, y) => x == null || y == null || Math.abs(x - y) < 1e-6;
  // 秒単位の記録と、ミリ秒の記録が同じ挑戦かどうか。経路が違うと sig が一致しないので、タイムと正確さで見る
  function sameRun(a, b) {
    if (!(a.ms > 0) || !(b.ms > 0)) return false;
    if (isPrecise(a) && isPrecise(b)) return false;
    return Math.abs(a.ms - b.ms) < 1000 && accEq(a.acc, b.acc);
  }
  function isDup(arr, rec) {
    return arr.some(a => isObj(a) && (a.sig === rec.sig || sameRun(a, rec)));
  }
  function pushAttempt(d, no, rec) {
    const arr = Array.isArray(d.attempts[no]) ? d.attempts[no] : [];
    if (isDup(arr, rec)) return false;
    arr.push(rec);
    d.attempts[no] = arr;
    return true;
  }
  // a が b より速いか。どちらかがミリ秒不明なら秒で比べる（SPEC 6.8）
  function faster(a, b) {
    if (isPrecise(a) && isPrecise(b)) return a.ms < b.ms;
    return Math.floor(a.ms / 1000) < Math.floor(b.ms / 1000);
  }
  function bestOf(arr) {
    let best = null;
    for (const a of Array.isArray(arr) ? arr : []) {
      if (!isObj(a) || !(a.ms > 0)) continue;
      if (!best || faster(a, best)) best = a;
    }
    return best;
  }
  // 最後に記録した時刻（ミリ秒）。保存データから取り込んだ記録は取り込んだ時刻になる。なければ 0
  function lastPlayed(arr) {
    let last = 0;
    for (const a of Array.isArray(arr) ? arr : []) {
      const t = isObj(a) && typeof a.at === 'string' ? Date.parse(a.at) : NaN;
      if (t > last) last = t;
    }
    return last;
  }

  // ---- API（同一オリジン。SPEC 4.2） ----
  async function api(path) {
    const res = await fetch(location.origin + path, {
      headers: { 'X-Tz-Offset': String(new Date().getTimezoneOffset()), Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`${path} の応答が ${res.status} でした`);
    return res.json();
  }
  const numOf = e => {
    const n = Number(e && e.dailyNumber);
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  function normEntry(e) {
    const v = e.isPlayable;
    return {
      date: e.dateKey == null ? '' : String(e.dateKey),
      d: Number(e.difficulty) || 0,
      author: e.author == null ? '' : String(e.author),
      pid: e.puzzleId == null ? '' : String(e.puzzleId),
      p: v == null || v === true || Number(v) > 0 ? 1 : 0,
    };
  }

  // 一覧データの更新（SPEC 6.6）。full でなければ、既知の問題しかないページで打ち切る
  let listJob = null;
  function updateList(full) {
    if (!listJob) listJob = runListUpdate(full).finally(() => { listJob = null; });
    return listJob;
  }
  async function runListUpdate(full) {
    const prev = list;
    const incremental = !full && prev.complete && Object.keys(prev.items).length > 0;
    const got = {};
    const seen = new Set();
    let page = 0, fetched = 0, complete = false;
    state.listBusy = true;
    scheduleRender();
    try {
      for (let guard = 0; guard < 100; guard++) {
        if (fetched) await sleep(PAGE_INTERVAL);
        let res;
        try {
          res = await api(`/archivelist?page=${page}`);
        } catch (e) {
          // ページ番号が 1 始まりの場合に備え、page=0 が失敗したら 1 から取り直す
          if (page === 0 && !fetched) { page = 1; continue; }
          throw e;
        }
        fetched++;
        const entries = res && Array.isArray(res.entries) ? res.entries : [];
        let fresh = 0, unknown = 0;
        for (const e of entries) {
          const n = numOf(e);
          if (!n || seen.has(n)) continue;
          seen.add(n);
          fresh++;
          if (!prev.items[n]) unknown++;
          got[n] = normEntry(e);
        }
        if (!entries.length) {
          if (page === 0) { page = 1; continue; }
          complete = true;
          break;
        }
        if (!fresh) {
          // page=0 と page=1 が同じ内容なら 1 始まり。それ以外で新しい問題がないなら最後まで来た
          if (page === 1) { page = 2; continue; }
          complete = true;
          break;
        }
        if (incremental && !unknown) break;
        if (res.areMore === false) { complete = true; break; }
        page++;
      }
      // 取得している間に当日の問題などが足されていることがあるので、今の一覧に重ねる
      list = { fetchedAt: Date.now(), complete: complete || incremental, items: Object.assign({}, list.items, got) };
      saveList();
    } catch (e) {
      // 途中までの分は残し、次回は全件を取り直す
      list = { fetchedAt: prev.fetchedAt, complete: false, items: Object.assign({}, list.items, got) };
      saveList();
      throw e;
    } finally {
      state.listBusy = false;
      scheduleRender();
    }
  }

  // 当日の問題（SPEC 6.2, 6.6）
  const dailyFresh = () => !!state.daily && state.daily.day === localDayKey();
  async function refreshDaily() {
    const res = await api('/dailypuzzle');
    const n = numOf(res);
    if (!n) throw new Error('当日の問題の番号がありません');
    state.daily = { n, day: localDayKey() };
    const e = normEntry(Object.assign({}, res, { isPlayable: 1 }));
    const cur = list.items[n];
    if (!isObj(cur) || cur.pid !== e.pid || cur.d !== e.d || cur.author !== e.author) {
      list.items[n] = isObj(cur) ? Object.assign({}, cur, e, { p: cur.p }) : e;
      saveList();
    }
  }
  // アーカイブに未掲載で、当日でもない直近の問題を /archivepuzzle で補う（SPEC 5.5）
  async function fillGap() {
    if (!state.daily) return;
    let top = 0;
    for (const k of Object.keys(list.items)) {
      const n = Number(k);
      if (n < state.daily.n && n > top) top = n;
    }
    if (!top) return;
    let changed = false;
    for (let n = top + 1; n < state.daily.n && n <= top + 3; n++) {
      if (list.items[n] || state.gapTried.has(n)) continue;
      state.gapTried.add(n);
      try {
        await sleep(PAGE_INTERVAL);
        const res = await api(`/archivepuzzle?number=${n}`);
        const obj = isObj(res) && !('difficulty' in res) && isObj(res.puzzle) ? res.puzzle : res;
        if (!isObj(obj) || !(Number(obj.difficulty) > 0)) continue;
        list.items[n] = normEntry(obj);
        changed = true;
      } catch (e) {
        report(e, `No.${n} の取得`, true);
      }
    }
    if (changed) saveList();
  }

  // 一覧データをそろえる。mode: start（起動時）/ open（オーバーレイを開いたとき）/ manual（設定から）
  let syncJob = null;
  function syncList(mode) {
    if (!syncJob) syncJob = runSync(mode).finally(() => { syncJob = null; });
    return syncJob;
  }
  async function runSync(mode) {
    const empty = !Object.keys(list.items).length;
    const stale = Date.now() - list.fetchedAt >= LIST_TTL;
    let ok = true;
    if (mode === 'manual' || empty || !list.complete || (mode === 'open' && stale)) {
      try {
        await updateList(mode === 'manual' || empty || !list.complete);
      } catch (e) {
        ok = false;
        report(e, '一覧データの取得');
      }
    }
    if (mode !== 'open' || !dailyFresh()) {
      try {
        await refreshDaily();
      } catch (e) {
        ok = false;
        report(e, '当日の問題の取得', mode !== 'manual');
      }
    }
    try { await fillGap(); } catch (e) { report(e, '未掲載の問題の取得', true); }
    return ok;
  }

  function pidMap() {
    if (pidIndex) return pidIndex;
    pidIndex = new Map();
    for (const k of Object.keys(list.items)) {
      const it = list.items[k];
      if (isObj(it) && it.pid) pidIndex.set(String(it.pid), Number(k));
    }
    return pidIndex;
  }

  // ---- 問題番号の判定（SPEC 6.2） ----
  function archiveNoFromUrl() {
    const m = /^\/archive\/(\d+)\/?$/.exec(location.pathname);
    return m ? Number(m[1]) : 0;
  }
  async function resolveNo() {
    const a = archiveNoFromUrl();
    if (a) return { n: a, how: 'url' };
    if (!dailyFresh()) {
      try { await refreshDaily(); } catch (e) { report(e, '当日の問題の取得', true); }
    }
    if (dailyFresh()) return { n: state.daily.n, how: 'daily' };
    return { n: fallbackNo(), how: 'calc' };
  }

  // ---- ゲームからの通知（SPEC 4.4, 6.3） ----
  let clearChain = Promise.resolve();
  function onMessage(ev) {
    let d = ev.data;
    if (typeof d === 'string' && d.charAt(0) === '{') {
      try { d = JSON.parse(d); } catch (e) { /* 文字列のまま扱う */ }
    }
    const clear = isObj(d) && !!d.animTimeBtn && d.timeResult != null;
    logMsg(d, clear);
    if (clear) {
      clearChain = clearChain.then(() => onClear(d)).catch(e => report(e, 'タイムの記録'));
    }
  }
  function logMsg(d, clear) {
    let type, data;
    try {
      if (isObj(d)) {
        type = Object.keys(d).slice(0, 4).join(',');
        data = JSON.stringify(d);
      } else {
        type = typeof d;
        data = String(d);
      }
    } catch (e) {
      type = 'unknown';
      data = '';
    }
    if (data.length > 300) data = data.slice(0, 300) + '…';
    addLog({ k: 'msg', type, path: location.pathname, data, clear: clear || undefined });
  }
  // 保存データのうち、通知のタイムと 1 秒以内で合うもの（SPEC 6.3 の 3）
  function pickSave(cands, sec) {
    let best = null;
    for (const c of cands) {
      if (sec != null) {
        const diff = Math.abs(c.ms / 1000 - sec);
        if (diff > 1) continue;
        if (!best || diff < Math.abs(best.ms / 1000 - sec)) best = c;
      } else if (!best || c.date > best.date) {
        best = c;
      }
    }
    return best;
  }
  async function onClear(msg) {
    const text = String(msg.timeResult).trim();
    const sec = parseTime(text);
    const acc = toAcc(msg.accuracy);
    const { n: no, how } = await resolveNo();
    const it = list.items[no];
    const pid = isObj(it) ? it.pid : '';
    let hit = null;
    if (pid) {
      // 保存データの書き込みが遅れることがあるので、0.5 秒間隔で 3 回まで試す
      for (let i = 0; i < 3 && !hit; i++) {
        if (i) await sleep(500);
        hit = pickSave(saveEntries().filter(c => c.pid === pid), sec);
      }
    }
    const rec = hit
      ? { at: nowISO(), ms: hit.ms, text: fmtTime(hit.ms), acc: acc != null ? acc : hit.acc, src: 'live', sig: saveSig(hit), date: hit.date }
      : { at: nowISO(), ms: sec != null ? sec * 1000 : null, text, acc, src: 'live', sig: `live|${no}|${text}|${acc == null ? '' : acc}` };
    let prevBest = null;
    const added = updateData(d => {
      prevBest = bestOf(d.attempts[no]);
      return pushAttempt(d, no, rec);
    });
    addLog({ k: 'rec', no, how, sig: rec.sig, ms: rec.ms, added });
    if (!added) return;   // 開き直したときの再送など

    const lamp = acc == null ? '' : ` ${lampText(acc)}`;
    if (!(rec.ms > 0)) {
      toast(`No.${no} 記録${lamp}`);
    } else if (!prevBest) {
      toast(`No.${no} 記録 ${dispTime(rec)}${lamp}`);
    } else if (faster(rec, prevBest)) {
      celebrate(no, prevBest, rec);
    } else {
      toast(`No.${no} ${dispTime(rec)}（ベスト ${dispTime(prevBest)}）`);
    }
  }

  // ---- ゲームの保存データからの取り込み（SPEC 6.4） ----
  let importJob = null;
  function importSave() {
    if (!importJob) importJob = runImportSave().finally(() => { importJob = null; });
    return importJob;
  }
  async function runImportSave() {
    await clearChain;   // クリア通知を処理している最中なら、そちらを先に済ませる（演出を出すため）
    const known = new Set();
    for (const arr of Object.values(loadData().attempts)) {
      if (Array.isArray(arr)) for (const a of arr) if (isObj(a)) known.add(a.sig);
    }
    const cands = saveEntries().filter(c => !known.has(saveSig(c)));
    if (!cands.length) return 0;
    let map = pidMap();
    const missing = cands.filter(c => !map.has(c.pid) && !state.pidTried.has(c.pid));
    if (missing.length) {
      // 番号が分からなければ一覧を更新してから探す。それでもなければ保留して次回に回す
      missing.forEach(c => state.pidTried.add(c.pid));
      try { await updateList(false); } catch (e) { report(e, '一覧データの取得'); }
      if (!dailyFresh()) {
        try { await refreshDaily(); } catch (e) { report(e, '当日の問題の取得', true); }
      }
      map = pidMap();
    }
    const at = nowISO();
    const added = updateData(d => {
      let n = 0;
      for (const c of cands) {
        const no = map.get(c.pid);
        if (!no) continue;
        const rec = { at, ms: c.ms, text: fmtTime(c.ms), acc: c.acc, src: 'save', sig: saveSig(c), date: c.date };
        if (pushAttempt(d, no, rec)) n++;
      }
      return n;
    });
    if (added) {
      addLog({ k: 'save', added });
      toast(`未記録のクリアを ${added} 件取り込みました`);
    }
    return added;
  }

  // ---- 旧版（試作 v0.1）からの移行（SPEC 6.7） ----
  function migrateV01() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && V01_KEY.test(k)) keys.push(k);
    }
    if (!keys.length) return;
    const raw = localStorage.getItem('akariTracker');
    if (raw != null) {
      let recs = null;
      try { recs = v01Records(JSON.parse(raw)); } catch (e) { recs = null; }
      if (!recs) {
        // 形式が分からないときは消さずに残す
        report(new Error('旧版のデータの形式が分かりません'), '旧版のデータの移行');
        return;
      }
      const added = updateData(d => recs.filter(r => pushAttempt(d, r.no, r.rec)).length);
      addLog({ k: 'v01', found: recs.length, added });
      if (added) toast(`旧版の記録を ${added} 件移行しました`);
    }
    keys.forEach(k => localStorage.removeItem(k));
  }
  // 旧版のデータを { no, rec } の配列にする。形が分からなければ null
  function v01Records(v) {
    if (isObj(v) && (isObj(v.attempts) || Array.isArray(v.attempts))) v = v.attempts;
    const out = [];
    const add = (no, r, i) => {
      const n = Number(no);
      if (!Number.isInteger(n) || n <= 0 || !isObj(r)) return;
      let s = Number(r.s != null ? r.s : r.sec != null ? r.sec : r.secs);
      if (!(s > 0) && r.ms > 0) s = Math.floor(r.ms / 1000);
      if (!(s > 0)) s = parseTime(r.time != null ? r.time : r.text);
      if (!(s > 0)) return;
      const atRaw = r.at != null ? r.at : r.t != null ? r.t : i;
      const at = typeof atRaw === 'number' && atRaw > 1e11 ? new Date(atRaw).toISOString() : String(atRaw);
      const acc = toAcc(r.acc != null ? r.acc : r.accuracy);
      out.push({ no: n, rec: { at, ms: s * 1000, text: fmtTime(s * 1000), acc, src: 'v01', sig: `v01|${n}|${atRaw}` } });
    };
    if (Array.isArray(v)) {
      v.forEach((r, i) => add(isObj(r) ? (r.no != null ? r.no : r.n != null ? r.n : r.number != null ? r.number : r.dailyNumber) : 0, r, i));
    } else if (isObj(v)) {
      for (const k of Object.keys(v)) (Array.isArray(v[k]) ? v[k] : [v[k]]).forEach((r, i) => add(k, r, i));
    } else {
      return null;
    }
    const size = Array.isArray(v) ? v.length : Object.keys(v).length;
    return size && !out.length ? null : out;
  }

  // ---- エクスポート・インポート（SPEC 7.2） ----
  function exportName() {
    const t = new Date();
    return `${APP}-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}.json`;
  }
  function countAttempts(d) {
    let n = 0;
    for (const k of Object.keys(d.attempts)) if (Array.isArray(d.attempts[k])) n += d.attempts[k].length;
    return n;
  }
  function exportData() {
    const d = loadData();
    const merged = completionMerged(d), completion = {};
    for (const k of Object.keys(merged)) completion[k] = { acc: merged[k] };
    const payload = { app: APP, schema: SCHEMA, exportedAt: nowISO(), attempts: d.attempts, completion };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName();
    els.sr.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`エクスポートしました（挑戦記録 ${countAttempts(d)} 件、クリア状況 ${Object.keys(completion).length} 件）`);
  }
  function cleanAttempt(a) {
    if (!isObj(a) || typeof a.sig !== 'string' || !a.sig || a.sig.length > 300) return null;
    const ms = a.ms == null ? null : Math.round(Number(a.ms));
    if (ms != null && !(ms > 0)) return null;
    const rec = {
      at: typeof a.at === 'string' ? a.at.slice(0, 40) : '',
      ms,
      text: typeof a.text === 'string' ? a.text.slice(0, 20) : fmtTime(ms),
      acc: toAcc(a.acc),
      src: 'import',
      sig: a.sig,
    };
    if (typeof a.date === 'string') rec.date = a.date.slice(0, 40);
    return rec;
  }
  // 上書きせずに合算する。挑戦記録は sig の和集合、ランプは高い方。何度インポートしても結果は同じ
  function mergeImport(obj) {
    if (!isObj(obj) || obj.app !== APP) throw new UserError('Daily Akari Tracker でエクスポートしたファイルではありません');
    if (typeof obj.schema !== 'number' || obj.schema > SCHEMA) throw new UserError('このファイルの形式には対応していません');
    const att = obj.attempts, comp = obj.completion == null ? {} : obj.completion;
    if (!isObj(att) || !isObj(comp)) throw new UserError('ファイルの内容が正しくありません');
    return updateData(d => {
      const sigs = new Set();
      for (const arr of Object.values(d.attempts)) {
        if (Array.isArray(arr)) for (const a of arr) if (isObj(a)) sigs.add(a.sig);
      }
      let attempts = 0, lamps = 0;
      for (const k of Object.keys(att)) {
        const n = Number(k);
        if (!Number.isInteger(n) || n <= 0 || !Array.isArray(att[k])) continue;
        for (const a of att[k]) {
          const rec = cleanAttempt(a);
          if (!rec || sigs.has(rec.sig)) continue;
          sigs.add(rec.sig);
          if (!Array.isArray(d.attempts[n])) d.attempts[n] = [];
          d.attempts[n].push(rec);
          attempts++;
        }
      }
      // ランプは、DA の値と今までにインポートした値のどちらよりも高いときだけ保存する
      const before = completionMerged(d);
      for (const k of Object.keys(comp)) {
        const n = Number(k), a = accFrom(comp[k]);
        if (!Number.isInteger(n) || n <= 0 || a == null) continue;
        if (before[n] != null && a <= before[n]) continue;
        d.completion[n] = { acc: a };
        lamps++;
      }
      return { attempts, lamps };
    });
  }
  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new UserError('ファイルが大きすぎます');
      let obj;
      try { obj = JSON.parse(await file.text()); } catch (e) { throw new UserError('JSON として読めないファイルです'); }
      const r = mergeImport(obj);
      addLog({ k: 'import', attempts: r.attempts, lamps: r.lamps });
      toast(`挑戦記録 +${r.attempts} 件、クリア状況 +${r.lamps} 件を統合しました`);
    } catch (e) {
      if (e instanceof UserError) toast(`⚠ ${e.message}`, { warn: true, ms: 6000 });
      else report(e, 'インポート');
    } finally {
      els.file.value = '';
    }
  }

  // ---- 全消去（DA 本体のデータは消さない） ----
  function wipe() {
    if (!confirm('ツールのデータ（挑戦記録、一覧データ、表示の設定、受信ログ）をすべて消去します。\nDA 本体のデータは消えません。\n\n消去してよろしいですか？')) return;
    clearTimeout(uiTimer);
    clearTimeout(logTimer);
    for (const k of Object.values(KEY)) {
      try { localStorage.removeItem(k); } catch (e) { /* 続ける */ }
    }
    list = emptyList();
    ui = defaultUI();
    ui.tab = 'set';
    logBuf = [];
    pidIndex = null;
    state.pidTried.clear();
    state.gapTried.clear();
    invalidate();
    showTab('set');
    toast('ツールのデータを消去しました');
  }

  // ---- 表示用のデータ ----
  function invalidate() {
    model = null;
    scheduleRender();
  }
  function getModel() {
    if (model) return model;
    const data = loadData();
    const comp = completionMerged(data);
    const rows = [], byN = new Map(), cnt = new Map();
    for (const k of Object.keys(list.items)) {
      const n = Number(k), it = list.items[k];
      if (!Number.isInteger(n) || n <= 0 || !isObj(it)) continue;
      const d = Number(it.d);
      const r = {
        n,
        d: d >= 1 && d <= 6 ? d : 0,
        author: typeof it.author === 'string' ? it.author : '',
        p: it.p ? 1 : 0,
        acc: comp[k] != null ? comp[k] : null,
        best: bestOf(data.attempts[k]),
        last: lastPlayed(data.attempts[k]),
        date: fmtYmd(parseDateKey(it.date) || ymdOfNo(n)),
      };
      r.authors = splitAuthors(r.author);
      rows.push(r);
      byN.set(n, r);
      if (r.p) for (const a of r.authors) cnt.set(a, (cnt.get(a) || 0) + 1);
    }
    // 作問者フィルタの選択肢（プレイ可能な問題を N 問以上作っている作問者。共作は分けて数える）
    const authors = [...cnt].filter(([, c]) => c >= AUTHOR_MIN).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'ja'));
    const authorSet = new Set(authors.map(x => x[0]));
    const otherCount = rows.filter(r => r.p && !r.authors.some(a => authorSet.has(a))).length;
    model = { rows, byN, authors, authorSet, otherCount, data };
    return model;
  }
  // 「プレイ不可を表示」（f.u）は表示の設定なので、絞り込みには数えない
  const filterActive = f => !!(f.d.length || f.l.length || f.a);
  function passes(r, f, authorSet) {
    if (!r.p && !f.u) return false;
    if (f.d.length && !f.d.includes(r.d)) return false;
    if (f.l.length && !f.l.includes(lampOf(r.acc))) return false;
    if (f.a === OTHER) return !r.authors.some(a => authorSet.has(a));
    if (f.a) return r.authors.includes(f.a);
    return true;
  }
  function sortRows(rows, s) {
    const key = SORT_KEYS[s.k] || SORT_KEYS.no, dir = s.dir < 0 ? -1 : 1;
    rows.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null || y == null) {
        if (x == null && y == null) return b.n - a.n;
        return x == null ? 1 : -1;   // 空欄はどちらの向きでも後ろ
      }
      const c = typeof x === 'string' ? x.localeCompare(y, 'ja') : x - y;
      return c ? c * dir : b.n - a.n;
    });
  }

  // ---- 描画 ----
  function setHTML(el, html) {
    if (el._html === html) return;
    el.innerHTML = html;
    el._html = html;
  }
  let rafId = 0;
  function scheduleRender() {
    if (!isOpen || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }
  function render() {
    if (!els || !isOpen) return;
    try {
      const m = getModel(), f = ui.filter;
      const vis = m.rows.filter(r => passes(r, f, m.authorSet));
      const base = m.rows.filter(r => r.p || f.u).length;
      // 問題選択は、並び順と曜日ごとをフィルタの 2 段目に入れる
      setHTML(els.flts.s, filterHTML(m, false));
      setHTML(els.flts.q, filterHTML(m, true));
      renderCnt(els.cnts.s, vis.length, base);
      renderCnt(els.cnts.q, vis.length, base);
      renderFolds();
      setHTML(els.bands, bandsHTML(m));
      renderTable(m, vis);
      renderGrid(m, vis);
      renderSettings();
      renderSheet();
    } catch (e) {
      report(e, '表示の更新');
    }
  }

  // フィルタ（SPEC 5.8）。q2 は問題選択用で、1 段目 = 難易度とランプ、2 段目 = 並び順・作問者・プレイ不可を表示・曜日ごと。
  // それ以外は 1 段目 = 難易度、2 段目 = ランプ・作問者・プレイ不可を表示
  function filterHTML(m, q2) {
    const f = ui.filter;
    let h = '<div class="frow">';
    for (let i = 1; i <= 6; i++) {
      h += `<button class="dbtn${f.d.includes(i) ? ' on' : ''}" data-act="fd" data-v="${i}" style="--c:var(--d-${DIFFS[i].cls})" aria-pressed="${f.d.includes(i)}">${DIFFS[i].k}</button>`;
    }
    const lamps = '<span class="lgrp">' + LAMPS.map(([k, t, c, label]) =>
      `<button class="lbtn${f.l.includes(k) ? ' on' : ''}" data-act="fl" data-v="${k}" style="--c:${c}" aria-pressed="${f.l.includes(k)}" aria-label="${label}">${t}</button>`).join('') + '</span>';
    if (q2) h += lamps + '</div><div class="frow">' + orderHTML('sortb');
    else h += '</div><div class="frow">' + lamps;
    h += authorHTML(m) + switchHTML('fu', f.u, 'プレイ不可を表示');
    if (q2) h += switchHTML('qweek', !ui.qpack, '曜日ごと');
    return h + '</div>';
  }
  function orderHTML(cls) {
    return `<button class="${cls}" data-act="qorder">${ui.qdesc ? '新しい順' : '古い順'}</button>`;
  }
  // 作問者はネイティブの select で選ぶ（見た目はボタン。値は "" = すべて / "o" = その他 / "a:<名前>"）
  function authorHTML(m) {
    const f = ui.filter;
    let opts = `<option value=""${f.a ? '' : ' selected'}>すべて</option>`;
    let found = !f.a || f.a === OTHER;
    for (const [a, c] of m.authors) {
      if (a === f.a) found = true;
      opts += `<option value="a:${esc(a)}"${a === f.a ? ' selected' : ''}>${esc(a)} (${c})</option>`;
    }
    if (!found) opts += `<option value="a:${esc(f.a)}" selected>${esc(f.a)}</option>`;
    opts += `<option value="o"${f.a === OTHER ? ' selected' : ''}>その他 (${m.otherCount})</option>`;
    const label = f.a === OTHER ? 'その他' : f.a || 'すべて';
    return `<label class="author${f.a ? ' on' : ''}"><span>作問者: ${esc(label)}</span><b>▾</b><select data-act="fa" aria-label="作問者">${opts}</select></label>`;
  }
  function switchHTML(act, on, label) {
    return `<label class="sw"><input type="checkbox" role="switch" data-act="${act}"${on ? ' checked' : ''}><i></i>${label}</label>`;
  }
  // 件数の行（件数と、絞り込み中なら [解除 ×]）
  function renderCnt(el, shown, base) {
    const active = filterActive(ui.filter);
    el.classList.toggle('on', active);
    let h = '<span class="cnt-l">';
    h += active ? `<span><b>絞り込み中</b>　${shown} / ${base} 問</span>` : `<span>${shown} 問</span>`;
    if (state.listBusy) h += '<span class="busy">一覧を更新中…</span>';
    h += '</span>';
    if (active) h += '<button class="pill" data-act="freset">解除 ×</button>';
    setHTML(el, h);
  }

  // クリア状況の「サマリー」「詳細」の開閉（SPEC 5.6）
  function renderFolds() {
    for (const k of ['sum', 'det']) {
      els.folds[k].btn.setAttribute('aria-expanded', String(ui.fold[k]));
      els.folds[k].body.hidden = !ui.fold[k];
    }
  }

  // 帯グラフ（SPEC 5.6）。フィルタの影響を受けない
  function bandsHTML(m) {
    const play = m.rows.filter(r => r.p);
    let h = band('全体', '', 'var(--text)', play, true);
    for (let i = 1; i <= 6; i++) h += band(DIFFS[i].k, DIFFS[i].name, `var(--d-${DIFFS[i].cls})`, play.filter(r => r.d === i), false);
    return h;
  }
  function band(label, sub, color, items, all) {
    const t = items.length;
    let p = 0, c = 0;
    for (const r of items) {
      const l = lampOf(r.acc);
      if (l === 'p') p++;
      else if (l === 'c') c++;
    }
    const n = t - p - c;
    const seg = (cls, v) => {
      if (!t || !v) return '';
      const w = v / t * 100;
      return `<span class="seg ${cls}" style="width:${w}%">${w >= 7 ? v : ''}</span>`;
    };
    const rate = v => (t ? `${Math.floor(v * 100 / t)}%` : '－');
    return `<div class="band${all ? ' all' : ''}" style="--c:${color}">` +
      `<div class="band-top"><span class="band-name"><b>${label}</b><span>${sub ? sub + '　' : ''}${t} 問</span></span>` +
      `<span class="band-rate">クリア率 <b>${rate(p + c)}</b>　パーフェクト率 <b>${rate(p)}</b></span></div>` +
      `<div class="bar" title="パーフェクト ${p}　クリア ${c}　未クリア ${n}">${seg('p', p)}${seg('c', c)}${seg('n', n)}</div></div>`;
  }

  // 表（SPEC 5.6）。行の背景 = ランプ（地の色に混ぜて文字は白）、難易度 = 文字の色。
  // 難易度は短縮名と正式名の両方を入れ、PC では正式名を見せる。狭い画面では横スクロールさせる
  let shownSort = null;   // 表に今出している並び順（列見出しを押したときの切り替えの基準）
  const CELL = {
    no: r => `<td class="no">${r.n}</td>`,
    date: r => `<td>${r.date}</td>`,
    diff: r => `<td class="df" style="--c:var(--d-${diffOf(r.d).cls})"><span class="dk">${diffOf(r.d).k}</span><span class="dn">${diffOf(r.d).name}</span></td>`,
    author: r => `<td title="${esc(r.author)}">${esc(r.author)}</td>`,
    lamp: r => `<td class="r">${lampText(r.acc)}</td>`,
    best: r => `<td class="r">${r.best ? fmtTime(r.best.ms) : ''}</td>`,
    last: r => `<td>${r.last ? fmtDay(r.last) : ''}</td>`,
  };
  function renderTable(m, vis) {
    const cg = COLS.map(([k]) => (k === 'author' ? '<col>' : `<col class="c-${k}">`)).join('');
    els.colgs.forEach(el => setHTML(el, cg));
    // 知らない列で並べ替えていたら（古い保存データなど）、No. の降順で見せる
    const sort = shownSort = COLS.some(c => c[0] === ui.sort.k) ? ui.sort : defaultUI().sort;
    let th = '<tr>';
    for (const [k, label, cls] of COLS) {
      const mark = sort.k === k ? (sort.dir < 0 ? ' ▼' : ' ▲') : '';
      th += `<th class="${cls}" data-act="sort" data-k="${k}">${label}${mark}</th>`;
    }
    setHTML(els.thead, th + '</tr>');
    const rows = vis.slice();
    sortRows(rows, sort);
    const sel = ui.sel.s;
    setHTML(els.tbody, rows.map(r =>
      `<tr class="lp-${lampOf(r.acc)}${r.p ? '' : ' np'}${r.n === sel ? ' sel' : ''}" data-n="${r.n}">` +
      COLS.map(([k]) => CELL[k](r)).join('') + '</tr>'
    ).join(''));
    els.sEmpty.hidden = rows.length > 0;
    if (!rows.length) setHTML(els.sEmpty, emptyHTML(m));
  }
  function emptyHTML(m) {
    if (!m.rows.length) {
      return state.listBusy
        ? '一覧データを読み込んでいます…'
        : '一覧データがありません。<br><button class="btn" data-act="refresh">一覧データを読み込む</button>';
    }
    return '条件に合う問題はありません。<br><button class="btn" data-act="freset">絞り込みを解除</button>';
  }

  // 問題選択（SPEC 5.7）。曜日ごと: 1 週間 = 1 行（月〜日）。欠番と絞り込みで外れた分は空き枠にし、空の週は詰める。
  // 詰めて表示: 曜日の見出しを消し、表示するマスだけを番号順に並べる
  function cellHTML(r, extra, withNo) {
    return `<div class="cell lp-${lampOf(r.acc)}${r.p ? '' : ' np'}${extra}"${withNo ? ` data-n="${r.n}"` : ''} style="--c:var(--d-${diffOf(r.d).cls})">${r.n}</div>`;
  }
  function renderGrid(m, vis) {
    const sel = ui.sel.q;
    els.weekH.hidden = ui.qpack;
    els.qEmpty.hidden = vis.length > 0;
    if (!vis.length) setHTML(els.qEmpty, emptyHTML(m));
    if (ui.qpack) {
      const rows = vis.slice().sort((a, b) => (ui.qdesc ? b.n - a.n : a.n - b.n));
      setHTML(els.grid, rows.map(r => cellHTML(r, r.n === sel ? ' sel' : '', true)).join(''));
      return;
    }
    const byN = new Map(vis.map(r => [r.n, r]));
    let maxN = 0;
    for (const r of m.rows) if (r.n > maxN) maxN = r.n;
    const weeks = Math.ceil(maxN / 7);
    let h = '';
    for (let i = 0; i < weeks; i++) {
      const w = ui.qdesc ? weeks - 1 - i : i;
      let row = '', any = false;
      for (let k = 0; k < 7; k++) {
        const r = byN.get(w * 7 + k + 1);
        if (r) {
          any = true;
          row += cellHTML(r, r.n === sel ? ' sel' : '', true);
        } else {
          row += '<div class="slot"></div>';
        }
      }
      if (any) h += row;
    }
    setHTML(els.grid, h);
  }

  // 詳細パネル（SPEC 5.7）。クリア状況タブの行をタップしたときも同じものを出す
  function renderSheet() {
    const tab = ui.tab, n = tab === 'set' ? 0 : ui.sel[tab];
    const r = n ? getModel().byN.get(n) : null;
    if (!r) {
      els.sheet.hidden = true;
      setHTML(els.sheet, '');
    } else {
      const df = diffOf(r.d);
      const today = state.daily && state.daily.n === r.n ? '<span class="today">今日の問題</span>' : '';
      setHTML(els.sheet,
        `<div class="sheet-top">${cellHTML(r, ' big', false)}<div class="meta">` +
        `<div class="date">No.${r.n}　${r.date}${today}</div>` +
        `<div class="diff"><span class="chip" style="--c:var(--d-${df.cls})">${df.k}</span>${df.name}</div>` +
        `<div class="auth">${r.author ? esc(r.author) : '（作問者不明）'}</div></div>` +
        // 右の領域: × とベストのタイム（クリア状況はマスの三角で分かるので出さない。記録がなければ --:--）
        '<div class="side"><button class="ibtn x" data-act="unsel" aria-label="閉じる">×</button>' +
        `<b class="best${r.best ? '' : ' none'}" aria-label="ベスト">${r.best ? fmtTime(r.best.ms) : '--:--'}</b></div></div>` +
        (r.p ? `<button class="play" data-act="play" data-n="${r.n}">▶ プレイ</button>` : '<button class="play" disabled>プレイ不可</button>'));
      els.sheet.hidden = false;
    }
    // パネルに隠れた分もスクロールで見られるようにする
    const h = els.sheet.hidden ? '' : `${els.sheet.offsetHeight + 8}px`;
    for (const k of ['s', 'q']) els.bodies[k].style.paddingBottom = k === tab ? h : '';
  }

  function renderSettings() {
    const d = loadData();
    const count = Object.keys(list.items).length;
    const stamp = list.fetchedAt ? fmtStamp(list.fetchedAt) : '未取得';
    const busy = state.listBusy;
    setHTML(els.set,
      '<div class="grp">' +
      `<div class="item"><div class="t"><b>エクスポート</b><small>${esc(exportName())}（挑戦記録 ${countAttempts(d)} 件）</small></div><button class="btn" data-act="export">保存</button></div>` +
      '<div class="item"><div class="t"><b>インポート</b><small>他の端末の記録と合算します。上書きしません</small></div><button class="btn" data-act="import">ファイルを選ぶ</button></div>' +
      `<div class="item"><div class="t"><b>一覧データを更新</b><small>最終更新: ${stamp} （${count} 問）</small></div><button class="btn" data-act="refresh"${busy ? ' disabled' : ''}>${busy ? '更新中…' : '更新'}</button></div>` +
      '</div><div class="grp">' +
      '<div class="item"><div class="t"><b>ツールのデータを全消去</b><small>Webサイト側のデータは消えません</small></div><button class="btn danger" data-act="wipe">全消去</button></div>' +
      `</div><div class="ver">Daily Akari Tracker v${VERSION}<br>非公式ツールです</div>`);
  }

  // ---- 通知と演出 ----
  function toast(content, opt = {}) {
    if (!els) return;
    const el = document.createElement('div');
    el.className = 'toast' + (opt.gold ? ' gold' : '') + (opt.warn ? ' warn' : '');
    el.setAttribute('role', 'status');
    if (opt.html) el.innerHTML = content;
    else el.textContent = content;
    els.toasts.appendChild(el);
    while (els.toasts.children.length > 3) els.toasts.firstElementChild.remove();
    let done = false;
    const hide = () => {
      if (done) return;
      done = true;
      el.classList.add('out');
      setTimeout(() => el.remove(), 250);
    };
    el.addEventListener('click', hide);
    setTimeout(hide, opt.ms || 3500);
  }
  function deltaText(prev, rec) {
    const ds = Math.floor(prev.ms / 1000) - Math.floor(rec.ms / 1000);
    return ds >= 1 ? `−${fmtTime(ds * 1000)}` : `−${((prev.ms - rec.ms) / 1000).toFixed(2)}秒`;
  }
  // 自己ベスト更新の演出（SPEC 6.9）。CSS アニメーションだけで、1.5 秒以内に終わる
  function celebrate(no, prev, rec) {
    toast(`<b>🏆 自己ベスト更新！</b><br>No.${no}　${dispTime(prev)} → ${dispTime(rec)}（${deltaText(prev, rec)}）`, { gold: true, html: true, ms: 6000 });
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#f2c94c', '#2ea043', '#5fd4f4', '#f778ba', '#a371f7', '#ffffff'];
    const cx = innerWidth / 2;
    let h = '';
    for (let i = 0; i < 24; i++) {
      const dx = Math.round((Math.random() - 0.5) * 300), dy = Math.round(60 + Math.random() * 220);
      const r = Math.round((Math.random() - 0.5) * 720), left = Math.round(cx + (Math.random() - 0.5) * 120);
      h += `<i style="left:${left}px;background:${colors[i % colors.length]};--dx:${dx}px;--dy:${dy}px;--r:${r}deg;animation-delay:${(Math.random() * 0.15).toFixed(2)}s"></i>`;
    }
    const box = document.createElement('div');
    box.innerHTML = h;
    els.fx.appendChild(box);
    setTimeout(() => box.remove(), 1600);
  }

  // ---- 開閉・タブ・選択 ----
  function open() {
    if (isOpen || !els) return;
    isOpen = true;
    els.ov.classList.add('open');
    model = null;
    render();
    showTab(ui.tab);
    pushBackEntry();
    importSave().catch(e => report(e, '保存データからの取り込み'));
    syncList('open').catch(e => report(e, '一覧データの取得'));
  }
  function close() {
    if (!isOpen) return Promise.resolve();
    isOpen = false;
    els.ov.classList.remove('open');
    saveUI(true);
    return popBackEntry();
  }
  function toggle() {
    if (isOpen) close();
    else open();
  }
  function showTab(tab) {
    if (!['s', 'q', 'set'].includes(tab)) tab = 's';
    ui.tab = tab;
    if (tab !== 'set') ui.lastTab = tab;
    for (const k of Object.keys(els.panes)) els.panes[k].classList.toggle('on', k === tab);
    els.hdrBtns.forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    renderSheet();
    els.bodies[tab].scrollTop = ui.scroll[tab] || 0;
    saveUI();
  }
  function select(n) {
    const tab = ui.tab;
    if (tab === 'set') return;
    ui.sel[tab] = ui.sel[tab] === n ? 0 : n;
    const root = tab === 's' ? els.tbody : els.grid;
    root.querySelectorAll('.sel').forEach(el => el.classList.remove('sel'));
    const el = ui.sel[tab] ? root.querySelector(`[data-n="${ui.sel[tab]}"]`) : null;
    if (el) el.classList.add('sel');
    root._html = null;   // 手で書き換えたので、次の描画では必ず作り直す
    renderSheet();
    saveUI();
    // 選んだ行やマスが詳細パネルに隠れたら、見える位置までスクロールする
    if (el && !els.sheet.hidden) {
      const er = el.getBoundingClientRect(), top = els.sheet.getBoundingClientRect().top;
      if (er.bottom > top - 8) els.bodies[tab].scrollTop += er.bottom - top + 12;
    }
  }
  function filterChanged() {
    saveUI();
    render();
    // 絞り込みを変えたら、一覧の先頭から見せる
    if (ui.tab === 's') {
      // 固定表示中の要素は位置がずれるので、直前の見出しの下端を一覧の始まりとする
      const body = els.bodies.s;
      const top = Math.round(els.listHead.getBoundingClientRect().bottom - body.getBoundingClientRect().top + body.scrollTop);
      if (body.scrollTop > top) body.scrollTop = top;
    } else if (ui.tab === 'q') {
      els.bodies.q.scrollTop = 0;
    }
  }
  function toggleIn(arr, v) {
    const i = arr.indexOf(v);
    if (i < 0) arr.push(v);
    else arr.splice(i, 1);
  }

  // プレイボタン（SPEC 6.5）。再読み込みせずに DA のルーターに遷移してもらう
  async function play(n) {
    const r = getModel().byN.get(n);
    if (!r || !r.p) return;
    const path = state.daily && state.daily.n === n ? '/' : `/archive/${n}`;
    await close();
    // 閉じたときの history.back() の popstate は DA のルーターにも届き、ルーターは setTimeout(0) の後に処理する。
    // その前に URL を変えると、元の問題へ遷移し直してしまうので少し待つ
    await sleep(50);
    if (location.pathname === path) return;
    if (!SPA_NAV) {
      alert('ページを再読み込みして移動します。\n再読み込み後は、ブックマークレットをもう一度実行してください。');
      location.assign(path);
      return;
    }
    try {
      history.pushState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      addLog({ k: 'nav', path });
    } catch (e) {
      report(e, 'ページの移動');
    }
  }

  // ---- 「戻る」で閉じる（SPEC 5.1） ----
  // 開いたときに同じ URL の履歴を 1 つ積み、「戻る」でそれが外れたら閉じる。
  // この popstate は先に登録された DA のルーターにも届く（window では capture でも先回りできない）。
  // URL が変わらないので、Angular の既定（onSameUrlNavigation: 'ignore'）なら遷移は起きない
  function pushBackEntry() {
    if (!BACK_TO_CLOSE || backPushed) return;
    try {
      const base = isObj(history.state) ? history.state : {};
      history.pushState(Object.assign({}, base, { __dat: 1 }), '', location.href);
      backPushed = true;
      backUrl = location.href;
    } catch (e) {
      report(e, '履歴の操作', true);
    }
  }
  function popBackEntry() {
    if (!backPushed) return Promise.resolve();
    backPushed = false;
    if (!(isObj(history.state) && history.state.__dat) || location.href !== backUrl) return Promise.resolve();
    return new Promise(resolve => {
      state.expectPop = resolve;
      setTimeout(() => {
        if (state.expectPop === resolve) {
          state.expectPop = null;
          resolve();
        }
      }, 600);
      history.back();
    });
  }
  function onPopState(ev) {
    if (!BACK_TO_CLOSE) return;
    const st = ev.state;
    if (state.expectPop) {
      // × などで閉じたときに積んだ履歴を外した分。stopImmediatePropagation は後に登録されたリスナー向け
      const resolve = state.expectPop;
      state.expectPop = null;
      ev.stopImmediatePropagation();
      resolve();
      return;
    }
    if (location.href !== backUrl) {
      // URL が変わる遷移は DA に任せる。開いたままなら閉じる
      if (isOpen) {
        backPushed = false;
        close();
      }
      return;
    }
    if (isOpen && backPushed && !(isObj(st) && st.__dat)) {
      backPushed = false;
      ev.stopImmediatePropagation();
      close();
    }
    // 「進む」で積んだ履歴に戻ったときは何もしない（開き直さない）
  }

  // ---- 操作 ----
  function onClick(e) {
    const t = e.target.closest('[data-act],[data-tab],[data-n]');
    if (!t) return;
    try {
      const act = t.dataset.act;
      if (!act && t.dataset.tab) {
        const tab = t.dataset.tab;
        showTab(tab === 'set' && ui.tab === 'set' ? ui.lastTab : tab);
        return;
      }
      if (!act) {
        select(Number(t.dataset.n));
        return;
      }
      switch (act) {
        case 'toggle': toggle(); break;
        case 'close': close(); break;
        case 'fd': toggleIn(ui.filter.d, Number(t.dataset.v)); filterChanged(); break;
        case 'fl': toggleIn(ui.filter.l, t.dataset.v); filterChanged(); break;
        case 'freset': ui.filter = Object.assign(defaultUI().filter, { u: ui.filter.u }); filterChanged(); break;
        case 'qorder': ui.qdesc = !ui.qdesc; saveUI(); render(); els.bodies.q.scrollTop = 0; break;
        case 'fold': {
          const k = t.dataset.k;
          ui.fold[k] = !ui.fold[k];
          saveUI();
          renderFolds();
          break;
        }
        case 'sort': {
          const k = t.dataset.k, cur = shownSort || ui.sort;
          ui.sort = cur.k === k ? { k, dir: -cur.dir } : { k, dir: SORT_FIRST_DIR[k] || 1 };
          saveUI();
          render();
          break;
        }
        case 'unsel': select(ui.sel[ui.tab]); break;
        case 'play': play(Number(t.dataset.n)).catch(err => report(err, 'ページの移動')); break;
        case 'export': exportData(); break;
        case 'import': els.file.click(); break;
        case 'refresh':
          syncList('manual').then(ok => {
            if (ok) toast(`一覧データを更新しました（${Object.keys(list.items).length} 問）`);
          });
          break;
        case 'wipe': wipe(); break;
        default: break;
      }
    } catch (err) {
      report(err, '操作');
    }
  }
  function onChange(e) {
    const t = e.target;
    try {
      if (t === els.file) {
        importFile(t.files && t.files[0]);
      } else if (t.dataset.act === 'fa') {
        const v = t.value;
        ui.filter.a = v === 'o' ? OTHER : v.startsWith('a:') ? v.slice(2) : '';
        filterChanged();
      } else if (t.dataset.act === 'fu') {
        ui.filter.u = t.checked;
        filterChanged();
      } else if (t.dataset.act === 'qweek') {
        ui.qpack = !t.checked;
        saveUI();
        render();
        els.bodies.q.scrollTop = 0;
      }
    } catch (err) {
      report(err, '操作');
    }
  }
  function onKeyDown(e) {
    if (isOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  function onStorage(e) {
    if (e.storageArea !== localStorage) return;
    if (e.key === null || e.key === KEY.list) {
      list = loadList();
      pidIndex = null;
    }
    if (e.key === null || e.key === KEY.data || e.key === KEY.list || e.key === DA_COMPLETION) invalidate();
  }

  // ---- UI の組み立て ----
  const CSS = `
:host { all: initial; }
/* DA の CSS がホスト要素に当たっても引き継がれないよう、色や字体は .root で指定し直す */
.root {
  --bg: #0d1117;
  --surface: #161b22;
  --surface2: #1f262f;
  --line: #2a313a;
  --text: #f0f3f6;
  --accent: #79c0ff;
  --gold: #f2c94c;
  /* ランプ（SPEC 5.4: パーフェクト = 黄、クリア = 緑、未クリア = 暗い灰） */
  --lamp-p: #e3b341;
  --lamp-c: #2ea043;
  --lamp-n: #2b323b;
  /* 問題選択のマスの三角だけは、明るい背景の上で目立つよう鮮やかな黄・緑にする */
  --tri-p: #ffd400;
  --tri-c: #00d455;
  /* 難易度（SPEC 5.4 の仮配色: 水色 / 青 / 紫 / ピンク / 赤 / 白）。VE と E、H と VH の差が出るよう、E は濃い青、VH は朱色寄り */
  --d-ve: #4cdbe6;
  --d-e: #3366ff;
  --d-m: #a371f7;
  --d-h: #ff6ec7;
  --d-vh: #ff4520;
  --d-uh: #f0f3f6;
  --d-x: #8b949e;
  /* 背景に敷く色の濃さ（SPEC 5.4）。表の行のランプは地の色に混ぜて文字を白に、問題選択のマスなどの難易度は白に混ぜて文字を黒にする */
  --tint-lamp: 30%;
  --tint-diff: 55%;
  color-scheme: dark;   /* select のポップアップなど、ブラウザが描く部品も暗い配色にする */
  color: var(--text);
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif;
  letter-spacing: normal;
  text-align: left;
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, select, input { font: inherit; color: inherit; margin: 0; }
button { cursor: pointer; touch-action: manipulation; }
button:disabled { cursor: default; }

/* バッジ */
.badge { position: fixed; z-index: 2147483000; left: 10px; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); display: flex; align-items: center; gap: 6px; padding: 6px 12px 6px 10px; border-radius: 999px; background: rgba(13,17,23,.9); border: 1px solid #30363d; color: var(--text); font-size: 12px; font-weight: 600; line-height: 1.2; box-shadow: 0 4px 14px rgba(0,0,0,.35); cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: manipulation; }
.badge i { width: 8px; height: 8px; border-radius: 50%; background: #ff5a52; animation: pulse 2s infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255,90,82,.6); } 70%, 100% { box-shadow: 0 0 0 6px rgba(255,90,82,0); } }

/* トーストと演出（トーストは紙吹雪より前面） */
.toasts { position: fixed; z-index: 2147483003; top: calc(10px + env(safe-area-inset-top, 0px)); left: 0; right: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 0 12px; pointer-events: none; }
.toast { position: relative; overflow: hidden; pointer-events: auto; width: max-content; max-width: min(100%, 520px); padding: 10px 16px; border-radius: 12px; border: 1px solid #30363d; background: rgba(22,27,34,.97); color: var(--text); font-size: 14px; line-height: 1.5; box-shadow: 0 8px 24px rgba(0,0,0,.45); overflow-wrap: anywhere; cursor: pointer; animation: tin .18s ease-out; transition: opacity .2s, transform .2s; }
.toast.out { opacity: 0; transform: translateY(-6px); }
.toast.warn { border-color: #b8524c; }
.toast.gold { text-align: center; padding: 10px 18px; background: linear-gradient(135deg, #2b2105, #4d3909); border-color: var(--gold); color: #fff4cc; box-shadow: 0 0 0 1px rgba(242,201,76,.25), 0 0 12px rgba(242,201,76,.3), 0 8px 24px rgba(0,0,0,.45); animation: tin .18s ease-out, glow 1.4s ease-out; }
.toast.gold b { font-size: 15px; }
.toast.gold::after { content: ""; position: absolute; inset: 0; background: linear-gradient(105deg, transparent 30%, rgba(255,255,255,.35) 50%, transparent 70%); transform: translateX(-120%); animation: shine 1.1s ease-out .1s forwards; pointer-events: none; }
@keyframes tin { from { opacity: 0; transform: translateY(-8px); } }
@keyframes shine { to { transform: translateX(120%); } }
@keyframes glow { from { box-shadow: 0 0 0 1px rgba(242,201,76,.5), 0 0 34px rgba(242,201,76,.75), 0 8px 24px rgba(0,0,0,.45); } }
.fx { position: fixed; z-index: 2147483002; inset: 0; pointer-events: none; overflow: hidden; }
.fx i { position: absolute; top: calc(64px + env(safe-area-inset-top, 0px)); width: 6px; height: 10px; border-radius: 1px; opacity: 0; animation: fall 1.3s cubic-bezier(.2,.6,.4,1) forwards; }
@keyframes fall { 0% { transform: translate(0,0) rotate(0); opacity: 1; } 100% { transform: translate(var(--dx), var(--dy)) rotate(var(--r)); opacity: 0; } }

/* オーバーレイ */
.ov { position: fixed; z-index: 2147483001; inset: 0; display: none; flex-direction: column; background: var(--bg); color: var(--text); overscroll-behavior: contain; }
.ov.open { display: flex; }
.hdr { flex: none; padding-top: env(safe-area-inset-top, 0px); background: var(--surface); border-bottom: 1px solid var(--line); }
.hdr-in { display: flex; align-items: center; height: 48px; max-width: 760px; margin: 0 auto; padding: 0 4px 0 6px; }
.tabs { flex: 1; display: flex; height: 100%; }
.tab { position: relative; border: 0; background: none; color: var(--text); font-size: 15px; font-weight: 500; padding: 0 14px; }
.tab.on { font-weight: 800; }
.tab.on::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: 0; height: 3px; border-radius: 3px 3px 0 0; background: var(--text); }
.ibtn { flex: none; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 10px; background: none; color: var(--text); font-size: 20px; line-height: 1; }
.ibtn.on { background: var(--surface2); }
.pane { flex: 1; min-height: 0; display: none; flex-direction: column; }
.pane.on { display: flex; }
.body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; scrollbar-width: thin; scrollbar-color: #30363d transparent; }
.wrap { max-width: 760px; margin: 0 auto; }
.empty { padding: 36px 16px; text-align: center; font-size: 13px; line-height: 1.8; }
.empty .btn { margin-top: 12px; }

/* フィルタ */
.flt { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 8px 7px; background: var(--bg); border-bottom: 1px solid var(--line); }
.pane > .flt, .pane > .cnt { padding-left: max(8px, calc(50% - 372px)); padding-right: max(8px, calc(50% - 372px)); }
.frow { display: flex; gap: 6px; align-items: center; min-width: 0; }
.dbtn { flex: 1; min-width: 0; height: 30px; padding: 0; border-radius: 8px; border: 1.5px solid color-mix(in srgb, var(--c) 55%, transparent); background: color-mix(in srgb, var(--c) 8%, transparent); color: var(--c); font-size: 13px; font-weight: 700; }
.dbtn.on { background: var(--c); border-color: var(--c); color: #000; }
.lbtn { flex: none; width: 36px; height: 30px; padding: 0; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--text); font-size: 14px; }
.lbtn.on { border-color: var(--c); background: color-mix(in srgb, var(--c) 28%, transparent); box-shadow: inset 0 0 0 1px var(--c); }
.lgrp { flex: none; display: flex; gap: 6px; }
/* 問題選択の 2 段目（並び順・作問者・プレイ不可を表示・曜日ごと）は、入りきらない分を次の行に折り返す */
.flt.col .frow:last-child { flex-wrap: wrap; }
.sortb { flex: none; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--text); font-size: 12px; white-space: nowrap; }
.author { position: relative; flex: 0 1 auto; min-width: 0; display: flex; align-items: center; gap: 4px; height: 30px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); font-size: 12px; white-space: nowrap; cursor: pointer; }
.author span { overflow: hidden; text-overflow: ellipsis; }
.author b { flex: none; font-weight: 400; }
.author.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.author select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; font-size: 16px; cursor: pointer; }
/* ポップアップの選択肢は select の文字色（白）を引き継ぐので、地の色も暗くしておく */
.author select, .author option { background-color: var(--surface); color: var(--text); }
/* スイッチ（プレイ不可を表示、曜日ごと） */
.sw { position: relative; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 2px; font-size: 12px; white-space: nowrap; cursor: pointer; user-select: none; -webkit-user-select: none; }
.sw input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.sw i { position: relative; flex: none; width: 30px; height: 18px; border-radius: 5px; border: 1.5px solid #8b949e; background: var(--surface); transition: background-color .15s, border-color .15s; }
.sw i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 3px; background: var(--text); transition: transform .15s; }
.sw input:checked + i { background: var(--accent); border-color: var(--accent); }
.sw input:checked + i::after { transform: translateX(12px); background: #000; }
.sw input:focus-visible + i { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 件数の行。入りきらないときは解除が折り返す */
.cnt { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-height: 34px; padding: 4px 8px 4px 12px; background: var(--bg); border-bottom: 1px solid var(--line); font-size: 12px; font-variant-numeric: tabular-nums; }
.cnt.on { background: #18202b; }
.cnt.on b { color: var(--accent); }
.cnt .busy { color: var(--accent); }
.cnt-l { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; min-height: 26px; }
.pill { flex: none; height: 26px; padding: 0 11px; border-radius: 13px; border: 1px solid var(--line); background: var(--surface2); color: var(--text); font-size: 12px; white-space: nowrap; }

/* クリア状況タブ（「サマリー」「詳細」は折り畳める見出しの帯） */
.fold { display: flex; align-items: center; gap: 8px; width: 100%; padding: 12px 14px; border: 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--surface); color: var(--text); font-size: 19px; font-weight: 800; text-align: left; }
.fold::before { content: "▸"; flex: none; width: 1em; font-size: .85em; text-align: center; }
.fold[aria-expanded="true"]::before { content: "▾"; }
.fold[data-k="sum"] { border-top: 0; }
.fold[data-k="det"] { margin-top: 14px; }
.legend { display: flex; gap: 16px; padding: 12px 12px 10px; font-size: 13px; }
.legend span::before { content: ""; display: inline-block; width: 11px; height: 11px; margin-right: 4px; border-radius: 2px; background: var(--c); vertical-align: -1px; box-shadow: 0 0 0 1px rgba(255,255,255,.25); }
.stick { position: sticky; top: 0; z-index: 2; }
.bands { display: flex; flex-direction: column; gap: 16px; padding: 0 12px 6px; }
/* 狭い画面で 1 行に入りきらないときは、率を 2 行目の右に折り返す */
.band-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 8px; margin-bottom: 6px; font-size: 14px; }
.band-name { white-space: nowrap; }
.band-name b { color: var(--c); font-size: 17px; margin-right: 6px; }
.band-name span { font-size: 13px; }
.band-rate { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar { display: flex; height: 24px; border-radius: 4px; overflow: hidden; background: var(--lamp-n); }
.band.all { padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.band.all .bar { height: 30px; }
.seg { flex: none; display: grid; place-items: center; overflow: hidden; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.seg.p { background: var(--lamp-p); color: #000; }
.seg.c { background: var(--lamp-c); color: #000; }
.seg.n { background: var(--lamp-n); color: var(--text); }

/* 表（行の背景 = ランプを地の色に混ぜて文字は白、難易度 = 文字の色）。
   狭い画面では作問者の列を約 104px に留めて横スクロールさせる（見出しの表と本体の表は scrollLeft を合わせる） */
.hx { overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
.hx::-webkit-scrollbar { display: none; }
.tbl { width: max(100%, 480px); border-collapse: collapse; table-layout: fixed; font-size: 12px; font-variant-numeric: tabular-nums; }
.tbl .c-no { width: 46px; }
.tbl .c-date { width: 84px; }
.tbl .c-diff { width: 40px; }
.tbl .c-lamp { width: 66px; }
.tbl .c-best { width: 56px; }
.tbl .c-last { width: 84px; }
.tbl .dn { display: none; }
.tbl th { padding: 8px 4px; background: var(--surface); color: var(--text); font-size: 11.5px; font-weight: 700; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--line); cursor: pointer; user-select: none; -webkit-user-select: none; }
.tbl td { height: 40px; padding: 0 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid rgba(0,0,0,.5); cursor: pointer; }
.tbl th:first-child, .tbl td:first-child { padding-left: 12px; }
.tbl th:last-child, .tbl td:last-child { padding-right: 10px; }
.tbl .r { text-align: right; }
.tbl .ct { text-align: center; }
.tbl tr.lp-p td { background-color: color-mix(in srgb, var(--lamp-p) var(--tint-lamp), var(--bg)); }
.tbl tr.lp-c td { background-color: color-mix(in srgb, var(--lamp-c) var(--tint-lamp), var(--bg)); }
.tbl tr.lp-n td { background-color: var(--surface); }
.tbl tr td.no { font-weight: 800; }
.tbl tr td.df { color: color-mix(in srgb, var(--c) 80%, #fff); font-weight: 800; text-align: center; }
.tbl tr.np td { background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.07) 0 5px, transparent 5px 10px); }
.tbl tr.sel td { box-shadow: inset 0 2px 0 #fff, inset 0 -2px 0 #fff; }
.tbl tr.sel td:first-child { box-shadow: inset 2px 0 0 #fff, inset 0 2px 0 #fff, inset 0 -2px 0 #fff; }
.tbl tr.sel td:last-child { box-shadow: inset -2px 0 0 #fff, inset 0 2px 0 #fff, inset 0 -2px 0 #fff; }

/* 問題選択（曜日ごとなら 1 週間 = 1 行。背景 = 難易度を白に混ぜた色で文字は黒、左上の三角 = ランプ） */
.week-h, .grid7 { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; max-width: 540px; margin: 0 auto; }
.week-h { position: sticky; top: 0; z-index: 1; padding: 6px 10px; background: var(--bg); border-bottom: 1px solid var(--line); font-size: 11.5px; font-weight: 700; text-align: center; }
.grid7 { padding: 8px 10px 16px; }
.cell { --t: 12px; --tri: none; height: 48px; border-radius: 6px; display: grid; place-items: center; background-color: color-mix(in srgb, var(--c) var(--tint-diff), #fff); background-image: var(--tri); color: #000; font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; cursor: pointer; user-select: none; -webkit-user-select: none; }
/* 三角は斜めの辺だけに細い黒い線を付ける（マスの縁には付けない） */
.cell.lp-p { --tri: linear-gradient(135deg, var(--tri-p) calc(var(--t) - .5px), #000 var(--t), #000 calc(var(--t) + 1px), transparent calc(var(--t) + 1.5px)); }
.cell.lp-c { --tri: linear-gradient(135deg, var(--tri-c) calc(var(--t) - .5px), #000 var(--t), #000 calc(var(--t) + 1px), transparent calc(var(--t) + 1.5px)); }
.cell.np { background-color: transparent; color: var(--text); background-image: var(--tri), repeating-linear-gradient(135deg, color-mix(in srgb, var(--c) 30%, transparent) 0 4px, transparent 4px 9px); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 50%, transparent); }
.cell.sel { outline: 2px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 6px rgba(255,255,255,.16); }
.slot { height: 48px; border-radius: 6px; background: rgba(255,255,255,.035); }

/* 詳細パネル */
.sheet { position: absolute; z-index: 3; left: 0; right: 0; bottom: 0; max-width: 560px; margin: 0 auto; padding: 14px 14px calc(14px + env(safe-area-inset-bottom, 0px)); background: var(--surface); border: 1px solid var(--line); border-bottom: 0; border-radius: 16px 16px 0 0; box-shadow: 0 -12px 30px rgba(0,0,0,.55); }
.sheet .x { width: 32px; height: 32px; font-size: 18px; background: var(--surface2); }
.sheet-top { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
.side { flex: none; margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.cell.big { --t: 22px; flex: none; width: 72px; height: 72px; border-radius: 12px; font-size: 24px; cursor: default; }
.meta { flex: 1 1 0; min-width: 0; align-self: center; }
.meta .date { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.meta .today { margin-left: 8px; color: var(--gold); font-weight: 700; }
.meta .diff { margin: 5px 0 3px; font-size: 15px; font-weight: 700; }
.meta .auth { font-size: 13.5px; overflow-wrap: anywhere; }
.chip { display: inline-block; min-width: 30px; margin-right: 6px; padding: 1px 7px; border-radius: 5px; background: color-mix(in srgb, var(--c) var(--tint-diff), #fff); box-shadow: inset 0 0 0 1px var(--c); color: #000; font-size: 12px; font-weight: 800; text-align: center; }
.side .best { font-size: 24px; font-weight: 800; line-height: 1.2; font-variant-numeric: tabular-nums; white-space: nowrap; }
.play { width: 100%; height: 46px; border: 0; border-radius: 12px; background: var(--text); color: var(--bg); font-size: 15.5px; font-weight: 800; }
.play:disabled { border: 1px dashed #8b949e; background: var(--surface2); color: var(--text); }

/* 設定（項目は横線で区切る。全消去は間を空けて別にする） */
.set { padding-top: 16px; }
.grp { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.grp + .grp { margin-top: 28px; }
.item { display: flex; align-items: center; gap: 10px; padding: 12px; }
.item + .item { border-top: 1px solid var(--line); }
.item .t { flex: 1; min-width: 0; }
.item .t b { display: block; font-size: 14px; font-weight: 600; }
.item .t small { display: block; margin-top: 3px; font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere; }
.btn { flex: none; height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface2); color: var(--text); font-size: 12.5px; white-space: nowrap; }
.btn:disabled { border-style: dashed; }
.btn.danger { border-color: #8e3a3a; background: transparent; color: #ff7b72; }
.ver { padding: 24px 12px 32px; text-align: center; font-size: 11px; line-height: 1.7; }

/* PC など幅の広い画面では、クリア状況のフィルタを 1 行に収め、表の文字を大きくして難易度を正式名にする */
@media (min-width: 700px) {
  .flt { flex-direction: row; align-items: center; }
  /* 難易度のボタンは広げず、クリア状況と問題選択で同じ幅にする（入りきらない幅では縮む） */
  .flt .frow:first-child { flex: none; }
  .flt .frow:not(:first-child) { flex: 1 1 auto; min-width: 0; }
  .dbtn { flex: none; width: 54px; }
  /* 問題選択は 2 段（1 段目 = 難易度とランプ、2 段目 = 並び順・作問者・プレイ不可を表示・曜日ごと） */
  .flt.col { flex-direction: column; align-items: stretch; }
  .flt.col .lgrp { margin-left: 10px; }
  .flt.col .sw { margin-left: 6px; }
  .tbl { width: 100%; font-size: 15px; }
  .tbl th { padding: 10px 6px; font-size: 13.5px; }
  .tbl td { padding: 0 6px; }
  .tbl .c-no { width: 58px; }
  .tbl .c-date { width: 108px; }
  .tbl .c-diff { width: 112px; }
  .tbl .c-lamp { width: 84px; }
  .tbl .c-best { width: 70px; }
  .tbl .c-last { width: 108px; }
  .tbl .dk { display: none; }
  .tbl .dn { display: inline; }
}
@media (prefers-reduced-motion: reduce) {
  .badge i, .toast, .toast.gold, .toast.gold::after { animation: none; }
}
`;

  function buildUI() {
    const host = document.createElement('dat-tracker');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = `<style>${CSS}</style><div class="root">
<div class="badge" data-act="toggle" role="button" tabindex="0" aria-label="Daily Akari Tracker を開く"><i></i>記録中</div>
<div class="ov" role="dialog" aria-label="Daily Akari Tracker">
  <div class="hdr"><div class="hdr-in">
    <div class="tabs"><button class="tab" data-tab="s">クリア状況</button><button class="tab" data-tab="q">問題選択</button></div>
    <button class="ibtn" data-tab="set" aria-label="設定">⚙&#xFE0E;</button>
    <button class="ibtn" data-act="close" aria-label="閉じる">×</button>
  </div></div>
  <div class="pane" data-pane="s"><div class="body"><div class="wrap">
    <button class="fold" data-act="fold" data-k="sum" aria-expanded="true">サマリー</button>
    <div class="fold-sum">
      <div class="legend"><span style="--c:var(--lamp-p)">パーフェクト</span><span style="--c:var(--lamp-c)">クリア</span><span style="--c:var(--lamp-n)">未クリア</span></div>
      <div class="bands"></div>
    </div>
    <button class="fold" data-act="fold" data-k="det" aria-expanded="false">詳細</button>
    <div class="fold-det">
      <div class="stick"><div class="flt"></div><div class="cnt"></div><div class="hx"><table class="tbl"><colgroup></colgroup><thead></thead></table></div></div>
      <div class="hx"><table class="tbl"><colgroup></colgroup><tbody></tbody></table></div>
      <div class="empty s-empty" hidden></div>
    </div>
  </div></div></div>
  <div class="pane" data-pane="q">
    <div class="flt col"></div><div class="cnt"></div>
    <div class="body">
      <div class="week-h"><span>月</span><span>火</span><span>水</span><span>木</span><span>金</span><span>土</span><span>日</span></div>
      <div class="grid7"></div>
      <div class="empty q-empty" hidden></div>
    </div>
  </div>
  <div class="pane" data-pane="set"><div class="body"><div class="wrap set"></div></div></div>
  <div class="sheet" hidden></div>
</div>
<div class="fx"></div>
<div class="toasts" aria-live="polite"></div>
<input type="file" accept=".json,application/json" hidden>
</div>`;
    const $ = s => sr.querySelector(s);
    const panes = {}, bodies = {};
    for (const p of sr.querySelectorAll('.pane')) {
      panes[p.dataset.pane] = p;
      bodies[p.dataset.pane] = p.querySelector('.body');
    }
    els = {
      host, sr, panes, bodies,
      ov: $('.ov'),
      hdrBtns: [...sr.querySelectorAll('[data-tab]')],
      flts: { s: $('[data-pane="s"] .flt'), q: $('[data-pane="q"] .flt') },
      cnts: { s: $('[data-pane="s"] .cnt'), q: $('[data-pane="q"] .cnt') },
      listHead: $('.fold[data-k="det"]'),
      folds: {
        sum: { btn: $('.fold[data-k="sum"]'), body: $('.fold-sum') },
        det: { btn: $('.fold[data-k="det"]'), body: $('.fold-det') },
      },
      bands: $('.bands'),
      weekH: $('.week-h'),
      colgs: [...sr.querySelectorAll('.tbl colgroup')],
      thead: $('thead'),
      tbody: $('tbody'),
      sEmpty: $('.s-empty'),
      grid: $('.grid7'),
      qEmpty: $('.q-empty'),
      set: $('.set'),
      sheet: $('.sheet'),
      fx: $('.fx'),
      toasts: $('.toasts'),
      file: $('input[type=file]'),
    };
    sr.addEventListener('click', onClick);
    sr.addEventListener('change', onChange);
    $('.badge').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    // 表の見出しと本体は別の表なので、横スクロールの位置を互いに合わせる（同じ値を入れても scroll は起きない）
    const hx = [...sr.querySelectorAll('.hx')];
    hx.forEach((el, i) => el.addEventListener('scroll', () => { hx[1 - i].scrollLeft = el.scrollLeft; }, { passive: true }));
    for (const k of Object.keys(bodies)) {
      bodies[k].addEventListener('scroll', () => {
        if (!isOpen || ui.tab !== k) return;
        ui.scroll[k] = Math.round(bodies[k].scrollTop);
        saveUI();
      }, { passive: true });
    }
    // DA の body には touch-action: none があるので、body ではなく <html> の直下に置く（SPEC 5.1）
    document.documentElement.appendChild(host);
  }

  // ---- 起動（SPEC 6.1） ----
  function start() {
    list = loadList();
    ui = loadUI();
    logBuf = loadLog();
    window.__dat = Object.freeze({ version: VERSION, toggle, open, close: () => { close(); } });
    buildUI();
    try { migrateV01(); } catch (e) { report(e, '旧版のデータの移行'); }
    window.addEventListener('message', onMessage);
    window.addEventListener('popstate', onPopState, true);
    window.addEventListener('storage', onStorage);
    document.addEventListener('keydown', onKeyDown, true);
    addLog({ k: 'start', v: VERSION, path: location.pathname });
    toast('記録を開始しました');
    syncList('start')
      .then(() => importSave())
      .catch(e => report(e, '起動時の処理'));
  }

  try {
    start();
  } catch (e) {
    try { delete window.__dat; } catch (x) { /* なにもしない */ }
    if (els) els.host.remove();
    alert(`Daily Akari Tracker を起動できませんでした（${(e && e.message) || e}）`);
  }
})();
