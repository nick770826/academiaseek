/* ============================================================
 *  app.js — Academiaseek 逻辑层
 *
 *  数据模型（data.js）：
 *    大学 { id,name,en,abbr,country,city,qs,score,scoreSrc,grades,band,
 *           scoreEst,nRows,nCats,nPrograms,cats[],entries[] }
 *    entry { cat,college,programs[],req,subjects,urlList,urlReq,year,note,
 *            score,scoreSrc,grades,basis,floor,estBasis }
 *
 *  门槛分口径：等效合计分，越低门槛越低。
 *    scoreSrc='official' → 官网原文解析；'est' → 按同侪院校推定
 *    floor=true → 官网给的是录取下边界/及格线，实际录取通常更高
 * ============================================================ */
(function () {
'use strict';

var LS_FAV = 'academiaseek.fav.v2';
var LS_CMP = 'academiaseek.cmp.v2';
var LS_THEME = 'academiaseek.theme.v2';
var LS_COLS = 'academiaseek.cols.v2';   // 卡片列数：1 单列 / 2 双列

/* 注意：局部变量名不能与 data.js 里的全局 const 同名，否则 var 提升会自我遮蔽，
 *      `typeof CATS` 恒为 undefined（踩过的坑）。 */
var UNIS = (typeof UNIVERSITIES !== 'undefined' ? UNIVERSITIES : []);
var ALL_CATS = (typeof CATS !== 'undefined' ? CATS : []);
var SYS = (typeof SYSTEMS !== 'undefined' ? SYSTEMS : {});
var METAINFO = (typeof META !== 'undefined' ? META : {});

var state = {
  theme: 'dark',
  view: 'browse',
  q: '',
  sort: 'default',
  hideEst: false,
  cols: 1,                 // 卡片列数：1 单列 / 2 双列
  grade: '',
  filters: { country: [], qsBand: [], cat: [], level: [], scoreSrc: [] },
  fav: [],
  cmp: [],
  cmpCat: '',
  openCats: {}
};

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function load(key, dflt) {
  try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

var toastTimer = null;
function toast(msg) {
  var el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('on'); el.hidden = true; }, 2000);
}

/* ---------------- 主题 ---------------- */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  var dark = state.theme === 'dark';
  $('#themeIcon').textContent = dark ? '☀' : '☾';
  $('#themeLabel').textContent = dark ? '日间' : '夜间';
  save(LS_THEME, state.theme);
}
window.applyTheme = applyTheme;

/* ---------------- 派生值 ---------------- */
function qsBandOf(qs) {
  if (!qs) return '300+';
  if (qs <= 50) return '1-50';
  if (qs <= 100) return '51-100';
  if (qs <= 200) return '101-200';
  return '201-300';
}
function bandClass(b) { return 'lv-' + (b === 1 || b === 2 || b === 3 ? b : 5); }
function bandText(b) { return b === 1 ? '较低' : b === 2 ? '中等' : b === 3 ? '较高' : '—'; }
function bandOfScore(s) { if (s == null) return 5; return s >= 20 ? 3 : s >= 15 ? 2 : 1; }

/** 当前恰好选中一个学科门类时，门槛/排序按该门类算 */
function activeCat() { return state.filters.cat.length === 1 ? state.filters.cat[0] : ''; }
function medianOf(arr) {
  if (!arr.length) return null;
  var a = arr.slice().sort(function (x, y) { return x - y; });
  var m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function uniScore(u) {
  var cat = activeCat();
  if (cat) {
    var es = u.entries.filter(function (e) { return e.cat === cat; });
    if (es.length) return medianOf(es.map(function (e) { return e.score; }));
  }
  return u.score;
}
function uniGrades(u) {
  var cat = activeCat();
  if (cat) {
    var e = u.entries.filter(function (x) { return x.cat === cat && x.grades; })[0];
    if (e) return e.grades;
  }
  return u.grades;
}
function scoreText(u) {
  var g = uniGrades(u), s = uniScore(u);
  return (g ? g + ' · ' : '') + '≈' + (s == null ? '—' : s.toFixed(1));
}
/* 等效合计分 → 最接近的标准等级组合，让推定值和官网值长得一样好读 */
var GRADE_LADDER = [
  [25.2, 'A*A*A*'], [23.8, 'A*A*A'], [22.4, 'A*AA'], [21, 'AAA'], [19.6, 'AAB'],
  [18.2, 'ABB'], [16.8, 'BBB'], [15.4, 'BBC'], [14, 'BCC'], [12.6, 'CCC'],
  [11.2, 'CCD'], [9.8, 'CDD'], [8.4, 'DDD'], [5.6, 'EEE']
];
function gradeForScore(s) {
  if (s == null) return null;
  var best = GRADE_LADDER[0];
  for (var i = 1; i < GRADE_LADDER.length; i++) {
    if (Math.abs(GRADE_LADDER[i][0] - s) < Math.abs(best[0] - s)) best = GRADE_LADDER[i];
  }
  return best[1];
}
/** 卡片门槛徽章：官网值直接用原文等级串，推定值用反推的等级串加 ≈ 前缀 */
function chipLabel(u) {
  var g = uniGrades(u);
  if (g) return g;
  var s = uniScore(u);
  var lg = gradeForScore(s);
  return lg ? '≈' + lg : '≈' + (s == null ? '—' : s.toFixed(1));
}

/** 详情/对比里用：等级串 + 数值双显示 */
function scoreTextFull(u) {
  var s = uniScore(u);
  return chipLabel(u) + (s == null ? '' : ' · ≈' + s.toFixed(1));
}

/* ---------------- 搜索索引 ---------------- */
UNIS.forEach(function (u) {
  var parts = [u.name, u.en, u.city, u.country, u.abbr];
  u.entries.forEach(function (e) {
    parts.push(e.cat, e.college);
    for (var i = 0; i < e.programs.length; i++) parts.push(e.programs[i]);
  });
  u._blob = parts.join(' ').toLowerCase();
  // 门类排序：该门类下明细越多越靠前（更能代表这所学校）
  u._catCount = {};
  u.entries.forEach(function (e) { u._catCount[e.cat] = (u._catCount[e.cat] || 0) + 1; });
  u._catsSorted = u.cats.slice().sort(function (a, b) {
    return (u._catCount[b] || 0) - (u._catCount[a] || 0) || a.localeCompare(b, 'zh');
  });
});

/* ---------------- 收藏 / 对比 ---------------- */
function isFav(id) { return state.fav.indexOf(id) >= 0; }
/** 重播一次 pop 动画（v1 的 restartAnim） */
function popEl(el) {
  if (!el || prefersReduced()) return;
  el.classList.remove('v3-pop');
  void el.offsetWidth;
  el.classList.add('v3-pop');
  setTimeout(function () { el.classList.remove('v3-pop'); }, 520);
}

/** 就地更新一张卡片的收藏/对比外观，避免为了换个按钮状态重绘整个列表 */
function refreshCard(id) {
  var fav = isFav(id), cmp = isCmp(id);
  $$('#uniList .uni-card[data-id="' + id + '"], #favList .uni-card[data-id="' + id + '"]').forEach(function (card) {
    card.classList.toggle('is-fav', fav);
    card.classList.toggle('is-cmp', cmp);
    var fb = card.querySelector('[data-act="fav"]');
    if (fb) { var wasOnF = fb.classList.contains('on'); fb.classList.toggle('on', fav); fb.textContent = fav ? '★ 已收藏' : '☆ 收藏'; if (wasOnF !== fav) popEl(fb); }
    var cb = card.querySelector('[data-act="cmp"]');
    if (cb) { var wasOnC = cb.classList.contains('on'); cb.classList.toggle('on', cmp); cb.textContent = cmp ? '✓ 已选' : '＋ 对比'; if (wasOnC !== cmp) popEl(cb); }
  });
  if (curDetail === id) {
    var df = $('#detailFav'), dc = $('#detailCompare');
    if (df) { df.textContent = fav ? '★ 已收藏' : '☆ 收藏'; df.classList.toggle('on', fav); }
    if (dc) { dc.textContent = cmp ? '✓ 已对比' : '＋ 对比'; dc.classList.toggle('on', cmp); }
  }
  $('#favCount').textContent = state.fav.length;
  $('#favCount').hidden = state.fav.length === 0;
  $('#favCount2').textContent = state.fav.length;
  if ($('#filterBadge')) { /* 筛选计数与收藏无关 */ }
}
function toggleFav(id) {
  var i = state.fav.indexOf(id);
  if (i >= 0) { state.fav.splice(i, 1); toast('已取消收藏'); }
  else { state.fav.push(id); toast('已加入收藏'); }
  save(LS_FAV, state.fav);
  refreshCard(id);
  if (state.view === 'favorites') renderFav();
}
function isCmp(id) { return state.cmp.indexOf(id) >= 0; }
function toggleCmp(id) {
  var i = state.cmp.indexOf(id);
  if (i >= 0) state.cmp.splice(i, 1);
  else {
    if (state.cmp.length >= 4) { toast('最多同时对比 4 所'); return; }
    state.cmp.push(id);
    toast('已加入对比（' + state.cmp.length + '/4）');
  }
  save(LS_CMP, state.cmp);
  refreshCard(id);
  renderTray();
  if (state.view === 'compare') renderCompare();
}
function uniById(id) { for (var i = 0; i < UNIS.length; i++) if (UNIS[i].id === id) return UNIS[i]; return null; }

/* ---------------- 筛选 ---------------- */
function matchFilters(u) {
  var f = state.filters;
  if (f.country.length && f.country.indexOf(u.country) < 0) return false;
  if (f.qsBand.length && f.qsBand.indexOf(qsBandOf(u.qs)) < 0) return false;
  if (f.level.length && f.level.indexOf(u.band) < 0) return false;
  if (f.scoreSrc.length && f.scoreSrc.indexOf(u.scoreSrc) < 0) return false;
  if (f.cat.length) {
    var has = false;
    for (var i = 0; i < f.cat.length; i++) if (u.cats.indexOf(f.cat[i]) >= 0) { has = true; break; }
    if (!has) return false;
  }
  if (state.grade) {
    var s = uniScore(u);
    if (s == null || s > Number(state.grade)) return false;
  }
  if (state.hideEst && u.scoreSrc === 'est') return false;
  return true;
}
function matchQuery(u) { return !state.q || u._blob.indexOf(state.q) >= 0; }
function visibleUnis() { return UNIS.filter(function (u) { return matchFilters(u) && matchQuery(u); }); }
function sortUnis(list) {
  var s = state.sort;
  var byQS = function (a, b) { return (a.qs || 9999) - (b.qs || 9999); };
  if (s === 'level-asc') return list.sort(function (a, b) { return uniScore(a) - uniScore(b) || byQS(a, b); });
  if (s === 'level-desc') return list.sort(function (a, b) { return uniScore(b) - uniScore(a) || byQS(a, b); });
  if (s === 'programs') return list.sort(function (a, b) { return b.nPrograms - a.nPrograms || byQS(a, b); });
  if (s === 'country') return list.sort(function (a, b) { return a.country.localeCompare(b.country, 'zh') || byQS(a, b); });
  if (s === 'name') return list.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
  return list.sort(byQS);
}

/* ---------------- 筛选面板 ---------------- */
var FILTER_DEFS = [
  { key: 'country', label: '国家/地区' },
  { key: 'qsBand', label: 'QS 排名', options: ['1-50', '51-100', '101-200', '201-300'] },
  { key: 'cat', label: '学科门类', options: ALL_CATS },
  { key: 'level', label: '门槛档位', options: [{ v: 1, t: '较低' }, { v: 2, t: '中等' }, { v: 3, t: '较高' }] },
  { key: 'scoreSrc', label: '门槛来源', options: [{ v: 'official', t: '官网公布' }, { v: 'est', t: '同侪推定' }] }
];
function optionsOf(def) {
  if (def.key === 'country') {
    var seen = {}, out = [];
    UNIS.forEach(function (u) { if (!seen[u.country]) { seen[u.country] = 1; out.push(u.country); } });
    return out;
  }
  return def.options || [];
}
var GRADE_OPTIONS = [
  ['', '不限制'], ['25.2', 'A*A*A*'], ['23.8', 'A*A*A'], ['22.4', 'A*AA'], ['21', 'AAA'],
  ['19.6', 'AAB'], ['18.2', 'ABB'], ['16.8', 'BBB'], ['15.4', 'BBC'], ['14', 'BCC'],
  ['12.6', 'CCC'], ['8.4', 'DDD']
];
function renderFilterPanel() {
  var html = '<div class="filter-groups">';
  FILTER_DEFS.forEach(function (def) {
    html += '<div class="filter-group"><div class="filter-group-name">' + esc(def.label) + '</div><div class="chips" data-fkey="' + def.key + '">';
    optionsOf(def).forEach(function (o) {
      var val = (typeof o === 'object') ? o.v : o;
      var txt = (typeof o === 'object') ? o.t : o;
      var on = state.filters[def.key].indexOf(val) >= 0;
      var count = countBy(def.key, val);
      html += '<button class="chip' + (on ? ' on' : '') + '" type="button" data-fkey="' + def.key + '" data-fval="' + esc(val) + '">'
        + esc(txt) + '<span class="chip-n">' + count + '</span></button>';
    });
    html += '</div></div>';
  });
  html += '<div class="filter-group"><div class="filter-group-name">我的成绩</div>'
    + '<div class="v2-graderow"><select id="gradeSelect" class="v2-select">'
    + GRADE_OPTIONS.map(function (o) {
        return '<option value="' + o[0] + '"' + (state.grade === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('')
    + '</select><span class="grade-hint" id="gradeHint">' + (state.grade ? '只看门槛不高于 ' + gradeLabel(state.grade) + ' 的大学' : '选一个预估成绩，只看门槛匹配的大学') + '</span></div></div>';
  html += '</div>';
  $('#filterPanel').innerHTML = html;
}
var _countCache = {};
function countBy(key, val) {
  var ck = key + '=' + val + '|' + state.q;
  if (_countCache[ck] != null) return _countCache[ck];
  var n = 0;
  UNIS.forEach(function (u) {
    if (!matchQuery(u)) return;
    var ok = false;
    if (key === 'country') ok = u.country === val;
    else if (key === 'qsBand') ok = qsBandOf(u.qs) === val;
    else if (key === 'cat') ok = u.cats.indexOf(val) >= 0;
    else if (key === 'level') ok = u.band === val;
    else if (key === 'scoreSrc') ok = u.scoreSrc === val;
    if (ok) n++;
  });
  _countCache[ck] = n;
  return n;
}

/* ---------------- 条件摘要 ---------------- */
function renderSummary() {
  var box = $('#activeSummary');
  var items = [];
  FILTER_DEFS.forEach(function (def) {
    state.filters[def.key].forEach(function (v) {
      var txt = v;
      if (def.key === 'level') txt = bandText(Number(v));
      if (def.key === 'scoreSrc') txt = v === 'official' ? '官网公布' : '同侪推定';
      items.push({ k: def.key, v: v, t: def.label + '：' + txt });
    });
  });
  if (state.grade) items.push({ k: 'grade', v: '', t: '成绩 ≤ ' + gradeLabel(state.grade) });
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = items.map(function (it) {
    return '<span class="sum-item" data-fkey="' + it.k + '" data-fval="' + esc(it.v) + '">' + esc(it.t) + '<span class="sum-x">✕</span></span>';
  }).join('') + '<button class="text-btn sum-clear" type="button">全部清除</button>';
}
function gradeLabel(v) {
  var map = { '25.2': 'A*A*A*', '23.8': 'A*A*A', '22.4': 'A*AA', '21': 'AAA', '19.6': 'AAB', '18.2': 'ABB', '16.8': 'BBB', '15.4': 'BBC', '14': 'BCC', '12.6': 'CCC', '8.4': 'DDD' };
  return map[String(v)] || v;
}

/* ---------------- 大学卡片 ---------------- */
function cardHtml(u) {
  var fav = isFav(u.id), cmp = isCmp(u.id);
  var srcTag = u.scoreSrc === 'official'
    ? '<span class="tag tag-brand" title="门槛来自学校官网公布的 A-Level 要求原文">官网门槛</span>'
    : '<span class="tag tag-warn" title="官网未公布等级门槛，此值参考同层次院校推算，仅供横向比较">推定门槛</span>';
  if (u.floorRows && u.floorRows === u.nRows) srcTag += '<span class="tag tag-warn" title="官网给出的是录取下边界/及格线，实际录取通常更高">录取下边界</span>';
  var active = activeCat();
  var ordered = u._catsSorted || u.cats;
  if (active && ordered.indexOf(active) >= 0) ordered = [active].concat(ordered.filter(function (c) { return c !== active; }));
  var cats = ordered.slice(0, 3).map(function (c) {
    return '<span class="tag' + (c === active ? ' tag-brand' : '') + '">' + esc(c) + '</span>';
  }).join('');
  if (ordered.length > 3) cats += '<span class="tag">+' + (ordered.length - 3) + '</span>';
  return ''
    + '<div class="uni-card' + (fav ? ' is-fav' : '') + (cmp ? ' is-cmp' : '') + '" data-id="' + u.id + '" tabindex="0" role="button">'
    +   '<div class="uni-rank"><b>' + (u.qs || '—') + '</b><i>' + esc(u.abbr || '') + '</i></div>'
    +   '<div class="uni-main">'
    +     '<div class="uni-title">'
    +       '<h3 class="uni-name">' + esc(u.name) + '</h3>'
    +       '<span class="lv-chip ' + bandClass(u.band) + '">' + esc(chipLabel(u)) + '</span>'
    +       srcTag
    +     '</div>'
    +     '<p class="uni-en">' + esc(u.en) + ' · ' + esc(u.city) + ' · ' + esc(u.country) + '</p>'
    +     '<div class="uni-req">' + u.nCats + ' 个学科门类 · ' + u.nPrograms + ' 个本科专业</div>'
    +     '<div class="chips v2-cats">' + cats + '</div>'
    +   '</div>'
    +   '<div class="uni-side">'
    +     '<button class="mini-btn fav' + (fav ? ' on' : '') + '" type="button" data-act="fav">' + (fav ? '★ 已收藏' : '☆ 收藏') + '</button>'
    +     '<button class="mini-btn' + (cmp ? ' on' : '') + '" type="button" data-act="cmp">' + (cmp ? '✓ 已选' : '＋ 对比') + '</button>'
    +   '</div>'
    + '</div>';
}
function renderList() {
  var list = sortUnis(visibleUnis());
  var box = $('#uniList');
  if (!list.length) {
    listReplay = false;
    box.innerHTML = '<div class="empty-state"><div class="es-icon">🔍</div><h3>没有符合条件的大学</h3>'
      + '<p>试着放宽国家、学科门类或门槛档位，或清空搜索词。</p></div>';
  } else {
    var replay = listReplay;
    listReplay = false;
    box.innerHTML = list.map(function (u, i) {
      var d = Math.min(i, 14) * 8;
      var open = replay
        ? '<div style="animation:listEnter ' + TIME.enterDur + 'ms var(--ease-ios) ' + d + 'ms both">'
        : '<div class="card-enter" style="--i:' + Math.min(i, 14) + '">';
      return open + cardHtml(u) + '</div>';
    }).join('');
    if (!replay && !prefersReduced()) initScrollAnim();
  }
  var prevCount = _lastCount;
  $('#resultCount').textContent = list.length;
  $('#resultUnit').textContent = '所大学';
  if (prevCount !== null && prevCount !== list.length) {
    var rc = $('#resultCount');
    rc.classList.remove('v3-pulse'); void rc.offsetWidth; rc.classList.add('v3-pulse');
  }
  _lastCount = list.length;
  $('#dataCount').textContent = UNIS.length + ' 所 · ' + (METAINFO.programs || 0) + ' 个专业';
  renderSystemNote(list);
}
function renderSystemNote(list) {
  var el = $('#systemNote');
  var countries = [];
  list.forEach(function (u) { if (countries.indexOf(u.country) < 0) countries.push(u.country); });
  // 只在结果已经收窄到少数几个国家时才提示录取体系，避免首屏常驻一条大黄条
  if (countries.length > 3) { el.hidden = true; return; }
  var keys = countries.filter(function (c) { return SYS[c] && SYS[c].note; });
  if (!keys.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = keys.map(function (k) {
    return '<div><b>' + esc(k) + '</b>：' + esc(SYS[k].note) + '</div>';
  }).join('');
}

/* ============================================================
 *  动效基础设施（自 v1 迁回；时序与 styles.css 里的 --fly-in / --rv-dur 对齐）
 * ============================================================ */
var TIME = {
  flyIn: 1050, flyInSettle: 980, revealAt: 380,
  collapse: 620, expand: 900,
  modal: 900, contentFade: 1050, veil: 900, veilOut: 200,
  leaveDur: 1020, enterDur: 1080, ball: 54
};
var BALL = TIME.ball;
var RV_DURATION = 620;
var flightTimer = null, closeTimer = null, contentTimer = null, flightEndsAt = 0;
var detailBodyTimer = null;                 // 详情正文的异步构建任务
var listAnimating = false, listReplay = false;
var savedPadRight = '';

function prefersReduced() {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function clearFlightTimers() {
  if (flightTimer) { clearTimeout(flightTimer); flightTimer = null; }
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (contentTimer) { clearTimeout(contentTimer); contentTimer = null; }
}
/** 滚动锁定：补滚动条宽度，避免锁定瞬间整页横向跳动 */
function lockScroll() {
  if (document.body.classList.contains('no-scroll')) return;
  var sbw = window.innerWidth - document.documentElement.clientWidth;
  if (sbw > 0) {
    savedPadRight = document.body.style.paddingRight;
    var cur = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
    document.body.style.paddingRight = (cur + sbw) + 'px';
  }
  document.body.classList.add('no-scroll');
}
function unlockScroll() {
  document.body.classList.remove('no-scroll');
  if (savedPadRight !== '') { document.body.style.paddingRight = savedPadRight; savedPadRight = ''; }
}

/* ---------------- 详情 ---------------- */
var curDetail = null, detailQ = '', _lastCount = null;
function openDetail(id, skipReset, deferBody) {
  curDetail = id; detailQ = '';
  var u = uniById(id);
  if (!u) return;
  if (!skipReset) resetModal();
  $('#detailName').textContent = u.name;
  $('#detailEn').textContent = u.en + ' · ' + u.city + ' · ' + u.country;
  renderDetailBadges(u);
  if (deferBody) {
    // 详情 DOM 在 v2 里很大（学科门类折叠 + 学院条目 + 专业清单），同步构建会阻塞主线程
    // → 飞行动画的起始帧掉帧，看起来就是「闪一下 + 卡顿」。
    // 这里先放骨架，等飞行开始后再异步构建，让构建与动画并行。
    $('#detailBody').innerHTML =
      '<div class="detail-skeleton">' +
      '<div class="sk-line w40"></div><div class="sk-line w90"></div>' +
      '<div class="sk-line w70"></div><div class="sk-line w80"></div>' +
      '</div>';
  } else {
    renderDetailBody(u);
  }
  var fav = isFav(id), cmp = isCmp(id);
  $('#detailFav').textContent = fav ? '★ 已收藏' : '☆ 收藏';
  $('#detailFav').classList.toggle('on', fav);
  $('#detailCompare').textContent = cmp ? '✓ 已对比' : '＋ 对比';
  $('#detailCompare').classList.toggle('on', cmp);
  $('#modal').hidden = false;
  lockScroll();
}

/** 异步补齐详情正文（飞行期间并行构建） */
function deferDetailBody(id) {
  var u = uniById(id);
  if (!u) return;
  // 连续打开时取消上一次的待构建任务
  if (detailBodyTimer) { clearTimeout(detailBodyTimer); detailBodyTimer = null; }
  detailBodyTimer = setTimeout(function () {
    detailBodyTimer = null;
    if (curDetail !== id) return;             // 已经切到别的学校了
    renderDetailBody(u);
    var body = $('#detailBody');
    if (body) { body.classList.remove('v3-enter'); void body.offsetWidth; body.classList.add('v3-enter'); }
  }, 0);
}

/** 弹窗复位：清掉飞行留下的内联样式与占位（只在弹窗真正隐藏/重新打开时调用） */
function resetModal() {
  var m = $('#modal');
  if (!m) return;
  clearFlightTimers();
  m.classList.remove('flying-in', 'flying-out', 'closing', 'modal-content-hidden', 'veil-off');
  var card = $('.modal-card');
  if (card) {
    card.style.animation = '';
    card.style.transition = '';
    card.style.transform = '';
    card.style.transformOrigin = '';
    card.style.borderRadius = '';
    card.style.opacity = '';
  }
  $$('.modal-card > *').forEach(function (el) { el.style.opacity = ''; });
  var bd = $('.modal-backdrop');
  if (bd) bd.style.opacity = '';
  $$('.uni-card.card-placeholder').forEach(function (el) { el.classList.remove('card-placeholder'); });
}
/** 标记/解除占位：飞行期间原卡片位置留空 */
function markPlaceholder(id, on) {
  var card = id ? $('.uni-card[data-id="' + id + '"]') : null;
  if (card) card.classList.toggle('card-placeholder', !!on);
}
function revealContent(early) {
  var modal = $('#modal');
  if (!modal) return;
  if (early) { modal.classList.add('modal-content-hidden'); return; }
  if (!modal.classList.contains('modal-content-hidden')) return;
  // 关键：先清掉「上一次关闭时留下的内联 opacity:0」，
  // 否则内联值会压住 CSS 的 contentFadeIn 动画，内容永远不显示（表现为空弹窗突然蹦内容）
  $$('.modal-card > *').forEach(function (el) { el.style.opacity = ''; });
  modal.classList.remove('modal-content-hidden');
  if (contentTimer) clearTimeout(contentTimer);
}

/** 卡片 → 详情：弹窗从卡片的位置与尺寸放大铺开 */
function openDetailFrom(card, id) {
  var modal = $('#modal');
  if (!card || !modal || prefersReduced()) { openDetail(id); return; }
  var from = card.getBoundingClientRect();
  if (!from.width || !from.height) { openDetail(id); return; }

  clearFlightTimers();
  resetModal();
  // 关键：在弹窗可见之前先藏内容，否则会先绘制一帧「未缩放 + 内容已插入」= 闪
  var mcPre = $('.modal-card');
  if (mcPre) mcPre.style.animation = 'none';
  modal.classList.add('modal-content-hidden');
  modal.classList.add('flying-in');
  markPlaceholder(id, true);
  // deferBody=true：详情正文先放骨架，等飞行动画起步后再异步构建（避免阻塞起始帧）
  openDetail(id, true, true);

  var card2 = $('.modal-card');
  card2.style.transformOrigin = 'center center';
  card2.style.transition = 'none';
  var to = card2.getBoundingClientRect();
  if (!to.width || !to.height) { resetModal(); openDetail(id); return; }
  var docW = document.documentElement.clientWidth;
  var sx = from.width / docW, sy = from.height / to.height;
  var tx = (from.left + from.width / 2) - (to.left + to.width / 2);
  var ty = (from.top + from.height / 2) - (to.top + to.height / 2);
  card2.style.transform = 'translate3d(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px,0) scale(' +
    sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
  card2.style.borderRadius = '18px';
  // 内容的显隐完全交给 CSS（.modal-content-hidden → opacity:0；移除后播放 contentFadeIn）。
  // 这里不再写内联 opacity —— 内联值会压住 CSS 过渡，导致内容一直是透明的。

  // 飞行形态已经钉好，正文构建放到下一帧 —— 起始帧先绘制，之后的长任务不会拖慢动画起步
  deferDetailBody(id);

  flightEndsAt = Date.now() + TIME.flyIn;
  setTimeout(function () {
    card2.style.transition = 'transform var(--fly-in,420ms) var(--ease-fly,ease), border-radius var(--fly-in,420ms) ease';
    card2.style.transform = 'none';
    card2.style.borderRadius = '';
    revealContent();                 // 移除 modal-content-hidden → 内容播放 contentFadeIn
    flightTimer = setTimeout(function () {
      flightTimer = null; flightEndsAt = 0;
      resetModal();
      $$('.modal-card > *').forEach(function (el) { el.style.opacity = ''; });
    }, TIME.flyInSettle);
  }, 24);
}
/** 即时关闭（无飞行目标 / reduced-motion）：整体淡出后隐藏 */
function closeDetailInstant() {
  var modal = $('#modal');
  if (!modal || modal.hidden) return;
  clearFlightTimers();
  curDetail = null;
  unlockScroll();
  modal.classList.add('closing');
  closeTimer = setTimeout(function () {
    modal.classList.remove('closing');
    modal.hidden = true;
    closeTimer = null;
    resetModal();
  }, prefersReduced() ? 0 : TIME.modal);
}
/** 详情 → 卡片：先收拢成小球移到原卡片中心，再展开复原成卡片 */
function closeDetailToCard() {
  var modal = $('#modal');
  if (!modal || modal.hidden ||
      modal.classList.contains('closing') || modal.classList.contains('flying-out')) return;
  var card = curDetail ? $('.uni-card[data-id="' + curDetail + '"]') : null;
  if (!card || prefersReduced()) { closeDetailInstant(); return; }
  var target = card.getBoundingClientRect();
  if (!target.width || !target.height) { closeDetailInstant(); return; }

  clearFlightTimers();
  var card2 = $('.modal-card');
  var cur = card2.getBoundingClientRect();
  if (!cur.width || !cur.height) { closeDetailInstant(); return; }

  modal.classList.remove('flying-in');
  modal.classList.add('flying-out', 'veil-off');
  $$('.modal-card > *').forEach(function (el) { el.style.opacity = '0'; });

  var cx = (target.left + target.width / 2) - (cur.left + cur.width / 2);
  var cy = (target.top + target.height / 2) - (cur.top + cur.height / 2);
  card2.style.transformOrigin = 'center center';
  card2.style.transition = 'transform ' + TIME.collapse + 'ms var(--ease-snap,ease), ' +
    'opacity ' + TIME.collapse + 'ms ease, border-radius ' + TIME.collapse + 'ms ease';
  card2.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0) scale(' +
    (BALL / cur.width).toFixed(4) + ',' + (BALL / cur.height).toFixed(4) + ')';
  card2.style.borderRadius = '50%';
  card2.style.opacity = '0.6';

  unlockScroll();                       // 动画期间就允许滚动/点别的卡片
  curDetail = null;
  flightEndsAt = Date.now() + TIME.collapse;

  flightTimer = setTimeout(function () {   // 阶段二：小球在原卡片位置展开复原
    flightTimer = null; flightEndsAt = 0;
    card2.style.transition = 'transform ' + TIME.expand + 'ms var(--ease-fly,ease), ' +
      'opacity ' + TIME.expand + 'ms ease, border-radius ' + TIME.expand + 'ms ease';
    card2.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0) scale(' +
      (target.width / cur.width).toFixed(4) + ',' + (target.height / cur.height).toFixed(4) + ')';
    card2.style.borderRadius = '18px';
    card2.style.opacity = '0';
    setTimeout(function () {
      var m = $('#modal');
      if (m) m.hidden = true;
      resetModal();                     // 到位后才释放占位卡片
    }, Math.max(0, TIME.expand - 40));
  }, TIME.collapse);
}
function closeDetail() { closeDetailToCard(); }
function renderDetailBadges(u) {
  var b = [];
  b.push('<span class="tag tag-brand">QS ' + (u.qs || '—') + '</span>');
  b.push('<span class="tag">' + esc(u.country) + '</span>');
  b.push('<span class="lv-chip ' + bandClass(u.band) + '">门槛 ' + bandText(u.band) + '</span>');
  b.push(u.scoreSrc === 'official' ? '<span class="tag tag-brand">官网门槛</span>' : '<span class="tag tag-warn">推定门槛</span>');
  if (u.floorRows) b.push('<span class="tag tag-warn">含录取下边界 ' + u.floorRows + ' 条</span>');
  $('#detailBadges').innerHTML = b.join('');
}
function kv(k, v) { return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'; }
function anchorText(how) {
  if (!how) return '—';
  if (how === 'same-uni') return '本校已公布门槛的中位数';
  if (how.indexOf('peer-country') === 0) return '同国 QS 相近院校的中位数';
  if (how.indexOf('uk-benchmark') === 0) return '同 QS 区间的英国院校为标尺';
  return '全体已公布院校的中位数';
}
function renderDetailBody(u) {
  var html = '';
  html += '<div class="kv-grid">'
    + kv('国家/地区', u.country) + kv('城市', u.city) + kv('QS 2026', u.qs || '—')
    + kv('学科门类', u.nCats + ' 个') + kv('本科专业条目', u.nPrograms + ' 个') + kv('明细行', u.nRows + ' 条')
    + kv('代表门槛', scoreTextFull(u)) + kv('门槛来源', u.scoreSrc === 'official' ? '官网公布' : '同侪推定')
    + '</div>';
  if (u.scoreSrc === 'est') {
    html += '<div class="system-note v2-note">该校官网未公布 A-Level 等级门槛。参考同层次院校推定为 <b>'
      + esc(scoreText(u)) + '</b>（锚定方式：' + esc(anchorText(u.anchorHow)) + '）。实际录取多采用整体评估，本值仅供横向比较。</div>';
  }
  if (SYS[u.country] && SYS[u.country].note) {
    html += '<div class="sys-hint v2-syshint">' + esc(u.country) + '录取体系：' + esc(SYS[u.country].note) + '</div>';
  }
  html += '<div class="detail-section"><h3>学科门类与专业要求（' + u.nCats + '）</h3>'
    + '<div class="v2-toolbar"><input type="search" id="detailFilter" class="v2-input" placeholder="在学院 / 专业名 / 要求里筛选…">'
    + '<span class="v2-hint" id="detailFilterHint"></span></div>'
    + '<div class="v2-catlist" id="detailCatList">' + catListHtml(u) + '</div></div>';
  $('#detailBody').innerHTML = html;
  var inp = $('#detailFilter');
  if (inp) inp.addEventListener('input', function () {
    detailQ = inp.value.trim().toLowerCase();
    $('#detailCatList').innerHTML = catListHtml(u);
    updDetailHint(u);
  });
  updDetailHint(u);
}
function entryMatches(e, q) {
  if (!q) return true;
  if (e.cat.toLowerCase().indexOf(q) >= 0) return true;
  if ((e.college || '').toLowerCase().indexOf(q) >= 0) return true;
  if ((e.req || '').toLowerCase().indexOf(q) >= 0) return true;
  if ((e.subjects || '').toLowerCase().indexOf(q) >= 0) return true;
  for (var i = 0; i < e.programs.length; i++) if (e.programs[i].toLowerCase().indexOf(q) >= 0) return true;
  return false;
}
function catListHtml(u) {
  var q = detailQ, html = '', shown = 0;
  u.cats.forEach(function (cat) {
    var entries = u.entries.filter(function (e) { return e.cat === cat && entryMatches(e, q); });
    if (!entries.length) return;
    shown++;
    var open = q ? true : state.openCats[u.id + '|' + cat] !== false;
    var progs = entries.reduce(function (s, e) { return s + e.programs.length; }, 0);
    var g = entries.filter(function (e) { return e.grades; })[0];
    html += '<div class="v2-cat' + (open ? ' open' : '') + '" data-cat="' + esc(cat) + '">'
      + '<button class="v2-cat-head" type="button" data-cat-toggle="' + esc(cat) + '" aria-expanded="' + (open ? 'true' : 'false') + '">'
      +   '<span class="v2-caret">▸</span>'
      +   '<span class="v2-cat-name">' + esc(cat) + '</span>'
      +   (g ? '<span class="lv-chip ' + bandClass(bandOfScore(g.score)) + '">' + esc(g.grades) + '</span>' : '')
      +   '<span class="v2-cat-meta">' + entries.length + ' 个学院 · ' + progs + ' 个专业</span>'
      + '</button>'
      + '<div class="v2-cat-body">' + entries.map(function (e) { return entryHtml(e, u); }).join('') + '</div>'
      + '</div>';
  });
  if (!shown) return '<div class="empty-state"><div class="es-icon">🔍</div><h3>没有匹配的条目</h3><p>换个关键词试试。</p></div>';
  return html;
}
/** 把「uk-benchmark-qs±25 + 门类偏移-0.2」这类内部标记说成人话 */
function basisText(u, e) {
  var s = anchorText(u.anchorHow);
  var m = /门类偏移(-?[\d.]+)/.exec(e.estBasis || '');
  var off = m ? Number(m[1]) : 0;
  if (off > 0) s += '，并按「' + e.cat + '」难度上调 ' + off.toFixed(1) + ' 分';
  else if (off < 0) s += '，并按「' + e.cat + '」难度下调 ' + Math.abs(off).toFixed(1) + ' 分';
  else s += '，「' + e.cat + '」难度与该校整体持平';
  return s;
}
function entryHtml(e, u) {
  var h = '<div class="v2-entry">';
  h += '<div class="v2-entry-head">'
    + '<span class="v2-college">' + esc(e.college || '（未标学院）') + '</span>'
    + (e.scoreSrc === 'official' ? '<span class="tag tag-brand">官网</span>' : '<span class="tag tag-warn">推定</span>')
    + (e.floor ? '<span class="tag tag-warn" title="官网给出的是录取下边界/及格线，实际录取通常更高">下边界</span>' : '')
    + (e.grades ? '<span class="lv-chip ' + bandClass(bandOfScore(e.score)) + '">' + esc(e.grades) + '</span>' : '')
    + '</div>';
  h += '<p class="detail-req v2-req">' + esc(e.req || '—') + '</p>';
  if (e.subjects) h += '<p class="v2-subj"><span class="req-label">科目要求</span>' + esc(e.subjects) + '</p>';
  if (e.programs.length) {
    h += '<details class="v2-progs"><summary>' + e.programs.length + ' 个本科专业</summary><div class="chips v2-progchips">'
      + e.programs.map(function (p) { return '<span class="chip chip-major">' + esc(p) + '</span>'; }).join('')
      + '</div></details>';
  }
  var meta = [];
  if (e.year) meta.push(esc(e.year));
  if (e.urlList) meta.push('<a href="' + esc(e.urlList) + '" target="_blank" rel="noopener">专业清单来源</a>');
  if (e.urlReq) meta.push('<a href="' + esc(e.urlReq) + '" target="_blank" rel="noopener">入学要求来源</a>');
  if (meta.length) h += '<div class="v2-src">' + meta.join(' · ') + '</div>';
  if (e.note) h += '<div class="v2-note-line">备注：' + esc(e.note) + '</div>';
  if (e.estBasis && u) h += '<div class="v2-note-line">推定依据：' + esc(basisText(u, e)) + '</div>';
  h += '</div>';
  return h;
}
function updDetailHint(u) {
  var el = $('#detailFilterHint');
  if (!el) return;
  el.classList.toggle('on', !!detailQ);
  if (!detailQ) { el.textContent = u.nRows + ' 条明细'; return; }
  var n = 0;
  u.entries.forEach(function (e) { if (entryMatches(e, detailQ)) n++; });
  el.textContent = '匹配 ' + n + ' / ' + u.nRows + ' 条';
}

/* ============================================================
 *  滚动方向进场：卡片进入视口时按「中心在上半屏/下半屏」从右上或右下展开；
 *  滚出视口清标记，滑回来会再播一次。首屏已在视口内的那批不播。
 *  动画进行中用 dataset 时间戳判断，不用定时器（虚拟时间下定时器会被快进）。
 * ============================================================ */
var scrollAnim = { primed: false, raf: 0, cleanup: null };
function scanCards() {
  if (prefersReduced()) return;
  var vh = window.innerHeight || 800;
  var listEl = $('#uniList');
  if (!listEl || listEl.hidden) return;
  var now = Date.now();

  $$('#uniList .uni-card').forEach(function (el) {
    var r = el.getBoundingClientRect();
    var inView = r.bottom > 0 && r.top < vh;

    if (!inView) {
      // 离开视口：立即复位。用 WAAPI 而不是 CSS 类，就是为了这里能"持句柄取消" ——
      // CSS 类动画在途中离开视口时没人负责清理，会留下 opacity:0 的透明卡片
      //（用户看到的就是"卡片莫名消失、滑回来又出现"）。
      if (el._rvAbort) { el._rvAbort(); el._rvAbort = null; }
      else if (el.getAnimations) {
        el.getAnimations().forEach(function (x) { try { x.cancel(); } catch (e) {} });
      }
      el.classList.remove('rv-b', 'rv-t', 'rv-done');
      delete el.dataset.rvUntil;
      el.style.removeProperty('--rvi');
      return;
    }
    // 已在播动画 → 不打扰
    if (Number(el.dataset.rvUntil || 0) > now) return;
    // 已经播过（本轮在视口内）→ 不重播
    if (el.classList.contains('rv-done')) return;
    if (!scrollAnim.primed) { el.classList.add('rv-done'); return; }

    el.classList.add('rv-done');            // 标记"本轮已处理"，与 CSS 类无关，仅作状态位
    el.dataset.rvUntil = String(now + 1500); // 兜底时间戳（真实时长由 WAAPI 控制）

    var fromTop = (r.top + r.height / 2) < (vh / 2);
    var dist = fromTop ? -1 : 1;             // 从上方来 / 从下方来
    var dx = 26, dy = 22 * dist;
    var origin = fromTop ? 'right top' : 'right bottom';
    el.style.transformOrigin = origin;

    try {
      var anim = el.animate([
        {
          opacity: 0,
          transform: 'translate3d(' + dx + 'px,' + dy + 'px,0) scale(.90)'
        },
        { opacity: 1, transform: 'none' }
      ], {
        duration: 1050,
        easing: 'cubic-bezier(.32,.72,0,1)',
        fill: 'backwards'                    // 只用 backwards，避免锁死终点值
      });
      // 动画收尾分两种情形：
      //   正常播完 → 清掉内联样式交回 CSS（自然可见）
      //   中途取消 → 必须主动钉成"完全可见"，否则 cancel 会让元素回退到动画初始的透明态
      //              —— 那正是用户看到的"卡片莫名消失"
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        try { anim.cancel(); } catch (e) {}
        el.style.opacity = '';
        el.style.transform = '';
        el.style.transformOrigin = '';
      };
      var abort = function () {
        if (settled) return;
        settled = true;
        try { anim.cancel(); } catch (e) {}
        el.style.opacity = '1';
        el.style.transform = 'none';
        el.style.transformOrigin = '';
      };
      anim.onfinish = finish;
      if (anim.finished && anim.finished.then) anim.finished.then(finish).catch(function () {});
      setTimeout(function () {
        if (settled) return;
        var done = false;
        try { done = anim.playState === 'finished'; } catch (e) {}
        if (done) finish(); else abort();     // 没跑完就兜底成可见
      }, 1200);
      el._rvAbort = abort;                    // 供"离开视口"时立即复位
    } catch (e) {
      // 不支持 WAAPI：直接可见，绝不留透明
      el.style.opacity = '';
      el.style.transform = '';
    }
  });
}
function initScrollAnim() {
  if (scrollAnim.cleanup) { scrollAnim.cleanup(); scrollAnim.cleanup = null; }
  if (prefersReduced()) return;
  var vh = window.innerHeight || 800;
  $$('#uniList .uni-card').forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < vh) el.classList.add('rv-done');   // 首屏这批不播
  });
  scrollAnim.primed = true;
  var lastY = window.scrollY;
  var poll = setInterval(function () {
    if (window.scrollY !== lastY) { lastY = window.scrollY; scanCards(); }
  }, 60);
  var onScroll = function () {
    if (scrollAnim.raf) return;
    scrollAnim.raf = setTimeout(function () { scrollAnim.raf = 0; scanCards(); }, 16);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  scrollAnim.cleanup = function () {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    clearInterval(poll);
  };
}

/* ============================================================
 *  列表过渡：筛选 / 排序变化时，卡片整体右移消失 → 换数据 → 从右侧重新进场
 * ============================================================ */
function playListChange(mutate) {
  var listEl = $('#uniList');
  if (listAnimating || !listEl || prefersReduced()) { mutate(); renderAll(); return; }
  var cards = $$('#uniList .uni-card');
  if (!cards.length) { mutate(); renderAll(); return; }

  // 本数据集有 292 张卡片：全部逐张错峰会拖慢整体节奏并拖累性能。
  // 策略：可视区内的卡片逐张错峰滑出，区外的用更短更轻的淡出 —— 既保留过渡感又不掉帧。
  var many = cards.length > 120;
  var vh = window.innerHeight || 800;
  var slot = 0;

  listAnimating = true;
  listEl.dataset.animating = 'leave';
  cards.forEach(function (el) {
    el.classList.add('list-leaving');
    var r = el.getBoundingClientRect();
    var visible = r.bottom > -80 && r.top < vh + 80;
    var delay = visible ? Math.min(slot++, 8) * 8 : 0;
    el.style.animation = (many && !visible)
      ? 'listFadeQuick 1020ms ease ' + delay + 'ms both'
      : 'listLeave ' + TIME.leaveDur + 'ms cubic-bezier(.4,0,.7,.4) ' + delay + 'ms both';
  });

  var wait = (many ? 260 : TIME.leaveDur) + Math.min(slot, 9) * 8 + 30;
  setTimeout(function () {
    mutate();
    listReplay = true;
    renderAll();
    listAnimating = false;
    delete listEl.dataset.animating;
  }, wait);
}

/* ---------------- 对比 ---------------- */
function shownCmp() { return state.cmp.map(uniById).filter(Boolean); }
function renderCompare() {
  var list = shownCmp();
  $('#compareCount').textContent = list.length;
  $('#compareMajor').textContent = state.cmpCat || '未指定门类';
  var wrap = $('#compareTableWrap');
  if (list.length < 2) {
    wrap.innerHTML = '<div class="empty-state"><div class="es-icon">⚖️</div><h3>至少选 2 所大学才能对比</h3><p>在列表里点「＋ 对比」，或用上方「手动添加大学」。</p></div>';
    $('#cmpPicker').hidden = true;
    return;
  }
  var common = ALL_CATS.filter(function (c) {
    return list.every(function (u) { return u.cats.indexOf(c) >= 0; });
  });
  var picker = $('#cmpPicker');
  picker.hidden = false;
  picker.innerHTML = '<span class="v2-picker-label">对比门类</span><div class="chips">'
    + '<button class="chip' + (!state.cmpCat ? ' on' : '') + '" type="button" data-cmpcat="">不指定</button>'
    + common.map(function (c) {
        return '<button class="chip' + (state.cmpCat === c ? ' on' : '') + '" type="button" data-cmpcat="' + esc(c) + '">' + esc(c) + '</button>';
      }).join('')
    + '</div>';

  var rows = [
    ['QS 2026', function (u) { return u.qs || '—'; }],
    ['国家 / 城市', function (u) { return u.country + ' · ' + u.city; }],
    ['学科门类数', function (u) { return u.nCats + ' 个'; }],
    ['本科专业条目', function (u) { return u.nPrograms + ' 个'; }],
    ['代表门槛', function (u) { return scoreTextFull(u); }],
    ['门槛档位', function (u) { return bandText(u.band); }],
    ['门槛来源', function (u) { return u.scoreSrc === 'official' ? '官网公布' : '同侪推定'; }],
    ['录取体系', function (u) { return (SYS[u.country] && SYS[u.country].note) || '—'; }]
  ];
  var html = '<table class="cmp-table"><thead><tr><th class="cmp-k"></th>'
    + list.map(function (u) {
        return '<th><div class="cmp-name">' + esc(u.name) + '</div><div class="cmp-sub">' + esc(u.en) + '</div></th>';
      }).join('')
    + '</tr></thead><tbody>';
  rows.forEach(function (r) {
    html += '<tr><th class="cmp-k">' + esc(r[0]) + '</th>'
      + list.map(function (u) { return '<td>' + esc(r[1](u)) + '</td>'; }).join('') + '</tr>';
  });
  if (state.cmpCat) {
    html += '<tr class="cmp-sep"><th class="cmp-k">' + esc(state.cmpCat) + '</th><td colspan="' + list.length + '"></td></tr>';
    html += '<tr><th class="cmp-k">典型要求</th>'
      + list.map(function (u) {
          var es = u.entries.filter(function (e) { return e.cat === state.cmpCat; });
          if (!es.length) return '<td class="muted">未开设</td>';
          return '<td>' + es.map(function (e) { return esc(e.req); }).join('<br>') + '</td>';
        }).join('') + '</tr>';
    html += '<tr><th class="cmp-k">科目要求</th>'
      + list.map(function (u) {
          var es = u.entries.filter(function (e) { return e.cat === state.cmpCat && e.subjects; });
          if (!es.length) return '<td class="muted">—</td>';
          return '<td>' + es.map(function (e) { return esc(e.subjects); }).join('<br>') + '</td>';
        }).join('') + '</tr>';
    html += '<tr><th class="cmp-k">专业数</th>'
      + list.map(function (u) {
          var n = u.entries.filter(function (e) { return e.cat === state.cmpCat; })
            .reduce(function (s, e) { return s + e.programs.length; }, 0);
          return '<td>' + (n || '<span class="muted">0</span>') + '</td>';
        }).join('') + '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}
function renderTray() {
  var list = shownCmp();
  var tray = $('#compareTray');
  if (!list.length) { tray.hidden = true; $('#trayItems').innerHTML = ''; return; }
  tray.hidden = false;
  $('#trayItems').innerHTML = list.map(function (u) {
    return '<span class="tray-chip" data-id="' + u.id + '">' + esc(u.name) + '<span class="sum-x">✕</span></span>';
  }).join('');
  $('#trayRun').disabled = list.length < 2;
  $('#trayRun').style.opacity = list.length < 2 ? .5 : 1;
}
function renderAddResults() {
  var q = ($('#addInput').value || '').trim().toLowerCase();
  if (!q) { $('#addResults').innerHTML = ''; return; }
  var hits = UNIS.filter(function (u) {
    return !isCmp(u.id) && (u.name.toLowerCase().indexOf(q) >= 0 || u.en.toLowerCase().indexOf(q) >= 0 || u.city.toLowerCase().indexOf(q) >= 0);
  }).slice(0, 8);
  $('#addResults').innerHTML = hits.length
    ? hits.map(function (u) {
        return '<div class="add-item" data-id="' + u.id + '"><b>' + esc(u.name) + '</b><span class="cmp-sub">' + esc(u.en) + ' · QS' + (u.qs || '—') + '</span></div>';
      }).join('')
    : '<div class="add-item muted">没有匹配的大学</div>';
}

/* ---------------- 收藏视图 ---------------- */
function renderFav() {
  var list = state.fav.map(uniById).filter(Boolean);
  $('#favCount2').textContent = list.length;
  $('#favList').innerHTML = list.length
    ? list.map(function (u, i) { return '<div class="card-enter" style="--i:' + Math.min(i, 14) + '">' + cardHtml(u) + '</div>'; }).join('')
    : '<div class="empty-state"><div class="es-icon">☆</div><h3>还没有收藏</h3><p>在列表或详情页点「☆ 收藏」，数据只存在你自己的浏览器里。</p></div>';
}

/* ---------------- 视图 ---------------- */
function setView(v) {
  state.view = v;
  var views = { browse: $('#viewBrowse'), compare: $('#viewCompare'), favorites: $('#viewFavorites') };
  Object.keys(views).forEach(function (k) { if (views[k]) views[k].hidden = k !== v; });
  var cur = views[v];
  if (cur) {   // 重放入场动画：先摘掉类、强制回流、再加上
    cur.classList.remove('v3-enter');
    void cur.offsetWidth;
    cur.classList.add('v3-enter');
  }
  $$('#tabs .tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-view') === v); });
  if (v === 'compare') renderCompare();
  if (v === 'favorites') renderFav();
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
}

/* ---------------- 主渲染 ---------------- */
function renderAll() {
  renderFilterPanel();
  renderSummary();
  renderList();
  renderTray();
  if (state.view === 'favorites') renderFav();
  if (state.view === 'compare') renderCompare();
  var n = 0;
  FILTER_DEFS.forEach(function (d) { n += state.filters[d.key].length; });
  if (state.grade) n++;
  $('#filterBadge').hidden = n === 0;
  $('#filterBadge').textContent = n;
  // 收藏角标要在任何视图下都同步（只点收藏、不切视图时也要变）
  $('#favCount').textContent = state.fav.length;
  $('#favCount').hidden = state.fav.length === 0;
}

/* ---------------- 事件 ---------------- */
function debounce(fn, ms) {
  var t; return function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
}
/* ---------------- 卡片列数（单列 / 双列） ---------------- */
function applyCols(persist) {
  var list = $('#uniList');
  if (!list) return;
  var two = state.cols === 2;
  list.classList.toggle('cols-2', two);
  // 注意是 $$（querySelectorAll）不是 $ —— $ 返回单个元素没有 forEach，会抛异常中断
  $$('#colToggle .col-btn').forEach(function (b) {
    var on = Number(b.dataset.cols) === state.cols;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if (persist) save(LS_COLS, state.cols);   // v2 用的是 save(key, val)
}

/** 切换列数：FLIP 动画 —— 卡片从旧位置「散开成小圆点」再飞向新位置归位
 *  只对可视区内的卡片做动画（292 张全动会掉帧），区外直接换位。 */
function setCols(n) {
  if (n !== 1 && n !== 2) return;
  if (state.cols === n) return;
  var list = $('#uniList');
  if (!list || prefersReduced() || typeof list.animate !== 'function') {
    state.cols = n; applyCols(true); return;
  }

  // ⚠️ 关键：必须用 offsetTop / offsetWidth 这类**布局属性**量坐标。
  // getBoundingClientRect() 会受 transform 影响 —— 上一张卡片正在跑的动画会改变它的 rect，
  // 导致位置和可见性判断都出错（表现为"有几张卡片直接出现，没有动画"）。
  var cards = $$('#uniList .uni-card');
  var listTop = list.offsetTop;
  var scrollY = window.scrollY || window.pageYOffset || 0;
  var vh = window.innerHeight || 800;
  var before = [];

  cards.forEach(function (el) {
    before.push({
      el: el,
      left: el.offsetLeft,
      top: el.offsetTop - listTop,      // 相对列表容器
      w: el.offsetWidth,
      h: el.offsetHeight,
      // 距离视口中心多远（用布局位置算，不依赖 rect）
      dist: Math.abs((el.offsetTop - listTop) - (scrollY + vh / 2))
    });
  });

  state.cols = n;
  applyCols(true);                       // 换布局
  void list.offsetHeight;                // 强制重排，让新布局生效

  // 按新布局分行：同一行同步出发 → 自上而下的波浪
  var rows = [];
  before.forEach(function (b) {
    b.nLeft = b.el.offsetLeft;
    b.nTop = b.el.offsetTop - listTop;
    b.nW = b.el.offsetWidth;
    b.nH = b.el.offsetHeight;
    var row = null;
    for (var k = 0; k < rows.length; k++) {
      if (Math.abs(rows[k].top - b.nTop) < 8) { row = rows[k]; break; }
    }
    if (!row) { row = { top: b.nTop, items: [] }; rows.push(row); }
    row.items.push(b);
  });
  rows.sort(function (x, y) { return x.top - y.top; });

  rows.forEach(function (row, ri) {
    // 错峰收紧到 12ms/行、最多 6 行 —— 整批 72ms 内全部出发，
    // 不会出现"前排还在动画、后排已经就位"的割裂感
    var delay = Math.min(ri, 6) * 12;

    row.items.forEach(function (b) {
      var dx = b.left - b.nLeft;
      var dy = b.top - b.nTop;
      var sx = b.w / Math.max(b.nW, 1);
      var sy = b.h / Math.max(b.nH, 1);

      // 分三档，兼顾「全部卡片都有过渡」与「不让 292 张同时跑完整动画」：
      //   full  —— 视口内：完整 FLIP（小圆点 → 飞出 → 归位）
      //   light —— 视口外一段距离：短促的淡入+微移，避免硬切
      //   skip  —— 远在屏幕外：不做动画（看不见，省性能）
      var distY = b.nTop - (scrollY - listTop) - vh / 2;   // 相对视口中心
      var inView = Math.abs(distY) < vh * 0.62;
      var farAway = Math.abs(distY) > vh * 2.2;
      if (farAway) return;

      var tiny = !inView ||
        (Math.abs(dx) < 6 && Math.abs(dy) < 6 && Math.abs(sx - 1) < .04 && Math.abs(sy - 1) < .04);

      try {
        var frames = tiny ? [
          { opacity: 0, transform: 'translateY(12px) scale(.965)', borderRadius: '18px', offset: 0 },
          { opacity: 1, transform: 'none', borderRadius: '', offset: 1 }
        ] : [
          {
            transform: 'translate(' + dx.toFixed(1) + 'px,' + (dy + 18).toFixed(1) + 'px) ' +
                       'scale(' + (sx * 0.2).toFixed(3) + ',' + (sy * 0.2).toFixed(3) + ')',
            opacity: 0,
            borderRadius: '50%',
            offset: 0
          },
          {
            transform: 'translate(' + (dx * 0.28).toFixed(1) + 'px,' + (dy * 0.28 - 4).toFixed(1) + 'px) ' +
                       'scale(' + (1 + (sx - 1) * 0.28 + 0.014).toFixed(3) + ',' +
                       (1 + (sy - 1) * 0.28 + 0.014).toFixed(3) + ')',
            opacity: 1,
            borderRadius: '22px',
            offset: 0.58
          },
          { transform: 'none', opacity: 1, borderRadius: '', offset: 1 }
        ];

        var anim = b.el.animate(frames, {
          // 完整动画 520ms（比之前 560 略快，收尾更利落）；轻量档 300ms
          duration: tiny ? 1040 : 1100,
          delay: tiny ? Math.min(delay, 36) : delay,   // 区外的延迟压到 36ms 内，避免"排队等"
          easing: 'cubic-bezier(.22,.88,.26,1)',
          // 只能用 backwards：both/forwards 会把终点值永久锁住，卡片就归不了位
          fill: 'backwards'
        });

        var clear = function () { try { anim.cancel(); } catch (e) {} };
        anim.onfinish = clear;
        if (anim.finished && anim.finished.catch) anim.finished.then(clear).catch(function () {});
        setTimeout(clear, (tiny ? 1040 : 1100) + delay + 160);
      } catch (e) { /* 个别环境不支持 animate 就跳过 */ }
    });
  });
}

function bind() {
  $('#themeBtn').addEventListener('click', function () {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });

  var si = $('#searchInput');
  var onSearch = function () {
    state.q = si.value.trim().toLowerCase();
    $('#searchClear').hidden = !si.value;
    _countCache = {};
    renderAll();
  };
  si.addEventListener('input', debounce(onSearch, 140));
  $('#searchClear').addEventListener('click', function () { si.value = ''; onSearch(); si.focus(); });

  $('#filterToggle').addEventListener('click', function () {
    var p = $('#filterPanel');
    p.hidden = !p.hidden;
    this.classList.toggle('on', !p.hidden);
  });

  $('#filterPanel').addEventListener('click', function (ev) {
    var chip = ev.target.closest('.chip');
    if (!chip) return;
    var key = chip.getAttribute('data-fkey'), val = chip.getAttribute('data-fval');
    var arr = state.filters[key], i = arr.indexOf(val);
    _countCache = {};
    playListChange(function () {
      if (i >= 0) arr.splice(i, 1); else arr.push(val);
    });
  });

  $('#activeSummary').addEventListener('click', function (ev) {
    if (ev.target.closest('.sum-clear')) {
      _countCache = {};
      playListChange(function () {
        state.filters = { country: [], qsBand: [], cat: [], level: [], scoreSrc: [] };
        state.grade = '';
        var gs = $('#gradeSelect'); if (gs) gs.value = '';
      });
      return;
    }
    var it = ev.target.closest('.sum-item');
    if (!it) return;
    var key = it.getAttribute('data-fkey'), val = it.getAttribute('data-fval');
    _countCache = {};
    playListChange(function () {
      if (key === 'grade') { state.grade = ''; var gs = $('#gradeSelect'); if (gs) gs.value = ''; }
      else {
        var arr = state.filters[key], i = arr.indexOf(val);
        if (i >= 0) arr.splice(i, 1);
      }
    });
  });

  $('#gradeBlock') && ($('#gradeBlock').hidden = true);
  $('#filterPanel').addEventListener('change', function (ev) {
    if (ev.target.id !== 'gradeSelect') return;
    var v = ev.target.value;
    var hint = $('#gradeHint');
    playListChange(function () {
      state.grade = v;
      if (hint) hint.textContent = v ? '只看门槛不高于 ' + gradeLabel(v) + ' 的大学' : '选一个预估成绩，只看门槛匹配的大学';
    });
  });

  $('#sortSelect').addEventListener('change', function () {
    var v = this.value;
    playListChange(function () { state.sort = v; });
  });
  var colToggle = $('#colToggle');
  if (colToggle) {
    colToggle.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.col-btn') : null;
      if (!btn) return;
      setCols(Number(btn.dataset.cols));
    });
  }
  $('#hideCheck').addEventListener('change', function () {
    var v = this.checked;
    playListChange(function () { state.hideEst = v; });
  });

  $('#tabs').addEventListener('click', function (ev) {
    var t = ev.target.closest('.tab');
    if (!t) return;
    var v = t.getAttribute('data-view');
    if (v === 'compare' && state.cmp.length < 2) { toast('先在列表里选 2 所以上大学'); return; }
    setView(v);
  });
  $('#backToBrowse').addEventListener('click', function () { setView('browse'); });
  $('#favBack').addEventListener('click', function () { setView('browse'); });
  $('#clearFav').addEventListener('click', function () {
    if (!state.fav.length) return;
    state.fav = []; save(LS_FAV, state.fav); renderFav();
    $$('#uniList .uni-card').forEach(function (c) { refreshCard(c.getAttribute('data-id')); });
    toast('收藏已清空');
  });
  $('#trayClear').addEventListener('click', function () {
    var ids = state.cmp.slice();
    state.cmp = []; save(LS_CMP, state.cmp);
    ids.forEach(refreshCard);
    renderTray();
  });
  $('#trayRun').addEventListener('click', function () { if (shownCmp().length >= 2) setView('compare'); });

  document.addEventListener('click', function (ev) {
    var x = ev.target.closest('.sum-x');
    if (x && x.closest('.tray-chip')) { toggleCmp(x.closest('.tray-chip').getAttribute('data-id')); return; }
    var btn = ev.target.closest('[data-act]');
    if (btn) {
      ev.stopPropagation();
      var card = btn.closest('.uni-card');
      if (!card) return;
      var uid = card.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'fav') toggleFav(uid);
      else if (btn.getAttribute('data-act') === 'cmp') toggleCmp(uid);
      return;
    }
    var item = ev.target.closest('.add-item[data-id]');
    if (item) { toggleCmp(item.getAttribute('data-id')); renderAddResults(); return; }
    var cc = ev.target.closest('[data-cmpcat]');
    if (cc) { state.cmpCat = cc.getAttribute('data-cmpcat'); renderCompare(); return; }
    var tg = ev.target.closest('[data-cat-toggle]');
    if (tg) {
      var wrap = tg.closest('.v2-cat');
      var open = wrap.classList.toggle('open');
      tg.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (curDetail) state.openCats[curDetail + '|' + tg.getAttribute('data-cat-toggle')] = open;
      return;
    }
    var card2 = ev.target.closest('.uni-card');
    if (card2) openDetailFrom(card2, card2.getAttribute('data-id'));
  });
  document.addEventListener('keydown', function (ev) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

    if (ev.key === 'Escape') {
      if (!$('#modal').hidden) { closeDetailToCard(); return; }
      if (typing && $('#searchInput').value) {
        $('#searchInput').value = ''; state.q = ''; $('#searchClear').hidden = true;
        _countCache = {}; renderAll(); return;
      }
      var open = $('#filterPanel');
      if (open && !open.hidden) { open.hidden = true; $('#filterToggle').classList.remove('on'); }
      return;
    }
    // `/` 聚焦搜索（不在输入框里时才拦截）
    if (ev.key === '/' && !typing) { ev.preventDefault(); $('#searchInput').focus(); return; }

    // ↑/↓ 在卡片间移动焦点，Enter 打开
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Enter') return;
    if (typing || $('#viewBrowse').hidden) return;   // 只在浏览视图里做卡片导航
    var cards = $$('#uniList .uni-card');
    if (!cards.length) return;
    var idx = cards.indexOf(document.activeElement);
    if (ev.key === 'Enter') {
      if (idx < 0) return;
      ev.preventDefault();
      openDetailFrom(cards[idx], cards[idx].getAttribute('data-id'));
      return;
    }
    if (idx < 0 && document.activeElement !== document.body) return;
    ev.preventDefault();
    var next = idx < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, idx + (ev.key === 'ArrowDown' ? 1 : -1)));
    cards[next].focus();
    if (cards[next].scrollIntoView) cards[next].scrollIntoView({ block: 'nearest' });
  });

  $('#detailClose').addEventListener('click', closeDetailToCard);
  $('#modal').addEventListener('click', function (ev) {
    if (ev.target.getAttribute('data-close') || ev.target === $('#modal')) closeDetailToCard();
  });
  $('#detailFav').addEventListener('click', function () { if (curDetail) toggleFav(curDetail); });
  $('#detailCompare').addEventListener('click', function () { if (curDetail) toggleCmp(curDetail); });

  $('#addToggle').addEventListener('click', function () {
    var p = $('#addPanel');
    p.hidden = !p.hidden;
    if (!p.hidden) $('#addInput').focus();
  });
  $('#addInput').addEventListener('input', debounce(renderAddResults, 120));
  $('#addInput').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var first = $('#addResults .add-item[data-id]');
    if (first) { toggleCmp(first.getAttribute('data-id')); this.value = ''; renderAddResults(); }
  });

  // 回到顶部
  var toTop = $('#toTop');
  window.addEventListener('scroll', function () {
    toTop.hidden = window.scrollY < 600;
  }, { passive: true });
  toTop.addEventListener('click', function () {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  });
}

/* ---------------- 启动 ---------------- */
var __inited = false;
function init() {
  if (__inited) return;      // 幂等：脚本被加载两次或事件被重放时，不会重复绑定监听器
  __inited = true;
  state.theme = load(LS_THEME, 'dark') || 'dark';
  // 脚本跑起来了 → 收掉「脚本没运行」的提示条
  var ns = $('#noScript'); if (ns) ns.hidden = true;
  state.fav = load(LS_FAV, []) || [];
  state.cmp = load(LS_CMP, []) || [];
  state.cols = Number(load(LS_COLS, 1)) === 2 ? 2 : 1;   // 恢复上次选择的列数
  applyTheme();
  bind();
  applyCols(false);
  $('#footNote').textContent = '数据源：' + (METAINFO.source || 'xlsx')
    + (METAINFO.dataAsOf ? ' · 截止 ' + METAINFO.dataAsOf : '')
    + (METAINFO.officialRows != null ? ' · 官网门槛 ' + METAINFO.officialRows + ' 行 / 推定 ' + METAINFO.estRows + ' 行' : '');
  renderAll();
  initScrollAnim();
  window.addEventListener('scroll', function () {          // 回到顶部按钮
    var t = $('#toTop'); if (t) t.hidden = window.scrollY < 600;
  }, { passive: true });
  window.state = state;
  window.__app = {
    renderAll: renderAll, openDetail: openDetail, openDetailFrom: openDetailFrom,
    closeDetail: closeDetail, closeDetailToCard: closeDetailToCard,
    UNIS: UNIS, setView: setView, toggleCmp: toggleCmp, toggleFav: toggleFav,
    scanCards: scanCards, playListChange: playListChange, prefersReduced: prefersReduced,
    TIME: TIME, state: function () { return state; }
  };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();

/* ============================================================
   开场动画控制
   黑底按钮 → 点击 → 进度条 → 扫屏 → 主界面从下方升起归位
   ============================================================ */
(function () {
  var intro = document.getElementById('intro');
  if (!intro) return;

  var btnWrap = document.getElementById('introBtnWrap');
  var btn = document.getElementById('introBtn');
  var loading = document.getElementById('introLoading');
  var fill = document.getElementById('introBarFill');
  var status = document.getElementById('introStatus');

  var STEPS = [
    { p: 26, t: '正在装载数据…' },
    { p: 58, t: '正在整理门槛…' },
    { p: 84, t: '正在渲染界面…' },
    { p: 100, t: '完成' }
  ];

  function setProgress(p, text) {
    if (fill) fill.style.width = p + '%';
    if (status && text) status.textContent = text;
  }

  /** 给卡片打上入场序号（用于错峰从下方冒出） */
  function markCards() {
    var i = 0;
    document.querySelectorAll('#uniList .uni-card').forEach(function (el) {
      el.style.setProperty('--intro-i', String(Math.min(i++, 9)));
    });
  }

  var started = false;
  function playIntro() {
    if (started) return;                     // 幂等：重复触发（点击+自动兜底）不会跑两遍
    started = true;
    if (btnWrap) btnWrap.classList.add('leaving');
    if (loading) loading.hidden = false;

    var i = 0;
    function step() {
      if (i >= STEPS.length) {
        finish();
        return;
      }
      var s = STEPS[i++];
      setProgress(s.p, s.t);
      setTimeout(step, s.p === 100 ? 420 : 380);
    }
    setTimeout(step, 520);   // 等按钮淡出

    function finish() {
      // ① 扫屏
      intro.classList.add('scanning');
      // ② 扫到一半时露出主界面（视觉上像"被扫出来"）
      setTimeout(function () {
        // 光束起步后主界面就从下方升起 —— 与"擦除"同步，
        // 视觉上是「光扫到哪里、页面就露到哪里」，而不是扫完突然切换
        document.body.classList.add('intro-done');
        markCards();
      }, 320);
      // ③ 擦除动画跑完（360ms 起 + 820ms）后再收掉开场层
      setTimeout(function () {
        intro.classList.add('hide');
      }, 1320);
      // ④ 彻底移除（释放层级，避免遮挡点击）
      setTimeout(function () {
        if (intro.parentNode) intro.parentNode.removeChild(intro);
      }, 1900);
    }
  }

  // ── 进入方式（三重保险，任何环境都不会卡住）──
  // ① 点按钮 ② 点屏幕任意位置 ③ 触摸 ④ 按回车/空格 ⑤ 6.5 秒后自动进入
  //
  // 之前只有"点按钮/点背景"的 click 监听，一旦 click 没送达（某些拦截插件、
  // 或是用户点到伪元素扩展出来的透明区域），开场层就把整个页面永久盖住了。
  // 现在任何一条路径都能进入，并且最后还有定时器兜底。
  intro.addEventListener('click', function () { playIntro(); });
  intro.addEventListener('pointerdown', function () { playIntro(); });
  intro.addEventListener('touchstart', function () { playIntro(); }, { passive: true });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') playIntro();
  }, { once: true });

  // 兜底：无论发生什么，6.5 秒后自动进入（用户不会被开场层困住）
  setTimeout(playIntro, 2600);

  // 更外层保险：脚本若在上面这段之前就抛异常，这个独立定时器也会放行
  setTimeout(function () {
    var el = document.getElementById('intro');
    if (el && el.parentNode) {
      document.body.classList.add('intro-done');
      el.style.transition = 'opacity .4s ease';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
    }
  }, 4600);
})();
