/* 말문 — 앱 로직. 외부 라이브러리 없음. 기록은 이 기기(localStorage)에만 저장. */
(function () {
  "use strict";

  var SITUATIONS = ["친구 모임", "어른·선배", "처음 만난 사람", "직장·학교", "손님·고객"];
  var FIELDS = ["날씨·생활", "스포츠", "음악·K팝", "영화·드라마", "IT·과학", "음식", "경제·돈", "동물·신기한 이야기"];
  // 시·도별 대표 좌표 (날씨 조회용)
  var REGIONS = [["서울", 37.57, 126.98], ["경기", 37.29, 127.01], ["인천", 37.46, 126.71], ["강원", 37.88, 127.73], ["충북", 36.64, 127.49], ["충남", 36.66, 126.67], ["대전", 36.35, 127.38], ["세종", 36.48, 127.29], ["전북", 35.82, 127.15], ["전남", 34.82, 126.46], ["광주", 35.16, 126.85], ["경북", 36.57, 128.73], ["경남", 35.24, 128.69], ["대구", 35.87, 128.60], ["울산", 35.54, 129.31], ["부산", 35.18, 129.08], ["제주", 33.50, 126.53]];
  var REACTIONS = { good: "웃었다", ok: "그냥", bad: "썰렁" };
  var STORE_KEY = "malmun:v1";
  var $app = document.getElementById("app");
  var $toast = document.getElementById("toast");

  // ---------- 저장소 ----------
  var state = load();
  function load() {
    var base = { onboarded: false, situations: ["친구 모임", "처음 만난 사람"], interests: [], region: "", weather: null, tone: "banmal", strength: "safe",
      notify: false, notifyTime: "07:00", logs: [], done: {}, drafts: {}, lastData: null };
    try { var raw = localStorage.getItem(STORE_KEY); if (raw) return Object.assign(base, JSON.parse(raw)); } catch (e) {}
    return base;
  }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }

  // ---------- 유틸 ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function toast(msg) { $toast.textContent = msg; $toast.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(function () { $toast.classList.remove("show"); }, 1800); }
  function todayStr(d) { d = d || new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function fmtDate(iso) { var p = iso.split("-"); var d = new Date(+p[0], +p[1] - 1, +p[2]); var w = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()]; return (+p[1]) + "월 " + (+p[2]) + "일 " + w + "요일"; }
  function fmtShort(iso) { var p = iso.split("-"); return (+p[1]) + "월 " + (+p[2]) + "일"; }
  function greeting() { var h = new Date().getHours(); if (h < 11) return "좋은 아침이에요"; if (h < 17) return "오늘도 한마디면 충분해요"; return "오늘 하루 어땠어요?"; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function weekStart(d) { d = new Date(d); var day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d; }
  function countInRange(from, to) { return state.logs.filter(function (l) { var t = new Date(l.ts); return t >= from && t < to; }).length; }
  function primarySituation() { return state.situations[0] || SITUATIONS[0]; }
  function fieldOf(o) { return o.field || o.tag || o.topic || ""; }
  function isInterest(o) { return state.interests.indexOf(fieldOf(o)) >= 0; }
  function isWeather(o) { var f = fieldOf(o) + " " + (o.topic || ""); return o.local || /날씨|기온|더위|추위|장마|폭염|한파|비 오|비오|눈 오/.test(f); }
  // 관심 분야를 앞으로, 그 뒤에 나머지. 원래 순서는 유지.
  function rankByInterest(list) {
    if (!state.interests.length) return list.slice();
    return list.filter(isInterest).concat(list.filter(function (o) { return !isInterest(o); }));
  }
  // 오늘의 한마디: 날씨가 아닌 것 중에서, 관심 분야 우선, 날짜에 따라 돌아가며.
  function pickToday(list) {
    var pool = list.filter(function (o) { return !isWeather(o); });
    if (!pool.length) pool = list.filter(function (o) { return !o.local; });
    if (!pool.length) return list[0] || null;
    var ranked = rankByInterest(pool);
    var top = state.interests.length ? ranked.filter(isInterest) : [];
    if (!top.length) top = ranked;
    var seed = parseInt((dataDate || "").replace(/-/g, ""), 10) || 0;
    return top[seed % top.length];
  }
  // 오늘의 새 소재: 관심 밖 분야 하나 (날짜로 돌아가며 고름)
  function pickFresh(list) {
    var out = list.filter(function (o) { return !isInterest(o) && !isWeather(o); });
    if (!out.length) return null;
    var seed = parseInt((dataDate || "").replace(/-/g, ""), 10) || 0;
    return out[seed % out.length];
  }

  // ---------- 데이터 ----------
  var data = null, dataDate = null, dataWarning = "";
  function fetchJSON(url) { return fetch(url, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  function loadData() {
    return fetchJSON("data/index.json").then(function (idx) {
      if (!idx.latest) throw new Error("no-data");
      var date = idx.latest;
      var name = state.tone + "-" + state.strength;
      return fetchJSON("data/" + date + "/" + name + ".json").catch(function () { return fetchJSON("data/" + date + "/banmal-safe.json"); })
        .then(function (d) { data = d; dataDate = date; state.lastData = d; save(); });
    }).catch(function () {
      if (state.lastData) { data = state.lastData; dataDate = data.date; dataWarning = "인터넷에 연결되지 않아 마지막으로 받은 내용을 보여 드려요."; }
      else { data = null; }
    });
  }

  // ---------- 내 지역 날씨 (open-meteo, 무료, 키 없음) ----------
  function loadWeather() {
    var r = REGIONS.filter(function (x) { return x[0] === state.region; })[0];
    if (!r) { state.weather = null; return Promise.resolve(); }
    var td = todayStr();
    if (state.weather && state.weather.date === td && state.weather.region === state.region) return Promise.resolve();
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + r[1] + "&longitude=" + r[2] + "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=Asia%2FSeoul&forecast_days=2";
    return fetch(url).then(function (x) { return x.json(); }).then(function (j) {
      var d = j.daily;
      state.weather = { date: td, region: state.region, hi: Math.round(d.temperature_2m_max[0]), lo: Math.round(d.temperature_2m_min[0]), rain: d.precipitation_probability_max[0], code: d.weather_code[0],
        tomorrowHi: Math.round(d.temperature_2m_max[1]), tomorrowLo: Math.round(d.temperature_2m_min[1]) };
      save();
    }).catch(function () {});
  }
  function weatherWord(code) { if (code == null) return ""; if (code === 0) return "맑음"; if (code <= 3) return "구름"; if (code <= 48) return "안개"; if (code <= 67) return "비"; if (code <= 77) return "눈"; if (code <= 82) return "소나기"; if (code <= 86) return "눈"; return "천둥번개"; }
  // 내 지역 날씨로 만든 한마디 (AI 없이 템플릿)
  function weatherCond(w) {
    if (w.rain >= 60) return "rain";
    if (Math.abs(w.hi - w.tomorrowHi) >= 5) return "swing";
    if (w.hi >= 28) return "hot";
    if (w.lo <= 5) return "cold";
    return "mild";
  }
  function fillWeather(t, w) {
    return String(t).replace(/\{지역\}/g, w.region).replace(/\{최고\}/g, w.hi).replace(/\{최저\}/g, w.lo).replace(/\{비확률\}/g, w.rain).replace(/\{내일최고\}/g, w.tomorrowHi).replace(/\{날씨\}/g, weatherWord(w.code));
  }
  function weatherOpener() {
    var w = state.weather; if (!w) return null;
    var jondae = state.tone === "jondae";
    // 오늘 생성된 날씨 문장 틀이 있으면 그걸 쓴다 (날짜로 돌아가며 선택). 없으면 아래 기본 틀.
    var cond = weatherCond(w);
    var tpls = ((data && data.weather_templates) || []).filter(function (t) { return t.cond === cond && t.text; });
    if (tpls.length) {
      var seed = parseInt((dataDate || "").replace(/-/g, ""), 10) || 0;
      var t = tpls[seed % tpls.length];
      return { field: "날씨·생활", topic: "내 지역 날씨", safety: "가장 안전", text: fillWeather(t.text, w), explain: fillWeather(t.explain || "", w), local: true };
    }
    var text, explain;
    if (w.rain >= 60) {
      text = jondae ? "오늘 " + w.region + "에 비 올 확률이 " + w.rain + "%래요. 우산 챙기셨어요?" : "오늘 " + w.region + " 비 올 확률 " + w.rain + "%래. 우산 챙겼어?";
      explain = "오늘 " + w.region + " 낮 최고 " + w.hi + "도, 비 올 확률 " + w.rain + "%" + (jondae ? "예요." : "야.");
    } else if (w.tomorrowHi - w.hi <= -5 || w.hi - w.tomorrowHi >= 5) {
      text = jondae ? "오늘 " + w.region + "는 " + w.hi + "도인데 내일은 " + w.tomorrowHi + "도래요. 옷 고르기 어렵네요." : "오늘 " + w.region + " " + w.hi + "도인데 내일은 " + w.tomorrowHi + "도래. 뭐 입어야 되냐.";
      explain = "하루 사이에 " + Math.abs(w.hi - w.tomorrowHi) + "도 차이" + (jondae ? "가 나요." : "가 나.");
    } else if (w.hi >= 28) {
      text = jondae ? "오늘 " + w.region + " " + w.hi + "도까지 간대요. 아직 여름이죠?" : "오늘 " + w.region + " " + w.hi + "도래. 아직 여름 아니냐?";
      explain = "오늘 " + w.region + " 낮 최고 " + w.hi + "도" + (jondae ? "예요." : "야.");
    } else if (w.lo <= 5) {
      text = jondae ? "오늘 아침 " + w.region + "가 " + w.lo + "도였대요. 겉옷 챙기셨어요?" : "오늘 아침 " + w.region + " " + w.lo + "도였대. 겉옷 챙겼어?";
      explain = "오늘 " + w.region + " 최저 " + w.lo + "도, 최고 " + w.hi + "도" + (jondae ? "예요." : "야.");
    } else {
      text = jondae ? "오늘 " + w.region + "는 " + w.hi + "도에 " + weatherWord(w.code) + "이래요. 나가기 좋은 날이죠?" : "오늘 " + w.region + " " + w.hi + "도에 " + weatherWord(w.code) + "이래. 나가기 딱 좋네.";
      explain = "오늘 " + w.region + " 최고 " + w.hi + "도, 최저 " + w.lo + "도" + (jondae ? "예요." : "야.");
    }
    return { field: "날씨·생활", topic: "내 지역 날씨", safety: "가장 안전", text: text, explain: explain, local: true };
  }
  // 자리별 목록에 내 지역 날씨 한마디를 앞에 끼워 넣는다 (AI가 쓴 날씨 한마디는 뒤로)
  // 목록 순서: 오늘의 한마디 → 내 지역 날씨 → 나머지(관심 우선) → AI가 쓴 날씨
  function withLocalWeather(list) {
    var w = weatherOpener();
    var today = pickToday(list);
    var rest = list.filter(function (o) { return o !== today && !isWeather(o); });
    var ai = list.filter(function (o) { return o !== today && isWeather(o); });
    return (today ? [today] : []).concat(w ? [w] : [], rankByInterest(rest), ai);
  }

  // ---------- 아이콘 ----------
  var I = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    talk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h14v16H5z"/><path d="M9 9h6M9 13h6M9 17h3"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.4H19l-4.3 3.2 1.7 5.4L12 13.8 7.6 17l1.7-5.4L5 8.4h5.2z"/></svg>',
    q: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5"/><path d="M12 17h.01"/></svg>',
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="#1B2231" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h13v9H9l-5 4z"/><path d="M20 10v7"/></svg>'
  };

  function tabbar(active) {
    var tabs = [["home", "홈", I.home], ["world", "세상", I.globe], ["talk", "대화", I.talk], ["practice", "연습", I.pen], ["log", "기록", I.log]];
    return '<nav class="tabbar five" aria-label="주 메뉴">' + tabs.map(function (t) {
      return '<a href="#' + t[0] + '"' + (active === t[0] ? ' class="on" aria-current="page"' : "") + ">" + t[2] + t[1] + "</a>";
    }).join("") + "</nav>";
  }

  // ---------- 라우터 ----------
  var views = {};
  function route() {
    var hash = (location.hash || "#home").slice(1).split("/")[0];
    if (!state.onboarded && hash !== "onboarding" && hash !== "privacy") { location.hash = "#onboarding"; return; }
    var v = views[hash] || views.home;
    $app.innerHTML = "";
    $app.appendChild(v());
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  function el(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  // ---------- 온보딩 ----------
  var obStep = 1;
  views.onboarding = function () {
    var picked = state.situations.slice();
    var pickedF = state.interests.slice();
    var step1 = obStep === 1, step3 = obStep === 3;
    var pickedR = state.region;
    var v = el('<div class="view dark">' +
      '<div class="row" style="gap:10px"><div style="width:34px;height:34px;border-radius:10px;background:var(--accent);display:flex;align-items:center;justify-content:center">' + I.logo.replace('viewBox', 'width="20" height="20" viewBox') + '</div><div class="display" style="font-size:1.25rem">말문</div></div>' +
      '<div style="flex:1 1 auto;display:flex;flex-direction:column;justify-content:center;gap:18px;padding:24px 0">' +
        '<div class="eyebrow" style="color:var(--card-dark-accent)">' + obStep + ' / 3</div>' +
        (step1
          ? '<h1 class="display" style="font-size:2rem;line-height:1.35;font-weight:400">사람을 만나면<br>무슨 말을 해야 할지<br>막막한가요?</h1>' +
            '<p style="color:var(--card-dark-muted);line-height:1.7">말문은 매일 아침, 그날 쓸 수 있는 한마디를 준비해 둬요. 외우는 게 아니라 꺼내 보는 연습이에요.<br>하루에 할 일은 딱 하나. 점수도, 틀린 답도 없어요.</p>'
          : step3
          ? '<h1 class="display" style="font-size:2rem;line-height:1.35;font-weight:400">어디에<br>살고 계세요?</h1>' +
            '<p style="color:var(--card-dark-muted);line-height:1.7">내 지역 날씨로 한마디를 만들어 드려요. 날씨는 누구와도 안전한 첫마디예요. 안 골라도 괜찮아요.</p>'
          : '<h1 class="display" style="font-size:2rem;line-height:1.35;font-weight:400">어떤 이야기가<br>조금이라도<br>편한가요?</h1>' +
            '<p style="color:var(--card-dark-muted);line-height:1.7">고른 분야의 한마디를 먼저 보여 드려요. 매일 하나씩은 다른 분야도 슬쩍 끼워 넣을게요. 화제가 넓어지는 건 그렇게 시작돼요.</p>') +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:12px">' +
        '<div class="small" style="color:#AAB4C3">' + (step1 ? "주로 어떤 자리에서 어려우세요? (여러 개 가능)" : step3 ? "사는 지역 (하나)" : "관심 분야 2~3개를 골라 주세요. 없으면 건너뛰어도 돼요.") + '</div>' +
        '<div class="chips" id="ob-chips"></div>' +
        '<div class="row" style="flex-wrap:nowrap;margin-top:6px">' + (step1 ? "" : '<button class="btn ghost onDark" id="ob-back" style="white-space:nowrap;min-width:72px">이전</button>') + '<button class="btn big light grow" id="ob-start">' + (step3 ? "시작하기" : "다음") + '</button></div>' +
        '<div class="xs" style="text-align:center;color:#8E99AB">회원가입 없이 바로 시작해요. 기록은 이 기기에만 저장돼요. <a href="#privacy" style="color:#C6CEDB">개인정보 처리방침</a></div>' +
      '</div></div>');
    var chips = v.querySelector("#ob-chips");
    var items = step1 ? SITUATIONS : step3 ? REGIONS.map(function (r) { return r[0]; }) : FIELDS;
    var sel = step1 ? picked : step3 ? (pickedR ? [pickedR] : []) : pickedF;
    function draw() {
      chips.innerHTML = items.map(function (s) { return '<button class="chip' + (sel.indexOf(s) >= 0 ? " on" : "") + '" data-s="' + esc(s) + '">' + esc(s) + "</button>"; }).join("");
    }
    draw();
    chips.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      var s = b.dataset.s, i = sel.indexOf(s);
      if (step3) { sel.length = 0; if (i < 0) sel.push(s); pickedR = sel[0] || ""; }
      else if (i >= 0) sel.splice(i, 1); else sel.push(s);
      draw();
    });
    var back = v.querySelector("#ob-back");
    if (back) back.addEventListener("click", function () {
      if (step3) state.region = pickedR; else state.interests = FIELDS.filter(function (f) { return pickedF.indexOf(f) >= 0; });
      save(); obStep -= 1; route();
    });
    v.querySelector("#ob-start").addEventListener("click", function () {
      if (step1) {
        if (!picked.length) { toast("하나만 골라 주세요"); return; }
        state.situations = SITUATIONS.filter(function (s) { return picked.indexOf(s) >= 0; }); save();
        obStep = 2; route(); return;
      }
      if (!step3) { state.interests = FIELDS.filter(function (f) { return pickedF.indexOf(f) >= 0; }); save(); obStep = 3; route(); return; }
      state.region = pickedR; state.onboarded = true; save();
      obStep = 1;
      loadWeather().then(function () { location.hash = "#home"; route(); });
    });
    return v;
  };

  // ---------- 홈 ----------
  views.home = function () {
    if (!data) return noData("home");
    var sit = primarySituation();
    var pool = (data.openers && data.openers[sit]) || [];
    var opener = pickToday(pool);
    var fresh = pickFresh(pool);
    var line = opener ? { text: opener.text, why: fieldOf(opener) + (opener.safety ? " · " + opener.safety : ""), explain: opener.explain, situation: sit } : data.today;
    var td = todayStr();
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    var monthCount = countInRange(monthStart, new Date(8640000000000000));
    var done = !!state.done[td];

    var v = el('<div class="view">' +
      '<div class="between" style="align-items:flex-end">' +
        '<div><div class="small muted">' + esc(fmtDate(dataDate)) + '</div><div class="display" style="font-size:1.6rem;line-height:1.3">' + esc(greeting()) + '</div></div>' +
        '<a class="pill" href="#log" aria-label="이번 달 기록 보기">' + I.star.replace('viewBox', 'width="14" height="14" viewBox') + ' 이번 달 ' + monthCount + '번</a>' +
      '</div>' +
      (dataWarning ? '<div class="note">' + esc(dataWarning) + '</div>' : "") +
      (dataDate !== td ? '<div class="note">오늘 내용이 아직 준비되지 않아 ' + esc(fmtShort(dataDate)) + ' 내용을 보여 드려요.</div>' : "") +
      (state.weather ? '<div class="small muted">오늘 ' + esc(state.weather.region) + ' ' + state.weather.lo + '~' + state.weather.hi + '도 · ' + esc(weatherWord(state.weather.code)) + (state.weather.rain >= 30 ? ' · 비 ' + state.weather.rain + '%' : '') + '</div>' : "") +
      '<div class="card hero">' +
        '<div class="meta"><span class="eyebrow">오늘의 한마디</span><span>' + esc(line.situation || sit) + '</span></div>' +
        '<div class="line">"' + esc(line.text) + '"</div>' +
        (line.why ? '<div class="why">' + esc(line.why) + '</div>' : "") +
        (line.explain ? '<div class="explain"><b>상대가 모르면</b> ' + esc(line.explain) + '</div>' : "") +
        '<div class="row" style="margin-top:2px;flex-wrap:nowrap"><a class="btn grow" href="#quick">말할 준비</a><a class="btn ghost onDark" href="#talk">대화 보기</a></div>' +
      '</div>' +
      '<div class="card task">' +
        '<button class="check' + (done ? " on" : "") + '" id="home-done" aria-pressed="' + done + '" aria-label="오늘 할 것 완료 표시">' + (done ? I.check : "") + '</button>' +
        '<div style="min-width:0"><div style="font-weight:600">오늘 할 것은 하나예요</div><div class="small muted">' + (done ? "오늘은 꺼냈어요. 그걸로 충분해요." : "한 사람에게 저 한마디를 꺼내 보기. 반응은 중요하지 않아요.") + '</div></div>' +
      '</div>' +
      (fresh && fresh !== opener ? '<div class="card" style="display:flex;flex-direction:column;gap:4px"><div class="row" style="justify-content:space-between"><span class="eyebrow">오늘의 새 소재</span><span class="tag">' + esc(fieldOf(fresh)) + '</span></div><div style="font-size:0.95rem">"' + esc(fresh.text) + '"</div><div class="xs muted">관심 분야 밖에서 하나. 안 써도 괜찮아요. 알아만 두세요.</div></div>' : "") +
      '<a class="small muted" href="#quick" style="text-align:center;font-weight:500">다른 자리, 다른 한마디 보기</a>' +
      '<div style="flex:1 1 auto"></div>' + tabbar("home") + '</div>');
    v.querySelector("#home-done").addEventListener("click", function () {
      if (state.done[td]) { delete state.done[td]; save(); route(); return; }
      openReaction(line.text, line.situation || sit);
    });
    return v;
  };

  // ---------- 만나기 30초 전 ----------
  var quickSit = null, quickPick = 0;
  views.quick = function () {
    if (!data) return noData("quick");
    var sits = state.situations.length ? state.situations : SITUATIONS;
    if (!quickSit || sits.indexOf(quickSit) < 0) quickSit = sits[0];
    var list = withLocalWeather((data.openers && data.openers[quickSit]) || []);
    if (quickPick >= list.length) quickPick = 0;
    var fq = data.fallback_question || { text: "요즘 뭐가 제일 재밌어?", why: "질문을 받으면 사람은 대부분 이야기를 시작해요." };

    var v = el('<div class="view">' +
      '<div class="topbar"><a class="iconbtn" href="#home" aria-label="홈으로">' + I.back + '</a><div><div class="title">말하기 전에</div><div class="sub">하나만 고르고, 말해 본 뒤 아래 버튼을 눌러요. 반응은 상관없어요.</div></div></div>' +
      '<div class="chips scroll" id="q-sits">' + SITUATIONS.map(function (s) { return '<button class="chip' + (s === quickSit ? " on" : "") + '" data-s="' + esc(s) + '">' + esc(s) + '</button>'; }).join("") + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px"><div class="eyebrow">꺼낼 말 하나</div><div class="list" id="q-list">' +
        list.map(function (o, i) {
          return '<button class="opener' + (i === quickPick ? " on" : "") + '" data-i="' + i + '" aria-pressed="' + (i === quickPick) + '">' +
            '<span class="head"><span>' + esc(fieldOf(o)) + (o.safety ? " · " + esc(o.safety) : "") + (o.local ? " · 내 지역" : isInterest(o) ? " · 관심" : "") + '</span>' + (i === quickPick ? I.check.replace('viewBox', 'width="18" height="18" style="color:var(--accent)" viewBox') : "") + '</span>' +
            '<span class="text">"' + esc(o.text) + '"</span>' +
            (o.explain ? '<span class="explain"><b>모르면</b> ' + esc(o.explain) + '</span>' : "") + '</button>';
        }).join("") +
        (list.length ? "" : '<div class="empty">이 자리에 맞는 한마디가 아직 없어요. 다른 자리를 골라 보세요.</div>') +
      '</div></div>' +
      '<div class="tip">' + I.q + '<div style="min-width:0;display:flex;flex-direction:column;gap:2px"><div class="h">말이 끊기면 이 질문 하나</div><div class="q">"' + esc(fq.text) + '"</div><div class="w">' + esc(fq.why) + '</div></div></div>' +
      '<div style="flex:1 1 auto"></div>' +
      '<div class="sticky-bottom"><button class="btn big" id="q-said">말해 봤어요</button><div class="xs muted" style="text-align:center">반응이 어땠든 눌러도 돼요. 꺼낸 것 자체가 오늘 할 일이었어요.</div></div>' +
    '</div>');
    v.querySelector("#q-sits").addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; quickSit = b.dataset.s; quickPick = 0; route(); });
    v.querySelector("#q-list").addEventListener("click", function (e) { var b = e.target.closest("button.opener"); if (!b) return; quickPick = +b.dataset.i; route(); });
    v.querySelector("#q-said").addEventListener("click", function () {
      var o = list[quickPick];
      openReaction(o ? o.text : "", quickSit);
    });
    return v;
  };

  // ---------- 반응 시트 ----------
  function openReaction(text, situation, after) {
    var sel = "";
    var bg = el('<div class="sheet-bg" role="dialog" aria-modal="true" aria-label="반응 기록"><div class="sheet">' +
      '<h3>어땠어요?</h3><div class="small muted">반응이 어땠든 꺼낸 건 1회예요. 썰렁했던 날도 기록이에요.</div>' +
      (text ? '<div class="small" style="background:var(--bg);border-radius:12px;padding:10px 12px">"' + esc(text) + '"</div>' : "") +
      '<div class="reactions" id="rx"><button data-r="good">웃었다</button><button data-r="ok">그냥</button><button data-r="bad">썰렁</button></div>' +
      '<div class="row" style="flex-wrap:nowrap"><button class="btn ghost grow" id="rx-cancel">아직이에요</button><button class="btn grow" id="rx-ok">기록하기</button></div>' +
    '</div></div>');
    bg.querySelector("#rx").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return; sel = b.dataset.r;
      bg.querySelectorAll("#rx button").forEach(function (x) { x.classList.toggle("on", x === b); });
    });
    bg.querySelector("#rx-cancel").addEventListener("click", function () { bg.remove(); });
    bg.addEventListener("click", function (e) { if (e.target === bg) bg.remove(); });
    bg.querySelector("#rx-ok").addEventListener("click", function () {
      addLog(text, situation, sel, true);
      bg.remove();
      toast("기록했어요. 오늘 할 일 끝!");
      if (after) after(); else location.hash = "#log";
      if (location.hash === "#log") route();
    });
    document.body.appendChild(bg);
  }

  function addLog(text, situation, reaction, said) {
    state.logs.unshift({ id: uid(), text: (text || "").trim(), situation: situation || "", reaction: reaction || "", said: !!said, ts: Date.now(), date: todayStr() });
    if (said) state.done[todayStr()] = true;
    save();
  }

  // ---------- 대화 예시 ----------
  var talkIdx = 0, whyOpen = {};
  views.talk = function () {
    if (!data) return noData("talk");
    var scenes = data.scenes || [];
    if (talkIdx >= scenes.length) talkIdx = 0;
    var s = scenes[talkIdx];
    var v = el('<div class="view">' +
      '<div><div class="topbar"><div><div class="title">이렇게 흘러가요</div><div class="sub">주황 테두리가 웃음 포인트예요. 외우지 말고 "왜"만 가져가세요.</div></div></div></div>' +
      '<div class="chips scroll" id="t-tabs">' + scenes.map(function (sc, i) { return '<button class="chip' + (i === talkIdx ? " on" : "") + '" data-i="' + i + '">' + esc(sc.title) + '</button>'; }).join("") + '</div>' +
      (s ? '<div class="talk" id="t-lines">' + s.lines.map(function (ln, i) {
        var h = ln.humor, key = talkIdx + ":" + i;
        return '<div class="bubble ' + (ln.who === "a" ? "a" : "b") + (h ? " humor" : "") + '">' +
          '<span class="who">' + (ln.who === "a" ? "나" : "상대") + '</span>' +
          '<div class="bub">' + (h ? '<span><span class="humorchip">' + esc(h.type) + '</span>' + esc(ln.text) + '</span>' + (whyOpen[key] ? '<span class="why"><b>왜 웃길까</b> · ' + esc(h.why) + '</span>' : "") : esc(ln.text)) + '</div>' +
          (h ? '<div class="actions"><button class="linkbtn" data-why="' + key + '">' + (whyOpen[key] ? "접기" : "왜 웃길까") + '</button><button class="linkbtn" data-save="' + esc(ln.text) + '" data-sit="' + esc(s.title) + '">기록에 저장</button></div>' : "") +
        '</div>';
      }).join("") + '</div>' : '<div class="empty">오늘 대화 예시가 없어요.</div>') +
      (s ? '<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;border-style:dashed"><div class="small muted" style="min-width:0">이 대화의 소재: ' + esc(s.topics) + '</div><a class="btn tiny" href="#practice" style="background:var(--teal-soft);color:var(--teal-ink)">내 말로 해 보기</a></div>' : "") +
      '<a class="small muted" href="#world" style="text-align:center;font-weight:500">오늘 소식 전체는 세상 탭에서</a>' +
      '<div style="flex:1 1 auto"></div>' + tabbar("talk") + '</div>');
    v.querySelector("#t-tabs").addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; talkIdx = +b.dataset.i; route(); });
    var lines = v.querySelector("#t-lines");
    if (lines) lines.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.dataset.why) { whyOpen[b.dataset.why] = !whyOpen[b.dataset.why]; route(); }
      if (b.dataset.save) { addLog(b.dataset.save, b.dataset.sit, "", false); toast("기록에 저장했어요"); }
    });
    return v;
  };

  // ---------- 세상 ----------
  var worldOpen = {};
  views.world = function () {
    if (!data) return noData("world");
    var news = data.news || [];
    var know = news.filter(function (n) { return n.kind === "know"; });
    var talk = rankByInterest(news.filter(function (n) { return n.kind !== "know"; }));
    var term = data.term;
    function item(n, i) {
      var key = n.kind + i, open = !!worldOpen[key], know = n.kind === "know";
      return '<div class="entry">' +
        '<div class="row" style="gap:6px"><span class="tag' + (know ? " know" : "") + '">' + (know ? "알아 두기" : esc(n.tag)) + '</span><strong style="font-size:0.95rem;min-width:0">' + esc(n.title) + '</strong></div>' +
        '<div class="small">' + esc(n.summary) + '</div>' +
        (n.context ? (open ? '<div class="small" style="background:var(--bg);border-radius:10px;padding:10px 12px;line-height:1.6"><b style="font-weight:600">배경</b> · ' + esc(n.context) + '</div>' : "") +
          '<div class="row"><button class="linkbtn" data-w="' + key + '">' + (open ? "접기" : "왜 중요한지 보기") + '</button>' + (n.url ? '<a class="xs" href="' + esc(n.url) + '" target="_blank" rel="noopener">출처: ' + esc(n.source || "기사") + '</a>' : "") + '</div>'
          : (n.url ? '<a class="xs" href="' + esc(n.url) + '" target="_blank" rel="noopener">출처: ' + esc(n.source || "기사") + '</a>' : "")) +
      '</div>';
    }
    var v = el('<div class="view">' +
      '<div class="topbar"><div><div class="title">오늘의 세상</div><div class="sub">5분이면 돼요. 다 몰라도 괜찮고, 하나만 건져도 충분해요.</div></div></div>' +
      (data.lede ? '<p class="small muted">' + esc(data.lede) + '</p>' : "") +
      (term ? '<div class="card hero" style="box-shadow:none;gap:8px"><div class="eyebrow">오늘의 용어</div><div class="display" style="font-size:1.3rem">' + esc(term.word) + '</div><div class="small" style="color:var(--card-dark-muted)">' + esc(term.meaning) + '</div>' + (term.example ? '<div class="small"><b style="color:var(--card-dark-accent);font-weight:600">이렇게 써요</b> · ' + esc(term.example) + '</div>' : "") + '</div>' : "") +
      '<div class="sechead"><h2>알아 두면 좋은 소식</h2><p>중요한 소식. 유머 없이 사실만</p></div>' +
      '<div class="list" id="w-know">' + (know.length ? know.map(item).join("") : '<div class="empty">오늘은 없어요.</div>') + '</div>' +
      '<div class="sechead"><h2>꺼내도 되는 소식</h2><p>가볍게 말해도 괜찮은 것</p></div>' +
      '<div class="list" id="w-talk">' + talk.map(item).join("") + '</div>' +
      '<div class="note">AI가 뉴스 RSS로 모은 기사를 요약·설명한 거예요. 중요한 내용은 출처에서 확인하세요.</div>' +
      '<div style="flex:1 1 auto"></div>' + tabbar("world") + '</div>');
    v.addEventListener("click", function (e) { var b = e.target.closest("button[data-w]"); if (!b) return; worldOpen[b.dataset.w] = !worldOpen[b.dataset.w]; route(); });
    return v;
  };

  // ---------- 내 차례 ----------
  var drillIdx = 0, showAns = false;
  views.practice = function () {
    if (!data) return noData("practice");
    var drills = data.drills || [];
    if (drillIdx >= drills.length) drillIdx = 0;
    var d = drills[drillIdx];
    var key = dataDate + ":" + drillIdx;
    var v = el('<div class="view">' +
      '<div class="topbar"><div><div class="title">내 차례</div><div class="sub">틀린 답은 없어요. 한 줄이면 충분하고, 어색해도 괜찮아요.</div></div></div>' +
      (d ? '<div class="progress">' + drills.map(function (_, i) { return '<span class="bar' + (i === drillIdx ? " on" : "") + '"></span>'; }).join("") + '<span>' + (drillIdx + 1) + ' / ' + drills.length + '</span></div>' +
      '<div class="card" style="display:flex;flex-direction:column;gap:12px">' +
        '<div><div class="xs" style="color:var(--teal);font-weight:600">상황</div><div>' + esc(d.q) + '</div></div>' +
        (d.hints && d.hints.length ? '<div class="chips">' + d.hints.map(function (h) { return '<span class="tag warm">힌트: ' + esc(h) + '</span>'; }).join("") + '</div>' : "") +
        '<label class="lbl" for="p-ta">내 한마디</label><textarea id="p-ta" placeholder="떠오르는 대로, 한 줄만"></textarea>' +
        '<div class="row" style="flex-wrap:nowrap"><button class="btn ink grow" id="p-show">' + (showAns ? "예시 닫기" : "예시 보기") + '</button><button class="btn ghost grow" id="p-save">내 기록에 저장</button></div>' +
      '</div>' +
      (showAns ? '<div class="answer"><div class="eyebrow">예시 (정답이 아니라 한 가지 방법)</div><div class="a">"' + esc(d.answer) + '"</div><div class="n">' + esc(d.note) + '</div></div>' : "") +
      '<div class="row" style="justify-content:space-between"><button class="btn tiny ghost" id="p-prev"' + (drillIdx === 0 ? " disabled" : "") + '>이전</button><button class="btn tiny" id="p-next">' + (drillIdx === drills.length - 1 ? "처음으로" : "다음 연습") + '</button></div>'
      : '<div class="empty">오늘 연습이 없어요.</div>') +
      (data.types && data.types.length ? '<details class="fold"><summary>유머 유형 <small>오늘 쓴 것</small></summary><div class="types">' + data.types.map(function (t) { return '<div><span class="humorchip">' + esc(t.name) + '</span>' + esc(t.desc) + '</div>'; }).join("") + '</div></details>' : "") +
      '<div style="flex:1 1 auto"></div>' + tabbar("practice") + '</div>');
    var ta = v.querySelector("#p-ta");
    if (ta) {
      ta.value = state.drafts[key] || "";
      ta.addEventListener("input", function () { state.drafts[key] = ta.value; save(); });
      v.querySelector("#p-show").addEventListener("click", function () { showAns = !showAns; route(); });
      v.querySelector("#p-save").addEventListener("click", function () { var t = ta.value.trim(); if (!t) { toast("먼저 한 줄만 적어 보세요"); return; } addLog(t, "연습", "", false); toast("기록에 저장했어요"); });
      v.querySelector("#p-prev").addEventListener("click", function () { drillIdx = Math.max(0, drillIdx - 1); showAns = false; route(); });
      v.querySelector("#p-next").addEventListener("click", function () { drillIdx = (drillIdx + 1) % drills.length; showAns = false; route(); });
    }
    return v;
  };

  // ---------- 내 기록 ----------
  var logFilter = "all";
  views.log = function () {
    var now = new Date(), ws = weekStart(now), we = new Date(ws); we.setDate(we.getDate() + 7);
    var pws = new Date(ws); pws.setDate(pws.getDate() - 7);
    var thisWeek = state.logs.filter(function (l) { return l.said && l.ts >= ws && l.ts < we; }).length;
    var lastWeek = state.logs.filter(function (l) { return l.said && l.ts >= pws && l.ts < ws; }).length;
    var days = []; for (var i = 0; i < 7; i++) { var d = new Date(ws); d.setDate(d.getDate() + i); days.push(d); }
    var headline = thisWeek === 0 ? "이번 주는 아직이에요.<br>오늘 한 번이면 시작이에요." : thisWeek + "번 말을 꺼냈어요." + (lastWeek ? "<br>지난주" + (thisWeek > lastWeek ? "보다 " + (thisWeek - lastWeek) + "번 더요." : thisWeek === lastWeek ? "와 같아요." : "보다 적지만, 꺼낸 건 꺼낸 거예요.") : "<br>지난주보다 " + thisWeek + "번 더요.");
    var logs = state.logs.filter(function (l) { return logFilter === "all" || (logFilter === "good" && l.reaction === "good") || (logFilter === "mine" && !l.said); });
    var v = el('<div class="view">' +
      '<div class="between" style="align-items:flex-end"><div><div class="title display" style="font-size:1.45rem">내 기록</div><div class="sub small muted">꺼낸 말이 쌓이면 그게 내 레퍼토리예요.</div></div><a class="iconbtn" href="#settings" aria-label="설정">' + I.gear + '</a></div>' +
      '<div class="card hero" style="box-shadow:none;gap:12px"><div class="eyebrow">이번 주</div><div class="display" style="font-size:1.25rem;line-height:1.45">' + headline + '</div>' +
        '<div class="week">' + days.map(function (d) { var k = todayStr(d); var fut = d > now; var on = !!state.done[k]; return '<div><span class="' + (fut ? "future" : on ? "on" : "") + '"></span>' + ["월", "화", "수", "목", "금", "토", "일"][(d.getDay() + 6) % 7] + '</div>'; }).join("") + '</div>' +
        '<div class="xs" style="color:var(--card-dark-muted)">빈 날은 쉰 날이에요. 벌점은 없어요.</div></div>' +
      '<div class="chips" id="l-filter"><button class="chip' + (logFilter === "all" ? " on" : "") + '" data-f="all">전체</button><button class="chip' + (logFilter === "good" ? " on" : "") + '" data-f="good">웃었던 말</button><button class="chip' + (logFilter === "mine" ? " on" : "") + '" data-f="mine">내가 쓴 말</button></div>' +
      '<div class="list" id="l-list">' + (logs.length ? logs.map(function (l) {
        var r = l.reaction === "good" ? '<span class="tag">웃었다</span>' : l.reaction === "bad" ? '<span class="tag warm">썰렁</span>' : l.reaction === "ok" ? '<span class="tag know">그냥</span>' : (l.said ? "" : '<span class="tag know">연습</span>');
        return '<div class="entry"><div style="font-size:0.95rem">' + (l.text ? '"' + esc(l.text) + '"' : '<span class="muted">(내용 없이 꺼냄)</span>') + '</div><div class="meta">' + r + (l.situation ? '<span>' + esc(l.situation) + '</span>' : "") + '<span>' + esc(fmtShort(l.date || todayStr(new Date(l.ts)))) + '</span>' + (l.reaction === "bad" ? '<span>꺼낸 것만으로 1회</span>' : "") + '<button class="del" data-del="' + l.id + '">삭제</button></div></div>';
      }).join("") : '<div class="empty">아직 기록이 없어요. "말할 준비"에서 하나 고르고, 말해 본 뒤 눌러 보세요.</div>') + '</div>' +
      '<div class="card" style="display:flex;flex-direction:column;gap:8px"><div class="small" style="font-weight:600">직접 적기</div><textarea id="l-ta" placeholder="오늘 써 본 말이나 들은 말"></textarea><div class="row"><input type="text" id="l-sit" placeholder="상황 (예: 친구와 점심)" style="flex:1 1 140px"><button class="btn" id="l-add">저장</button></div></div>' +
      '<div style="flex:1 1 auto"></div>' + tabbar("log") + '</div>');
    v.querySelector("#l-filter").addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; logFilter = b.dataset.f; route(); });
    v.querySelector("#l-list").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-del]"); if (!b) return;
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "정말 삭제"; setTimeout(function () { b.dataset.confirm = ""; b.textContent = "삭제"; }, 2500); return; }
      state.logs = state.logs.filter(function (l) { return l.id !== b.dataset.del; }); save(); route();
    });
    v.querySelector("#l-add").addEventListener("click", function () {
      var t = v.querySelector("#l-ta").value.trim(); if (!t) { toast("내용을 적어 주세요"); return; }
      addLog(t, v.querySelector("#l-sit").value, "", false); toast("저장했어요"); route();
    });
    return v;
  };

  // ---------- 설정 ----------
  views.settings = function () {
    var v = el('<div class="view">' +
      '<div class="topbar"><a class="iconbtn" href="#log" aria-label="뒤로">' + I.back + '</a><div class="title">설정</div></div>' +
      '<div><div class="eyebrow" style="margin-bottom:8px">나에게 맞추기</div><div class="group">' +
        '<div class="grow-row"><div class="h">자주 있는 자리</div><div class="chips" id="s-sits">' + SITUATIONS.map(function (s) { return '<button class="chip' + (state.situations.indexOf(s) >= 0 ? " on" : "") + '" data-s="' + esc(s) + '">' + esc(s) + '</button>'; }).join("") + '</div><div class="d">첫 번째로 고른 자리가 홈의 "오늘의 한마디"에 쓰여요.</div></div>' +
        '<div class="grow-row"><div class="h">사는 지역</div><div class="chips" id="s-region">' + REGIONS.map(function (r) { return '<button class="chip' + (state.region === r[0] ? " on" : "") + '" data-r="' + esc(r[0]) + '">' + esc(r[0]) + '</button>'; }).join("") + '</div><div class="d">내 지역 날씨로 한마디를 만들어요. 서울 기준 소식에 끌려가지 않게요.</div></div>' +
        '<div class="grow-row"><div class="h">관심 분야</div><div class="chips" id="s-fields">' + FIELDS.map(function (f) { return '<button class="chip' + (state.interests.indexOf(f) >= 0 ? " on" : "") + '" data-f="' + esc(f) + '">' + esc(f) + '</button>'; }).join("") + '</div><div class="d">고른 분야의 한마디를 먼저 보여 줘요. 하나도 안 고르면 골고루 보여요.</div></div>' +
        '<div class="grow-row"><div class="between"><div class="h">유머 강도</div></div><div class="seg" id="s-str"><button data-v="safe"' + (state.strength === "safe" ? ' class="on"' : "") + '>안전하게</button><button data-v="normal"' + (state.strength === "normal" ? ' class="on"' : "") + '>보통</button><button data-v="bold"' + (state.strength === "bold" ? ' class="on"' : "") + '>조금 과감하게</button></div><div class="d">안전하게: 날씨·계절·나를 낮추는 농담 위주. 상대를 소재로 삼지 않아요.</div></div>' +
        '<div class="grow-row"><div class="between"><div><div class="h">말투</div><div class="d">예시 대사를 어떤 말투로 볼지</div></div><div class="toggle2" id="s-tone"><button data-v="banmal"' + (state.tone === "banmal" ? ' class="on"' : "") + '>반말</button><button data-v="jondae"' + (state.tone === "jondae" ? ' class="on"' : "") + '>존댓말</button></div></div></div>' +
      '</div></div>' +
      '<div><div class="eyebrow" style="margin-bottom:8px">아침 알림</div><div class="group">' +
        '<div class="grow-row"><div class="between"><div><div class="h">오늘의 한마디 알림</div><div class="d">하루 한 번, 짧게. 앱이 열려 있을 때만 울려요. 홈 화면에 설치하면 더 잘 와요.</div></div><button class="switch' + (state.notify ? " on" : "") + '" id="s-notify" role="switch" aria-checked="' + state.notify + '" aria-label="알림"><i></i></button></div></div>' +
        '<div class="grow-row"><div class="between"><div class="h">시각</div><input type="time" id="s-time" value="' + esc(state.notifyTime) + '" style="width:auto"></div></div>' +
      '</div></div>' +
      '<div><div class="eyebrow" style="margin-bottom:8px">내 데이터</div><div class="group">' +
        '<button class="rowbtn" id="s-export">기록 내보내기<span class="xs muted">텍스트 파일</span></button>' +
        '<button class="rowbtn danger" id="s-clear">모든 기록 지우기</button>' +
      '</div><div class="note" style="margin-top:8px">기록은 이 기기에만 저장돼요. 뉴스와 대화 예시만 서버에서 받아요. <a href="#privacy">개인정보 처리방침</a></div></div>' +
      '<div style="flex:1 1 auto"></div><div class="xs muted" style="text-align:center">말문 0.1 · ' + (data ? "내용 " + esc(data.generated_at || dataDate) : "") + '</div>' +
    '</div>');
    v.querySelector("#s-sits").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return; var s = b.dataset.s, i = state.situations.indexOf(s);
      if (i >= 0) { if (state.situations.length === 1) { toast("하나는 남겨 두세요"); return; } state.situations.splice(i, 1); } else state.situations.push(s);
      state.situations = SITUATIONS.filter(function (x) { return state.situations.indexOf(x) >= 0; }); save(); route();
    });
    v.querySelector("#s-region").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      state.region = state.region === b.dataset.r ? "" : b.dataset.r; state.weather = null; save();
      loadWeather().then(route);
    });
    v.querySelector("#s-fields").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return; var f = b.dataset.f, i = state.interests.indexOf(f);
      if (i >= 0) state.interests.splice(i, 1); else state.interests.push(f);
      state.interests = FIELDS.filter(function (x) { return state.interests.indexOf(x) >= 0; }); save(); route();
    });
    v.querySelector("#s-str").addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; state.strength = b.dataset.v; save(); loadData().then(route); });
    v.querySelector("#s-tone").addEventListener("click", function (e) { var b = e.target.closest("button"); if (!b) return; state.tone = b.dataset.v; save(); loadData().then(route); });
    v.querySelector("#s-notify").addEventListener("click", function () {
      if (!state.notify) {
        if (!("Notification" in window)) { toast("이 브라우저는 알림을 지원하지 않아요"); return; }
        Notification.requestPermission().then(function (p) { if (p === "granted") { state.notify = true; save(); scheduleNotify(); route(); } else toast("알림이 허용되지 않았어요"); });
      } else { state.notify = false; save(); route(); }
    });
    v.querySelector("#s-time").addEventListener("change", function (e) { state.notifyTime = e.target.value || "07:00"; save(); scheduleNotify(); });
    v.querySelector("#s-export").addEventListener("click", function () {
      var txt = state.logs.map(function (l) { return (l.date || "") + "\t" + (REACTIONS[l.reaction] || (l.said ? "꺼냄" : "연습")) + "\t" + (l.situation || "") + "\t" + l.text; }).join("\n");
      var blob = new Blob(["말문 기록\n날짜\t반응\t상황\t내용\n" + txt], { type: "text/plain;charset=utf-8" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "malmun-" + todayStr() + ".txt"; document.body.appendChild(a); a.click(); a.remove();
    });
    v.querySelector("#s-clear").addEventListener("click", function (e) {
      var b = e.currentTarget;
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "정말 지우기 (되돌릴 수 없어요)"; setTimeout(function () { b.dataset.confirm = ""; b.textContent = "모든 기록 지우기"; }, 3000); return; }
      state.logs = []; state.done = {}; state.drafts = {}; save(); toast("지웠어요"); route();
    });
    return v;
  };

  // ---------- 개인정보 ----------
  views.privacy = function () {
    return el('<div class="view"><div class="topbar"><a class="iconbtn" href="' + (state.onboarded ? "#settings" : "#onboarding") + '" aria-label="뒤로">' + I.back + '</a><div class="title">개인정보 처리방침</div></div>' +
      '<div class="card" style="display:flex;flex-direction:column;gap:10px;font-size:0.93rem">' +
      '<p><b>수집하는 정보</b><br>말문은 회원가입이 없고, 이름·이메일·연락처를 수집하지 않아요.</p>' +
      '<p><b>기기에만 저장되는 정보</b><br>내가 고른 자리, 관심 분야, 사는 지역(시·도 단위), 말투, 유머 강도, 내 기록(한마디·반응·날짜)은 이 기기의 브라우저 저장소에만 저장돼요. 서버로 보내지 않아요. 앱 데이터를 지우거나 "모든 기록 지우기"를 누르면 사라져요.</p>' +
      '<p><b>서버에서 받는 정보</b><br>매일 생성되는 뉴스 요약과 대화 예시 파일을 내려받기만 해요. 이때 일반적인 웹 접속 기록(접속 시각, IP) 외에 개인을 식별하는 정보는 전송되지 않아요.</p>' +
      '<p><b>제3자</b><br>글꼴은 Google Fonts에서 불러와요. 지역을 고르면 그 시·도의 대표 좌표로 Open-Meteo에서 날씨를 받아요(정확한 위치는 보내지 않아요). 내용 생성에는 Anthropic Claude API가 쓰이지만, 사용자의 기록은 전달되지 않아요.</p>' +
      '<p><b>이 앱은 치료 도구가 아니에요</b><br>말문은 대화 소재와 연습을 돕는 앱이에요. 마음이 많이 힘들다면 전문가의 도움을 받는 것이 좋아요.</p>' +
      '<p class="xs muted">최종 수정: 2026년 10월</p></div></div>');
  };

  function noData(tab) {
    return el('<div class="view"><div class="topbar"><div class="title">말문</div></div><div class="empty">오늘 내용을 아직 받지 못했어요.<br>인터넷 연결을 확인하고 다시 열어 보세요.</div><div class="row"><button class="btn" id="retry">다시 시도</button></div><div style="flex:1 1 auto"></div>' + tabbar(tab) + '</div>');
  }
  document.addEventListener("click", function (e) { if (e.target.id === "retry") loadData().then(route); });

  // ---------- 알림 (앱이 열려 있을 때만) ----------
  var notifyTimer = null;
  function scheduleNotify() {
    clearTimeout(notifyTimer);
    if (!state.notify || !("Notification" in window) || Notification.permission !== "granted") return;
    var p = (state.notifyTime || "07:00").split(":"); var t = new Date(); t.setHours(+p[0], +p[1], 0, 0);
    if (t <= new Date()) t.setDate(t.getDate() + 1);
    notifyTimer = setTimeout(function () {
      try { new Notification("말문", { body: "오늘의 한마디가 준비됐어요. 10초만 볼까요?", icon: "icons/icon-192.png" }); } catch (e) {}
      scheduleNotify();
    }, t - new Date());
  }

  // ---------- 시작 ----------
  if ("serviceWorker" in navigator) { navigator.serviceWorker.register("sw.js").catch(function () {}); }
  loadData().then(loadWeather).then(function () { route(); scheduleNotify(); });
})();
