/* ============================================================
 *  app.js — 录取要求查询逻辑
 *  数据来自 data.js（由 xlsx 生成）：UNIVERSITIES / MAJORS / FILTERS / SYSTEMS / META
 * ============================================================ */

var $ = function (sel, root) { return (root || document).querySelector(sel); };
var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function closestEl(el, sel) {
  var node = el;
  while (node && node.nodeType === 1) {
    if (node.matches && node.matches(sel)) return node;
    node = node.parentElement || node.parentNode;
  }
  return null;
}
function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/* ---------- 数据访问：data.js 缺失时页面仍可用 ---------- */
function UNIS() { return (typeof UNIVERSITIES !== 'undefined' && Array.isArray(UNIVERSITIES)) ? UNIVERSITIES : []; }
function MAJOR_LIST() { return (typeof MAJORS !== 'undefined' && Array.isArray(MAJORS)) ? MAJORS : []; }
function FILTER_DEFS() { return (typeof FILTERS !== 'undefined' && Array.isArray(FILTERS)) ? FILTERS : []; }
function SYSTEM_MAP() { return (typeof SYSTEMS !== 'undefined' && SYSTEMS) ? SYSTEMS : {}; }
function META_INFO() { return (typeof META !== 'undefined' && META) ? META : {}; }

/* ---------- 门槛分档 ----------
 * 分档由 data.js 预先算好（每所学校带 band 字段）：
 *   3 = 较高 / 2 = 中等 / 1 = 较低 / 'uncertain' = 数据太少难以判断
 * 口径：按「该国国内」的分布划分（P25/P75），保证同一国家内可比、
 * 又不会出现"英国全落较高"这种没有区分度的情况。
 * A-Level 等级分与澳洲合计分不是同一尺度，比较时统一折算成合计分：
 *   等效合计分 = 等级分 × 1.4（用户给定阈值：≥16 较高、13–16 中等、≤12 较低）
 */
var EQ_K = 1.4;

function bandCutsOf() {
  return (typeof BAND_CUTS !== 'undefined' && BAND_CUTS) ? BAND_CUTS : {};
}
var BAND_LABEL = { 1: '门槛较低', 2: '门槛中等', 3: '门槛较高' };
var BAND_HINT = {
  1: '该国国内门槛偏低的一档（组内比较）',
  2: '该国国内门槛居中（组内比较）',
  3: '该国国内门槛偏高的一档（组内比较）'
};

/** 该校的门槛档：直接来自 data.js 预算结果（未选专业时用） */
function levelBand(u) {
  if (!u) return null;
  return typeof u.band === 'number' ? u.band : null;
}

/** 数据太少（少于 3 个专业有分数）→ 分档不可靠 */
function isUncertain(u) { return u && u.band === 'uncertain'; }

/** 热门专业的要求摘要（详情页用来解释"门槛高低"的判断依据） */
var HOT_MAJORS = ['计算机科学', '经济学', '数学', '法律', '医学'];
function hotMajorsHTML(u) {
  var items = HOT_MAJORS.filter(function (m) { return MAJOR_LIST().indexOf(m) > -1; })
    .map(function (m) {
      var v = majorReq(u, m);
      if (!v || v.type !== 'req') return null;
      var t = v.grades || (typeof v.points === 'number' ? v.points + ' 分' : null);
      if (!t) return null;
      return '<div class="hot-item"><span class="hot-name">' + esc(m) + '</span>' +
        '<span class="hot-val">' + esc(t) + '</span></div>';
    }).filter(Boolean);
  if (!items.length) return '';
  return '<section class="detail-section"><h3>热门专业的要求</h3>' +
    '<div class="hot-grid">' + items.join('') + '</div></section>';
}

function qsBandOf(qs) {
  if (qs == null) return '';
  if (qs <= 50) return '1-50';
  if (qs <= 100) return '51-100';
  if (qs <= 200) return '101-200';
  if (qs <= 300) return '201-300';
  return '300+';
}

/** 某校某专业的要求；返回 { type:'req'|'closed'|'check', text?, score? } */
function majorReq(u, major) {
  if (!major) return null;                 // 未选专业
  var v = u.majors && u.majors[major];
  if (!v) return { type: 'check' };
  return v;
}

/* ---------- 「当前上下文」的门槛：选了专业看该专业，没选则看该校最低档 ----------
 * 澳洲的合计分口径与 A-Level 等级分不是一个尺度，折算一下（A*≈6）以便统一比较：
 *   15 分 ≈ 3 门 A* → 18（较高）    10 分 ≈ 3 门 C → 9（较低）
 */
function pointsToScore(pts) {
  if (typeof pts !== 'number') return null;
  return Math.round(pts * 18 / 15);
}

/* ---------- 当前上下文下该校的可比分数（等效合计分） ----------
 * 有专业 → 该专业的要求（澳洲合计分直接用，A-Level 等级分 × 1.4）
 * 未选专业 → 各专业的平均（data.js 预算好的 pointsAvg）
 */
function curScore(u) {
  if (state.major) {
    var r = majorReq(u, state.major);
    if (r && typeof r.points === 'number') return r.points;
    if (r && typeof r.score === 'number') return Math.round(r.score * EQ_K * 10) / 10;
    return null;
  }
  return typeof u.pointsAvg === 'number' ? u.pointsAvg : null;
}

/** 具体等级文字（如 A*A*A），未选专业时为空 */
function curGrades(u) {
  if (!state.major) return '';
  var r = majorReq(u, state.major);
  if (r && r.grades) return r.grades;
  if (r && typeof r.points === 'number') return r.points + ' 分';
  return '';
}

/** 由「等效合计分」和该国阈值定档：≥high 较高 / ≥low 中等 / 其余较低 */
function getBand(country, eq) {
  if (eq == null) return null;
  var c = bandCutsOf()[country] || {};
  if (typeof c.high !== 'number' || typeof c.low !== 'number') {
    return eq >= 16 ? 3 : (eq >= 13 ? 2 : 1);
  }
  return eq >= c.high ? 3 : (eq >= c.low ? 2 : 1);
}

/** 上下文档位：有专业时按该专业要求，否则按平均难度 */
function curBand(u) { return getBand(u.country, curScore(u)); }

/* ============================================================
 *  状态
 * ============================================================ */
var LS_KEY = 'university-finder:v2';

var state = {
  query: '',
  view: 'browse',
  filters: {},                  // { country:Set, qsBand:Set }  门槛用 levelBand 单选
  levelFilter: null,            // 录取门槛分档（1/2/3，null=不限）
  major: '',                    // 专业（单选）
  myGrade: null,
  hideCheck: false,
  sort: 'default',
  compare: new Set(),
  favorites: new Set(),
  theme: 'light',
  currentId: null,
  addOpen: false,               // 对比页「手动添加」是否展开
  addQuery: ''
};

var memoryStore = {};
function loadStore() {
  var raw = null;
  try { raw = localStorage.getItem(LS_KEY); } catch (e) { raw = memoryStore[LS_KEY] || null; }
  if (!raw) return;
  try {
    var d = JSON.parse(raw);
    state.favorites = new Set(d.favorites || []);
    state.compare = new Set(d.compare || []);
    state.theme = d.theme || 'light';
    if (d.major) state.major = d.major;
    if (d.myGrade) state.myGrade = d.myGrade;
    if (d.levelFilter) state.levelFilter = d.levelFilter;
    state.hideCheck = !!d.hideCheck;
    state.filters = {};
    Object.keys(d.filters || {}).forEach(function (k) { state.filters[k] = new Set(d.filters[k]); });
  } catch (e) { /* 数据损坏忽略 */ }
}
function saveStore() {
  var filters = {};
  Object.keys(state.filters).forEach(function (k) {
    if (state.filters[k] && state.filters[k].size) filters[k] = Array.from(state.filters[k]);
  });
  var payload = JSON.stringify({
    favorites: Array.from(state.favorites),
    compare: Array.from(state.compare),
    filters: filters,
    levelFilter: state.levelFilter,
    theme: state.theme,
    major: state.major,
    myGrade: state.myGrade,
    hideCheck: state.hideCheck
  });
  try { localStorage.setItem(LS_KEY, payload); } catch (e) { memoryStore[LS_KEY] = payload; }
}

/** 清掉指向已不存在学校的收藏/对比记录 */
function pruneStored() {
  var ids = {};
  UNIS().forEach(function (u) { ids[u.id] = 1; });
  var changed = false;
  ['favorites', 'compare'].forEach(function (k) {
    state[k].forEach(function (id) { if (!ids[id]) { state[k].delete(id); changed = true; } });
  });
  if (changed) saveStore();
}

/* ============================================================
 *  查询 / 排序
 * ============================================================ */
function nameOf(id) {
  var u = UNIS().filter(function (x) { return x.id === id; })[0];
  return u ? u.name : id;
}

function haystack(u) {
  return [u.name, u.en, u.city, u.country].filter(Boolean).join(' ').toLowerCase();
}

function activeFilterCount() {
  var n = 0;
  Object.keys(state.filters).forEach(function (k) { n += state.filters[k].size; });
  if (state.levelFilter) n++;
  return n;
}

/** 判断某校是否通过当前筛选 */
function passes(u) {
  var q = state.query.trim().toLowerCase();
  if (q && haystack(u).indexOf(q) === -1) return false;

  // 国家
  var set = state.filters.country;
  if (set && set.size && !set.has(u.country)) return false;

  // QS 分档
  set = state.filters.qsBand;
  if (set && set.size && !set.has(qsBandOf(u.qs))) return false;

  // 录取门槛（针对当前专业的要求；没有分数的学校不因此被排除，避免误伤德法体系）
  if (state.levelFilter) {
    var band = curBand(u);
    if (band != null && band !== state.levelFilter) return false;
  }

  // 我的成绩：统一折算成合计分口径比较
  // （用户选的是 A-Level 等级，澳洲/英国都用等效合计分换算后再比）
  if (state.myGrade != null) {
    var sc = curScore(u);
    var mine = state.myGrade * EQ_K;
    if (sc != null && sc > mine) return false;
  }

  // 需查官网
  if (state.hideCheck) {
    var r3 = majorReq(u, state.major);
    if (r3.type === 'check') return false;
  }
  return true;
}

function queryList() {
  var list = UNIS().filter(passes);
  return sortList(list);
}

function sortList(list) {
  var out = list.slice();
  // 未选专业时，用该校最低门槛参与排序
  var lv = function (u) {
    if (state.major) {
      var r = majorReq(u, state.major);
      if (r && r.type === 'closed') return 999;
      var s = curScore(u);
      return s == null ? 998 : s;
    }
    var s2 = curScore(u);
    return s2 == null ? 998 : s2;
  };
  // 门槛排序：以「档位」为主键、绝对分为次键 ——
  // 档位是按国家相对划分的，光按绝对分排会出现「较低/中等交错」的观感
  var bandKey = function (u) {
    var b = curBand(u);
    return b == null ? 9 : b;
  };
  if (state.sort === 'level-asc' || state.sort === 'level-desc') {
    var dir = state.sort === 'level-asc' ? 1 : -1;
    out.sort(function (a, b) {
      var d = (bandKey(a) - bandKey(b)) * dir;
      if (d !== 0) return d;
      var s = (lv(a) - lv(b)) * dir;
      if (s !== 0) return s;
      return (a.qs || 999) - (b.qs || 999);
    });
  }
  else if (state.sort === 'country') out.sort(function (a, b) {
    return String(a.country).localeCompare(String(b.country), 'zh') || (a.qs || 999) - (b.qs || 999);
  });
  else if (state.sort === 'name') out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh'); });
  else out.sort(function (a, b) { return (a.qs || 999) - (b.qs || 999); });
  return out;
}

/* ============================================================
 *  渲染：门槛徽章
 * ============================================================ */
/** 上下文下的具体等级文字（选了专业才有） */
function levelText(u) {
  if (!state.major) return '';
  var r = majorReq(u, state.major);
  if (!r || typeof r.score !== 'number') return '';
  if (r.grades) return r.grades;
  if (typeof r.points === 'number') return r.points + ' 分';
  return '';
}

/** 门槛徽章：未选专业 → 分档（较高/中等/较低）；选了专业 → 精确等级（A*A*A） */
function levelChipHTML(u) {
  var band = curBand(u);
  if (band == null) {
    if (isUncertain(u) && !state.major) {
      return '<span class="lv-chip lv-none" title="有分数的专业不足 3 个，分档不可靠">门槛待定</span>';
    }
    return '';
  }
  var text = levelText(u) || BAND_LABEL[band];
  return '<span class="lv-chip lv-' + band + '" title="' +
    esc(BAND_LABEL[band] + ' · ' + (BAND_HINT[band] || '')) + '">' + esc(text) + '</span>';
}

/** 该专业要求的展示块（仅在已选择专业时使用） */
function reqHTML(u) {
  var r = majorReq(u, state.major);
  if (!r || r.type === 'closed') {
    return '<div class="req req-closed">该校本科未开设此专业</div>';
  }
  if (r.type === 'check') {
    return '<div class="req req-check">需查官网 —— 本轮未查证到公开数据</div>';
  }
  return '<div class="req">' + esc(r.text) + '</div>';
}

/** 未选择专业时：门槛分档由校名旁的徽章承载，这里只说明判断依据 */
function minLevelHTML(u) {
  var n = u.pointsAvgN || 0;
  if (isUncertain(u)) {
    return '<div class="req req-min"><span class="min-score">门槛待定</span>' +
      '<span class="min-from">· 仅 ' + n + ' 个专业有公开要求，样本太少</span>' +
      '<span class="min-note">选专业后可看具体要求</span></div>';
  }
  if (levelBand(u) != null) {
    return '<div class="req req-min" title="把该校各专业的要求折算到同一尺度后取平均，再与同国其他学校比较得出分档">' +
      '<span class="min-from">按 ' + n + ' 个专业的平均要求判断</span>' +
      (u.sampleFew ? '<span class="min-note warn">样本较少，仅供参考</span>' : '') +
      '</div>';
  }
  return '<div class="req req-min"><span class="min-score">门槛需查官网</span>' +
    '<span class="min-note">选专业后可看具体要求</span></div>';
}

/* ============================================================
 *  渲染：筛选面板（专业 + 国家 + QS + 门槛）与条件摘要
 * ============================================================ */
function optionsFor(key) {
  var def = FILTER_DEFS().filter(function (f) { return f.key === key; })[0];
  if (!def || !Array.isArray(def.options)) return [];
  return def.options;
}

/** 一组 chip */
function chipGroupHTML(label, chips, hint) {
  return '<div class="filter-group">' +
    '<div class="filter-group-name">' + esc(label) +
      (hint ? '<span class="fg-hint" title="' + esc(hint) + '">?</span>' : '') + '</div>' +
    '<div class="chips">' + (chips || '<span class="muted">无可选项</span>') + '</div>' +
    '</div>';
}

function renderFilters() {
  var host = $('#filterPanel');

  // 专业（单选，必选）
  var majorChips = MAJOR_LIST().map(function (m) {
    return '<button type="button" class="chip chip-major' + (m === state.major ? ' on' : '') +
      '" data-fkey="major" data-fvalue="' + esc(m) + '">' + esc(m) + '</button>';
  }).join('');

  // 国家（多选）
  var countryChips = optionsFor('country').map(function (opt) {
    var on = state.filters.country && state.filters.country.has(String(opt));
    return '<button type="button" class="chip' + (on ? ' on' : '') +
      '" data-fkey="country" data-fvalue="' + esc(opt) + '">' + esc(opt) + '</button>';
  }).join('');

  // QS 分档（多选）
  var qsChips = optionsFor('qsBand').map(function (opt) {
    var on = state.filters.qsBand && state.filters.qsBand.has(String(opt));
    return '<button type="button" class="chip' + (on ? ' on' : '') +
      '" data-fkey="qsBand" data-fvalue="' + esc(opt) + '">QS ' + esc(opt) + '</button>';
  }).join('');

  // 录取门槛（单选）
  var levelChips = optionsFor('level').map(function (opt) {
    var isObj = opt !== null && typeof opt === 'object';
    var value = Number(isObj ? opt.value : opt);
    var label = isObj ? opt.label : opt;
    return '<button type="button" class="chip' + (state.levelFilter === value ? ' on' : '') +
      '" data-fkey="level" data-fvalue="' + value + '" title="' + esc(BAND_HINT[value] || '') + '">' +
      esc(label) + '</button>';
  }).join('');

  host.innerHTML =
    '<div class="filter-head">' +
      '<strong>筛选与专业</strong>' +
      '<button class="text-btn" id="resetFilters" type="button">重置全部</button>' +
    '</div>' +
    chipGroupHTML('专业', majorChips, '决定列表里展示哪个专业的要求') +
    chipGroupHTML('国家', countryChips) +
    chipGroupHTML('QS 排名', qsChips) +
    chipGroupHTML('录取门槛', levelChips) +
    '<div class="switch-row">' +
      '<label class="switch"><input type="checkbox" id="hideCheck"' + (state.hideCheck ? ' checked' : '') +
      '><span>隐藏「需查官网」的条目</span></label>' +
    '</div>';

  var n = activeFilterCount();
  var badge = $('#filterBadge');
  badge.textContent = n;
  badge.hidden = n === 0;
  renderSummary();
}

/** 顶部条件摘要条：随时能看到当前专业与门槛/成绩等不在 chip 上的条件 */
function renderSummary() {
  var box = $('#activeSummary');
  var parts = [];
  parts.push('<span class="sum-item sum-major">专业：' + esc(state.major || '未选（显示各校录取门槛）') + '</span>');
  var nCountry = state.filters.country ? state.filters.country.size : 0;
  var nQs = state.filters.qsBand ? state.filters.qsBand.size : 0;
  if (nCountry) parts.push('<span class="sum-item">国家 ' + nCountry + ' 项</span>');
  if (nQs) parts.push('<span class="sum-item">QS ' + nQs + ' 档</span>');
  if (state.levelFilter) {
    parts.push('<span class="sum-item">门槛：' + esc(BAND_LABEL[state.levelFilter]) +
      '<button type="button" class="sum-x" data-clear="level" title="清除">✕</button></span>');
  }
  if (state.myGrade != null) {
    var gl = $('#gradeSelect');
    var txt = gl && gl.selectedIndex >= 0 ? gl.options[gl.selectedIndex].text : state.myGrade;
    parts.push('<span class="sum-item">成绩：' + esc(txt) +
      '<button type="button" class="sum-x" data-clear="grade" title="清除">✕</button></span>');
  }
  if (state.hideCheck) {
    parts.push('<span class="sum-item">已隐藏需查官网' +
      '<button type="button" class="sum-x" data-clear="hideCheck" title="清除">✕</button></span>');
  }
  var hasExtra = nCountry || nQs || state.levelFilter || state.myGrade != null || state.hideCheck;
  // 专业是核心上下文：选了默认专业之外的专业时，也把摘要条显示出来
  var nonDefaultMajor = state.major && MAJOR_LIST().length && state.major !== MAJOR_LIST()[0];
  box.hidden = !(hasExtra || nonDefaultMajor);
  box.innerHTML = (hasExtra || nonDefaultMajor)
    ? parts.join('') + (hasExtra ? '<button type="button" class="text-btn" id="sumReset">全部重置</button>' : '')
    : '';
}

function clearOne(what) {
  playListChange(function () {
    if (what === 'level') state.levelFilter = null;
    else if (what === 'grade') state.myGrade = null;
    else if (what === 'hideCheck') state.hideCheck = false;
    saveStore();
  });
}

function renderGrade() {
  var sel = $('#gradeSelect');
  sel.value = state.myGrade == null ? '' : String(state.myGrade);
  var hint = $('#gradeHint');
  if (state.myGrade == null) {
    hint.textContent = '';
    return;
  }
  var n = UNIS().filter(function (u) {
    var sc = curScore(u);
    return sc != null && sc <= state.myGrade;
  }).length;
  hint.textContent = (state.major ? '在「' + state.major + '」下，' : '按各校最低门槛估算，')
    + '共 ' + n + ' 所大学的要求不高于你的成绩'
    + (state.major ? '' : '（选具体专业后更准确）');
}

/* ============================================================
 *  滚动进场动画（方向感知）
 *  下滚：从下方露出的卡片 → 自「右下角」一个点展开成卡片
 *  上滚：从上方露出的卡片 → 自「右上角」展开
 *
 *  用「自己监听 scroll + 位置判断」而不是 IntersectionObserver：
 *  IO 的触发依赖渲染帧，在某些环境下不稳定；scroll 事件则一定能拿到位置，
 *  而且能明确判断"这是从下面上来的还是从上面下来的"，正是这里需要的方向感。
 * ============================================================ */
var scrollAnim = { seen: {}, primed: false, off: false, raf: 0, bound: false, scrollCleanup: null };

/** 一次检查：进入视口且"待播"的卡片按方向播进场动画；离开视口恢复待播状态 */
var RV_DURATION = 620;      // 滚动进场的总时长（含错开），与 CSS 的 --dur-rv 对齐

function scanCards() {
  var vh = window.innerHeight || 800;
  var list = $('#uniList');
  if (!list || list.hidden) return;
  var now = Date.now();
  var batch = 0;
  $$('#uniList .uni-card').forEach(function (el) {
    var r = el.getBoundingClientRect();
    var inView = r.bottom > 0 && r.top < vh;
    // 动画进行中用时间戳判断（不用定时器：定时器在虚拟时间下会被快进，
    // 导致卡片被瞬间标记成"已完成"，回到视口就不再播了）
    var until = Number(el.dataset.rvUntil || 0);
    var animating = until > now;

    if (!inView) {
      if (!animating) {
        el.classList.remove('rv-b', 'rv-t', 'rv-done');
        delete el.dataset.rvUntil;
      }
      return;
    }
    if (animating) return;
    if (until && until <= now) {                       // 动画刚结束
      el.classList.remove('rv-b', 'rv-t');
      el.classList.add('rv-done');
      delete el.dataset.rvUntil;
      return;
    }
    if (el.classList.contains('rv-done')) return;      // 本轮已在视口内播过
    if (!scrollAnim.primed) { el.classList.add('rv-done'); return; }   // 首屏那批不播

    // 卡片中心在视口上半 → 从上面下来的（右上角展开）；下半 → 从下面上来的（右下角）
    var fromTop = (r.top + r.height / 2) < (vh / 2);
    el.style.setProperty('--rvi', String(Math.min(batch, 6)));
    batch++;
    el.classList.remove('card-enter');                 // 摘掉列表入场动画，避免压住滚动动画
    el.classList.add(fromTop ? 'rv-t' : 'rv-b');
    el.dataset.rvUntil = String(now + RV_DURATION);    // 动画结束时刻（不用定时器判断）
    if (window.__rvLog) window.__rvLog.push({ id: el.dataset.id, dir: fromTop ? 'TR' : 'BR', y: Math.round(window.scrollY) });
    void el.offsetHeight;                              // 强制生效，让动画从头播
  });
}

function initScrollAnim() {
  if (scrollAnim.scrollCleanup) { scrollAnim.scrollCleanup(); scrollAnim.scrollCleanup = null; }
  if (scrollAnim.off) return;

  // 只有当前真的在视口内的卡片标记为「已播过」：
  // 首屏那一批不会忽然播滚动动画；一旦滚出视口，scanCards 会清掉标记，
  // 滑回来时就会播（每进出一次播一次）。
  var vh = window.innerHeight || 800;
  $$('#uniList .uni-card').forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.bottom > 0 && r.top < vh) el.classList.add('rv-done');
  });
  scrollAnim.primed = true;

  // 兜底轮询：scroll 事件在少数环境下可能不派发（无头/某些内嵌浏览器），
  // 这里按位置变化驱动，成本极低（只在滚动位置变化时才扫一遍）
  var lastY = window.scrollY;
  var poll = window.setInterval(function () {
    if (window.scrollY !== lastY) {
      lastY = window.scrollY;
      scanCards();
    }
  }, 60);

  var onScroll = function () {
    if (scrollAnim.raf) return;
    scrollAnim.raf = window.setTimeout(function () {
      scrollAnim.raf = 0;
      scanCards();
    }, 16);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  scrollAnim.scrollCleanup = function () {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    window.clearInterval(poll);
  };
}

/* ============================================================
 *  卡片 ⇄ 详情：位置/尺寸衔接的放大与缩小过渡
 * ============================================================ */
/** 卡片 ⇄ 详情：位置/尺寸衔接的放大与缩小过渡 */
/* ---------- 动画时序（与 styles.css 末尾「时间参数唯一来源」保持同步） ----------
 * 改 CSS 里的 --fly-in / --fly-out / --dur-modal 时，这里也要一起改 */
var TIME = {
  flyIn: 420,            // 对应 --fly-in（弹窗放大铺开）
  flyInSettle: 360,
  revealAt: 150,         // 放大开始后多久内容淡入
  collapse: 220,         // 关闭阶段一：从四周快速收拢成小球
  expand: 300,           // 关闭阶段二：在原卡片位置展开复原
  flyOutPhase1: 220,     // 兼容旧引用
  flyOutRestore: 300,
  flyOutPhase2: 200,
  modal: 300,            // 对应 --dur-modal
  contentFade: 320,      // 内容淡入时长 + 余量
  veil: 340,             // 背景遮罩淡入
  veilOut: 200,          // 背景遮罩淡出（关闭时要快，别让整个 UI 一直糊着）
  leaveDur: 360,         // 筛选/排序：列表整体右移消失
  enterDur: 460,         // 筛选/排序：列表从右侧重新出现
  ball: 54               // 关闭时收拢成的"小球"直径（px）
};
var BALL = TIME.ball;

/* ---------- 背景遮罩 ----------
 * 完全交给 CSS 类控制：`.flying-in / .flying-out` → opacity 1，`.closing` → 0。
 * 模糊值在 CSS 里写死（静态），只让 opacity 渐变 —— 由合成器处理，几乎零成本。
 * 早期版本用 JS 每 16ms 改一次 backdrop-filter 的 blur，浏览器每帧都要重算
 * 整个视口的模糊，帧率骤降，看起来就像"闪"。 */

var flightTimer = null;      // 飞行动画的收尾计时器
var closeTimer = null;       // 关闭动画的收尾计时器
var flightEndsAt = 0;        // 飞行过渡预计结束的时刻（防止提前清样式造成跳变）
var contentTimer = null;     // 内容淡入的收尾计时器

/** 内容淡入：early=true 时确保内容处于"已挂载但隐藏"状态 */
function revealContent(early) {
  var modal = $('#modal');
  if (!modal) return;
  if (early) {
    modal.classList.add('modal-content-hidden');
    return;
  }
  if (!modal.classList.contains('modal-content-hidden')) return;
  modal.classList.remove('modal-content-hidden');
  if (contentTimer) window.clearTimeout(contentTimer);
  contentTimer = window.setTimeout(revealContentDone, TIME.contentFade);
}

/** 清掉内容上的内联样式，恢复由 CSS 掌控 */
function revealContentDone() {
  if (contentTimer) { window.clearTimeout(contentTimer); contentTimer = null; }
  $$('.modal-card > *').forEach(function (el) { el.style.opacity = ''; });
}

function prefersReduced() {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 清掉所有飞行/关闭计时器（避免旧计时器误关新打开的弹窗） */
function clearFlightTimers() {
  if (flightTimer) { window.clearTimeout(flightTimer); flightTimer = null; }
  if (closeTimer) { window.clearTimeout(closeTimer); closeTimer = null; }
  flightEndsAt = 0;                  // 计时器一并失效，避免"等过渡结束"的判断误触发
}

/** 飞行收尾：只摘类名，**保留内联样式** ——
 *  清样式会让元素在那一帧回退到 CSS 默认值，就是"过渡完成瞬间闪一下"的来源。
 *  占位卡片也继续留着，等小球复原到位再放出来。 */
function clearFlight() {
  var modal = $('#modal');
  if (!modal) return;
  // 过渡还没跑完就收尾会看到"跳一下"，所以延长
  if (flightEndsAt && Date.now() < flightEndsAt) {
    if (flightTimer) window.clearTimeout(flightTimer);
    flightTimer = window.setTimeout(function () {
      flightTimer = null;
      flightEndsAt = 0;
      clearFlight();
    }, flightEndsAt - Date.now() + 40);
    return;
  }
  if (contentTimer) { window.clearTimeout(contentTimer); contentTimer = null; }
  modal.classList.remove('flying-in', 'flying-out', 'modal-content-hidden', 'veil-off');
}

/** 彻底复位弹窗：清掉所有内联样式与占位（只在弹窗真正隐藏时调用） */
function resetFlightStyles() {
  var modal = $('#modal');
  if (!modal) return;
  modal.classList.remove('flying-in', 'flying-out', 'out', 'modal-content-hidden', 'veil-off');
  var card = $('.modal-card');
  if (card) {
    card.style.transform = '';
    card.style.transformOrigin = '';
    card.style.borderRadius = '';
    card.style.opacity = '';
    card.style.transition = '';
    card.style.animation = '';
  }
  $$('.modal-card > *').forEach(function (el) { el.style.opacity = ''; });
  var backdrop = $('.modal-backdrop');
  if (backdrop) backdrop.style.opacity = '';
  // 只有到这里才把占位卡片放出来
  $$('#uniList .uni-card.card-placeholder').forEach(function (el) {
    el.classList.remove('card-placeholder');
  });
}

/* ---------- 滚动锁定：补滚动条宽度，避免整页横向跳动 ---------- */
var savedPadRight = '';
function lockScroll() {
  if (document.body.classList.contains('no-scroll')) return;
  var sbw = window.innerWidth - document.documentElement.clientWidth;
  if (sbw > 0) {
    savedPadRight = document.body.style.paddingRight;
    var cur = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
    document.body.style.paddingRight = (cur + sbw) + 'px';
  }
  document.body.classList.add('no-scroll');
}
function unlockScroll() {
  document.body.classList.remove('no-scroll');
  if (savedPadRight !== '') {
    document.body.style.paddingRight = savedPadRight;
    savedPadRight = '';
  }
}

/** 标记/解除"占位"：原卡片位置留空，等详情界面复位 */
function markPlaceholder(id, on) {
  var card = id ? $('#uniList .uni-card[data-id="' + id + '"]') : null;
  if (card) card.classList.toggle('card-placeholder', !!on);
}

/** 卡片 → 详情：弹窗从卡片的位置尺寸放大铺开；背景同步慢慢变模糊 */
function openDetailFrom(card, id) {
  var modal = $('#modal');
  if (!card || !modal || prefersReduced()) { openDetail(id); return; }

  // 量不到卡片尺寸时（隐藏、未布局、display:none）不做飞行，直接普通打开
  var from = card.getBoundingClientRect();
  if (!from.width || !from.height) { openDetail(id); return; }

  clearFlightTimers();                           // 清掉上一次飞行的收尾
  clearFlight();
  // 关键：在弹窗变可见**之前**就把内容藏起来。
  // openDetail 里会重建 #detailBody 的 DOM，如果那时弹窗已经可见，
  // 浏览器可能先绘制一帧"未缩放 + 内容已插入"的画面 —— 那就是闪烁。
  var mcPre = $('.modal-card');
  if (mcPre) mcPre.style.animation = 'none';
  modal.classList.add('modal-content-hidden');
  modal.classList.add('flying-in');
  markPlaceholder(id, true);                     // 原卡片位置留空
  openDetail(id, true);                          // true: 保留飞行/占位/内容隐藏状态

  var card2 = $('.modal-card');
  // 先钉住初始形态，再读几何 —— 保证浏览器不可能绘制出"未缩放但可见"的中间帧
  card2.style.transformOrigin = 'center center';
  card2.style.transition = 'none';
  var to = card2.getBoundingClientRect();
  if (!to.width || !to.height) { resetFlightStyles(); return; }   // 弹窗还没量到尺寸
  // 横向用 clientWidth 而不是 rect.width，避免滚动条宽度污染换算
  var docW = document.documentElement.clientWidth;
  var sx = from.width / docW, sy = from.height / to.height;
  var tx = (from.left + from.width / 2) - (to.left + to.width / 2);
  var ty = (from.top + from.height / 2) - (to.top + to.height / 2);

  card2.style.transform = 'translate3d(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px,0) scale(' +
    sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
  card2.style.borderRadius = '18px';
  // 先给子元素钉住 opacity:0 的初态（内联），这样后面解除隐藏时是"0 → 1 平滑淡入"，
  // 而不是从"不可见"直接跳到"可见"（那一下就是大面积突变 = 闪）
  $$('.modal-card > *').forEach(function (el) { el.style.opacity = '0'; });

  flightEndsAt = Date.now() + TIME.flyIn;
  window.setTimeout(function () {
    card2.style.transition = 'transform var(--fly-in) var(--ease-fly), border-radius var(--fly-in) ease';
    card2.style.transform = 'none';
    card2.style.borderRadius = '';
    // 解除隐藏 → 子元素从内联 opacity:0 平滑过渡到 1（不是跳变）
    revealContent();
    flightTimer = window.setTimeout(function () {
      flightTimer = null;
      flightEndsAt = 0;
      clearFlight();
      revealContentDone();
    }, TIME.flyInSettle);
  }, 24);
}

/** 详情 → 卡片：先缩成一个小球移到原卡片中心，再展开复原成卡片 */
function closeDetailToCard() {
  var modal = $('#modal');
  if (!modal || modal.hidden || modal.classList.contains('closing') ||
      modal.classList.contains('flying-out')) return;

  var card = state.currentId ? $('#uniList .uni-card[data-id="' + state.currentId + '"]') : null;
  if (!card || prefersReduced()) { closeDetail(); return; }

  // 量不到尺寸就别飞（隐藏/未布局），否则会算出 Infinity/NaN 的 transform
  var target = card.getBoundingClientRect();
  if (!target.width || !target.height) { closeDetail(); return; }

  clearFlightTimers();
  var card2 = $('.modal-card');
  var cur = card2.getBoundingClientRect();
  if (!cur.width || !cur.height) { closeDetail(); return; }

  modal.classList.remove('flying-in', 'out');
  modal.classList.add('flying-out', 'veil-off');
  // 内容跟着淡出
  $$('.modal-card > *').forEach(function (el) { el.style.opacity = '0'; });

  var cx = (target.left + target.width / 2) - (cur.left + cur.width / 2);
  var cy = (target.top + target.height / 2) - (cur.top + cur.height / 2);

  card2.style.transformOrigin = 'center center';
  card2.style.transition = 'transform ' + TIME.collapse + 'ms var(--ease-snap), ' +
    'opacity ' + TIME.collapse + 'ms ease, border-radius ' + TIME.collapse + 'ms ease';
  // 阶段一：从四周快速收拢成一个"小球"，同时移到原卡片中心
  card2.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0) ' +
    'scale(' + (BALL / cur.width).toFixed(4) + ',' + (BALL / cur.height).toFixed(4) + ')';
  card2.style.borderRadius = '50%';
  card2.style.opacity = '0.6';

  // 遮罩快速淡出：不要让整个 UI 一直糊着
  modal.classList.add('veil-off');
  // 立刻解锁：动画期间用户已经可以滚动/点其他卡片
  unlockScroll();
  state.currentId = null;
  flightEndsAt = Date.now() + TIME.collapse;

  // 阶段二：小球在原卡片位置展开复原成卡片
  flightTimer = window.setTimeout(function () {
    flightTimer = null;
    flightEndsAt = 0;
    var sx2 = target.width / cur.width, sy2 = target.height / cur.height;
    card2.style.transition = 'transform ' + TIME.expand + 'ms var(--ease-fly), ' +
      'opacity ' + TIME.expand + 'ms ease, border-radius ' + TIME.expand + 'ms ease';
    card2.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0) scale(' +
      sx2.toFixed(4) + ',' + sy2.toFixed(4) + ')';
    card2.style.borderRadius = '18px';
    card2.style.opacity = '0';
    // 占位留到小球复原到位才释放（见 resetFlightStyles）
    window.setTimeout(closeDetailInstant, TIME.expand - 40);
  }, TIME.collapse);
}
/** 立即隐藏（关闭动画收尾）：此时才彻底复位，并放回占位卡片 */
function closeDetailInstant() {
  var modal = $('#modal');
  if (!modal) return;
  modal.classList.add('closing-instant');
  modal.hidden = true;
  unlockScroll();
  window.setTimeout(function () {
    resetFlightStyles();
    window.setTimeout(function () { modal.classList.remove('closing-instant'); }, 40);
  }, 40);
}

/** 真正的关闭（播完 .closing 再隐藏） */
function closeDetail() {
  var modal = $('#modal');
  if (!modal) return;
  clearFlightTimers();
  clearFlight();
  if (modal.hidden) { resetFlightStyles(); return; }
  modal.classList.add('closing');
  unlockScroll();
  state.currentId = null;
  closeTimer = window.setTimeout(function () {
    modal.classList.remove('closing');
    modal.hidden = true;
    closeTimer = null;
    resetFlightStyles();          // 弹窗真正隐藏后才复位样式与占位
  }, TIME.modal);
}

/* ============================================================
 *  列表过渡：筛选 / 排序变化时，卡片整体右移消失，再从右侧重新出现
 * ============================================================ */
var listAnimating = false;

/** 测试/调试用：置 true 则筛选排序走同步渲染（不做列表动画） */
var syncListAnim = false;

function playListChange(mutate) {
  var list = $('#uniList');
  if (listAnimating || !list || syncListAnim) { mutate(); render(); return; }

  var cards = $$('#uniList .uni-card');
  // 卡片太多时（>90）不做逐张动画，直接重绘，保证流畅优先
  if (!cards.length || cards.length > 90) { mutate(); render(); return; }

  listAnimating = true;
  list.dataset.animating = 'leave';
  cards.forEach(function (el, i) {
    el.classList.add('list-leaving');
    el.style.animation =
      'listLeave ' + TIME.leaveDur + 'ms cubic-bezier(.4,0,.7,.4) ' + (Math.min(i, 14) * 8) + 'ms both';
  });

  var wait = TIME.leaveDur + Math.min(cards.length, 15) * 8 + 30;
  window.setTimeout(function () {
    mutate();
    listReplay = true;                 // 让新一批卡片走"从右侧进入"
    render();
    listAnimating = false;
    delete list.dataset.animating;
  }, wait);
}
function cardHTML(u) {
  var isFav = state.favorites.has(u.id);
  var isCmp = state.compare.has(u.id);
  var hasMajor = !!state.major;
  var r = majorReq(u, state.major);
  var sys = SYSTEM_MAP()[u.country] || {};
  var abbr = u.abbr || (u.en || '').slice(0, 3);
  var qsText = u.qs != null ? 'QS ' + u.qs : 'QS —';

  return '<article class="uni-card' + (isFav ? ' is-fav' : '') + (isCmp ? ' is-cmp' : '') +
      '" data-id="' + esc(u.id) + '" tabindex="0" role="button">' +
    '<div class="uni-abbr" title="' + esc(u.name + ' · ' + (u.en || '')) + '">' +
      '<b>' + esc(abbr) + '</b></div>' +
    '<div class="uni-main">' +
      '<div class="uni-title">' +
        '<h3 class="uni-name">' + esc(u.name) + '</h3>' +
        '<span class="uni-qs">' + esc(qsText) + '</span>' +
        levelChipHTML(u) +
        (isFav ? '<span class="tag tag-fav">已收藏</span>' : '') +
      '</div>' +
      '<p class="uni-en">' + esc(u.en || '—') + ' · ' + esc(u.city || '') + '</p>' +
      (hasMajor
        ? '<div class="uni-req"><span class="req-label">' + esc(state.major) + '</span>' + reqHTML(u) + '</div>'
        : '<div class="uni-req">' + minLevelHTML(u) + '</div>') +
      (sys.kind === 'qualify' ? '<div class="sys-hint">' + esc(sys.note) + '</div>' : '') +
    '</div>' +
    '<div class="uni-side">' +
      '<div class="card-actions">' +
        '<button class="mini-btn fav' + (isFav ? ' on' : '') + '" data-act="fav" data-id="' + esc(u.id) + '">' +
          (isFav ? '★ 已收藏' : '☆ 收藏') + '</button>' +
        '<button class="mini-btn cmp' + (isCmp ? ' on' : '') + '" data-act="cmp" data-id="' + esc(u.id) + '">' +
          (isCmp ? '✓ 已加入对比' : '＋ 对比') + '</button>' +
      '</div>' +
    '</div>' +
  '</article>';
}

function emptyHTML(icon, title, desc) {
  return '<div class="empty-state"><div class="es-icon">' + icon + '</div>' +
    '<h3>' + esc(title) + '</h3><p>' + esc(desc) + '</p></div>';
}

function renderSystemNote(list) {
  var note = $('#systemNote');
  if (!list.length) { note.hidden = true; return; }
  var countries = {};
  list.forEach(function (u) { countries[u.country] = 1; });
  var notes = Object.keys(countries).map(function (c) {
    var s = SYSTEM_MAP()[c];
    return s && s.kind === 'qualify' ? c + '：' + s.note : null;
  }).filter(Boolean);
  if (!notes.length) { note.hidden = true; return; }
  note.hidden = false;
  note.innerHTML = '⚠️ 当前结果含<b>非等级择优</b>的录取体系 —— ' + notes.map(esc).join('；');
}

var listReplay = true;          // 首次渲染也播一次入场动画

function renderBrowse() {
  var all = UNIS();
  var list = queryList();
  var entering = listReplay;      // 是"换页/筛选后重出现"还是普通重绘
  $('#resultCount').textContent = list.length;
  $('#resultUnit').textContent = state.major
    ? ' 所大学 · ' + state.major
    : ' 所大学 · 未选专业（显示各校录取门槛）';
  renderSystemNote(list);

  if (!all.length) {
    $('#uniList').innerHTML = emptyHTML('📄', 'data.js 里还没有数据',
      '运行转换脚本生成 data.js 后刷新本页。');
    listReplay = false;
    return;
  }

  var replay = listReplay;
  listReplay = false;
  $('#uniList').innerHTML = list.length
    ? list.map(function (u, i) {
        return cardHTML(u).replace('<article class="uni-card',
          '<article style="--i:' + Math.min(i, 14) + '" class="uni-card' +
          (replay ? ' card-enter' : ''));
      }).join('')
    : emptyHTML('🔍', '没有符合要求的大学', '放宽筛选条件，或点「重置全部」再看看。');

  // 入场动画用 backwards 填充：结束状态即元素自身样式，
  // 因此只需在动画跑完后摘掉标记类（不清也能正常工作，这里只为保持 DOM 干净）
  if (replay) releaseCards();

  initScrollAnim();   // 重建滚动进场监听
}

var cardReleaseTimer = null;
function releaseCards() {
  if (cardReleaseTimer) window.clearTimeout(cardReleaseTimer);
  cardReleaseTimer = window.setTimeout(function () {
    $$('#uniList .card-enter').forEach(function (el) { el.classList.remove('card-enter'); });
    cardReleaseTimer = null;
  }, 1800);                  // 最后一档延迟 + 动画时长再留余量
}

function renderFavorites() {
  var list = UNIS().filter(function (u) { return state.favorites.has(u.id); });
  $('#favCount2').textContent = list.length;
  $('#favList').innerHTML = list.length
    ? list.map(cardHTML).join('')
    : emptyHTML('☆', '还没有收藏任何大学', '在列表或详情页点「☆ 收藏」，就会集中出现在这里。');
  var n = state.favorites.size, c = $('#favCount');
  c.textContent = n; c.hidden = n === 0;
}

/* ============================================================
 *  对比视图：手动添加大学（不受当前筛选限制）
 * ============================================================ */
/** 在当前筛选结果之外，按关键词找学校（供手动添加用） */
function searchAny(q) {
  var s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  return UNIS().filter(function (u) { return haystack(u).indexOf(s) > -1; });
}

/** 只重绘添加面板，避免输入框失焦 */
function renderAdd() {
  var panel = $('#addPanel');
  if (!panel) return;
  panel.hidden = !state.addOpen;
  var input = $('#addInput');
  if (document.activeElement !== input) input.value = state.addQuery;

  var picked = state.compare.size;
  var hint = $('#addHint');
  var results = $('#addResults');

  if (picked >= 4) {
    results.innerHTML = '<p class="muted">已选满 4 所。移除一所后可以继续添加。</p>';
    hint.textContent = '最多同时对比 4 所。';
    return;
  }
  hint.textContent = '不受当前筛选条件限制，可直接加入任意大学；已选 ' + picked + ' / 4 所。';

  var q = state.addQuery.trim();
  if (!q) {
    results.innerHTML = '<p class="muted">输入校名、英文名或城市开始搜索。</p>';
    return;
  }
  var hits = searchAny(q);
  if (!hits.length) {
    results.innerHTML = '<p class="muted">没有匹配「' + esc(q) + '」的大学。</p>';
    return;
  }
  results.innerHTML = hits.slice(0, 30).map(function (u) {
    var already = state.compare.has(u.id);
    return '<button type="button" class="add-item' + (already ? ' done' : '') +
        '" data-add="' + esc(u.id) + '"' + (already ? ' disabled' : '') + '>' +
      '<span class="ai-name">' + esc(u.name) + '</span>' +
      '<span class="ai-meta">' + esc(u.country) + (u.city ? ' · ' + esc(u.city) : '') +
        ' · QS ' + esc(u.qs != null ? u.qs : '—') + '</span>' +
      (already ? '<span class="ai-flag">已加入</span>' : '<span class="ai-flag">＋</span>') +
    '</button>';
  }).join('') + (hits.length > 30 ? '<p class="muted">仅显示前 30 条，继续输入可缩小范围。</p>' : '');
}

/** 手动把某校加入对比（绕过筛选条件） */
function addToCompare(id) {
  if (state.compare.has(id)) return;
  if (state.compare.size >= 4) { toast('最多同时对比 4 所'); return; }
  state.compare.add(id);
  state.addQuery = '';
  var input = $('#addInput');
  if (input) input.value = '';
  saveStore();
  render();                       // 重绘对比表 + 对比栏
  toast('已加入对比：' + nameOf(id));
  if (state.compare.size >= 4) toast('已选满 4 所');
}

/* ============================================================
 *  渲染：对比表（同一专业横向比）
 * ============================================================ */
function renderCompare() {
  var picked = UNIS().filter(function (u) { return state.compare.has(u.id); });
  $('#compareCount').textContent = picked.length;
  $('#compareMajor').textContent = state.major;
  var wrap = $('#compareTableWrap');

  if (picked.length < 2) {
    wrap.innerHTML = emptyHTML('⚖️', picked.length ? '再选一所就能对比' : '还没有选择对比的大学',
      '可以从列表里点「＋ 对比」，也可以用上面的「＋ 手动添加大学」直接搜索加入。');
    return;
  }

  var head = picked.map(function (u) {
    return '<th class="col-head">' + esc(u.name) +
      '<span class="cmp-sub">' + esc(u.country || '') + ' · QS ' + esc(u.qs != null ? u.qs : '—') + '</span></th>';
  }).join('');

  function row(label, fn) {
    return '<tr><th>' + esc(label) + '</th>' + picked.map(function (u) {
      return '<td>' + fn(u) + '</td>';
    }).join('') + '</tr>';
  }

  var rows = '';
  rows += row(state.major ? '录取门槛' : '录取门槛（该校最低档）', function (u) {
    var band = curBand(u);
    if (band == null) {
      return isUncertain(u) ? '<span class="pending">门槛待定</span>' : '<span class="pending">需查官网</span>';
    }
    var txt = curGrades(u) || BAND_LABEL[band];
    return '<span class="lv-chip lv-' + band + '">' + esc(txt) + '</span>';
  });
  if (state.major) {
    rows += row(state.major + ' 要求', function (u) { return reqHTML(u); });
  }
  rows += row('平均录取要求', function (u) {
    if (isUncertain(u)) return '<span class="pending">样本不足（' + (u.pointsAvgN || 0) + ' 个专业）</span>';
    if (typeof u.levelAvg === 'number') return esc('等级均分 ' + u.levelAvg + ' / 27');
    if (typeof u.pointsAvg === 'number') return esc('合计分均 ' + u.pointsAvg);
    return '<span class="pending">—</span>';
  });
  rows += row('录取体系', function (u) {
    var s = SYSTEM_MAP()[u.country];
    return esc(s ? s.note : '—');
  });
  rows += row('城市', function (u) { return esc(u.city || '—'); });
  rows += row('开设专业数', function (u) {
    var n = 0;
    MAJOR_LIST().forEach(function (m) {
      var r = majorReq(u, m);
      if (r && r.type === 'req') n++;
    });
    return esc(n + ' / ' + MAJOR_LIST().length);
  });

  wrap.innerHTML = '<table class="cmp"><thead><tr><th>对比项</th>' + head + '</tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
  if (listReplay) {
    wrap.classList.add('replay');
    listReplay = false;
  }
}

/* ============================================================
 *  视图切换
 * ============================================================ */
function renderTray() {
  var ids = Array.from(state.compare);
  $('#compareTray').hidden = ids.length === 0;
  $('#trayItems').innerHTML = ids.map(function (id) {
    return '<span class="tray-chip">' + esc(nameOf(id)) +
      '<button type="button" data-act="unpick" data-id="' + esc(id) + '" title="移出对比">✕</button></span>';
  }).join('');
  var run = $('#trayRun');
  run.disabled = ids.length < 2;
  run.textContent = ids.length < 2 ? '再选 1 所' : '开始对比 ' + ids.length + ' 所';
}

function render() {
  $$('#tabs .tab').forEach(function (t) { t.classList.toggle('on', t.dataset.view === state.view); });
  $$('.view').forEach(function (v) { v.hidden = true; });
  if (state.view === 'browse') { $('#viewBrowse').hidden = false; renderBrowse(); }
  else if (state.view === 'compare') { $('#viewCompare').hidden = false; renderCompare(); renderAdd(); }
  else { $('#viewFavorites').hidden = false; renderFavorites(); }

  var n = state.favorites.size, c = $('#favCount');
  c.textContent = n; c.hidden = n === 0;
  renderTray();
  renderFilters();
  renderGrade();
}

function setView(v) {
  state.view = v;
  listReplay = true;          // 换视图时让列表/表格播一次入场动画
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================================================
 *  详情弹窗
 * ============================================================ */
function reqDetailHTML(r) {
  if (!r || r.type === 'closed') return '<p class="detail-req closed">该校本科未开设此专业。</p>';
  if (r.type === 'check') return '<p class="detail-req check">需查官网 —— 本轮未在官网或权威来源查证到公开数据，未做猜测填充。</p>';
  var parts = String(r.text).split(/[；;]/).map(function (s) { return s.trim(); }).filter(Boolean);
  var first = parts.length > 1 ? parts[0] : null;
  var rest = parts.length > 1 ? parts.slice(1) : parts;
  return (first ? '<p class="detail-req-main">' + esc(first) + '</p>' : '') +
    '<ul class="req-list">' + rest.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
}

function openDetail(id, skipReset) {
  var u = UNIS().filter(function (x) { return x.id === id; })[0];
  if (!u) return;
  var modal = $('#modal');
  var flying = modal.classList.contains('flying-in');
  state.currentId = id;
  // 飞行/占位由调用方负责时不要在这里清掉（清了会让压制动画失效、占位被提前释放）
  if (!skipReset) resetModal();

  var mc0 = $('.modal-card');
  if (mc0) {
    mc0.style.animation = flying ? 'none'
      : 'modalIn var(--modal-dur) var(--ease-ios) both';
  }

  var sys = SYSTEM_MAP()[u.country] || {};
  var badges = [];
  badges.push('<span class="tag tag-brand">QS ' + esc(u.qs != null ? u.qs : '—') + '</span>');
  badges.push('<span class="tag">' + esc(u.country) + (u.city ? ' · ' + esc(u.city) : '') + '</span>');
  if (sys.kind === 'qualify') badges.push('<span class="tag tag-warn">非等级择优</span>');
  $('#detailBadges').innerHTML = badges.join('');
  $('#detailName').textContent = u.name;
  $('#detailEn').textContent = u.en || '';

  var html = '';

  // 当前专业（未选专业时给出引导）
  if (state.major) {
    var r = majorReq(u, state.major);
    html += '<section class="detail-section"><h3>当前专业 · ' + esc(state.major) + '</h3>' +
      reqDetailHTML(r) + '</section>';
  } else {
    html += '<section class="detail-section"><h3>当前专业 · 未选择</h3>' +
      '<p class="muted">在上面「筛选」面板里选一个专业，就会显示该校该专业的完整要求；' +
      '也可以直接点下面的专业矩阵。</p></section>';
  }

  // 学校信息
  var openCount = 0;
  MAJOR_LIST().forEach(function (m) {
    var rr = majorReq(u, m);
    if (rr && rr.type === 'req') openCount++;
  });
  html += '<section class="detail-section"><h3>学校信息</h3><div class="kv-grid">' +
    kv('国家 / 地区', u.country) + kv('城市', u.city) + kv('QS 2026', u.qs != null ? String(u.qs) : '') +
    kv('开设专业数', openCount + ' / ' + MAJOR_LIST().length) +
    kv('录取体系', sys.note || '') +
    '</div></section>';

  // 门槛判断依据（用户关心"凭什么说它门槛高/低"）
  var bandVal = curBand(u);
  var bandTxt;
  if (isUncertain(u)) {
    bandTxt = '待定（仅 ' + (u.pointsAvgN || 0) + ' 个专业有公开要求，样本太少）';
  } else if (bandVal != null) {
    bandTxt = BAND_LABEL[bandVal] + (u.sampleFew ? '（样本较少，仅供参考）' : '');
  } else {
    bandTxt = '需查官网';
  }
  var detailRows = [];
  detailRows.push(kv('门槛判断', bandTxt));
  if (typeof u.levelAvg === 'number') detailRows.push(kv('等级均分', u.levelAvg + ' / 27'));
  if (typeof u.levelMin === 'number') {
    detailRows.push(kv('最低的一档', u.levelMin + (u.levelMinMajor ? '（' + u.levelMinMajor + '）' : '')));
  }
  if (typeof u.pointsAvg === 'number') detailRows.push(kv('平均合计分', u.pointsAvg));
  if (typeof u.pointsMin === 'number') {
    detailRows.push(kv('最低合计分', u.pointsMin + (u.pointsMinMajor ? '（' + u.pointsMinMajor + '）' : '')));
  }
  html += '<section class="detail-section"><h3>录取强度</h3><div class="kv-grid">' +
    detailRows.join('') + '</div>' +
    '<p class="muted">门槛按「各专业平均要求」判断，且分档是<b>该国国内</b>的相对高低 —— ' +
    '同一个「门槛较高」在不同国家代表的绝对分数并不相同。</p></section>';

  // 热门专业
  html += hotMajorsHTML(u);

  // 全部专业（矩阵里直接给出精确等级，这是详情页的核心价值）
  html += '<section class="detail-section"><h3>全部 ' + MAJOR_LIST().length + ' 个专业的要求</h3>' +
    '<div class="major-matrix">' + MAJOR_LIST().map(function (m) {
      var rr = majorReq(u, m);
      var cls, label;
      if (rr.type === 'req') {
        var t = rr.grades || (typeof rr.points === 'number' ? rr.points + ' 分' : '');
        if (!t) {
          // 有要求但没解析出等级（多为德法体系或只有考试/面试要求）
          t = '按资格认定';
          cls = 'q';
        } else {
          // 选了专业时高亮为绿，未选专业时用普通深色（详情页始终可看等级）
          cls = (m === state.major) ? 'ok cur' : 'dc';
        }
        label = t;
      } else if (rr.type === 'closed') {
        cls = 'no'; label = '未开设';
      } else {
        cls = 'q'; label = '需查官网';
      }
      var cur = m === state.major ? ' cur' : '';
      return '<button type="button" class="mx ' + cls + cur + '" data-major="' + esc(m) + '"' +
        ' title="' + esc(m + '：' + label) + '">' +
        '<span class="mx-name">' + esc(m) + '</span>' +
        '<span class="mx-val">' + esc(label) + '</span></button>';
    }).join('') + '</div>' +
    '<p class="muted">点任意专业可切换查看完整要求（含必选科目、笔试、面试等）。</p></section>';

  $('#detailBody').innerHTML = html;
  $('#detailBody').scrollTop = 0;
  syncDetailButtons();
  $('#modal').hidden = false;
  document.body.classList.add('no-scroll');
}

function kv(label, value) {
  var blank = isBlank(value);
  return '<div class="kv"><div class="k">' + esc(label) + '</div><div class="v' +
    (blank ? ' pending' : '') + '">' + (blank ? '待填充' : esc(value)) + '</div></div>';
}

function syncDetailButtons() {
  var id = state.currentId;
  if (!id) return;
  var fav = state.favorites.has(id), cmp = state.compare.has(id);
  var fb = $('#detailFav');
  fb.textContent = fav ? '★ 已收藏' : '☆ 收藏';
  fb.classList.toggle('on', fav);
  var cb = $('#detailCompare');
  cb.textContent = cmp ? '✓ 已加入对比' : '＋ 对比';
  cb.classList.toggle('on', cmp);
}

/** 回到「可打开」的初始状态：清掉飞行/关闭动画残留 */
function resetModal() {
  var modal = $('#modal');
  if (!modal) return;
  clearFlightTimers();
  modal.classList.remove('closing');
  modal.hidden = false;              // 先解除 hidden，避免 display:none 打断动画
}

/* ============================================================
 *  动作
 * ============================================================ */
/* ============================================================
 *  局部更新：卡片上的收藏/对比状态
 *  整表重建会打断悬停与进行中的动画（视觉上就是"闪一下"），
 *  所以点收藏/对比时只改对应卡片的按钮与类名
 * ============================================================ */
function updateCardState(id) {
  var slot = $('#viewBrowse').hidden ? '#favList' : '#uniList';
  var card = $(slot + ' .uni-card[data-id="' + id + '"]');
  if (!card) return;

  var isFav = state.favorites.has(id);
  var isCmp = state.compare.has(id);
  card.classList.toggle('is-fav', isFav);
  card.classList.toggle('is-cmp', isCmp);

  var fav = card.querySelector('[data-act="fav"]');
  if (fav) {
    var wasOn = fav.classList.contains('on');
    fav.classList.toggle('on', isFav);
    fav.textContent = isFav ? '★ 已收藏' : '☆ 收藏';
    if (wasOn !== isFav) restartAnim(fav);
  }
  var cmp = card.querySelector('[data-act="cmp"]');
  if (cmp) {
    var wasCmp = cmp.classList.contains('on');
    cmp.classList.toggle('on', isCmp);
    cmp.textContent = isCmp ? '✓ 已加入对比' : '＋ 对比';
    if (wasCmp !== isCmp) restartAnim(cmp);
  }

  // 卡片内"已收藏"小标签
  var nameEl = card.querySelector('.uni-name');
  var tag = nameEl && nameEl.querySelector('.tag-fav');
  if (isFav && !tag) nameEl.insertAdjacentHTML('beforeend', ' <span class="tag tag-fav">已收藏</span>');
  else if (!isFav && tag) tag.remove();

  // 顶部数字
  var n = state.favorites.size, c = $('#favCount');
  if (c) { c.textContent = n; c.hidden = n === 0; }
}

/** 重播一次弹跳动画（同一元素连续切换时也能触发） */
function restartAnim(el) {
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
  window.setTimeout(function () { el.classList.remove('pop'); }, 520);
}

function toggleFavorite(id) {
  var adding = !state.favorites.has(id);
  if (adding) state.favorites.add(id);
  else state.favorites.delete(id);
  saveStore();
  toast(adding ? '已收藏「' + nameOf(id) + '」' : '已取消收藏');
  updateCardState(id);
  syncDetailButtons();
  // 收藏页里取消收藏 → 条目要从列表移除
  if (state.view === 'favorites') renderFavorites();
  refreshTrayAndSummary();
}

function toggleCompare(id) {
  if (state.compare.has(id)) {
    state.compare.delete(id);
    toast('已移出对比');
  } else {
    if (state.compare.size >= 4) { toast('最多同时对比 4 所'); return; }
    state.compare.add(id);
    toast('已加入对比（' + state.compare.size + ' 所）');
  }
  saveStore();
  updateCardState(id);
  syncDetailButtons();
  renderTray();
  if (state.view === 'compare') renderCompare();
}

/** 只刷新对比栏、筛选角标与摘要（不重建列表） */
function refreshTrayAndSummary() {
  renderTray();
  var n = activeFilterCount();
  var badge = $('#filterBadge');
  if (badge) { badge.textContent = n; badge.hidden = n === 0; }
}

var toastTimer = null;
function toast(msg) {
  var el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 1900);
}

function applyTheme() {
  // 只保留暗色模式（取消日间切换）：配色统一，也少一套样式计算
  state.theme = 'dark';
  document.documentElement.setAttribute('data-theme', 'dark');
  var icon = $('#themeIcon'), label = $('#themeLabel');
  if (icon) icon.textContent = '☾';
  if (label) label.textContent = '夜间';
}

/* ============================================================
 *  事件
 * ============================================================ */
function bind() {
  var input = $('#searchInput');
  input.addEventListener('input', function () {
    state.query = input.value;
    $('#searchClear').hidden = !input.value;
    if (state.view !== 'browse') state.view = 'browse';
    render();
  });
  $('#searchClear').addEventListener('click', function () {
    input.value = ''; state.query = ''; $('#searchClear').hidden = true; render(); input.focus();
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && input.value) {
      input.value = ''; state.query = ''; $('#searchClear').hidden = true; render();
    }
  });

  /* 筛选按钮 */
  $('#filterToggle').addEventListener('click', function () {
    var p = $('#filterPanel');
    p.hidden = !p.hidden;
    $('#filterToggle').classList.toggle('active', !p.hidden || activeFilterCount() > 0);
  });

  /* 筛选面板内的所有点击：专业 / 国家 / QS / 门槛 / 重置 / 隐藏需查官网 */
  $('#filterPanel').addEventListener('click', function (e) {
    var reset = closestEl(e.target, '#resetFilters');
    if (reset) {
      playListChange(function () {
        state.filters = {};
        state.levelFilter = null;
        state.myGrade = null;
        state.hideCheck = false;
        state.major = '';                 // 专业也一起清空（回到「未选专业」）
        saveStore();
      });
      toast('已重置筛选条件');
      return;
    }
    var chip = closestEl(e.target, '.chip');
    if (!chip) return;
    var key = chip.dataset.fkey;

    playListChange(function () {
      if (key === 'major') {
        // 专业单选
        state.major = chip.dataset.fvalue;
      } else if (key === 'level') {
        var lv = Number(chip.dataset.fvalue);
        state.levelFilter = state.levelFilter === lv ? null : lv;
      } else {
        var value = String(chip.dataset.fvalue);
        if (!state.filters[key]) state.filters[key] = new Set();
        var set = state.filters[key];
        if (set.has(value)) set.delete(value); else set.add(value);
        if (!set.size) delete state.filters[key];
      }
      if (state.view !== 'browse') state.view = 'browse';
      saveStore();
    });
  });

  /* 面板里的「隐藏需查官网」 */
  $('#filterPanel').addEventListener('change', function (e) {
    if (e.target && e.target.id === 'hideCheck') {
      var on = e.target.checked;
      playListChange(function () { state.hideCheck = on; saveStore(); });
    }
  });

  /* 摘要条上的单项清除 */
  $('#activeSummary').addEventListener('click', function (e) {
    var x = closestEl(e.target, '[data-clear]');
    if (x) { clearOne(x.dataset.clear); return; }
    if (closestEl(e.target, '#sumReset')) {
      playListChange(function () {
        state.filters = {};
        state.levelFilter = null;
        state.myGrade = null;
        state.hideCheck = false;
        saveStore();
      });
    }
  });

  $('#gradeSelect').addEventListener('change', function () {
    var v = this.value === '' ? null : Number(this.value);
    playListChange(function () { state.myGrade = v; saveStore(); });
  });

  $('#tabs').addEventListener('click', function (e) {
    var t = closestEl(e.target, '.tab');
    if (t) setView(t.dataset.view);
  });

  $('#sortSelect').addEventListener('change', function () {
    var v = this.value;
    playListChange(function () { state.sort = v; });
  });

  function listClick(e) {
    if (closestEl(e.target, '.tray-actions')) return;
    var actBtn = closestEl(e.target, '[data-act]');
    if (actBtn) {
      e.stopPropagation();
      var id = actBtn.dataset.id;
      if (actBtn.dataset.act === 'fav') toggleFavorite(id);
      else if (actBtn.dataset.act === 'cmp') toggleCompare(id);
      else if (actBtn.dataset.act === 'unpick') { toggleCompare(id); }
      return;
    }
    var card = closestEl(e.target, '.uni-card');
    if (card) openDetailFrom(card, card.dataset.id);
  }
  ['#uniList', '#favList', '#compareTray'].forEach(function (sel) { $(sel).addEventListener('click', listClick); });
  ['#uniList', '#favList'].forEach(function (sel) {
    $(sel).addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = closestEl(e.target, '.uni-card');
      if (card) { e.preventDefault(); openDetailFrom(card, card.dataset.id); }
    });
  });

  $('#trayRun').addEventListener('click', function () {
    if (state.compare.size < 2) { toast('至少选择 2 所大学'); return; }
    setView('compare');
  });
  $('#trayClear').addEventListener('click', function () { state.compare.clear(); saveStore(); render(); });

  /* 对比页：手动添加大学 */
  $('#addToggle').addEventListener('click', function () {
    state.addOpen = !state.addOpen;
    renderAdd();
    if (state.addOpen) $('#addInput').focus();
  });
  $('#addInput').addEventListener('input', function () {
    state.addQuery = this.value;
    renderAdd();
  });
  $('#addInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      // 回车加入第一所搜索结果
      var first = $('#addResults .add-item:not([disabled])');
      if (first) { addToCompare(first.dataset.add); }
      else { toast('没有可添加的结果'); }
    } else if (e.key === 'Escape') {
      state.addOpen = false;
      state.addQuery = '';
      this.value = '';
      renderAdd();
    }
  });
  $('#addResults').addEventListener('click', function (e) {
    var item = closestEl(e.target, '[data-add]');
    if (item && !item.disabled) addToCompare(item.dataset.add);
  });
  $('#backToBrowse').addEventListener('click', function () { setView('browse'); });
  $('#favBack').addEventListener('click', function () { setView('browse'); });
  $('#clearFav').addEventListener('click', function () {
    if (!state.favorites.size) return;
    state.favorites.clear(); saveStore(); render(); toast('已清空收藏');
  });

  // 详情弹窗：切换专业
  $('#detailBody').addEventListener('click', function (e) {
    var mx = closestEl(e.target, '[data-major]');
    if (!mx) return;
    state.major = mx.dataset.major;
    saveStore();
    openDetail(state.currentId);
  });
  $('#detailClose').addEventListener('click', closeDetailToCard);
  $('#modal').addEventListener('click', function (e) {
    if (e.target.dataset && e.target.dataset.close === '1') closeDetailToCard();
  });
  $('#detailFav').addEventListener('click', function () { if (state.currentId) toggleFavorite(state.currentId); });
  $('#detailCompare').addEventListener('click', function () { if (state.currentId) toggleCompare(state.currentId); });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('#modal').hidden) closeDetailToCard();
    else if (!$('#filterPanel').hidden) { $('#filterPanel').hidden = true; renderFilters(); }
    else if (state.view !== 'browse') setView('browse');
  });

  var themeBtn = $('#themeBtn');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    // 已取消日间模式：按钮在界面上隐藏，这里保留兜底不做切换
    applyTheme();
  });
}

/* ============================================================
 *  启动
 * ============================================================ */
(function init() {
  loadStore();
  pruneStored();
  applyTheme();

  if (!MAJOR_LIST().length) state.major = '';
  $('#dataCount').textContent = UNIS().length + ' 所大学 · ' + MAJOR_LIST().length + ' 个专业';
  var meta = META_INFO();
  if (meta.source) $('#footNote').textContent = '数据源：' + meta.source;
  $('#sortSelect').value = state.sort;
  $('#gradeSelect').value = state.myGrade == null ? '' : String(state.myGrade);
  $('#addInput').value = state.addQuery;
  bind();
  render();

  window.__UF_STARTED = true;
  var gate = document.getElementById('noScript');
  if (gate) gate.hidden = true;
})();
