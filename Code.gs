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
  SHEET_ID: 'PASTE_SHEET_ID_CUA_LISTEN_DICTATION_VAO_DAY',
  DEFAULT_TEACHER_PASS: 'CHANGE_ME_TEACHER_PASS', // dùng khi Settings chưa có TeacherPassword
  TABS: {
    USERS:    'Users',
    CLASSES:  'Classes',
    SESSIONS: 'Sessions',
    SETTINGS: 'Settings'
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
  if (action === 'session.delete')              return sessionDelete(user, p);
  if (action === 'student.checkBookTestPart')   return studentCheckBookTestPart(user, p);

  // Teacher-only actions
  if (user.role === 'Teacher') {
    if (action === 'teacher.getClasses')      return teacherGetClasses(p);
    if (action === 'teacher.createClass')     return teacherCreateClass(user, p);
    if (action === 'teacher.setClassStatus')  return teacherSetClassStatus(p);
    if (action === 'teacher.archiveClass')    return teacherArchiveClass(p);
    if (action === 'teacher.getRoster')       return teacherGetRoster(p);
    if (action === 'teacher.archiveStudent')  return teacherArchiveStudent(p);
    if (action === 'teacher.getAllSessions')  return teacherGetAllSessions(p);
    if (action === 'teacher.getSessionDetail') return teacherGetSessionDetail(p);
    if (action === 'teacher.exportSessions')  return teacherExportSessions(p);
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
    Sessions: [
      'SessionID', 'StudentID', 'StudentName', 'ClassID', 'ClassName', 'BookTestPart',
      'StartTime', 'EndTime', 'DurationMin',
      'ScriptText', 'CorrectedScriptJSON', 'CEFRJSON', 'CollocationJSON',
      'QuizJSON', 'GapFillJSON', 'DictationJSON',
      'QuizScore', 'GapFillScore', 'DictationAccuracy', 'TotalScore',
      'CreatedAt'
      // NOTE: audio is intentionally NOT persisted server-side (decided against it — simpler to
      // just have the student re-attach the file/link when they resume than to store and manage
      // audio references). See resumeSession()'s audio-reattach prompt in student.html.
    ],
    Settings: ['Key', 'Value']
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
// ClassName là trường hiển thị chính (đã chốt) — mọi nơi trả user/session đều kèm className.
function classNameOf(classId) {
  if (!classId) return '';
  var cid = String(classId).trim().toUpperCase();
  var cls = sheetToObjects(getSheet(CONFIG.TABS.CLASSES)).find(function (c) {
    return String(c.ClassID).trim().toUpperCase() === cid;
  });
  return cls ? String(cls.ClassName || cid) : cid;
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
    var rows = sheetToObjects(sheet);
    var user = rows.find(function (u) {
      return String(u.StudentID).trim() === idOrEmail ||
        String(u.Email || '').trim().toLowerCase() === lower;
    });
    if (!user) return { success: false, error: 'Không tìm thấy tài khoản.' };
    if (String(user.Password) !== pass) return { success: false, error: 'Sai mật khẩu.' };
    if (String(user.Status) === 'Archived') return { success: false, error: 'Tài khoản đã bị khoá. Liên hệ giảng viên.' };

    var token = Utilities.getUuid();
    // Không cap số phiên đồng thời (đã chốt) — chỉ append token mới vào danh sách.
    var allRows = sheet.getDataRange().getValues();
    var hdrs = allRows[0];
    var iSID = hdrs.indexOf('StudentID'), iEmail = hdrs.indexOf('Email'), iTok = hdrs.indexOf('SessionToken');
    for (var i = 1; i < allRows.length; i++) {
      var sameId = iSID >= 0 && String(allRows[i][iSID]) === String(user.StudentID) && String(user.StudentID) !== '';
      var sameEmail = iEmail >= 0 && String(allRows[i][iEmail]).toLowerCase() === String(user.Email).toLowerCase() && String(user.Email) !== '';
      if (sameId || sameEmail) {
        var cur = String(allRows[i][iTok] || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
        cur.push(token);
        sheet.getRange(i + 1, iTok + 1).setValue(cur.join(','));
        break;
      }
    }
    return {
      success: true, sessionToken: token,
      user: {
        studentId: String(user.StudentID || ''), fullName: String(user.FullName || ''),
        classId: String(user.ClassID || ''), className: classNameOf(user.ClassID),
        email: String(user.Email || ''), role: String(user.Role || 'Student')
      }
    };
  } catch (e) { return { success: false, error: e.message }; }
}

function authTeacherLogin(p) {
  var r = authLogin(p);
  if (r.success && r.user.role !== 'Teacher') return { success: false, error: 'Tài khoản này không phải GV.' };
  return r;
}

function validateUser(token) {
  if (!token) return null;
  var rows = sheetToObjects(getSheet(CONFIG.TABS.USERS));
  var user = rows.find(function (u) {
    return String(u.SessionToken || '').split(',').some(function (t) { return t.trim() === String(token); });
  });
  if (!user || String(user.Status) === 'Archived') return null;
  return {
    studentId: String(user.StudentID || ''), fullName: String(user.FullName || ''),
    classId: String(user.ClassID || ''), className: classNameOf(user.ClassID),
    email: String(user.Email || ''), role: String(user.Role || 'Student')
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

// ─── SESSIONS ───────────────────────────────────────────────
function sessionStart(user, p) {
  try {
    var id = genId();
    getSheet(CONFIG.TABS.SESSIONS).appendRow([
      id, user.studentId, user.fullName, user.classId, user.className, p.bookTestPart || '',
      nowIso(), '', '',
      '', '', '', '',
      '', '', '',
      '', '', '', '',
      nowIso()
    ]);
    return { success: true, sessionId: id };
  } catch (e) { return { success: false, error: e.message }; }
}

function _findSessionRow(sessionId, studentId) {
  var sheet = getSheet(CONFIG.TABS.SESSIONS);
  var data = sheet.getDataRange().getValues(), hdrs = data[0];
  var iId = hdrs.indexOf('SessionID'), iSid = hdrs.indexOf('StudentID');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][iId]) === String(sessionId)) {
      if (studentId && String(data[i][iSid]) !== String(studentId)) return null; // chống mở nhầm session người khác
      return { sheet: sheet, hdrs: hdrs, rowIdx: i + 1, row: data[i] };
    }
  }
  return null;
}
function _setCell(found, colName, value) {
  var idx = found.hdrs.indexOf(colName);
  if (idx < 0) return;
  found.sheet.getRange(found.rowIdx, idx + 1).setValue(value);
}
function _getCell(found, colName) {
  var idx = found.hdrs.indexOf(colName);
  return idx < 0 ? '' : found.row[idx];
}
// Google Sheets returns an untouched numeric cell as '' (empty string), not null/undefined —
// so `value != null` alone doesn't correctly detect "not set yet" and would render "%" instead
// of "—" on the client. Normalize here once instead of patching every consumer.
function _numOrNull(v) {
  return (v === '' || v === null || v === undefined) ? null : v;
}

function sessionSaveAnalysis(user, p) {
  try {
    var f = _findSessionRow(p.sessionId, user.studentId);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    _setCell(f, 'ScriptText', p.scriptText || '');
    _setCell(f, 'CorrectedScriptJSON', JSON.stringify(p.correctedSentences || []));
    _setCell(f, 'CEFRJSON', JSON.stringify(p.cefr || {}));
    _setCell(f, 'CollocationJSON', JSON.stringify(p.collocations || []));
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

// Quiz & Gap-fill: KHÔNG cho lưu dở dang — server từ chối nếu chưa làm đủ (đã chốt).
// Quiz (đã chốt round 2): client gửi lên TOÀN BỘ các lượt làm (attempts) — mỗi lượt là 1 bộ
// 15 câu (rút từ pool 30 câu AI sinh 1 lần, không tốn thêm token khi làm lại). Chỉ chấp nhận
// lưu khi lượt CUỐI CÙNG đúng 15/15 — đó là điều kiện bắt buộc để vào Gap-fill.
function sessionSaveQuiz(user, p) {
  try {
    var attempts = p.attempts || [];
    if (!attempts.length) return { success: false, error: 'Thiếu dữ liệu các lượt làm Quiz.' };
    var last = attempts[attempts.length - 1];
    if (!last || !last.answers || last.answers.length !== 15 || last.correct !== 15) {
      return { success: false, error: 'Quiz phải đúng 15/15 ở lượt làm cuối cùng mới được lưu.' };
    }
    var f = _findSessionRow(p.sessionId, user.studentId);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    // Lưu toàn bộ attempts (mỗi attempt kèm "questions" gốc + "answers" đã chọn) để GV xem lại
    // được cả những lượt làm sai trước đó, không chỉ lượt cuối đúng hết.
    _setCell(f, 'QuizJSON', JSON.stringify({ attempts: attempts, attemptsCount: attempts.length, savedAt: nowIso() }));
    _setCell(f, 'QuizScore', p.score != null ? p.score : 100);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}
function sessionSaveGapFill(user, p) {
  try {
    var answers = p.answers || [];
    var total = p.total || answers.length;
    if (!total || answers.length !== total) return { success: false, error: 'Gap-fill phải điền hết mới được lưu (' + answers.length + '/' + total + ').' };
    var f = _findSessionRow(p.sessionId, user.studentId);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    _setCell(f, 'GapFillJSON', JSON.stringify({ answers: answers, correct: p.correct, total: total, savedAt: nowIso() }));
    _setCell(f, 'GapFillScore', p.score != null ? p.score : Math.round((p.correct || 0) / total * 100));
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

// Dictation: DUY NHẤT cho phép checkpoint (đã chốt). Gọi bao nhiêu lần cũng được, ghi đè.
function sessionSaveDictationProgress(user, p) {
  try {
    var f = _findSessionRow(p.sessionId, user.studentId);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    _setCell(f, 'DictationJSON', JSON.stringify({
      currentSentenceIdx: p.currentSentenceIdx || 0,
      answers: p.answers || [],
      completed: false,
      savedAt: nowIso()
    }));
    return { success: true, sessionId: p.sessionId }; // sessionId = "IDsavesession" cho My History
  } catch (e) { return { success: false, error: e.message }; }
}
function sessionFinishDictation(user, p) {
  try {
    var f = _findSessionRow(p.sessionId, user.studentId);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    var accuracy = p.accuracy != null ? p.accuracy : 0;
    _setCell(f, 'DictationJSON', JSON.stringify({ answers: p.answers || [], accuracy: accuracy, completed: true, savedAt: nowIso() }));
    _setCell(f, 'DictationAccuracy', accuracy);
    var quizScore = Number(_getCell(f, 'QuizScore')) || 0;
    var gapScore = Number(_getCell(f, 'GapFillScore')) || 0;
    var total = Math.round((quizScore + gapScore + accuracy) / 3);
    _setCell(f, 'TotalScore', total);
    _setCell(f, 'EndTime', nowIso());
    var start = new Date(_getCell(f, 'StartTime'));
    var durMin = isNaN(start.getTime()) ? '' : Math.round((Date.now() - start.getTime()) / 60000);
    _setCell(f, 'DurationMin', durMin);
    return { success: true, totalScore: total };
  } catch (e) { return { success: false, error: e.message }; }
}

// GAS + Sheets đọc TOÀN BỘ sheet mỗi lần gọi (không index, không truy vấn có điều kiện) — sheet
// càng nhiều dòng thì càng chậm, và payload trả về càng nặng nếu không lọc trước (bài học từ
// Fluentalk). Mặc định chỉ trả 7 ngày gần nhất; SV bấm "Show all" (p.showAll=true) mới tải hết.
function studentGetHistory(user, p) {
  try {
    var rows = sheetToObjects(getSheet(CONFIG.TABS.SESSIONS)).filter(function (r) {
      if (String(r.StudentID) !== String(user.studentId)) return false;
      try { return JSON.parse(r.DictationJSON || '{}').completed === true; } catch (e) { return false; }
    });
    if (!(p && p.showAll)) {
      var cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      rows = rows.filter(function (r) { return new Date(r.StartTime) >= cutoff; });
    }
    rows.sort(function (a, b) { return new Date(b.StartTime) - new Date(a.StartTime); });
    return {
      success: true, data: rows.map(function (r) {
        return {
          sessionId: r.SessionID, bookTestPart: r.BookTestPart, startTime: r.StartTime, endTime: r.EndTime,
          durationMin: r.DurationMin, quizScore: _numOrNull(r.QuizScore), gapFillScore: _numOrNull(r.GapFillScore),
          dictationAccuracy: _numOrNull(r.DictationAccuracy), totalScore: _numOrNull(r.TotalScore)
        };
      })
    };
  } catch (e) { return { success: false, error: e.message }; }
}
// "In progress" = student saved SOMETHING for this session (Quiz pass, Gap-fill pass, or a
// Dictation checkpoint) but hasn't finished Dictation yet. Stage tells the client which screen
// to resume into: 'gapfill' (Quiz passed, Gap-fill not yet saved — redo Gap-fill from scratch,
// since it has no partial save) or 'dictation' (Gap-fill passed — resume/start Dictation,
// using the DictationJSON checkpoint if one exists).
function studentGetInProgress(user) {
  try {
    var rows = sheetToObjects(getSheet(CONFIG.TABS.SESSIONS)).filter(function (r) {
      if (String(r.StudentID) !== String(user.studentId)) return false;
      var finished = false;
      try { finished = JSON.parse(r.DictationJSON || '{}').completed === true; } catch (e) {}
      if (finished) return false;
      return !!r.QuizJSON || !!r.GapFillJSON || !!r.DictationJSON;
    });
    rows.sort(function (a, b) { return new Date(b.StartTime) - new Date(a.StartTime); });
    return {
      success: true, data: rows.map(function (r) {
        var dj = {}; try { dj = r.DictationJSON ? JSON.parse(r.DictationJSON) : {}; } catch (e) {}
        var stage = r.GapFillJSON ? 'dictation' : 'gapfill';
        return {
          sessionId: r.SessionID, bookTestPart: r.BookTestPart, startTime: r.StartTime,
          stage: stage, savedAt: dj.savedAt || r.StartTime, currentSentenceIdx: dj.currentSentenceIdx || 0,
          quizScore: _numOrNull(r.QuizScore), gapFillScore: _numOrNull(r.GapFillScore)
        };
      })
    };
  } catch (e) { return { success: false, error: e.message }; }
}
function studentResumeSession(user, p) {
  try {
    var f = _findSessionRow(p.sessionId, user.studentId); // gate: StudentID + SessionID
    if (!f) return { success: false, error: 'Không tìm thấy hoặc không có quyền mở session này.' };
    var obj = {}; f.hdrs.forEach(function (h, i) { obj[h] = f.row[i]; });
    ['CorrectedScriptJSON', 'CEFRJSON', 'CollocationJSON', 'QuizJSON', 'GapFillJSON', 'DictationJSON'].forEach(function (k) {
      try { obj[k] = obj[k] ? JSON.parse(obj[k]) : null; } catch (e) { obj[k] = null; }
    });
    return { success: true, data: obj };
  } catch (e) { return { success: false, error: e.message }; }
}
// Student-initiated delete — e.g. they pasted the wrong script or misread the teacher's
// instructions. Gated by StudentID + SessionID (same as resume), so a student can only delete
// their own sessions. Row is physically removed — once deleted, the teacher no longer sees it
// and it's not counted anywhere.
function sessionDelete(user, p) {
  try {
    var f = _findSessionRow(p.sessionId, user.studentId);
    if (!f) return { success: false, error: 'Không tìm thấy hoặc không có quyền xoá session này.' };
    f.sheet.deleteRow(f.rowIdx);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}
// Lightweight lookup used by the Setup screen to warn a student BEFORE they start a new session
// if they already have one (in progress or completed) with the same Book/Test/Part — likely a
// typo in the book info, or they forgot they already did this test. They can still proceed;
// this is a warning, not a hard block (duplicates are allowed — they can delete the old one from
// History if it was a mistake).
function studentCheckBookTestPart(user, p) {
  try {
    var target = String(p.bookTestPart || '').trim().toLowerCase();
    if (!target) return { success: true, data: [] };
    var rows = sheetToObjects(getSheet(CONFIG.TABS.SESSIONS)).filter(function (r) {
      return String(r.StudentID) === String(user.studentId) && String(r.BookTestPart || '').trim().toLowerCase() === target;
    });
    rows.sort(function (a, b) { return new Date(b.StartTime) - new Date(a.StartTime); });
    return { success: true, data: rows.map(function (r) { return { sessionId: r.SessionID, startTime: r.StartTime }; }) };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── TEACHER: SESSIONS DASHBOARD ──────────────────────────────
// Chỉ trả cột tóm tắt cho bảng — không kèm JSON blob nặng, đúng tinh thần "nhẹ payload".
// Server-side default cùng lý do như studentGetHistory(): nếu client lỡ gọi mà không kèm
// fromDate (bug, tab cũ chưa load lại, v.v.) thì vẫn không kéo cả sheet — mặc định 7 ngày gần
// nhất trừ khi client chủ động gửi p.showAll=true (nút "Show all" trên UI GV).
function teacherGetAllSessions(p) {
  try {
    var rows = sheetToObjects(getSheet(CONFIG.TABS.SESSIONS));
    // Đã chốt: chỉ hiện session khi SV đã hoàn thành ÍT NHẤT 1 phần (Quiz/Gap-fill/Dictation).
    // Session mới tạo (mới paste script, mới học vocab) chưa làm gì thì KHÔNG hiện cho GV.
    rows = rows.filter(function (r) { return !!r.QuizJSON || !!r.GapFillJSON || !!r.DictationJSON; });
    if (p && p.classId) rows = rows.filter(function (r) { return String(r.ClassID).toUpperCase() === String(p.classId).toUpperCase(); });
    if (p && p.fromDate) rows = rows.filter(function (r) { return new Date(r.StartTime) >= new Date(p.fromDate); });
    else if (!(p && p.showAll)) {
      var cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      rows = rows.filter(function (r) { return new Date(r.StartTime) >= cutoff; });
    }
    if (p && p.toDate) rows = rows.filter(function (r) { return new Date(r.StartTime) <= new Date(p.toDate); });
    return {
      success: true, data: rows.map(function (r) {
        return {
          sessionId: r.SessionID, studentId: r.StudentID, studentName: r.StudentName,
          className: r.ClassName, bookTestPart: r.BookTestPart,
          startTime: r.StartTime, endTime: r.EndTime, durationMin: r.DurationMin,
          quizScore: _numOrNull(r.QuizScore), gapFillScore: _numOrNull(r.GapFillScore),
          dictationAccuracy: _numOrNull(r.DictationAccuracy), totalScore: _numOrNull(r.TotalScore)
        };
      })
    };
  } catch (e) { return { success: false, error: e.message }; }
}
function teacherGetSessionDetail(p) {
  try {
    var f = _findSessionRow(p.sessionId, null); // GV được xem mọi SV, không gate theo studentId
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    var obj = {}; f.hdrs.forEach(function (h, i) { obj[h] = f.row[i]; });
    ['CorrectedScriptJSON', 'CEFRJSON', 'CollocationJSON', 'QuizJSON', 'GapFillJSON', 'DictationJSON'].forEach(function (k) {
      try { obj[k] = obj[k] ? JSON.parse(obj[k]) : null; } catch (e) { obj[k] = null; }
    });
    return { success: true, data: obj };
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
