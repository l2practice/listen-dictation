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
    enabled: true,
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
        .then(function () { return loadScript('ld-fbdata.js?v=3'); })
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
      _toastWrap.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;width:max-content;max-width:calc(100vw - 32px)';
      document.body.appendChild(_toastWrap);
    }
    type = type || 'info';
    var colors = { info: '#15171C', ok: '#2E8B57', err: '#C0392B' };
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'background:' + (colors[type] || colors.info) + ';color:#fff;padding:12px 22px;border-radius:999px;font-family:inherit;font-size:14px;font-weight:600;box-shadow:0 12px 30px rgba(21,23,28,.22);max-width:420px;text-align:center';
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

  /*── DICTATION: 1 câu đã lưu ─────────────────────
    { typed, checked, attempted, wrong: [các lần bấm Check bị sai, theo thứ tự] }
    Chỉ lưu chữ SV gõ (câu gốc đã có trong script). Tối đa 20 lần sai gần nhất, mỗi lần ≤ 500 ký tự. */
  LD.DICT_MAX_WRONG = 20;
  LD.compactDictAnswer = function (a) {
    a = a || {};
    var wrong = (Array.isArray(a.wrong) ? a.wrong : []).map(function (w) { return String(w || '').trim().slice(0, 500); })
      .filter(Boolean).slice(-LD.DICT_MAX_WRONG);
    return { typed: String(a.typed || ''), checked: !!a.checked, attempted: !!(a.attempted || a.checked || a.resultHtml), wrong: wrong };
  };
  // Các lần gõ sai cần hiển thị TRƯỚC dòng cuối: bỏ lần sai cuối nếu nó chính là câu cuối cùng còn sai
  LD.dictWrongBeforeFinal = function (a, finalCorrect) {
    var w = (a && Array.isArray(a.wrong)) ? a.wrong.slice() : [];
    if (!finalCorrect && w.length && w[w.length - 1] === String((a && a.typed) || '').trim()) w.pop();
    return w;
  };

  /*── ICONS ───────────────────────────────────────
    Nét mảnh (stroke 2), cùng kiểu với ArticuWrite (AW.icon).
    LD.icon('name') → chuỗi <svg>. Trong HTML tĩnh: <i data-ic="name"></i>,
    LD.hydrateIcons(root) thay bằng svg (tự chạy khi trang tải xong). */
  var S = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var IC = {
    headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
    progress:   '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    history:    '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    logout:     '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    search:     '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
    home:       '<path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    library:    '<path d="M4 5a1 1 0 0 1 1-1h5v16H5a1 1 0 0 1-1-1V5z"/><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5V4z"/>',
    book:       '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    music:      '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    script:     '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    scissors:   '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>',
    sparkle:    '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    key:        '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M14 9l2 2"/>',
    settings:   '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    link:       '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    chart:      '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
    quiz:       '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
    puzzle:     '<path d="M4 7h3a2 2 0 1 1 4 0h3v3a2 2 0 1 1 0 4v3h-3a2 2 0 1 0-4 0H4v-3a2 2 0 1 0 0-4z"/>',
    pen:        '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
    keyboard:   '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    save:       '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    download:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload:     '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    play:       '<path d="M7 4l13 8-13 8z"/>',
    volume:     '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    palette:    '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A5.7 5.7 0 0 0 22 9.7C22 5.4 17.5 2 12 2z"/>',
    target:     '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    hand:       '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
    flag:       '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
    check:      '<path d="M20 6L9 17l-5-5"/>',
    circle:     '<circle cx="12" cy="12" r="9"/>',
    checkCircle:'<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    x:          '<path d="M18 6L6 18M6 6l12 12"/>',
    refresh:    '<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    arrowLeft:  '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    arrowUpRight:'<path d="M7 17L17 7M8 7h9v9"/>',
    external:   '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
    results:    '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/>',
    report:     '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/>',
    users:      '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    user:       '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    plus:       '<path d="M12 5v14M5 12h14"/>',
    bell:       '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    archive:    '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
    trash:      '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    eye:        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    clock:      '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
    print:      '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    pin:        '<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
    alert:      '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    lock:       '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    mail:       '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/>',
    copy:       '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    filter:     '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>'
  };
  LD.icon = function (name, cls) {
    var body = IC[name];
    if (!body) return '';
    return (cls ? S.replace('class="ic"', 'class="ic ' + cls + '"') : S) + body + '</svg>';
  };
  // Nhãn nút: icon + chữ (+ mũi tên tròn cam ở cuối nếu go = true)
  LD.label = function (icon, text, go) {
    return (icon ? LD.icon(icon) : '') + '<span>' + LD.esc(text) + '</span>' +
      (go ? '<span class="ld-go">' + LD.icon('arrowUpRight') + '</span>' : '');
  };
  LD.hydrateIcons = function (root) {
    var els = (root || document).querySelectorAll('i[data-ic]');
    for (var k = 0; k < els.length; k++) {
      var el = els[k];
      var svg = LD.icon(el.getAttribute('data-ic'), el.className || '');
      if (svg) el.outerHTML = svg;
    }
  };
  if (global.document && document.querySelectorAll) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { LD.hydrateIcons(); });
    else LD.hydrateIcons();
  }

  global.LD = LD;
})(window);
