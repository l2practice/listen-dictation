/*───────────────────────────────────────────────────
  LisDictation — shared client library (ld-common.js)
  Include once per page: <script src="ld-common.js"></script>
  Session model:
  - sessionStorage (tự xoá khi đóng tab/cửa sổ — không persist qua lần mở mới)
  - Idle timeout 45 phút: không tương tác → tự logout + xoá session
  - Warning toast lúc còn 2 phút để người dùng kịp lưu bài
  - server verify SessionToken mỗi request
───────────────────────────────────────────────────*/
(function (global) {
  'use strict';

  var GAS = 'https://script.google.com/macros/s/AKfycbyadq7DEYYcTNKILHotdXw7cCElBwggj4JGHJ3JD6tM07agn1CQq6aSklIwii5G0iiQ/exec';

  var LD = {
    GAS: GAS,
    LOGIN_PAGE: 'login.html',
    STUDENT_HOME: 'student.html',
    TEACHER_HOME: 'teacher.html'
  };

  /*── API: POST (fetch) trước, JSONP làm fallback ─────*/
  LD.api = function (action, payload) {
    payload = payload || {};
    // Mỗi lần gọi API = có hoạt động → reset idle timer
    _idleReset();
    return postJSON(action, payload).catch(function () { return jsonp(action, payload); });
  };
  function postJSON(action, payload) {
    var s = LD.session.get();
    return fetch(GAS, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
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

  /*── SESSION (sessionStorage — tự xoá khi đóng tab) ──────────────────────
    Dùng sessionStorage thay localStorage:
    - Đóng tab / cửa sổ → session bị xoá ngay, mở lại phải đăng nhập mới
    - Mỗi tab là một session độc lập (sinh viên mở 2 tab = 2 lần đăng nhập)
    Idle timeout 45 phút được quản lý hoàn toàn client-side.
  ────────────────────────────────────────────────────────────────────────────*/
  var SKEY = 'ld_session';
  var IDLE_MS   = 45 * 60 * 1000; // 45 phút
  var WARN_MS   = 43 * 60 * 1000; // cảnh báo trước 2 phút
  var _idleTimer = null, _warnTimer = null, _warnShown = false;

  function _idleClear() {
    if (_idleTimer) clearTimeout(_idleTimer);
    if (_warnTimer) clearTimeout(_warnTimer);
    _idleTimer = _warnTimer = null;
    _warnShown = false;
  }

  function _idleStart() {
    _idleClear();
    // Warning toast lúc còn 2 phút
    _warnTimer = setTimeout(function () {
      if (!LD.session.get()) return; // đã logout rồi
      _warnShown = true;
      LD.toast('⚠️ Phiên làm việc sẽ hết hạn sau 2 phút do không có hoạt động. Nhấn bất kỳ phím hoặc di chuyển chuột để tiếp tục.', 'err', 10000);
    }, WARN_MS);
    // Logout sau 45 phút
    _idleTimer = setTimeout(function () {
      if (!LD.session.get()) return;
      LD.session.clear();
      LD.toast('🔒 Phiên làm việc đã hết hạn (45 phút không có hoạt động). Vui lòng đăng nhập lại.', 'err', 5000);
      setTimeout(function () { location.href = LD.LOGIN_PAGE; }, 2000);
    }, IDLE_MS);
  }

  function _idleReset() {
    // Chỉ reset nếu đang có session (không reset trên trang login)
    if (!LD.session.get()) return;
    if (_warnShown) _warnShown = false; // huỷ warning nếu user đã dùng trước khi timeout
    _idleStart();
  }

  // Các sự kiện được tính là "có hoạt động"
  var _IDLE_EVENTS = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll', 'click'];
  var _throttleTimer = null;
  function _onActivity() {
    if (_throttleTimer) return; // throttle 30 giây để không reset liên tục
    _throttleTimer = setTimeout(function () { _throttleTimer = null; }, 30000);
    _idleReset();
  }

  LD.session = {
    set: function (token, user) {
      try {
        sessionStorage.setItem(SKEY, JSON.stringify({ token: token, user: user }));
        // Bắt đầu đếm idle ngay khi login
        _idleStart();
        // Gắn event listeners nếu chưa có
        _IDLE_EVENTS.forEach(function (e) { document.addEventListener(e, _onActivity, { passive: true }); });
      } catch (ex) {}
    },
    get: function () {
      try {
        var raw = sessionStorage.getItem(SKEY);
        if (!raw) return null;
        var o = JSON.parse(raw);
        return (o && o.token && o.user) ? o : null;
      } catch (e) { return null; }
    },
    clear: function () {
      try { sessionStorage.removeItem(SKEY); } catch (e) {}
      _idleClear();
      // Gỡ event listeners
      _IDLE_EVENTS.forEach(function (e) { document.removeEventListener(e, _onActivity); });
    },
    role: function () { var s = LD.session.get(); return s ? s.user.role : null; },
    require: function (role) {
      var s = LD.session.get();
      if (!s || (role && s.user.role !== role)) { location.href = LD.LOGIN_PAGE; return null; }
      // Đảm bảo idle timer đang chạy (đề phòng page reload trong cùng tab)
      if (!_idleTimer) {
        _idleStart();
        _IDLE_EVENTS.forEach(function (e) { document.addEventListener(e, _onActivity, { passive: true }); });
      }
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
    setTimeout(function () { if (el.parentNode) el.remove(); }, ms || 3200);
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
