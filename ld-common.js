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

  /*── FIREBASE ─────────────────────────────────────
    Dán Web app config từ Firebase console → Project settings → Your apps.
    enabled: false = app vẫn dùng Apps Script + Google Sheet như cũ.
    Chỉ bật true SAU KHI đã chạy xong các bước chuyển dữ liệu trong gas/FirebaseLD.gs. */
  var LD_FIREBASE = global.LD_FIREBASE || {
    enabled: false,
    config: {
      apiKey: 'AIzaSyABj5BoT_Bz8aGJ6bys8LWCLAFhut5VJL8',
      authDomain: 'listendictation-4c26e.firebaseapp.com',
      projectId: 'listendictation-4c26e',
      storageBucket: 'listendictation-4c26e.firebasestorage.app',
      messagingSenderId: '76602878721',
      appId: '1:76602878721:web:67c0b5c192c6ed88828900'
    },
    studentDomain: 'students.lisdictation.app'   // phải khớp LDFB.STUDENT_DOMAIN trong FirebaseLD.gs
  };
  global.LD_FIREBASE = LD_FIREBASE;

  var LD = {
    GAS: GAS,
    firebaseOn: !!(LD_FIREBASE.enabled && LD_FIREBASE.config && LD_FIREBASE.config.apiKey),
    LOGIN_PAGE: 'login.html',
    STUDENT_HOME: 'student.html',
    TEACHER_HOME: 'teacher.html'
  };

  /*── API ─────────────────────────────────────────
    Firebase bật: ld-fbdata.js trả lời thẳng từ Firestore (nhanh).
    Firebase tắt: POST (fetch) tới Apps Script, JSONP làm fallback.   */
  LD._legacyApi = function (action, payload) {
    return postJSON(action, payload).catch(function () { return jsonp(action, payload); });
  };
  LD.api = function (action, payload) {
    payload = payload || {};
    // Mỗi lần gọi API = có hoạt động → reset idle timer
    _idleReset();
    if (!LD.firebaseOn) return LD._legacyApi(action, payload);
    return LD.firebaseReady().then(function (FB) { return FB.call(action, payload); })
      .then(function (res) {
        if (res && res.success === false && res.error === 'SESSION_EXPIRED') {
          LD.session.clear();
          if (!/(login|signup)\.html/.test(location.pathname)) location.href = LD.LOGIN_PAGE;
        }
        return res;
      });
  };

  /*── Firebase SDK + ld-fbdata.js: chỉ tải khi Firebase bật, 1 lần ──*/
  var FB_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var _fbLoad = null;
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = src; sc.onload = res;
      sc.onerror = function () { rej(new Error('Không tải được ' + src)); };
      document.head.appendChild(sc);
    });
  }
  LD.firebaseReady = function () {
    if (!_fbLoad) {
      _fbLoad = loadScript(FB_SDK + 'firebase-app-compat.js')
        .then(function () { return Promise.all([loadScript(FB_SDK + 'firebase-auth-compat.js'), loadScript(FB_SDK + 'firebase-firestore-compat.js')]); })
        .then(function () { return loadScript('ld-fbdata.js?v=1'); })
        .then(function () { return global.FB; });
      _fbLoad.catch(function () { _fbLoad = null; });   // cho phép thử lại sau lỗi mạng
    }
    return _fbLoad;
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
      if (LD.firebaseOn) LD.firebaseReady().then(function (FB) { return FB.signOut(); }).catch(function () {});
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
    logout: function () {
      var go = function () { location.href = LD.LOGIN_PAGE; };
      if (!LD.firebaseOn) { LD.session.clear(); go(); return; }
      // Đợi Firebase đăng xuất xong (tối đa 3 giây) rồi mới chuyển trang
      try { sessionStorage.removeItem(SKEY); } catch (e) {}
      _idleClear();
      Promise.race([LD.firebaseReady().then(function (FB) { return FB.signOut(); }), new Promise(function (r) { setTimeout(r, 3000); })])
        .then(go, go);
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

  /*── DICTATION: so khớp câu gõ với câu gốc ────────
    So theo DÃY từ (Levenshtein cấp từ), KHÔNG theo vị trí: thiếu/thừa 1 từ chỉ tính sai
    đúng từ đó, không làm lệch cả phần sau của câu. Bỏ qua dấu câu, nháy, gạch, hoa/thường
    (don't = don’t = dont). Token chỉ toàn dấu câu (vd. "—") không tính là từ.
    Trả về ops theo thứ tự câu gốc: ok | sub (gõ sai) | miss (thiếu) | extra (thừa). */
  LD.wordKey = function (w) {
    return String(w || '').replace(/[‘’ʼʹ]/g, "'").replace(/[^a-z0-9]/gi, '').toLowerCase();
  };
  LD.alignWords = function (target, typed) {
    var words = function (s) { return String(s || '').split(/\s+/).filter(function (w) { return LD.wordKey(w); }); };
    var a = words(target), b = words(typed);
    var ka = a.map(LD.wordKey), kb = b.map(LD.wordKey);
    var n = a.length, m = b.length, d = [], i, j;
    for (i = 0; i <= n; i++) { d[i] = [i]; }
    for (j = 1; j <= m; j++) d[0][j] = j;
    for (i = 1; i <= n; i++) for (j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j - 1] + (ka[i - 1] === kb[j - 1] ? 0 : 1), d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
    var ops = [];
    i = n; j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && ka[i - 1] === kb[j - 1] && d[i][j] === d[i - 1][j - 1]) { ops.push({ op: 'ok', t: a[i - 1], y: b[j - 1] }); i--; j--; }
      else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) { ops.push({ op: 'sub', t: a[i - 1], y: b[j - 1] }); i--; j--; }
      else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { ops.push({ op: 'miss', t: a[i - 1] }); i--; }
      else { ops.push({ op: 'extra', y: b[j - 1] }); j--; }
    }
    ops.reverse();
    var correct = ops.filter(function (o) { return o.op === 'ok'; }).length;
    return { ops: ops, correct: correct, total: n, allCorrect: correct === n && m === n };
  };

  global.LD = LD;
})(window);
