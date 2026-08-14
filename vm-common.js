/*───────────────────────────────────────────────────
  VocabMaster — shared client library (vm-common.js)
  Provides: VM.api, VM.session, VM.toast, VM.renderShell, VM.icon
  Mirrors ArticuWrite's aw-common.js architecture.
───────────────────────────────────────────────────*/
(function (global) {
  'use strict';

  // ── CONFIG ─────────────────────────────────────
  // Replace with your deployed GAS /exec URL
  var GAS = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

  var VM = {
    GAS: GAS,
    LOGIN_PAGE:   'login.html',
    STUDENT_HOME: 'student.html',
    TEACHER_HOME: 'teacher.html',
  };

  /*── API ──────────────────────────────────────────
    GitHub Pages → GAS: always use JSONP (GET with callback).
    CORS blocks fetch POST from static origins.
    Large payloads (>4KB) fall back to POST no-cors
    and rely on doPost returning JSONP via callback param.
  ─────────────────────────────────────────────────*/
  /*── API ──────────────────────────────────────────
    Always JSONP GET — the only method that works cross-origin
    from GitHub Pages to GAS without CORS issues.
    For payloads > URL limit, VM.apiChunked() splits them.
  ─────────────────────────────────────────────────*/
  VM.api = function (action, payload) {
    return jsonp(action, payload || {});
  };

  /*── VM.apiLarge — for assign.create / assign.update with vocab
    Step 1: create/update without vocab (small payload → JSONP)
    Step 2: patch vocab in chunks of 8 words via assign.appendVocab
    Returns Promise<{success, data}>
  ─────────────────────────────────────────────────*/
  VM.apiLarge = function (action, payload) {
    var vocab = (payload.vocab || []).slice();
    var slim  = {};
    for (var k in payload) { if (k !== 'vocab') slim[k] = payload[k]; }
    slim.vocab = [];  // create/update with empty vocab first

    return VM.api(action, slim).then(function (res) {
      if (!res || !res.success) return res;
      var assignmentId = (res.data && res.data.assignmentId) || payload.assignmentId;
      if (!vocab.length) return res;

      // Patch vocab in chunks of 8
      var CHUNK = 8;
      var chunks = [];
      for (var i = 0; i < vocab.length; i += CHUNK) {
        chunks.push(vocab.slice(i, i + CHUNK));
      }

      function sendChunk(idx) {
        if (idx >= chunks.length) return Promise.resolve(res);
        return VM.api('assign.appendVocab', {
          assignmentId: assignmentId,
          vocab: chunks[idx],
          replace: idx === 0   // first chunk replaces, rest append
        }).then(function () { return sendChunk(idx + 1); });
      }
      return sendChunk(0);
    });
  };

  var _jsonpId = 0;
  function jsonp(action, payload) {
    return new Promise(function (resolve, reject) {
      var cb = 'vmcb_' + (++_jsonpId) + '_' + Date.now();
      var timer = setTimeout(function () {
        cleanup(); reject(new Error('Timeout — kiểm tra kết nối mạng hoặc GAS deployment.'));
      }, 30000);
      global[cb] = function (data) { cleanup(); resolve(data); };
      function cleanup() {
        clearTimeout(timer);
        try { delete global[cb]; } catch (e) { global[cb] = undefined; }
        if (s && s.parentNode) s.parentNode.removeChild(s);
      }
      var params = new URLSearchParams({
        action: action,
        callback: cb,
        payload: JSON.stringify(payload)
      });
      var s = document.createElement('script');
      s.src = GAS + '?' + params.toString();
      s.onerror = function () { cleanup(); reject(new Error('Network error — không tải được GAS script.')); };
      document.head.appendChild(s);
    });
  }


  VM.session = {
    set: function (obj, opts) {
      var remember = !!(opts && opts.remember === true);
      var payload  = JSON.stringify({ data: obj, exp: Date.now() + SESSION_TTL });
      try { sessionStorage.removeItem(SKEY); } catch(e) {}
      try { localStorage.removeItem(SKEY);   } catch(e) {}
      try { (remember ? localStorage : sessionStorage).setItem(SKEY, payload); } catch(e) {}
      _refreshIdle();
    },
    get: function () {
      var raw = null;
      try { raw = sessionStorage.getItem(SKEY) || localStorage.getItem(SKEY); } catch(e) {}
      if (!raw) return null;
      try {
        var o = JSON.parse(raw);
        if (!o || !o.data || !o.exp) { VM.session.clear(); return null; }
        if (Date.now() > o.exp)      { VM.session.clear(); return null; }
        if (_isIdle())               { VM.session.clear(); return null; }
        return o.data;
      } catch(e) { VM.session.clear(); return null; }
    },
    clear: function () {
      try { localStorage.removeItem(SKEY);   } catch(e) {}
      try { sessionStorage.removeItem(SKEY); } catch(e) {}
    },
    role: function () { var s = VM.session.get(); return s ? s.role : null; },
    require: function (role) {
      var s = VM.session.get();
      if (!s || (role && s.role !== role)) { location.href = VM.LOGIN_PAGE; return null; }
      _refreshIdle();
      return s;
    },
    logout: function () { VM.session.clear(); location.href = VM.LOGIN_PAGE; },
  };

  // Activity listeners — throttled to once/minute
  var _idleThrottle = 0;
  function _onActivity() {
    var now = Date.now();
    if (now - _idleThrottle > 60000) { _idleThrottle = now; _refreshIdle(); }
  }
  ['click','keydown','touchstart','scroll'].forEach(function (ev) {
    document.addEventListener(ev, _onActivity, { passive: true, capture: true });
  });

  // Gemini key (survives session clear)
  VM.geminiKey = {
    get: function () { return localStorage.getItem('vm_gemini_key') || ''; },
    set: function (k) { localStorage.setItem('vm_gemini_key', k || ''); },
  };

  /*── DOM helpers ──────────────────────────────────*/
  VM.el  = function (sel, root) { return (root || document).querySelector(sel); };
  VM.els = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  VM.esc = function (str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  };

  VM.fmtDate = function (val) {
    if (!val) return '—';
    var s = String(val).trim();
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s))
      return d.toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric' });
    return d.toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric' }) +
           ' ' + d.toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit', hour12:false });
  };

  VM.fmtDuration = function (sec) {
    sec = parseInt(sec, 10) || 0;
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
  };

  /*── Toast ────────────────────────────────────────*/
  var _toastEl = null;
  VM.toast = function (msg, kind, ms) {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.className = 'vm-toast';
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.className = 'vm-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(_toastEl._t);
    _toastEl._t = setTimeout(function () {
      _toastEl.className = 'vm-toast' + (kind ? ' ' + kind : '');
    }, ms || 2600);
  };

  /*── Brand ────────────────────────────────────────*/
  VM.logoSVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="24" height="24" rx="5" fill="currentColor"/>' +
    '<text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" font-family="system-ui">V</text>' +
    '</svg>';

  VM.brandLockup = function () {
    return '<a class="vm-logo" href="#"><span class="vm-logo-mark">' + VM.logoSVG +
           '</span><span class="vm-logo-name">VocabMaster</span></a>';
  };

  /*── Fonts ────────────────────────────────────────*/
  (function () {
    if (document.getElementById('vm-fonts')) return;
    var l = document.createElement('link');
    l.id = 'vm-fonts'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap';
    document.head.appendChild(l);
  })();

  /*── Icons ────────────────────────────────────────*/
  var IC = {
    hw:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>',
    inclass:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    reading:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
    results:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    classes:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    assign:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
    logout:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
    menu:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>',
    plus:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
    search:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>',
    check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
    star:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
    book:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
    trash:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>',
    edit:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    eye:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    clock:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  };
  VM.icon = function (name) { return IC[name] || ''; };

  /*── Shell renderer ───────────────────────────────*/
  VM.renderShell = function (opts) {
    var s    = VM.session.get() || {};
    var name = (opts.user && opts.user.name) || s.name || s.email || 'User';
    var roleLabel = s.role === 'teacher' ? 'Teacher' : 'Student';
    var initials  = name.split(/\s+/).map(function (w) { return w[0] || ''; }).slice(0, 2).join('').toUpperCase();

    var navHtml = opts.nav.map(function (n) {
      var cls = 'vm-nav' + (n.active ? ' active' : '');
      var ic  = n.icon ? VM.icon(n.icon) : '';
      return '<a class="' + cls + '" ' + (n.href ? 'href="' + n.href + '"' : 'data-nav="' + n.id + '"') + '>' +
             ic + '<span>' + n.label + '</span>' + (n.badge ? '<span class="vm-nav-badge">' + n.badge + '</span>' : '') + '</a>';
    }).join('');

    var html =
      '<div class="vm-shell">' +
        '<aside class="vm-side" id="vmSide">' +
          VM.brandLockup() + navHtml +
          '<div style="margin-top:auto">' +
            '<button class="vm-nav" id="vmLogout">' + VM.icon('logout') + '<span>Sign out</span></button>' +
          '</div>' +
        '</aside>' +
        '<div class="vm-main">' +
          '<header class="vm-topbar">' +
            '<button class="vm-menu-btn" id="vmMenuBtn">' + VM.icon('menu') + '</button>' +
            '<div>' +
              '<div class="vm-eyebrow">' + VM.esc(opts.eyebrow || '') + '</div>' +
              '<h1 class="vm-page-title" id="vmPageTitle">' + VM.esc(opts.title || '') + '</h1>' +
            '</div>' +
            '<div class="vm-topbar-right">' +
              '<div class="vm-user">' +
                '<div class="vm-avatar">' + initials + '</div>' +
                '<div>' +
                  '<div class="vm-user-name">' + VM.esc(name) + '</div>' +
                  '<div class="vm-user-role">' + roleLabel + '</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</header>' +
          '<main class="vm-content" id="vmContent"></main>' +
        '</div>' +
      '</div>';

    document.getElementById(opts.mount || 'app').innerHTML = html;
    document.getElementById('vmLogout').onclick = function () { VM.session.logout(); };

    // Idle auto-logout: check every 60s, warn at T-5min, logout at T=0
    var _idleWarned = false;
    var _idleCheck = setInterval(function () {
      try {
        var t   = parseInt(localStorage.getItem(IDLE_KEY) || '0', 10);
        if (!t) return;
        var ago = Date.now() - t;
        if (ago >= IDLE_LIMIT_MS) {
          clearInterval(_idleCheck);
          VM.session.clear();
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(16,34,46,.85);z-index:99999;display:flex;align-items:center;justify-content:center';
          overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:28px 32px;max-width:380px;text-align:center">' +
            '<div style="font-size:2rem;margin-bottom:10px">⏰</div>' +
            '<h2 style="margin:0 0 8px">Phiên làm việc đã hết hạn</h2>' +
            '<p style="color:#5B6B7A;font-size:.9rem;margin:0 0 18px">Bạn không hoạt động trong 45 phút.</p>' +
            '<a href="' + VM.LOGIN_PAGE + '" style="display:inline-block;background:#1B7F5E;color:#fff;padding:10px 24px;border-radius:24px;text-decoration:none;font-weight:700">Đăng nhập lại</a>' +
            '</div>';
          document.body.appendChild(overlay);
          setTimeout(function () { location.href = VM.LOGIN_PAGE; }, 3000);
        } else if (!_idleWarned && ago >= IDLE_LIMIT_MS - 5 * 60 * 1000) {
          _idleWarned = true;
          var mins = Math.ceil((IDLE_LIMIT_MS - ago) / 60000);
          var warn = document.createElement('div');
          warn.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#B42318;color:#fff;padding:12px 20px;border-radius:12px;z-index:9998;font-size:.88rem;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.3);display:flex;align-items:center;gap:12px';
          warn.innerHTML = '⏰ Còn <b style="margin:0 4px">' + mins + ' phút</b> trước khi tự động đăng xuất. <button onclick="this.parentNode.remove()" style="background:rgba(255,255,255,.2);border:none;border-radius:8px;color:#fff;padding:4px 10px;cursor:pointer">Huỷ</button>';
          document.body.appendChild(warn);
        }
      } catch(e) {}
    }, 60000);

    // Mobile sidebar
    var menuBtn = document.getElementById('vmMenuBtn');
    if (menuBtn) menuBtn.onclick = function (e) {
      e.stopPropagation();
      document.getElementById('vmSide').classList.toggle('open');
    };
    document.addEventListener('click', function (e) {
      var side = document.getElementById('vmSide');
      if (!side || !side.classList.contains('open')) return;
      if (side.contains(e.target)) return;
      if (menuBtn && menuBtn.contains(e.target)) return;
      side.classList.remove('open');
    });

    // Data-nav click routing
    VM.els('[data-nav]').forEach(function (a) {
      a.onclick = function () { if (opts.onNav) opts.onNav(a.getAttribute('data-nav'), a); };
    });

    return document.getElementById('vmContent');
  };

  VM.setActiveNav = function (id) {
    VM.els('.vm-nav').forEach(function (a) { a.classList.remove('active'); });
    var el = VM.el('[data-nav="' + id + '"]');
    if (el) el.classList.add('active');
  };

  VM.setTitle = function (title, eyebrow) {
    var t = document.getElementById('vmPageTitle'); if (t) t.textContent = title;
    var e = VM.el('.vm-eyebrow'); if (e && eyebrow) e.textContent = eyebrow;
  };

  /*── Today's Word widget ─────────────────────────*/
  VM.renderTodaysWord = function (mountId) {
    var mount = document.getElementById(mountId || 'vmTodaysWord');
    if (!mount) return;
    var LK = 'vm_login_count';
    var logins   = parseInt(localStorage.getItem(LK) || '0', 10);
    var forceIdx = Math.floor(logins / 5);
    VM.api('vocab.today', { index: forceIdx }).then(function (res) {
      if (!res || !res.success || !res.data) { mount.innerHTML = ''; return; }
      var d = res.data, c = d.current, prev = d.previous;
      mount.innerHTML =
        '<div class="vm-tw">' +
          '<div class="vm-tw-glow"></div>' +
          '<div class="vm-tw-grid">' +
            '<div class="vm-tw-left">' +
              '<div class="vm-tw-eyebrow">✦ TODAY\'S WORD</div>' +
              '<div class="vm-tw-word">' + VM.esc(c.word) +
                (c.ipa ? '<span class="vm-tw-ipa">/' + VM.esc(c.ipa) + '/</span>' : '') +
                (c.band ? '<span class="vm-tw-band">' + VM.esc(c.band) + '</span>' : '') +
              '</div>' +
              (c.meaningVi ? '<div class="vm-tw-mean"><span class="vm-tw-flag">🇻🇳</span> ' + VM.esc(c.meaningVi) + '</div>' : '') +
              (c.synonyms && c.synonyms.length ?
                '<div class="vm-tw-syn"><span class="vm-tw-lbl">SYNONYMS</span><div class="vm-tw-chips">' +
                c.synonyms.map(function (s) { return '<span class="vm-tw-chip">' + VM.esc(s) + '</span>'; }).join('') +
                '</div></div>' : '') +
            '</div>' +
            '<div class="vm-tw-right">' +
              (prev && prev.word ?
                '<div class="vm-tw-prev"><span class="vm-tw-prev-lbl">PREVIOUSLY</span>' +
                '<div class="vm-tw-prev-word">' + VM.esc(prev.word) + '</div>' +
                (prev.meaningVi ? '<div class="vm-tw-prev-mean">' + VM.esc(prev.meaningVi) + '</div>' : '') +
                '</div>' : '') +
              (c.examples && c.examples.length ?
                '<div class="vm-tw-ex"><span class="vm-tw-lbl">EXAMPLES</span>' +
                c.examples.map(function (e) { return '<p>"' + VM.esc(e) + '"</p>'; }).join('') +
                '</div>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
    });
  };
  VM.bumpLoginCount = function () {
    var LK = 'vm_login_count';
    localStorage.setItem(LK, String(parseInt(localStorage.getItem(LK) || '0', 10) + 1));
  };

  /*── Quiz engine ──────────────────────────────────
    Given a vocab array [{word, ipa, synonyms, vi, ...}],
    builds a randomised quiz and returns a controller object.

    Modes:
      'blank'    — fill in the blank from a sentence with word removed
      'match'    — match word ↔ definition
      'choice'   — 4-option MCQ (definition → pick word)
      'spell'    — type the word given IPA + Vietnamese meaning

    Usage:
      var quiz = VM.buildQuiz(vocabArr, { mode:'choice', shuffle:true });
      quiz.questions  → array of question objects
      quiz.check(qIdx, answer) → { correct, correctAnswer }
  ─────────────────────────────────────────────────*/
  VM.buildQuiz = function (vocab, opts) {
    opts = opts || {};
    var mode = opts.mode || 'choice';
    var items = vocab.slice();
    if (opts.shuffle !== false) items = _shuffle(items.slice());

    var questions = items.map(function (item, i) {
      // Build 3 random wrong options (for MCQ / match)
      var others = items.filter(function (x) { return x.word !== item.word; });
      var wrongs = _shuffle(others.slice()).slice(0, 3);

      var q = { idx: i, word: item.word, ipa: item.ipa || '', vi: item.meaningVi || item.vi || '',
                synonyms: item.synonyms || [], examples: item.examples || [] };

      if (mode === 'choice') {
        // Show definition, pick the correct word
        var options = _shuffle([item].concat(wrongs)).map(function (x) { return x.word; });
        q.prompt   = (item.synonyms && item.synonyms.length ? item.synonyms[0] : '') || item.vi;
        q.subprompt = item.vi;
        q.options  = options;
        q.answer   = item.word;
      } else if (mode === 'blank') {
        // Fill in the blank — use example or synthesise one
        var ex = (item.examples && item.examples[0]) || '';
        // Replace whole word (case-insensitive) with _____
        var re = new RegExp('\\b' + item.word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\b', 'i');
        q.prompt  = ex.replace(re, '_____') || ('_____ means: ' + (item.vi || item.word));
        q.hint    = item.ipa ? '/' + item.ipa + '/' : '';
        q.answer  = item.word.toLowerCase();
        q.caseSensitive = false;
      } else if (mode === 'spell') {
        // Given IPA + Vietnamese, type the word
        q.prompt  = (item.ipa ? '/' + item.ipa + '/' : '') + (item.vi ? '  —  ' + item.vi : '');
        q.answer  = item.word.toLowerCase();
        q.caseSensitive = false;
      } else if (mode === 'match') {
        // Left column: words; right column: definitions (shuffled separately by caller)
        q.prompt  = item.word;
        q.answer  = item.vi || (item.synonyms && item.synonyms[0]) || item.word;
        q.options = _shuffle([item].concat(wrongs)).map(function (x) {
          return x.vi || (x.synonyms && x.synonyms[0]) || x.word;
        });
      }
      return q;
    });

    return {
      mode:      mode,
      questions: questions,
      check: function (qIdx, answer) {
        var q = questions[qIdx];
        if (!q) return { correct: false, correctAnswer: '' };
        var given   = q.caseSensitive === false ? String(answer).toLowerCase().trim() : String(answer).trim();
        var correct = q.caseSensitive === false ? q.answer.toLowerCase().trim() : q.answer.trim();
        return { correct: given === correct, correctAnswer: q.answer };
      }
    };
  };

  function _shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  VM._shuffle = _shuffle; // expose for use in pages

  /*── Gemini vocab analysis ────────────────────────
    Takes a raw word list string (one word per line, or word = definition)
    and a Gemini API key. Returns a Promise<vocabArray>.
    vocabArray: [{word, synonyms, ipa, vi}]
  ─────────────────────────────────────────────────*/
  VM.analyzeVocab = function (rawList, apiKey, onProgress) {
    // ── Step 1: Parse client-side (no tokens used) ─────────────────
    // Extracts word + synonym/definition from lines like:
    //   polar= relating to the North Pole
    //   threaten: to harm or destroy
    //   biodiversity
    var lines = rawList.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
    var parsed = [];
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      // Strip leading numbering: "1." "2)" "71 "
      line = line.replace(/^\d+[\.)\s]+/, '').replace(/^[-\u2022\u2013\u2014*]\s*/, '').trim();
      if (!line) continue;
      var word = '', syn = '';
      var eqIdx  = line.indexOf('=');
      var colIdx = line.indexOf(':');
      var splitIdx = -1;
      if (eqIdx >= 0 && (colIdx < 0 || eqIdx <= colIdx)) splitIdx = eqIdx;
      else if (colIdx >= 0 && colIdx < 40) splitIdx = colIdx;
      if (splitIdx >= 0) {
        word = line.slice(0, splitIdx).trim();
        syn  = line.slice(splitIdx + 1).trim();
      } else {
        word = line.trim();
      }
      // Strip trailing noise from word (brackets, parens, punctuation)
      word = word.replace(/\s*[\(\[].+[\)\]]\s*$/, '').replace(/[,;:]+$/, '').trim();
      if (word) parsed.push({ word: word, syn: syn });
    }

    if (!parsed.length) return Promise.reject(new Error('No words found.'));

    // ── Step 2: Show immediately with parsed data ───────────────────
    var result = parsed.map(function(p) {
      var syns = p.syn ? p.syn.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
      return { word: p.word, ipa: '', synonyms: syns, vi: '', meaningVi: '' };
    });
    if (onProgress) onProgress(0, parsed.length);

    // ── Step 3: AI enrichment — IPA + Vietnamese ONLY (batch 30) ────
    // Short prompt → small output → no truncation
    var BATCH = 30;
    var words = parsed.map(function(p){ return p.word; });
    var batches = [];
    for (var b = 0; b < words.length; b += BATCH) {
      batches.push({ words: words.slice(b, b + BATCH), offset: b });
    }

    // Model cascade: try newest first, fall back
    var MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-001'];

    function callGemini(wordBatch) {
      var prompt =
        'You are a vocabulary dictionary. Return ONLY a valid JSON array, no markdown, no explanation.\n' +
        'For EVERY word below, return exactly one object with:\n' +
        '- "word": the word exactly as given\n' +
        '- "ipa": British English IPA (e.g. /\u02c8w\u025c\u02d0d/)\n' +
        '- "vi": concise Vietnamese translation (1-5 words)\n\n' +
        'CRITICAL: Include ALL ' + wordBatch.length + ' words. No skipping.\n\n' +
        'Words:\n' + wordBatch.join('\n') + '\n\n' +
        'Return ONLY the JSON array.';

      var modelIdx = 0;
      function tryModel() {
        if (modelIdx >= MODELS.length) return Promise.reject(new Error('All models failed'));
        var model = MODELS[modelIdx++];
        return fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' + model +
          ':generateContent?key=' + encodeURIComponent(apiKey),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 4096, temperature: 0.1 }
            })
          }
        ).then(function(r) {
          if (r.status === 429) {
            return new Promise(function(res){ setTimeout(res, 3000); }).then(function(){
              return tryModel();
            });
          }
          if (!r.ok) return r.json().catch(function(){ return {}; }).then(function(e){
            throw new Error((e.error && e.error.message) || 'HTTP ' + r.status + ' on ' + model);
          });
          return r.json();
        }).then(function(d) {
          var text = (((d.candidates||[])[0]||{}).content||{}).parts;
          text = text ? text.map(function(p){ return p.text||''; }).join('') : '';
          if (!text) throw new Error('Empty response from ' + model);
          return text.trim();
        }).catch(function(err) {
          if (modelIdx < MODELS.length) return tryModel();
          throw err;
        });
      }
      return tryModel().then(function(raw) {
        raw = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        // Robustly close truncated JSON
        var opens  = (raw.match(/\{/g)||[]).length;
        var closes = (raw.match(/\}/g)||[]).length;
        if (opens > closes) {
          // Close last object and array
          raw = raw.replace(/,?\s*$/, '') + '}]';
        }
        if (!raw.endsWith(']')) raw = raw + ']';
        return JSON.parse(raw);
      });
    }

    function runBatches(idx) {
      if (idx >= batches.length) return Promise.resolve(result);
      var b = batches[idx];
      return callGemini(b.words).then(function(arr) {
        arr.forEach(function(item, j) {
          var ri = b.offset + j;
          if (ri >= result.length) return;
          if (item.ipa) result[ri].ipa = item.ipa;
          if (item.vi)  { result[ri].vi = item.vi; result[ri].meaningVi = item.vi; }
        });
        if (onProgress) onProgress(b.offset + b.words.length, parsed.length);
        // 600ms between batches to avoid rate limit
        if (idx < batches.length - 1) {
          return new Promise(function(res){ setTimeout(res, 600); }).then(function(){
            return runBatches(idx + 1);
          });
        }
        return result;
      }).catch(function(err) {
        console.warn('Batch ' + (idx+1) + ' failed:', err.message);
        if (onProgress) onProgress(b.offset + b.words.length, parsed.length);
        // Continue to next batch even on error
        return runBatches(idx + 1);
      });
    }

    return runBatches(0);
  };


  global.VM = VM;
})(window);
