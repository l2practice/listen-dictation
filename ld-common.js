/*───────────────────────────────────────────────────
  LisDictation — shared client library (ld-common.js)
  Include once per page: <script src="ld-common.js"></script>
  Theo mẫu aw-common.js (ArticuWrite) nhưng session model theo Fluentalk:
  server verify SessionToken mỗi request, KHÔNG cap số phiên, KHÔNG TTL client-side.
───────────────────────────────────────────────────*/
(function (global) {
  'use strict';

  var GAS = 'https://script.google.com/macros/s/AKfycbzByaIjPqA1nKLEFtyGIsDTUiGaE4HA0rb0TEiA5oXj6LqANjc4Wa2EZHO3gOyNZXyH/exec';

  // ── CLEAR CACHE ON TAB CLOSE (keep API keys) ──────────────────────────
  // Runs once, synchronously, the moment ld-common.js loads on ANY page — before that page's own
  // script runs. Goal: force both roles to log in again after the tab was actually closed (so a
  // stale/corrupted localStorage cache can't cause load bugs next time), WITHOUT logging them out
  // on every ordinary page navigation inside the app (login→student.html, Setup→resume?sessionId,
  // etc.) or on a simple refresh — those are the same tab, just a new document.
  //
  // Trick: sessionStorage is scoped to the tab (browsing context) and the browser wipes it when
  // the tab/window is actually closed, but it SURVIVES reloads and same-tab navigations. So: if
  // our marker is missing from sessionStorage, either this is a brand-new tab or the previous tab
  // was closed — either way, clear localStorage except the whitelisted keys below, then set the
  // marker. If the marker IS present, this is just a reload/navigation within the same tab — leave
  // localStorage (including the session token) untouched.
  (function clearCacheOnTabClose() {
    var MARK = 'ld_tab_open';
    var KEEP = ['ld_gemini_key', 'ld_groq_key']; // student's own AI API keys — must survive
    try {
      if (!sessionStorage.getItem(MARK)) {
        var keep = {};
        KEEP.forEach(function (k) { var v = localStorage.getItem(k); if (v !== null) keep[k] = v; });
        localStorage.clear();
        Object.keys(keep).forEach(function (k) { localStorage.setItem(k, keep[k]); });
      }
      sessionStorage.setItem(MARK, '1');
    } catch (e) {}
  })();

  var LD = {
    GAS: GAS,
    LOGIN_PAGE: 'login.html',
    STUDENT_HOME: 'student.html',
    TEACHER_HOME: 'teacher.html'
  };

  /*── API: POST (fetch) trước, JSONP làm fallback ─────*/
  // QUAN TRỌNG: postJSON KHÔNG có timeout trước đây — nếu fetch() bị treo (cold start GAS,
  // mất kết nối giữa chừng, v.v.) thì code sẽ chờ vô thời hạn trước khi rơi qua JSONP fallback,
  // và vì nhiều màn hình gọi 2 LD.api liên tiếp (vd startSession), tổng thời gian treo có thể
  // lên tới cả phút. Fix: bọc AbortController timeout 8s quanh fetch để fail nhanh và rơi qua
  // JSONP sớm; đồng thời giảm JSONP timeout xuống 20s (đủ cho GAS cold start, không quá lâu).
  var LD_POST_TIMEOUT = 8000, LD_JSONP_TIMEOUT = 20000;
  LD.api = function (action, payload) {
    payload = payload || {};
    return postJSON(action, payload).catch(function () { return jsonp(action, payload); });
  };
  function postJSON(action, payload) {
    var s = LD.session.get();
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, LD_POST_TIMEOUT) : null;
    return fetch(GAS, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // tránh CORS preflight với Apps Script
      body: JSON.stringify({ action: action, payload: payload, sessionToken: (s && s.token) || '' }),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { if (timer) clearTimeout(timer); return r.json(); })
      .catch(function (err) { if (timer) clearTimeout(timer); throw err; });
  }
  var _jsonpId = 0;
  function jsonp(action, payload) {
    var s = LD.session.get();
    return new Promise(function (resolve, reject) {
      var cb = 'ldcb_' + (++_jsonpId) + '_' + Date.now();
      var timer = setTimeout(function () { cleanup(); reject(new Error('JSONP timeout')); }, LD_JSONP_TIMEOUT);
      global[cb] = function (data) { cleanup(); resolve(data); };
      function cleanup() {
        clearTimeout(timer);
        try { delete global[cb]; } catch (e) { global[cb] = undefined; }
        if (sc && sc.parentNode) sc.parentNode.removeChild(sc);
      }
      var params = new URLSearchParams({
        action: action, callback: cb, payload: JSON.stringify(payload), sessionToken: (s && s.token) || ''
      });
      var sc = document.createElement('script');
      sc.src = GAS + '?' + params.toString();
      sc.onerror = function () { cleanup(); reject(new Error('JSONP network error')); };
      document.head.appendChild(sc);
    });
  }

  /*── SESSION (localStorage, không TTL — server verify token mỗi lần) ──*/
  var SKEY = 'ld_session';
  LD.session = {
    set: function (token, user) {
      try { localStorage.setItem(SKEY, JSON.stringify({ token: token, user: user })); } catch (e) {}
    },
    get: function () {
      try {
        var raw = localStorage.getItem(SKEY);
        if (!raw) return null;
        var o = JSON.parse(raw);
        return (o && o.token && o.user) ? o : null;
      } catch (e) { return null; }
    },
    clear: function () { try { localStorage.removeItem(SKEY); } catch (e) {} },
    role: function () { var s = LD.session.get(); return s ? s.user.role : null; },
    require: function (role) {
      var s = LD.session.get();
      if (!s || (role && s.user.role !== role)) { location.href = LD.LOGIN_PAGE; return null; }
      return s;
    },
    logout: function () { LD.session.clear(); location.href = LD.LOGIN_PAGE; }
  };

  /*── IDLE AUTO-LOGOUT (2h) ─────────────────────────*/
  // Last-activity timestamp lives in localStorage (not sessionStorage) — it must survive normal
  // in-app navigation and even a page reload, since the whole point is "2 real hours with no
  // interaction", not "2 hours since this particular document loaded".
  var IDLE_MS = 2 * 60 * 60 * 1000; // 2h
  var IDLE_KEY = 'ld_last_activity';
  var IDLE_CHECK_MS = 60 * 1000; // poll every 60s — fine-grained enough for a 2h window
  var ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];
  function touchActivity() { try { localStorage.setItem(IDLE_KEY, String(Date.now())); } catch (e) {} }
  LD.idle = {
    // onBeforeLogout: optional function (may return a Promise) — called right before the idle
    // logout happens, so a page can save unsaved work first (e.g. Dictation checkpoint). If it
    // throws/rejects, logout still proceeds — an idle user must never get stuck signed in forever
    // just because a save request failed.
    init: function (onBeforeLogout) {
      if (!LD.session.get()) return; // not logged in — nothing to time out
      touchActivity();
      var lastTouch = 0;
      ACTIVITY_EVENTS.forEach(function (evt) {
        document.addEventListener(evt, function () {
          var now = Date.now();
          if (now - lastTouch > 5000) { lastTouch = now; touchActivity(); } // throttle localStorage writes
        }, { passive: true });
      });
      setInterval(function () {
        var s = LD.session.get();
        if (!s) return; // already logged out (e.g. from another tab)
        var last = Number(localStorage.getItem(IDLE_KEY)) || Date.now();
        if (Date.now() - last < IDLE_MS) return;
        var finish = function () {
          LD.toast('Signed out after 2 hours of inactivity — please log in again.', 'info', 4000);
          setTimeout(function () { LD.session.logout(); }, 700);
        };
        try { Promise.resolve(onBeforeLogout ? onBeforeLogout() : null).then(finish, finish); }
        catch (e) { finish(); }
      }, IDLE_CHECK_MS);
    }
  };

  /*── DOM + UX helpers ─────────────────────────────*/
  LD.el = function (sel, root) { return (root || document).querySelector(sel); };
  LD.els = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  LD.esc = function (str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var _toastWrap = null;
  LD.toast = function (msg, type, ms) {
    if (!_toastWrap) {
      _toastWrap = document.createElement('div');
      _toastWrap.id = 'ld-toast-wrap';
      _toastWrap.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none';
      document.body.appendChild(_toastWrap);
    }
    type = type || 'info';
    var colors = { info: '#1A1A16', ok: '#1A7A4A', err: '#C8102E' };
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'background:' + (colors[type] || colors.info) + ';color:#fff;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:600;box-shadow:0 8px 26px rgba(0,0,0,.25);max-width:420px;text-align:center';
    _toastWrap.appendChild(el);
    setTimeout(function () { el.remove(); }, ms || 3200);
  };
  LD.fmtDate = function (val) {
    if (!val) return '—';
    var d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  LD.fmtDuration = function (min) {
    min = Number(min);
    if (!min && min !== 0) return '—';
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    return h > 0 ? (h + 'h' + (m ? m + 'p' : '')) : (m + ' phút');
  };

  global.LD = LD;
})(window);
