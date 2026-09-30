// ============================================================
// LisDictation — Apps Script Backend (Code.gs)
// Sheet: "Listen Dictation" — https://docs.google.com/spreadsheets/d/1r6wq4xMYV_yM67Y-tw-LIfQHRofbNx3GiWs4lUwsmmU
// Deploy: Extensions ▸ Apps Script ▸ dán file này ▸ Deploy ▸ New deployment
//         ▸ Web app ▸ Execute as: Me ▸ Who has access: Anyone
//         ▸ copy /exec URL vào GAS_URL trong ld-common.js
//
// Kiến trúc (đã chốt với Thanh-Tu):
//  - 1 sheet Users + cột Role (Student|Teacher) — theo Fluentalk, KHÔNG tách Students/Teachers.
//  - SessionToken verify server-side mỗi request (theo Fluentalk) — KHÔNG cap số phiên đồng thời.
//  - Mã lớp: LD-XXXXXX (3 chữ + 3 số, bỏ ký tự dễ nhầm 0/O/1/I/L) — theo Fluentalk.
//  - Password: plaintext, không hash (theo yêu cầu).
//  - ClassName là trường hiển thị chính; ClassID chỉ dùng nội bộ để join dữ liệu.
//  - Quiz & Gap-fill: KHÔNG cho lưu dở dang — chỉ ghi 1 lần khi làm xong hết.
//  - Dictation: DUY NHẤT cho phép lưu dở dang (checkpoint), resume qua StudentID+SessionID.
//  - AI (Gemini) gọi trực tiếp từ client, KHÔNG qua Apps Script — Code.gs không có action ai.*.
// ============================================================

var CONFIG = {
  SHEET_ID: '1r6wq4xMYV_yM67Y-tw-LIfQHRofbNx3GiWs4lUwsmmU',
  DEFAULT_TEACHER_PASS: 'CHANGE_ME_TEACHER_PASS', // dùng khi Settings chưa có TeacherPassword
  TABS: {
    USERS:    'Users',
    CLASSES:  'Classes',
    RESULTS:  'Results',         // 1 dòng/bài: thông tin + điểm (nhẹ) — mọi danh sách chỉ đọc tab này
    DETAILS:  'SessionDetails',  // 1 dòng/bài: script + bài làm JSON (nặng) — chỉ đọc đúng 1 dòng khi cần
    LEGACY:   'Sessions',        // tab cũ (1 tab chứa tất cả) — chỉ đọc khi chạy rp_migrateSessions()
    SETTINGS: 'Settings',
    REVIEWS:  'Reviews'
  }
};

// ─── ENTRY POINTS ────────────────────────────────────────────
function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action || '';
    var p      = body.payload || {};
    var tok    = body.sessionToken || '';
    return out(routeAction(action, p, tok));
  } catch (err) {
    return out({ success: false, error: err.message });
  }
}

function doGet(e) {
  if (!e || !e.parameter || !e.parameter.action)
    return HtmlService.createHtmlOutput('<h2>LisDictation API ✓</h2>');
  var cb     = e.parameter.callback || 'cb';
  var action = e.parameter.action || '';
  var p      = JSON.parse(e.parameter.payload || '{}');
  var tok    = e.parameter.sessionToken || '';
  var result = routeAction(action, p, tok);
  return ContentService
    .createTextOutput(cb + '(' + JSON.stringify(result) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ─── ROUTER ──────────────────────────────────────────────────
function routeAction(action, p, tok) {
  if (action === 'ping') return { pong: true };

  // Public — không cần token
  if (action === 'auth.register')        return authRegister(p);
  if (action === 'auth.registerTeacher') return authRegisterTeacher(p);
  if (action === 'auth.login')           return authLogin(p);
  if (action === 'auth.teacherLogin')    return authTeacherLogin(p);
  if (action === 'auth.forgotPassword')  return authForgotPassword(p);
  if (action === 'auth.verifyCode')      return authVerifyCode(p);
  if (action === 'auth.resetPassword')   return authResetPassword(p);

  var user = validateUser(tok);
  if (!user) return { success: false, error: 'SESSION_EXPIRED' };

  // Report Doc + New Practice (Reports.gs)
  var rp = rpRoute(action, user, p);
  if (rp) return rp;

  // Student actions — mọi Role đều dùng chung (Teacher cũng có thể gọi nếu cần test)
  if (action === 'session.start')               return sessionStart(user, p);
  if (action === 'session.saveAnalysis')        return sessionSaveAnalysis(user, p);
  if (action === 'session.saveQuiz')            return sessionSaveQuiz(user, p);
  if (action === 'session.saveGapFill')         return sessionSaveGapFill(user, p);
  if (action === 'session.saveDictationProgress') return sessionSaveDictationProgress(user, p);
  if (action === 'session.finishDictation')     return sessionFinishDictation(user, p);
  if (action === 'student.getHistory')          return studentGetHistory(user, p);
  if (action === 'student.getInProgress')       return studentGetInProgress(user);
  if (action === 'student.resumeSession')       return studentResumeSession(user, p);

  // Student lightweight actions
  if (action === 'student.getHistorySummary')  return studentGetHistorySummary(user, p);
  if (action === 'student.getInProgressTop5')  return studentGetInProgressTop5(user);
  if (action === 'student.deleteSession')      return studentDeleteSession(user, p);

  // Teacher-only actions
  if (user.role === 'Teacher') {
    if (action === 'teacher.getClasses')         return teacherGetClasses(p);
    if (action === 'teacher.createClass')        return teacherCreateClass(user, p);
    if (action === 'teacher.setClassStatus')     return teacherSetClassStatus(p);
    if (action === 'teacher.archiveClass')       return teacherArchiveClass(p);
    if (action === 'teacher.getRoster')          return teacherGetRoster(p);
    if (action === 'teacher.archiveStudent')     return teacherArchiveStudent(p);
    if (action === 'teacher.getAllSessions')     return teacherGetAllSessions(p);
    if (action === 'teacher.getFilteredSessions') return teacherGetFilteredSessions(p);
    if (action === 'teacher.getSessionDetail')   return teacherGetSessionDetail(p);
    if (action === 'teacher.exportSessions')     return teacherExportSessions(p);
    if (action === 'teacher.getFilterOptions')   return teacherGetFilterOptions(p);
  }

  return { success: false, error: 'Unknown action or không đủ quyền: ' + action };
}

// ─── SPREADSHEET HELPERS ─────────────────────────────────────
var _ss = null;
function getSS() { if (!_ss) _ss = SpreadsheetApp.openById(CONFIG.SHEET_ID); return _ss; }
var _colChecked = {};
function getSheet(name) {
  var ss = getSS();
  var sheet = ss.getSheetByName(name);
  if (!sheet) { sheet = ss.insertSheet(name); initHeaders(sheet, name); }
  else if (!_colChecked[name]) { _colChecked[name] = true; ensureColumns(sheet, name); }
  return sheet;
}
function ensureColumns(sheet, name) {
  try {
    var want = headerSpec()[name];
    if (!want || sheet.getLastRow() === 0) return;
    var have = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
    var missing = want.filter(function (h) { return have.indexOf(h) < 0; });
    if (!missing.length) return;
    sheet.getRange(1, have.length + 1, 1, missing.length).setValues([missing])
      .setFontWeight('bold').setBackground('#1A1A16').setFontColor('#ffffff');
  } catch (e) {}
}
function sheetToObjects(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0];
  return data.slice(1).map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}
function serRows(rows) {
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) { if (r[k] instanceof Date) r[k] = r[k].toISOString(); });
  });
  return rows;
}
function nowIso() { return new Date().toISOString(); }
function genId() { return Utilities.getUuid().replace(/-/g, '').substring(0, 16).toUpperCase(); }

function headerSpec() {
  return {
    Users: ['StudentID', 'FullName', 'ClassID', 'Email', 'Phone', 'Password', 'Role', 'Status', 'SessionToken', 'RegisteredAt'],
    Classes: ['ClassID', 'ClassName', 'AcademicYear', 'Semester', 'TeacherName', 'TeacherEmail', 'Status', 'CreatedAt'],
    // Kết quả: nhẹ, không có JSON. DictInProgress/DictSavedAt/DictSentenceIdx = Dictation đang lưu dở.
    Results: [
      'SessionID', 'StudentID', 'StudentName', 'ClassID', 'ClassName', 'BookTestPart',
      'StartTime', 'EndTime', 'DurationMin',
      'QuizScore', 'GapFillScore', 'DictationAccuracy', 'TotalScore', 'CreatedAt',
      'DocURL', 'DetailPurgedAt', 'DictInProgress', 'DictSavedAt', 'DictSentenceIdx'
    ],
    // Chi tiết: nặng. Sau 10 ngày (đã có Doc) cả dòng bị xoá — Results giữ điểm + link Doc.
    SessionDetails: [
      'SessionID', 'StudentID', 'ScriptText', 'CorrectedScriptJSON', 'CEFRJSON', 'CollocationJSON',
      'QuizJSON', 'GapFillJSON', 'DictationJSON', 'CreatedAt'
    ],
    Settings: ['Key', 'Value'],
    // Reports.gs — mốc GV đã tick "Done" cho từng nhóm Lớp + Book/Test/Part trong tab New Practice
    Reviews: ['GroupKey', 'ClassID', 'BookTestPart', 'ReviewedUpTo', 'PrevReviewedUpTo', 'ReviewedAt', 'ReviewedBy']
  };
}
function initHeaders(sheet, name) {
  var H = headerSpec();
  if (H[name]) {
    sheet.appendRow(H[name]);
    sheet.getRange(1, 1, 1, H[name].length).setFontWeight('bold').setBackground('#1A1A16').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
}

// ─── SETTINGS ────────────────────────────────────────────────
function getSetting(key) {
  try {
    var rows = getSheet(CONFIG.TABS.SETTINGS).getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) if (rows[i][0] === key) return rows[i][1];
  } catch (e) {}
  return null;
}
function setSetting(key, value) {
  var sheet = getSheet(CONFIG.TABS.SETTINGS);
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) if (rows[i][0] === key) { sheet.getRange(i + 1, 2).setValue(value); return; }
  sheet.appendRow([key, value]);
}

// ─── AUTH ─────────────────────────────────────────────────────
// Cache tên lớp trong 1 request — tránh đọc sheet Classes nhiều lần
var _classNameCache = null;
function classNameOf(classId) {
  if (!classId) return '';
  var cid = String(classId).trim().toUpperCase();
  if (!_classNameCache) {
    _classNameCache = {};
    sheetToObjects(getSheet(CONFIG.TABS.CLASSES)).forEach(function (c) {
      _classNameCache[String(c.ClassID).trim().toUpperCase()] = String(c.ClassName || '');
    });
  }
  return _classNameCache[cid] || cid;
}

function authRegister(p) {
  try {
    var classId = String(p.classId || '').trim().toUpperCase();
    if (!classId) return { success: false, error: 'Cần nhập mã lớp — hỏi giảng viên.' };
    var cls = sheetToObjects(getSheet(CONFIG.TABS.CLASSES)).find(function (c) {
      return String(c.ClassID).trim().toUpperCase() === classId;
    });
    if (!cls) return { success: false, error: 'Mã lớp "' + classId + '" không tồn tại. Kiểm tra lại với giảng viên.' };
    if (String(cls.Status) !== 'Active') return { success: false, error: 'Lớp "' + cls.ClassName + '" hiện không mở đăng ký.' };
    if (!p.studentId || !p.password || !p.fullName) return { success: false, error: 'Nhập đủ họ tên, mã SV và mật khẩu.' };

    var sheet = getSheet(CONFIG.TABS.USERS);
    var rows = sheetToObjects(sheet);
    if (rows.some(function (u) { return String(u.StudentID) === String(p.studentId); }))
      return { success: false, error: 'Mã SV đã tồn tại.' };
    if (p.email && rows.some(function (u) { return String(u.Email).toLowerCase() === String(p.email).toLowerCase(); }))
      return { success: false, error: 'Email này đã được đăng ký.' };

    sheet.appendRow([
      p.studentId, p.fullName, classId, p.email || '', p.phone || '',
      p.password, 'Student', 'Active', '', nowIso()
    ]);
    return { success: true, message: 'Chào mừng vào lớp ' + cls.ClassName + '! Đăng nhập ngay.' };
  } catch (e) { return { success: false, error: e.message }; }
}

// Đăng ký GV — tự do đăng ký (giống ArticuWrite/Fluentalk), Thanh-Tu chủ động khoá bằng
// cách đổi Status='Archived' trên sheet Users nếu có tài khoản GV lạ.
function authRegisterTeacher(p) {
  try {
    if (!p.email || !p.password || !p.fullName) return { success: false, error: 'Nhập đủ họ tên, email, mật khẩu.' };
    var sheet = getSheet(CONFIG.TABS.USERS);
    var rows = sheetToObjects(sheet);
    if (rows.some(function (u) { return String(u.Email).toLowerCase() === String(p.email).toLowerCase(); }))
      return { success: false, error: 'Email đã tồn tại.' };
    sheet.appendRow(['', p.fullName, '', p.email, p.phone || '', p.password, 'Teacher', 'Active', '', nowIso()]);
    return { success: true, message: 'Tạo tài khoản GV thành công.' };
  } catch (e) { return { success: false, error: e.message }; }
}

function authLogin(p) {
  try {
    var idOrEmail = String(p.studentId || p.email || p.login || '').trim();
    var pass = String(p.password || '');
    if (!idOrEmail || !pass) return { success: false, error: 'Nhập đủ tài khoản và mật khẩu.' };
    var lower = idOrEmail.toLowerCase();

    var sheet = getSheet(CONFIG.TABS.USERS);
    // Đọc sheet 1 lần duy nhất — không gọi sheetToObjects riêng rồi getDataRange lại
    var allRows = sheet.getDataRange().getValues();
    if (allRows.length < 2) return { success: false, error: 'Không tìm thấy tài khoản.' };
    var hdrs = allRows[0];
    var iSID  = hdrs.indexOf('StudentID'),  iName  = hdrs.indexOf('FullName');
    var iCls  = hdrs.indexOf('ClassID'),    iEmail = hdrs.indexOf('Email');
    var iPass = hdrs.indexOf('Password'),   iRole  = hdrs.indexOf('Role');
    var iStat = hdrs.indexOf('Status'),     iTok   = hdrs.indexOf('SessionToken');

    var foundIdx = -1;
    for (var i = 1; i < allRows.length; i++) {
      var sid = String(allRows[i][iSID] || '').trim();
      var em  = String(allRows[i][iEmail] || '').trim().toLowerCase();
      if (sid === idOrEmail || em === lower) { foundIdx = i; break; }
    }
    if (foundIdx < 0) return { success: false, error: 'Không tìm thấy tài khoản.' };

    var row = allRows[foundIdx];
    if (String(row[iPass]) !== pass) return { success: false, error: 'Sai mật khẩu.' };
    if (String(row[iStat]) === 'Archived') return { success: false, error: 'Tài khoản đã bị khoá. Liên hệ giảng viên.' };

    var token = Utilities.getUuid();
    // Giữ tối đa 10 token gần nhất — tránh chuỗi token vô hạn
    var cur = String(row[iTok] || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    cur.push(token);
    if (cur.length > 10) cur = cur.slice(cur.length - 10);
    sheet.getRange(foundIdx + 1, iTok + 1).setValue(cur.join(','));

    var classId = String(row[iCls] || '');
    return {
      success: true, sessionToken: token,
      user: {
        studentId: String(row[iSID] || ''), fullName: String(row[iName] || ''),
        classId: classId, className: classNameOf(classId),
        email: String(row[iEmail] || ''), role: String(row[iRole] || 'Student')
      }
    };
  } catch (e) { return { success: false, error: e.message }; }
}

function authTeacherLogin(p) {
  var r = authLogin(p);
  if (r.success && r.user.role !== 'Teacher') return { success: false, error: 'Tài khoản này không phải GV.' };
  return r;
}

// Chạy ở MỌI request → không đọc cả tab Users: TextFinder tìm token ngay trên Google rồi đọc đúng 1 dòng
function validateUser(token) {
  if (!token) return null;
  var tok = String(token).trim();
  if (!tok) return null;
  var sheet = getSheet(CONFIG.TABS.USERS), n = sheet.getLastRow() - 1;
  if (n < 1) return null;
  var hdrs = _headers(CONFIG.TABS.USERS);
  var iTok = hdrs.indexOf('SessionToken');
  if (iTok < 0) return null;
  var cell = sheet.getRange(2, iTok + 1, n, 1).createTextFinder(tok).matchEntireCell(false).findNext();
  if (!cell) return null;
  var row = sheet.getRange(cell.getRow(), 1, 1, hdrs.length).getValues()[0];
  var col = function (k) { return row[hdrs.indexOf(k)]; };
  // Ô chứa tối đa 10 token nối bằng dấu phẩy → xác nhận khớp NGUYÊN token, không chỉ chứa chuỗi con
  var match = String(col('SessionToken') || '').split(',').some(function (t) { return t.trim() === tok; });
  if (!match || String(col('Status')) === 'Archived') return null;
  var classId = String(col('ClassID') || '');
  return {
    studentId: String(col('StudentID') || ''), fullName: String(col('FullName') || ''),
    classId: classId, className: classNameOf(classId),
    email: String(col('Email') || ''), role: String(col('Role') || 'Student')
  };
}

function authForgotPassword(p) {
  try {
    var email = String(p.email || '').trim().toLowerCase();
    if (!email) return { success: false, error: 'Nhập email đã đăng ký.' };
    var user = sheetToObjects(getSheet(CONFIG.TABS.USERS)).find(function (u) { return String(u.Email).toLowerCase() === email; });
    if (!user) return { success: false, error: 'Không tìm thấy email này.' };
    var code = Math.floor(100000 + Math.random() * 900000).toString();
    var expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    setSetting('reset_' + email.replace(/[@.]/g, '_'), code + '|' + expiry);
    try {
      MailApp.sendEmail({ to: email, subject: '[LisDictation] Mã khôi phục mật khẩu', body: 'Mã của bạn: ' + code + '\nHết hạn sau 15 phút.' });
      return { success: true, emailSent: true };
    } catch (e) { return { success: true, emailSent: false, code: code }; }
  } catch (e) { return { success: false, error: e.message }; }
}
function authVerifyCode(p) {
  var raw = getSetting('reset_' + String(p.email || '').toLowerCase().replace(/[@.]/g, '_'));
  if (!raw) return { success: false, error: 'Chưa yêu cầu khôi phục.' };
  var parts = raw.split('|');
  if (new Date() > new Date(parts[1])) return { success: false, error: 'Mã đã hết hạn.' };
  if (String(p.code) !== parts[0]) return { success: false, error: 'Sai mã.' };
  return { success: true };
}
function authResetPassword(p) {
  var v = authVerifyCode(p);
  if (!v.success) return v;
  var sheet = getSheet(CONFIG.TABS.USERS);
  var data = sheet.getDataRange().getValues();
  var hdrs = data[0];
  var iEmail = hdrs.indexOf('Email'), iPass = hdrs.indexOf('Password');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iEmail]).toLowerCase() === String(p.email).toLowerCase()) {
      sheet.getRange(i + 1, iPass + 1).setValue(p.newPassword);
      setSetting('reset_' + String(p.email).toLowerCase().replace(/[@.]/g, '_'), '');
      return { success: true };
    }
  }
  return { success: false, error: 'Không tìm thấy tài khoản.' };
}

// ─── CLASSES ────────────────────────────────────────────────
// Mã dễ đọc/gõ tay: 3 chữ + 3 số, loại 0/O/1/I/L (theo Fluentalk).
function genClassCode() {
  var A = 'ABCDEFGHJKMNPQRSTUVWXYZ', N = '23456789';
  var existing = {};
  sheetToObjects(getSheet(CONFIG.TABS.CLASSES)).forEach(function (c) { existing[String(c.ClassID).trim().toUpperCase()] = true; });
  for (var attempt = 0; attempt < 50; attempt++) {
    var code = 'LD-';
    for (var i = 0; i < 3; i++) code += A.charAt(Math.floor(Math.random() * A.length));
    for (var j = 0; j < 3; j++) code += N.charAt(Math.floor(Math.random() * N.length));
    if (!existing[code]) return code;
  }
  return 'LD-' + genId().substring(0, 6);
}

function teacherCreateClass(user, p) {
  try {
    var className = String(p.className || '').trim();
    if (!className) return { success: false, error: 'Nhập tên lớp.' };
    var classId = genClassCode();
    getSheet(CONFIG.TABS.CLASSES).appendRow([
      classId, className, p.academicYear || '', p.semester || '',
      user.fullName || '', user.email || '', 'Active', nowIso()
    ]);
    return { success: true, classId: classId, className: className };
  } catch (e) { return { success: false, error: e.message }; }
}

function teacherGetClasses(p) {
  try {
    var classes = serRows(sheetToObjects(getSheet(CONFIG.TABS.CLASSES)));
    if (p && p.teacherEmail) classes = classes.filter(function (c) { return String(c.TeacherEmail).toLowerCase() === String(p.teacherEmail).toLowerCase(); });
    var users = sheetToObjects(getSheet(CONFIG.TABS.USERS));
    classes.forEach(function (c) {
      var cid = String(c.ClassID || '').toUpperCase();
      c.StudentCount = users.filter(function (u) { return String(u.ClassID || '').toUpperCase() === cid && String(u.Status) !== 'Archived' && u.Role === 'Student'; }).length;
    });
    // ClassName ưu tiên hiển thị — sắp xếp theo tên lớp cho GV dễ tìm.
    classes.sort(function (a, b) { return String(a.ClassName).localeCompare(String(b.ClassName)); });
    return { success: true, data: classes };
  } catch (e) { return { success: false, error: e.message }; }
}

function teacherSetClassStatus(p) {
  try {
    var sheet = getSheet(CONFIG.TABS.CLASSES);
    var data = sheet.getDataRange().getValues(), hdrs = data[0];
    var iId = hdrs.indexOf('ClassID'), iSt = hdrs.indexOf('Status');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][iId]) === String(p.classId)) { sheet.getRange(i + 1, iSt + 1).setValue(p.status || 'Active'); return { success: true }; }
    }
    return { success: false, error: 'Không tìm thấy lớp.' };
  } catch (e) { return { success: false, error: e.message }; }
}
function teacherArchiveClass(p) { return teacherSetClassStatus({ classId: p.classId, status: 'Archived' }); }

function teacherGetRoster(p) {
  try {
    var users = sheetToObjects(getSheet(CONFIG.TABS.USERS)).filter(function (u) {
      return u.Role === 'Student' && (!p.classId || String(u.ClassID).toUpperCase() === String(p.classId).toUpperCase());
    });
    return {
      success: true, data: users.map(function (u) {
        return { studentId: u.StudentID, fullName: u.FullName, email: u.Email, phone: u.Phone, status: u.Status, className: classNameOf(u.ClassID) };
      })
    };
  } catch (e) { return { success: false, error: e.message }; }
}
function teacherArchiveStudent(p) {
  try {
    var sheet = getSheet(CONFIG.TABS.USERS);
    var data = sheet.getDataRange().getValues(), hdrs = data[0];
    var iId = hdrs.indexOf('StudentID'), iSt = hdrs.indexOf('Status');
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][iId]) === String(p.studentId)) { sheet.getRange(i + 1, iSt + 1).setValue(p.archived === false ? 'Active' : 'Archived'); return { success: true }; }
    }
    return { success: false, error: 'Không tìm thấy SV.' };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── SESSIONS: Results (nhẹ) + SessionDetails (nặng) ─────────────
// Nguyên tắc đọc dữ liệu để app không chậm dần theo thời gian:
//  - Tìm 1 bài: TextFinder tìm SessionID ngay trên Google (không tải cả cột về) rồi đọc đúng 1 dòng.
//  - Danh sách: chỉ đọc các cột cần trong Results, gộp thành 1 lần đọc (_readCols).
//  - SessionDetails: KHÔNG BAO GIỜ đọc cả tab.
var _hdrCache = {};
function _headers(tab) {
  if (!_hdrCache[tab]) { var sh = getSheet(tab); _hdrCache[tab] = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]; }
  return _hdrCache[tab];
}

// Đọc các cột theo tên — 1 lần gọi cho dải cột nhỏ nhất bao trọn các cột cần. Trả về mảng object.
function _readCols(tab, names) {
  var sheet = getSheet(tab), hdrs = _headers(tab), n = sheet.getLastRow() - 1;
  var idx = names.map(function (k) { return hdrs.indexOf(k); });
  var have = idx.filter(function (c) { return c >= 0; });
  if (n < 1 || !have.length) return [];
  var c0 = Math.min.apply(null, have), c1 = Math.max.apply(null, have);
  var vals = sheet.getRange(2, c0 + 1, n, c1 - c0 + 1).getValues();
  return vals.map(function (row, r) {
    var o = { _row: r + 2 };
    names.forEach(function (k, j) { o[k] = idx[j] >= 0 ? row[idx[j] - c0] : ''; });
    return o;
  });
}

// Tìm dòng theo SessionID (cột A) bằng TextFinder → chỉ đọc đúng dòng đó
function _findRowById(tab, sessionId) {
  if (!sessionId) return null;
  var sheet = getSheet(tab), hdrs = _headers(tab), n = sheet.getLastRow() - 1;
  var col = hdrs.indexOf('SessionID');
  if (col < 0 || n < 1) return null;
  var cell = sheet.getRange(2, col + 1, n, 1).createTextFinder(String(sessionId)).matchEntireCell(true).findNext();
  if (!cell) return null;
  var rowIdx = cell.getRow();
  return { sheet: sheet, hdrs: hdrs, rowIdx: rowIdx, row: sheet.getRange(rowIdx, 1, 1, hdrs.length).getValues()[0] };
}
function _setCell(found, colName, value) {
  var idx = found.hdrs.indexOf(colName);
  if (idx < 0) return;
  found.sheet.getRange(found.rowIdx, idx + 1).setValue(value);
  found.row[idx] = value;
}
function _getCell(found, colName) {
  var idx = found.hdrs.indexOf(colName);
  return idx < 0 ? '' : found.row[idx];
}
function _rowObj(found) { var o = {}; found.hdrs.forEach(function (h, i) { o[h] = found.row[i]; }); return o; }
function _iso(v) { return v instanceof Date ? v.toISOString() : v; }
function _has(v) { return v !== '' && v != null; }

// Session của SV: dòng Results (+ dòng SessionDetails nếu cần). studentId = null → GV, không gate.
function _findSession(sessionId, studentId, withDetail) {
  var r = _findRowById(CONFIG.TABS.RESULTS, sessionId);
  if (!r) return null;
  if (studentId && String(_getCell(r, 'StudentID')) !== String(studentId)) return null; // chống mở bài người khác
  return { res: r, det: withDetail ? _findRowById(CONFIG.TABS.DETAILS, sessionId) : null };
}
function _detailOrCreate(f) {
  if (f.det) return f.det;
  var sheet = getSheet(CONFIG.TABS.DETAILS), hdrs = _headers(CONFIG.TABS.DETAILS);
  var rec = { SessionID: _getCell(f.res, 'SessionID'), StudentID: _getCell(f.res, 'StudentID'), CreatedAt: nowIso() };
  sheet.appendRow(hdrs.map(function (h) { return rec[h] != null ? rec[h] : ''; }));
  f.det = _findRowById(CONFIG.TABS.DETAILS, rec.SessionID);
  return f.det;
}

// Trạng thái từng phần — chỉ dựa vào cột trong Results. get(colName) → giá trị ô.
function _progressOf(get) {
  var quizDone = _has(get('QuizScore')), gapDone = _has(get('GapFillScore')), dictDone = _has(get('DictationAccuracy'));
  var dictInProgress = !dictDone && !!get('DictInProgress');
  return {
    quizDone: quizDone, gapDone: gapDone, dictDone: dictDone, dictInProgress: dictInProgress,
    isComplete: quizDone && gapDone && dictDone,
    hasActivity: quizDone || gapDone || dictDone || dictInProgress
  };
}
var RESULT_LIST_COLS = ['SessionID', 'StudentID', 'StudentName', 'ClassID', 'ClassName', 'BookTestPart',
  'StartTime', 'EndTime', 'DurationMin', 'QuizScore', 'GapFillScore', 'DictationAccuracy', 'TotalScore',
  'DocURL', 'DetailPurgedAt', 'DictInProgress', 'DictSavedAt', 'DictSentenceIdx'];

function sessionStart(user, p) {
  try {
    // Mở đầu bằng chữ cái: mã toàn số/dạng "12E45…" sẽ bị Sheets tự đổi thành số và hỏng mã
    var id = 'S' + genId().substring(0, 15), now = nowIso();
    var res = { SessionID: id, StudentID: user.studentId, StudentName: user.fullName, ClassID: user.classId,
                ClassName: user.className, BookTestPart: p.bookTestPart || '', StartTime: now, CreatedAt: now };
    var det = { SessionID: id, StudentID: user.studentId, CreatedAt: now };
    // Ghi theo tên cột (không theo vị trí) — tab có thể có thêm cột mới ở cuối
    getSheet(CONFIG.TABS.RESULTS).appendRow(_headers(CONFIG.TABS.RESULTS).map(function (h) { return res[h] != null ? res[h] : ''; }));
    getSheet(CONFIG.TABS.DETAILS).appendRow(_headers(CONFIG.TABS.DETAILS).map(function (h) { return det[h] != null ? det[h] : ''; }));
    return { success: true, sessionId: id };
  } catch (e) { return { success: false, error: e.message }; }
}

function sessionSaveAnalysis(user, p) {
  try {
    var f = _findSession(p.sessionId, user.studentId, true);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    var d = _detailOrCreate(f);
    _setCell(d, 'ScriptText', p.scriptText || '');
    _setCell(d, 'CorrectedScriptJSON', JSON.stringify(p.correctedSentences || []));
    _setCell(d, 'CEFRJSON', JSON.stringify(p.cefr || {}));
    _setCell(d, 'CollocationJSON', JSON.stringify(p.collocations || []));
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

// Quiz & Gap-fill: KHÔNG cho lưu dở dang — server từ chối nếu chưa làm đủ (đã chốt).
function sessionSaveQuiz(user, p) {
  try {
    var answers = p.answers || [];
    if (answers.length !== 15) return { success: false, error: 'Quiz phải làm đủ 15/15 câu mới được lưu (hiện ' + answers.length + ').' };
    var f = _findSession(p.sessionId, user.studentId, true);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    // Lưu cả "questions" (đề bài AI đã sinh) — để GV xem lại SV đã chọn gì so với câu hỏi gốc.
    _setCell(_detailOrCreate(f), 'QuizJSON', JSON.stringify({ questions: p.questions || [], answers: answers, correct: p.correct, total: 15, savedAt: nowIso() }));
    _setCell(f.res, 'QuizScore', p.score != null ? p.score : Math.round((p.correct || 0) / 15 * 100));
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}
function sessionSaveGapFill(user, p) {
  try {
    var answers = p.answers || [];
    var total = p.total || answers.length;
    if (!total || answers.length !== total) return { success: false, error: 'Gap-fill phải điền hết mới được lưu (' + answers.length + '/' + total + ').' };
    var f = _findSession(p.sessionId, user.studentId, true);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    _setCell(_detailOrCreate(f), 'GapFillJSON', JSON.stringify({ answers: answers, correct: p.correct, total: total, savedAt: nowIso() }));
    _setCell(f.res, 'GapFillScore', p.score != null ? p.score : Math.round((p.correct || 0) / total * 100));
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

// Chỉ lưu câu SV gõ + trạng thái — câu gốc đã có trong CorrectedScriptJSON.
// Lọc ở server để trang cũ còn trong cache (gửi kèm resultHtml = cả câu script dạng HTML) không làm sheet phình.
function _compactDictAnswers(answers) {
  return (answers || []).map(function (a) {
    a = a || {};
    return { typed: String(a.typed || ''), checked: !!a.checked, attempted: !!(a.attempted || a.checked || a.resultHtml) };
  });
}

// Dictation: DUY NHẤT cho phép checkpoint (đã chốt). Gọi bao nhiêu lần cũng được, ghi đè.
function sessionSaveDictationProgress(user, p) {
  try {
    var f = _findSession(p.sessionId, user.studentId, true);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    var now = nowIso(), idx = p.currentSentenceIdx || 0;
    _setCell(_detailOrCreate(f), 'DictationJSON', JSON.stringify({
      currentSentenceIdx: idx, answers: _compactDictAnswers(p.answers), completed: false, savedAt: now
    }));
    _setCell(f.res, 'DictInProgress', true);
    _setCell(f.res, 'DictSavedAt', now);
    _setCell(f.res, 'DictSentenceIdx', idx);
    return { success: true, sessionId: p.sessionId };
  } catch (e) { return { success: false, error: e.message }; }
}
function sessionFinishDictation(user, p) {
  try {
    var f = _findSession(p.sessionId, user.studentId, true);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    var accuracy = p.accuracy != null ? p.accuracy : 0;
    _setCell(_detailOrCreate(f), 'DictationJSON', JSON.stringify({ answers: _compactDictAnswers(p.answers), accuracy: accuracy, completed: true, savedAt: nowIso() }));
    var quizScore = Number(_getCell(f.res, 'QuizScore')) || 0;
    var gapScore = Number(_getCell(f.res, 'GapFillScore')) || 0;
    var total = Math.round((quizScore + gapScore + accuracy) / 3);
    var start = new Date(_getCell(f.res, 'StartTime'));
    // Ghi các cột liền nhau của Results trong 1 lần nếu được — ít lời gọi hơn
    _setCell(f.res, 'DictationAccuracy', accuracy);
    _setCell(f.res, 'TotalScore', total);
    _setCell(f.res, 'EndTime', nowIso());
    _setCell(f.res, 'DurationMin', isNaN(start.getTime()) ? '' : Math.round((Date.now() - start.getTime()) / 60000));
    _setCell(f.res, 'DictInProgress', '');
    return { success: true, totalScore: total };
  } catch (e) { return { success: false, error: e.message }; }
}

// Ghép Results + SessionDetails thành 1 object như trước (frontend không phải đổi)
function _sessionObject(f) {
  var obj = _rowObj(f.res);
  var det = f.det ? _rowObj(f.det) : {};
  ['ScriptText', 'CorrectedScriptJSON', 'CEFRJSON', 'CollocationJSON', 'QuizJSON', 'GapFillJSON', 'DictationJSON'].forEach(function (k) {
    if (k === 'ScriptText') { obj[k] = det[k] || ''; return; }
    try { obj[k] = det[k] ? JSON.parse(det[k]) : null; } catch (e) { obj[k] = null; }
  });
  return serRows([obj])[0];
}
function studentResumeSession(user, p) {
  try {
    var f = _findSession(p.sessionId, user.studentId, true); // gate: StudentID + SessionID
    if (!f) return { success: false, error: 'Không tìm thấy hoặc không có quyền mở session này.' };
    return { success: true, data: _sessionObject(f) };
  } catch (e) { return { success: false, error: e.message }; }
}
function teacherGetSessionDetail(p) {
  try {
    var f = _findSession(p.sessionId, null, true); // GV được xem mọi SV
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    return { success: true, data: _sessionObject(f) };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── DANH SÁCH (chỉ đọc Results) ─────────────────────────────
function _summary(r) {
  var prog = _progressOf(function (k) { return r[k]; });
  return {
    sessionId: r.SessionID, studentId: r.StudentID, studentName: r.StudentName, classId: r.ClassID,
    className: r.ClassName, bookTestPart: r.BookTestPart,
    startTime: _iso(r.StartTime), endTime: _iso(r.EndTime), durationMin: r.DurationMin,
    quizScore: prog.quizDone ? r.QuizScore : null, gapFillScore: prog.gapDone ? r.GapFillScore : null,
    dictationAccuracy: prog.dictDone ? r.DictationAccuracy : null, totalScore: _has(r.TotalScore) ? r.TotalScore : null,
    quizDone: prog.quizDone, gapDone: prog.gapDone, dictDone: prog.dictDone,
    isComplete: prog.isComplete, dictInProgress: prog.dictInProgress,
    docUrl: r.DocURL || '', detailPurged: _has(r.DetailPurgedAt)
  };
}
function _byNewest(a, b) { return new Date(b.startTime) - new Date(a.startTime); }

function studentGetHistory(user, p) {
  try {
    var rows = _readCols(CONFIG.TABS.RESULTS, RESULT_LIST_COLS)
      .filter(function (r) { return String(r.StudentID) === String(user.studentId) && _has(r.DictationAccuracy); })
      .map(_summary).sort(_byNewest);
    return { success: true, data: rows };
  } catch (e) { return { success: false, error: e.message }; }
}
function studentGetInProgress(user) {
  try {
    var rows = _readCols(CONFIG.TABS.RESULTS, RESULT_LIST_COLS)
      .filter(function (r) { return String(r.StudentID) === String(user.studentId) && _progressOf(function (k) { return r[k]; }).dictInProgress; })
      .map(function (r) { return { sessionId: r.SessionID, bookTestPart: r.BookTestPart, startTime: _iso(r.StartTime), savedAt: _iso(r.DictSavedAt), currentSentenceIdx: Number(r.DictSentenceIdx) || 0 }; });
    rows.sort(function (a, b) { return new Date(b.savedAt || b.startTime) - new Date(a.savedAt || a.startTime); });
    return { success: true, data: rows };
  } catch (e) { return { success: false, error: e.message }; }
}
// Top 5 bài Dictation đang lưu dở
function studentGetInProgressTop5(user) {
  var r = studentGetInProgress(user);
  if (r.success) r.data = r.data.slice(0, 5);
  return r;
}
// Chỉ trả tên bài + điểm. Bài chưa làm phần nào (mới dán script) không hiện.
function studentGetHistorySummary(user, p) {
  try {
    var fromDate = (p && p.fromDate) ? new Date(p.fromDate) : null;
    var rows = _readCols(CONFIG.TABS.RESULTS, RESULT_LIST_COLS).filter(function (r) {
      if (String(r.StudentID) !== String(user.studentId)) return false;
      if (!_progressOf(function (k) { return r[k]; }).hasActivity) return false;
      if (fromDate) { var d = new Date(r.StartTime); if (isNaN(d.getTime()) || d < fromDate) return false; }
      return true;
    }).map(_summary).sort(_byNewest);
    return { success: true, data: rows };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── TEACHER: SESSIONS DASHBOARD ──────────────────────────────
// Chỉ hiện session khi SV đã hoàn thành ÍT NHẤT 1 phần (Quiz/Gap-fill/Dictation).
function teacherGetAllSessions(p) {
  try {
    var classId = p && p.classId ? String(p.classId).toUpperCase() : '';
    var from = p && p.fromDate ? new Date(p.fromDate) : null, to = p && p.toDate ? new Date(p.toDate + 'T23:59:59') : null;
    var rows = _readCols(CONFIG.TABS.RESULTS, RESULT_LIST_COLS).filter(function (r) {
      if (!_progressOf(function (k) { return r[k]; }).hasActivity) return false;
      if (classId && String(r.ClassID).toUpperCase() !== classId) return false;
      var d = new Date(r.StartTime);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    }).map(_summary).sort(_byNewest);
    return { success: true, data: rows };
  } catch (e) { return { success: false, error: e.message }; }
}
function teacherExportSessions(p) {
  var r = teacherGetAllSessions(p);
  if (!r.success) return r;
  var cols = ['sessionId', 'studentId', 'studentName', 'className', 'bookTestPart', 'startTime', 'durationMin', 'quizScore', 'gapFillScore', 'dictationAccuracy', 'totalScore'];
  var lines = [cols.join(',')].concat(r.data.map(function (d) {
    return cols.map(function (c) { return '"' + String(d[c] == null ? '' : d[c]).replace(/"/g, '""') + '"'; }).join(',');
  }));
  return { success: true, csv: lines.join('\n') };
}

// Lazy load — GV phải chọn ít nhất 1 bộ lọc trước khi tải
function teacherGetFilteredSessions(p) {
  try {
    if (!p || (!p.classId && !p.fromDate && !p.bookFilter)) {
      return { success: false, error: 'Vui lòng chọn ít nhất một bộ lọc (lớp, ngày bắt đầu, hoặc book) trước khi tải.' };
    }
    var fromDate = p.fromDate ? new Date(p.fromDate) : null;
    var toDate = p.toDate ? new Date(p.toDate + 'T23:59:59') : null;
    var classId = p.classId ? String(p.classId).toUpperCase() : '';
    var bookFilter = p.bookFilter ? String(p.bookFilter).toLowerCase() : '';
    var testRe = p.testFilter ? new RegExp('Test\\s*' + String(p.testFilter).trim() + '(\\s|$)', 'i') : null;
    var partRe = p.partFilter ? new RegExp('Part\\s*' + String(p.partFilter).trim() + '(\\s|$)', 'i') : null;
    var results = _readCols(CONFIG.TABS.RESULTS, RESULT_LIST_COLS).filter(function (r) {
      if (!_progressOf(function (k) { return r[k]; }).hasActivity) return false;
      if (classId && String(r.ClassID || '').toUpperCase() !== classId) return false;
      if (r.StartTime) {
        var d = new Date(r.StartTime);
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
      }
      var btp = String(r.BookTestPart || '');
      if (bookFilter && btp.toLowerCase().indexOf(bookFilter) < 0) return false;
      if (testRe && !testRe.test(btp)) return false;
      if (partRe && !partRe.test(btp)) return false;
      return true;
    }).map(_summary).sort(_byNewest);
    return { success: true, data: results, count: results.length };
  } catch (e) { return { success: false, error: e.message }; }
}

// Danh sách book + lớp có trong Results — cho filter dropdown
function teacherGetFilterOptions(p) {
  try {
    var booksSet = {}, classesMap = {};
    _readCols(CONFIG.TABS.RESULTS, ['ClassID', 'ClassName', 'BookTestPart']).forEach(function (r) {
      var book = String(r.BookTestPart || '').trim().split(/\s+/)[0];
      if (book) booksSet[book] = true;
      var cid = String(r.ClassID || '').trim(), cn = String(r.ClassName || '').trim();
      if (cid && cn) classesMap[cid] = cn;
    });
    return {
      success: true, books: Object.keys(booksSet).sort(),
      classes: Object.keys(classesMap).map(function (id) { return { classId: id, className: classesMap[id] }; })
        .sort(function (a, b) { return a.className.localeCompare(b.className); })
    };
  } catch (e) { return { success: false, error: e.message }; }
}

// SV tự xoá bài của mình — chỉ bài CHƯA hoàn thành đủ 3 phần (bài đã xong là kết quả chính thức cho GV)
function studentDeleteSession(user, p) {
  try {
    var f = _findSession(p.sessionId, user.studentId, true);
    if (!f) return { success: false, error: 'Không tìm thấy session hoặc bạn không có quyền xoá bài này.' };
    if (_progressOf(function (k) { return _getCell(f.res, k); }).isComplete) {
      return { success: false, error: 'Bài đã hoàn thành đủ 3 phần — không thể xoá.' };
    }
    if (f.det) f.det.sheet.deleteRow(f.det.rowIdx);
    f.res.sheet.deleteRow(f.res.rowIdx);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}
