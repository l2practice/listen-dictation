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
    SESSIONS: 'Sessions',
    SETTINGS: 'Settings',
    HOMEWORK: 'Homework'
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

  // Homework Book + Report Doc (Homework.gs)
  var hw = hwRoute(action, user, p);
  if (hw) return hw;

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
    if (action === 'teacher.clearSessionData')   return teacherClearSessionData(p);
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
    Sessions: [
      'SessionID', 'StudentID', 'StudentName', 'ClassID', 'ClassName', 'BookTestPart',
      'StartTime', 'EndTime', 'DurationMin',
      'ScriptText', 'CorrectedScriptJSON', 'CEFRJSON', 'CollocationJSON',
      'QuizJSON', 'GapFillJSON', 'DictationJSON',
      'QuizScore', 'GapFillScore', 'DictationAccuracy', 'TotalScore',
      'CreatedAt',
      // Homework.gs — ensureColumns tự thêm vào cuối sheet hiện có
      'HomeworkID', 'DocURL', 'DetailPurgedAt'
    ],
    Settings: ['Key', 'Value'],
    Homework: ['HomeworkID', 'ClassID', 'ClassName', 'Book', 'Test', 'Part', 'BookTestPart',
               'Deadline', 'Note', 'Status', 'CreatedBy', 'CreatedAt']
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

function validateUser(token) {
  if (!token) return null;
  var tok = String(token);
  var allRows = getSheet(CONFIG.TABS.USERS).getDataRange().getValues();
  if (allRows.length < 2) return null;
  var hdrs = allRows[0];
  var iSID  = hdrs.indexOf('StudentID'), iName = hdrs.indexOf('FullName');
  var iCls  = hdrs.indexOf('ClassID'),   iEmail = hdrs.indexOf('Email');
  var iRole = hdrs.indexOf('Role'),      iStat = hdrs.indexOf('Status');
  var iTok  = hdrs.indexOf('SessionToken');
  for (var i = 1; i < allRows.length; i++) {
    var row = allRows[i];
    if (String(row[iStat]) === 'Archived') continue;
    var tokens = String(row[iTok] || '').split(',');
    var match = false;
    for (var j = 0; j < tokens.length; j++) { if (tokens[j].trim() === tok) { match = true; break; } }
    if (!match) continue;
    var classId = String(row[iCls] || '');
    return {
      studentId: String(row[iSID] || ''), fullName: String(row[iName] || ''),
      classId: classId, className: classNameOf(classId),
      email: String(row[iEmail] || ''), role: String(row[iRole] || 'Student')
    };
  }
  return null;
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
    var id = genId(), now = nowIso();
    var sheet = getSheet(CONFIG.TABS.SESSIONS);
    // Ghi theo tên cột (không theo vị trí) — sheet có thể có thêm cột mới ở cuối
    var rec = {
      SessionID: id, StudentID: user.studentId, StudentName: user.fullName,
      ClassID: user.classId, ClassName: user.className, BookTestPart: p.bookTestPart || '',
      StartTime: now, CreatedAt: now,
      HomeworkID: hwResolveHomeworkId_(user, p.homeworkId, p.bookTestPart)
    };
    var hdrs = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    sheet.appendRow(hdrs.map(function (h) { return rec[h] != null ? rec[h] : ''; }));
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

// Trạng thái từng phần dựa vào CỘT ĐIỂM, không dựa vào JSON — vì JSON chi tiết bị xoá sau 10 ngày
// (Homework.gs) nhưng kết quả vẫn phải hiện cho GV và SV. get(colName) → giá trị ô.
function _progressOf(get) {
  var has = function (v) { return v !== '' && v != null; };
  var dj = {};
  try { dj = JSON.parse(get('DictationJSON') || '{}') || {}; } catch (e) {}
  var quizDone = has(get('QuizScore')), gapDone = has(get('GapFillScore'));
  var dictDone = has(get('DictationAccuracy')) || dj.completed === true;
  var dictInProgress = !dictDone && dj.completed === false;
  return {
    quizDone: quizDone, gapDone: gapDone, dictDone: dictDone, dictInProgress: dictInProgress,
    hasActivity: quizDone || gapDone || dictDone || dictInProgress || !!get('QuizJSON') || !!get('GapFillJSON')
  };
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
function sessionSaveQuiz(user, p) {
  try {
    var answers = p.answers || [];
    if (answers.length !== 15) return { success: false, error: 'Quiz phải làm đủ 15/15 câu mới được lưu (hiện ' + answers.length + ').' };
    var f = _findSessionRow(p.sessionId, user.studentId);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    // Lưu cả "questions" (đề bài AI đã sinh) — không chỉ đáp án — để GV xem lại được SV đã chọn gì so với câu hỏi gốc.
    _setCell(f, 'QuizJSON', JSON.stringify({ questions: p.questions || [], answers: answers, correct: p.correct, total: 15, savedAt: nowIso() }));
    _setCell(f, 'QuizScore', p.score != null ? p.score : Math.round((p.correct || 0) / 15 * 100));
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

function studentGetHistory(user, p) {
  try {
    var rows = sheetToObjects(getSheet(CONFIG.TABS.SESSIONS)).filter(function (r) {
      if (String(r.StudentID) !== String(user.studentId)) return false;
      return _progressOf(function (k) { return r[k]; }).dictDone;
    });
    rows.sort(function (a, b) { return new Date(b.StartTime) - new Date(a.StartTime); });
    return {
      success: true, data: rows.map(function (r) {
        return {
          sessionId: r.SessionID, bookTestPart: r.BookTestPart, startTime: r.StartTime, endTime: r.EndTime,
          durationMin: r.DurationMin, quizScore: r.QuizScore, gapFillScore: r.GapFillScore,
          dictationAccuracy: r.DictationAccuracy, totalScore: r.TotalScore
        };
      })
    };
  } catch (e) { return { success: false, error: e.message }; }
}
function studentGetInProgress(user) {
  try {
    var rows = sheetToObjects(getSheet(CONFIG.TABS.SESSIONS)).filter(function (r) {
      if (String(r.StudentID) !== String(user.studentId)) return false;
      if (!r.DictationJSON) return false;
      try { return JSON.parse(r.DictationJSON).completed === false; } catch (e) { return false; }
    });
    rows.sort(function (a, b) { return new Date(b.StartTime) - new Date(a.StartTime); });
    return {
      success: true, data: rows.map(function (r) {
        var dj = {}; try { dj = JSON.parse(r.DictationJSON); } catch (e) {}
        return { sessionId: r.SessionID, bookTestPart: r.BookTestPart, startTime: r.StartTime, savedAt: dj.savedAt, currentSentenceIdx: dj.currentSentenceIdx };
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

// ─── TEACHER: SESSIONS DASHBOARD ──────────────────────────────
// Chỉ trả cột tóm tắt cho bảng — không kèm JSON blob nặng, đúng tinh thần "nhẹ payload".
function teacherGetAllSessions(p) {
  try {
    var rows = sheetToObjects(getSheet(CONFIG.TABS.SESSIONS));
    // Đã chốt: chỉ hiện session khi SV đã hoàn thành ÍT NHẤT 1 phần (Quiz/Gap-fill/Dictation).
    // Session mới tạo (mới paste script, mới học vocab) chưa làm gì thì KHÔNG hiện cho GV.
    rows = rows.filter(function (r) { return _progressOf(function (k) { return r[k]; }).hasActivity; });
    if (p && p.classId) rows = rows.filter(function (r) { return String(r.ClassID).toUpperCase() === String(p.classId).toUpperCase(); });
    if (p && p.fromDate) rows = rows.filter(function (r) { return new Date(r.StartTime) >= new Date(p.fromDate); });
    if (p && p.toDate) rows = rows.filter(function (r) { return new Date(r.StartTime) <= new Date(p.toDate); });
    return {
      success: true, data: rows.map(function (r) {
        return {
          sessionId: r.SessionID, studentId: r.StudentID, studentName: r.StudentName,
          className: r.ClassName, bookTestPart: r.BookTestPart,
          startTime: r.StartTime, endTime: r.EndTime, durationMin: r.DurationMin,
          quizScore: r.QuizScore, gapFillScore: r.GapFillScore, dictationAccuracy: r.DictationAccuracy,
          totalScore: r.TotalScore
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

// ─── TEACHER: FILTERED SESSIONS (lazy load — GV phải chọn filter trước) ────
// Trả về summary nhẹ: không kèm JSON blobs. GV phải chọn ít nhất classId hoặc fromDate.
function teacherGetFilteredSessions(p) {
  try {
    if (!p || (!p.classId && !p.fromDate && !p.bookFilter)) {
      return { success: false, error: 'Vui lòng chọn ít nhất một bộ lọc (lớp, ngày bắt đầu, hoặc book) trước khi tải.' };
    }
    var sheet = getSheet(CONFIG.TABS.SESSIONS);
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { success: true, data: [] };
    var hdrs = data[0];
    // Map header → col index một lần cho hiệu suất
    var ci = {};
    hdrs.forEach(function(h,i){ ci[h]=i; });

    var fromDate = p.fromDate ? new Date(p.fromDate) : null;
    var toDate = p.toDate ? new Date(p.toDate + 'T23:59:59') : null;
    var classId = p.classId ? String(p.classId).toUpperCase() : '';
    var bookFilter = p.bookFilter ? String(p.bookFilter).toLowerCase() : '';
    var testFilter = p.testFilter ? String(p.testFilter).trim() : '';
    var partFilter = p.partFilter ? String(p.partFilter).trim() : '';

    var results = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      // Bỏ qua session chưa làm gì (không có Quiz/GapFill/Dictation)
      if (!_progressOf(function (k) { return row[ci[k]]; }).hasActivity) continue;
      // Filter class
      if (classId && String(row[ci['ClassID']] || '').toUpperCase() !== classId) continue;
      // Filter date
      var st = row[ci['StartTime']];
      if (st) {
        var d = new Date(st);
        if (fromDate && d < fromDate) continue;
        if (toDate && d > toDate) continue;
      }
      // Filter book/test/part — match từng phần của BookTestPart (vd "Cam14 Test 3 Part 2")
      var btp = String(row[ci['BookTestPart']] || '');
      if (bookFilter && btp.toLowerCase().indexOf(bookFilter.toLowerCase()) < 0) continue;
      if (testFilter) {
        // Match "Test X" hoặc "TestX" — flexible
        var testRe = new RegExp('Test\\s*' + testFilter + '(\\s|$)', 'i');
        if (!testRe.test(btp)) continue;
      }
      if (partFilter) {
        var partRe = new RegExp('Part\\s*' + partFilter + '(\\s|$)', 'i');
        if (!partRe.test(btp)) continue;
      }
      results.push({
        sessionId: row[ci['SessionID']], studentId: row[ci['StudentID']],
        studentName: row[ci['StudentName']], classId: row[ci['ClassID']],
        className: row[ci['ClassName']], bookTestPart: row[ci['BookTestPart']],
        startTime: row[ci['StartTime']] instanceof Date ? row[ci['StartTime']].toISOString() : row[ci['StartTime']],
        endTime: row[ci['EndTime']] instanceof Date ? row[ci['EndTime']].toISOString() : row[ci['EndTime']],
        durationMin: row[ci['DurationMin']],
        quizScore: row[ci['QuizScore']], gapFillScore: row[ci['GapFillScore']],
        dictationAccuracy: row[ci['DictationAccuracy']], totalScore: row[ci['TotalScore']],
        docUrl: row[ci['DocURL']] || '', detailPurged: !!row[ci['DetailPurgedAt']]
      });
    }
    // Sắp xếp mới nhất lên đầu
    results.sort(function(a,b){ return new Date(b.startTime) - new Date(a.startTime); });
    return { success: true, data: results, count: results.length };
  } catch (e) { return { success: false, error: e.message }; }
}

// Trả danh sách book, test, part có trong sheet — cho filter dropdown
function teacherGetFilterOptions(p) {
  try {
    var sheet = getSheet(CONFIG.TABS.SESSIONS);
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { success: true, books: [], classes: [] };
    var hdrs = data[0];
    var iBtp = hdrs.indexOf('BookTestPart'), iCls = hdrs.indexOf('ClassName'), iCid = hdrs.indexOf('ClassID');
    var booksSet = {}, classesMap = {};
    for (var i = 1; i < data.length; i++) {
      var btp = String(data[i][iBtp] || '').trim();
      // Trích Book (phần đầu trước số test, vd "Cam14 Test 3 Part 2" → "Cam14")
      if (btp) {
        var book = btp.split(/\s+/)[0];
        if (book) booksSet[book] = true;
      }
      var cid = String(data[i][iCid] || '').trim();
      var cn = String(data[i][iCls] || '').trim();
      if (cid && cn) classesMap[cid] = cn;
    }
    return {
      success: true,
      books: Object.keys(booksSet).sort(),
      classes: Object.keys(classesMap).map(function(id){ return { classId: id, className: classesMap[id] }; })
        .sort(function(a,b){ return a.className.localeCompare(b.className); })
    };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── TEACHER: CLEAR SESSION DATA ────────────────────────────
// Xoá: ScriptText, CorrectedScriptJSON, CEFRJSON, CollocationJSON, QuizJSON, GapFillJSON, DictationJSON
// Giữ lại: điểm số, ngày giờ làm, tên bài, thông tin SV
// Dùng batch setValues() — KHÔNG gọi setValue() từng cell (sẽ timeout với sheet lớn)
function teacherClearSessionData(p) {
  try {
    if (!p || !p.fromDate || !p.toDate) {
      return { success: false, error: 'Cần chọn khoảng ngày để clear.' };
    }
    var fromDate = new Date(p.fromDate);
    var toDate = new Date(p.toDate + 'T23:59:59');
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return { success: false, error: 'Ngày không hợp lệ.' };
    }
    var classId = p.classId ? String(p.classId).toUpperCase() : '';

    var sheet = getSheet(CONFIG.TABS.SESSIONS);
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { success: true, cleared: 0 };
    var hdrs = data[0];
    var ci = {};
    hdrs.forEach(function(h, i) { ci[h] = i; });

    var CLEAR_COLS = ['ScriptText','CorrectedScriptJSON','CEFRJSON','CollocationJSON','QuizJSON','GapFillJSON','DictationJSON'];
    var clearIdx = CLEAR_COLS.map(function(c) { return ci[c]; }).filter(function(i) { return i >= 0; });
    if (!clearIdx.length) return { success: true, cleared: 0 };

    // Đọc toàn bộ range một lần — ghi lại toàn bộ một lần (batch)
    var colMin = Math.min.apply(null, clearIdx); // cột đầu tiên cần xoá (0-indexed)
    var colMax = Math.max.apply(null, clearIdx); // cột cuối cùng cần xoá (0-indexed)
    var numCols = colMax - colMin + 1;
    var numRows = data.length - 1; // số hàng dữ liệu (bỏ header)

    // Đọc sub-range chính xác (chỉ những cột cần xoá)
    var subRange = sheet.getRange(2, colMin + 1, numRows, numCols);
    var subValues = subRange.getValues(); // numRows × numCols

    // relative index của từng CLEAR_COL trong sub-range
    var relIdx = clearIdx.map(function(ci) { return ci - colMin; });

    var clearedCount = 0;
    for (var i = 0; i < numRows; i++) {
      var rowData = data[i + 1]; // data[0] = headers
      var st = rowData[ci['StartTime']];
      if (!st) continue;
      var d = new Date(st);
      if (d < fromDate || d > toDate) continue;
      if (classId && String(rowData[ci['ClassID']] || '').toUpperCase() !== classId) continue;
      // An toàn: chỉ xoá chi tiết của bài ĐÃ có Google Doc lưu trữ (Homework.gs)
      if (!rowData[ci['DocURL']]) continue;

      // Kiểm tra có gì để xoá không
      var hasData = relIdx.some(function(ri) {
        return String(subValues[i][ri] || '').length > 0;
      });
      if (!hasData) continue;

      // Xoá trong bản sao — sẽ ghi lại 1 lần sau
      relIdx.forEach(function(ri) { subValues[i][ri] = ''; });
      clearedCount++;
    }

    if (clearedCount > 0) {
      // Ghi toàn bộ sub-range 1 lần duy nhất — không phụ thuộc số session
      subRange.setValues(subValues);
    }

    return {
      success: true, cleared: clearedCount,
      message: 'Đã xoá dữ liệu chi tiết của ' + clearedCount + ' session(s). Điểm số và thông tin làm bài vẫn được giữ lại.'
    };
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── STUDENT: LIGHTWEIGHT HISTORY ───────────────────────────
// Chỉ trả tên bài + điểm. Các bài thiếu điểm (incomplete) được đánh dấu để client biết cần fetch thêm.
function studentGetHistorySummary(user, p) {
  try {
    var sheet = getSheet(CONFIG.TABS.SESSIONS);
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { success: true, data: [] };
    var hdrs = data[0];
    var ci = {};
    hdrs.forEach(function(h,i){ ci[h]=i; });

    // fromDate filter — chỉ lấy session trong khoảng thời gian
    var fromDate = (p && p.fromDate) ? new Date(p.fromDate) : null;

    var rows = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (String(row[ci['StudentID']]) !== String(user.studentId)) continue;
      // Chỉ hiện session đã bắt đầu làm ít nhất 1 phần
      var prog = _progressOf(function (k) { return row[ci[k]]; });
      if (!prog.hasActivity) continue;
      // fromDate filter
      if (fromDate) {
        var st = row[ci['StartTime']];
        var sessionDate = st instanceof Date ? st : new Date(st);
        if (isNaN(sessionDate.getTime()) || sessionDate < fromDate) continue;
      }

      var quizDone = prog.quizDone, gapDone = prog.gapDone, dictDone = prog.dictDone;

      rows.push({
        sessionId: row[ci['SessionID']],
        bookTestPart: row[ci['BookTestPart']],
        startTime: row[ci['StartTime']] instanceof Date ? row[ci['StartTime']].toISOString() : row[ci['StartTime']],
        endTime: row[ci['EndTime']] instanceof Date ? row[ci['EndTime']].toISOString() : row[ci['EndTime']],
        durationMin: row[ci['DurationMin']],
        quizScore: quizDone ? row[ci['QuizScore']] : null,
        gapFillScore: gapDone ? row[ci['GapFillScore']] : null,
        dictationAccuracy: dictDone ? row[ci['DictationAccuracy']] : null,
        totalScore: row[ci['TotalScore']],
        quizDone: quizDone, gapDone: gapDone, dictDone: dictDone,
        isComplete: quizDone && gapDone && dictDone,
        dictInProgress: prog.dictInProgress,
        docUrl: row[ci['DocURL']] || ''
      });
    }
    rows.sort(function(a,b){ return new Date(b.startTime) - new Date(a.startTime); });
    return { success: true, data: rows };
  } catch (e) { return { success: false, error: e.message }; }
}

// Top 5 in-progress dictation sessions (nhẹ hơn getInProgress — không load toàn bộ DictationJSON)
function studentGetInProgressTop5(user) {
  try {
    var sheet = getSheet(CONFIG.TABS.SESSIONS);
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { success: true, data: [] };
    var hdrs = data[0];
    var ci = {};
    hdrs.forEach(function(h,i){ ci[h]=i; });

    var rows = [];
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (String(row[ci['StudentID']]) !== String(user.studentId)) continue;
      var dj = String(row[ci['DictationJSON']] || '');
      if (!dj) continue;
      var parsed; try { parsed = JSON.parse(dj); } catch(e) { continue; }
      if (parsed.completed !== false) continue;
      rows.push({
        sessionId: row[ci['SessionID']],
        bookTestPart: row[ci['BookTestPart']],
        startTime: row[ci['StartTime']] instanceof Date ? row[ci['StartTime']].toISOString() : row[ci['StartTime']],
        savedAt: parsed.savedAt || '',
        currentSentenceIdx: parsed.currentSentenceIdx || 0
      });
    }
    rows.sort(function(a,b){ return new Date(b.savedAt || b.startTime) - new Date(a.savedAt || a.startTime); });
    return { success: true, data: rows.slice(0, 5) }; // chỉ 5 bài gần nhất
  } catch (e) { return { success: false, error: e.message }; }
}

// Sinh viên tự xoá session của mình — chỉ được xoá nếu đúng StudentID
function studentDeleteSession(user, p) {
  try {
    var sheet = getSheet(CONFIG.TABS.SESSIONS);
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { success: false, error: 'Session không tồn tại.' };
    var hdrs = data[0];
    var ci = {};
    hdrs.forEach(function(h, i) { ci[h] = i; });
    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      if (String(row[ci['SessionID']]) !== String(p.sessionId)) continue;
      // Kiểm tra quyền: chỉ xoá được session của chính mình
      if (String(row[ci['StudentID']]) !== String(user.studentId)) {
        return { success: false, error: 'Bạn không có quyền xoá bài này.' };
      }
      // Bài đã nộp đủ 3 phần là kết quả chính thức cho GV thống kê → không cho SV xoá
      var prog = _progressOf(function (k) { return row[ci[k]]; });
      if (prog.quizDone && prog.gapDone && prog.dictDone) {
        return { success: false, error: 'Bài đã hoàn thành đủ 3 phần — không thể xoá.' };
      }
      // Bài thuộc Homework Book (kể cả đang làm dở) là bằng chứng quá trình làm bài cho GV → không cho xoá
      if (hwIsAssigned_(user, row[ci['HomeworkID']], row[ci['BookTestPart']])) {
        return { success: false, error: 'Bài này thuộc bài tập GV đã giao — không thể xoá.' };
      }
      sheet.deleteRow(i + 1); // +1 vì data[0] là header, sheet row 1 = data[0]
      return { success: true };
    }
    return { success: false, error: 'Không tìm thấy session.' };
  } catch (e) { return { success: false, error: e.message }; }
}
