/*───────────────────────────────────────────────────
  LisDictation — shared client library (ld-common.js)
  Include once per page: <script src="ld-common.js"></script>
  Theo mẫu aw-common.js (ArticuWrite) nhưng session model theo Fluentalk:
  server verify SessionToken mỗi request, KHÔNG cap số phiên, KHÔNG TTL client-side.
───────────────────────────────────────────────────*/
(function (global) {
  'use strict';

  // ⚠️ Đổi URL này sau khi deploy Code.gs (Apps Script ▸ Deploy ▸ Web app ▸ copy /exec)
  var GAS = 'PASTE_APPS_SCRIPT_EXEC_URL_VAO_DAY';

  var LD = {
    GAS: GAS,
    LOGIN_PAGE: 'login.html',
    STUDENT_HOME: 'student.html',
    TEACHER_HOME: 'teacher.html'
  };

  /*── API: POST (fetch) trước, JSONP làm fallback ─────*/
  LD.api = function (action, payload) {
    payload = payload || {};
    return postJSON(action, payload).catch(function () { return jsonp(action, payload); });
  };
  function postJSON(action, payload) {
    var s = LD.session.get();
    return fetch(GAS, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // tránh CORS preflight với Apps Script
      body: JSON.stringify({ action: action, payload: payload, sessionToken: (s && s.token) || '' }),
      redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }
  var _jsonpId = 0;
  function jsonp(action, payload) {
    var s = LD.session.get();
    return new Promise(function (resolve, reject) {
      var cb = 'ldcb_' + (++_jsonpId) + '_' + Date.now();
      var timer = setTimeout(function () { cleanup(); reject(new Error('JSONP timeout')); }, 30000);
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
