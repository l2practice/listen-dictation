// ============================================================
// LisDictation — Homework Book + Report Docs + Auto-purge (Homework.gs)
// Cùng project Apps Script với Code.gs (dùng chung CONFIG, getSheet, _setCell…).
//
// Chức năng:
//  1. Homework Book: GV giao bài (lớp + Book/Test/Part + deadline). SV đăng nhập thấy banner.
//     Trước deadline 24h: email nhắc những SV chưa xong, ghi rõ phần còn thiếu.
//  2. Report Doc: SV nộp đủ 3 phần → tạo Google Doc (script, word levels, collocations,
//     quiz/gap-fill/dictation review) + gửi email kèm PDF.
//     Sau 10 ngày: xoá JSON chi tiết trong sheet Sessions (điểm số giữ nguyên) —
//     GV bấm Detail sẽ mở Doc thay cho trang HTML.
//
// Cài đặt (1 lần): chạy hàm hw_setup() trong editor → cấp quyền Docs/Drive/Mail/Trigger
//   → Deploy ▸ Manage deployments ▸ Edit ▸ Version: New version (giữ nguyên URL /exec).
// ============================================================

var HW = {
  PURGE_AFTER_DAYS: 10,
  REMIND_BEFORE_HOURS: 24,
  EXPORT_BATCH: 8,          // số Doc tạo tối đa mỗi lần cron chạy (quota Docs/Mail cá nhân ~100-250/ngày)
  PURGE_BATCH: 80,
  REPORT_FOLDER: 'LisDictation — Student Reports',
  // 'link' = ai có link đều xem được (SV mở được link trong email, không cần Google account)
  // 'private' = chỉ GV xem; SV vẫn nhận bản PDF đính kèm
  DOC_SHARING: 'link',
  TZ: 'Asia/Ho_Chi_Minh',
  APP_URL: 'https://l2practice.github.io/listen-dictation/login.html',
  DETAIL_COLS: ['ScriptText', 'CorrectedScriptJSON', 'CEFRJSON', 'CollocationJSON', 'QuizJSON', 'GapFillJSON', 'DictationJSON']
};

// ─── ROUTER (gọi từ routeAction trong Code.gs) ───────────────
function hwRoute(action, user, p) {
  p = p || {};
  try {
    if (action === 'homework.mine')        return hwListForStudent(user);
    if (action === 'session.exportReport') return hwExportForStudent(user, p);
    if (user.role === 'Teacher') {
      if (action === 'homework.create')    return hwCreate(user, p);
      if (action === 'homework.update')    return hwUpdate(p);
      if (action === 'homework.delete')    return hwDelete(p);
      if (action === 'homework.list')      return hwListForTeacher(p);
      if (action === 'homework.progress')  return hwProgress(p);
      if (action === 'homework.remind')    return hwRemindNow(p);
    }
    return null; // không phải action của module này
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── SETUP + CRON ────────────────────────────────────────────
function hw_setup() {
  getSheet(CONFIG.TABS.HOMEWORK);
  getSheet(CONFIG.TABS.SESSIONS); // ensureColumns → thêm HomeworkID, DocURL, DocSentAt, DetailPurgedAt
  if (!getSetting('hw_installed_at')) setSetting('hw_installed_at', nowIso());
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hw_hourly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hw_hourly').timeBased().everyHours(1).create();
  hwReportFolder_(); // tạo folder trước để kiểm tra quyền Drive
  Logger.log('Homework module ready. Trigger hw_hourly installed.');
}

// Chạy mỗi giờ: (1) tạo Doc cho bài đã xong (2) nhắc deadline (3) xoá chi tiết > 10 ngày
function hw_hourly() {
  var res = {};
  try { res.exported = hwExportPending_(); } catch (e) { res.exportError = e.message; }
  try { res.reminded = hwSendDueReminders_(); } catch (e) { res.remindError = e.message; }
  try { res.purged = hwPurgeOld_(); } catch (e) { res.purgeError = e.message; }
  Logger.log(JSON.stringify(res));
  return res;
}

// ─── HELPERS ─────────────────────────────────────────────────
function hwTime_(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  var t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}
function hwIso_(v) { var t = hwTime_(v); return t ? new Date(t).toISOString() : ''; }
function hwHas_(v) { return v !== '' && v != null; }
function hwFmt_(v) { var t = hwTime_(v); return t ? Utilities.formatDate(new Date(t), HW.TZ, 'dd/MM/yyyy HH:mm') : '—'; }
function hwBtp_(book, test, part) { return [book, 'Test ' + test, 'Part ' + part].join(' · '); }
// Khoá so khớp BookTestPart: "Cam17 · Test 1 · Part 4" ≡ "cam17 test 1 part 4"
function hwBtpKey_(s) { return String(s || '').toLowerCase().replace(/[·|,]/g, ' ').replace(/\s+/g, ' ').trim(); }
function hwJson_(v, fb) { if (!v) return fb; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return fb; } }
function hwEsc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
// Cùng quy tắc so từ với student.html (checkSentence): bỏ dấu câu/nháy/gạch, không phân biệt hoa thường
function hwWordKey_(w) {
  return String(w || '').replace(/[‘’ʼʹ]/g, "'").replace(/[^a-z0-9]/gi, '').toLowerCase();
}
function hwSheetHeaders_(sheet) { return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]; }

// Đọc riêng vài cột của Sessions (tránh kéo cả JSON blob nặng)
function hwReadSessionCols_(names) {
  var sheet = getSheet(CONFIG.TABS.SESSIONS);
  var hdrs = hwSheetHeaders_(sheet), n = sheet.getLastRow() - 1, cols = {};
  names.forEach(function (name) {
    var c = hdrs.indexOf(name);
    cols[name] = (c >= 0 && n > 0) ? sheet.getRange(2, c + 1, n, 1).getValues().map(function (r) { return r[0]; }) : [];
  });
  return { sheet: sheet, hdrs: hdrs, n: Math.max(n, 0), cols: cols };
}

// Tìm 1 session theo ID mà chỉ đọc cột SessionID + đúng 1 hàng
function hwFindSession_(sessionId) {
  var sheet = getSheet(CONFIG.TABS.SESSIONS);
  var hdrs = hwSheetHeaders_(sheet), iId = hdrs.indexOf('SessionID'), n = sheet.getLastRow() - 1;
  if (iId < 0 || n < 1) return null;
  var ids = sheet.getRange(2, iId + 1, n, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(sessionId)) {
      var row = sheet.getRange(i + 2, 1, 1, hdrs.length).getValues()[0];
      return { sheet: sheet, hdrs: hdrs, rowIdx: i + 2, row: row };
    }
  }
  return null;
}
function hwRowObj_(f) { var o = {}; f.hdrs.forEach(function (h, i) { o[h] = f.row[i]; }); return o; }

// Tiến độ 3 phần của 1 hàng Sessions — dựa vào cột ĐIỂM (không phụ thuộc JSON, vì JSON bị xoá sau 10 ngày)
function hwPartsOf_(quizScore, gapScore, dictAcc) {
  var q = hwHas_(quizScore), g = hwHas_(gapScore), d = hwHas_(dictAcc);
  var missing = [];
  if (!q) missing.push('Quiz');
  if (!g) missing.push('Gap-fill');
  if (!d) missing.push('Dictation');
  return { quizDone: q, gapDone: g, dictDone: d, partsDone: 3 - missing.length, missing: missing };
}

// Index: studentId|btpKey → session tốt nhất (nhiều phần xong nhất, rồi mới nhất)
function hwSessionIndex_(studentIdFilter) {
  var d = hwReadSessionCols_(['SessionID', 'StudentID', 'BookTestPart', 'StartTime', 'EndTime', 'QuizScore', 'GapFillScore', 'DictationAccuracy', 'TotalScore', 'DocURL']);
  var idx = {}, c = d.cols;
  for (var i = 0; i < d.n; i++) {
    var sid = String(c.StudentID[i] || '').trim();
    if (!sid || (studentIdFilter && sid !== String(studentIdFilter))) continue;
    var key = sid.toLowerCase() + '|' + hwBtpKey_(c.BookTestPart[i]);
    var s = hwPartsOf_(c.QuizScore[i], c.GapFillScore[i], c.DictationAccuracy[i]);
    s.sessionId = String(c.SessionID[i]);
    s.startTime = hwIso_(c.StartTime[i]);
    s.endTime = hwIso_(c.EndTime[i]);
    s.totalScore = hwHas_(c.TotalScore[i]) ? c.TotalScore[i] : null;
    s.docUrl = String(c.DocURL[i] || '');
    var prev = idx[key];
    if (!prev || s.partsDone > prev.partsDone || (s.partsDone === prev.partsDone && hwTime_(s.startTime) > hwTime_(prev.startTime))) idx[key] = s;
  }
  return idx;
}

function hwStudentsOf_(classId) {
  var cid = String(classId || '').toUpperCase();
  return sheetToObjects(getSheet(CONFIG.TABS.USERS)).filter(function (u) {
    return u.Role === 'Student' && String(u.Status) !== 'Archived' && String(u.ClassID || '').toUpperCase() === cid;
  }).map(function (u) {
    return { studentId: String(u.StudentID), fullName: String(u.FullName || ''), email: String(u.Email || '').trim() };
  });
}
function hwStudentById_(studentId) {
  var u = sheetToObjects(getSheet(CONFIG.TABS.USERS)).find(function (x) { return String(x.StudentID) === String(studentId); });
  return u ? { studentId: String(u.StudentID), fullName: String(u.FullName || ''), email: String(u.Email || '').trim() } : null;
}

// ─── HOMEWORK SHEET ──────────────────────────────────────────
function hwAllHomework_() {
  var sheet = getSheet(CONFIG.TABS.HOMEWORK);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var hdrs = data[0];
  return data.slice(1).map(function (r, i) {
    var o = { _row: i + 2 };
    hdrs.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  }).filter(function (h) { return h.HomeworkID && h.Status !== 'Deleted'; });
}
function hwSetHwCell_(rowIdx, col, value) {
  var sheet = getSheet(CONFIG.TABS.HOMEWORK);
  var c = hwSheetHeaders_(sheet).indexOf(col);
  if (c >= 0) sheet.getRange(rowIdx, c + 1).setValue(value);
}
function hwPublic_(h) {
  return {
    homeworkId: String(h.HomeworkID), classId: String(h.ClassID), className: String(h.ClassName || classNameOf(h.ClassID)),
    book: String(h.Book), test: String(h.Test), part: String(h.Part), bookTestPart: String(h.BookTestPart),
    deadline: hwIso_(h.Deadline), note: String(h.Note || ''), status: String(h.Status || 'Active'),
    createdAt: hwIso_(h.CreatedAt), reminderSentAt: hwIso_(h.ReminderSentAt)
  };
}
function hwValidate_(p) {
  var book = String(p.book || '').trim(), test = String(p.test || '').trim(), part = String(p.part || '').trim();
  if (!p.classId) return { error: 'Chọn lớp.' };
  if (!book || !test || !part) return { error: 'Nhập đủ Book, Test, Part.' };
  var dl = new Date(p.deadline);
  if (!p.deadline || isNaN(dl.getTime())) return { error: 'Deadline không hợp lệ.' };
  return { book: book, test: test, part: part, deadline: dl.toISOString(), btp: hwBtp_(book, test, part) };
}

function hwCreate(user, p) {
  var v = hwValidate_(p);
  if (v.error) return { success: false, error: v.error };
  var classId = String(p.classId).toUpperCase();
  var dup = hwAllHomework_().some(function (h) {
    return String(h.ClassID).toUpperCase() === classId && hwBtpKey_(h.BookTestPart) === hwBtpKey_(v.btp);
  });
  if (dup) return { success: false, error: 'Lớp này đã được giao bài ' + v.btp + ' rồi.' };
  var sheet = getSheet(CONFIG.TABS.HOMEWORK);
  var rec = {
    HomeworkID: 'HW-' + genId().substring(0, 8), ClassID: classId, ClassName: classNameOf(classId),
    Book: v.book, Test: v.test, Part: v.part, BookTestPart: v.btp, Deadline: v.deadline,
    Note: String(p.note || '').slice(0, 500), Status: 'Active',
    CreatedBy: user.email || user.fullName || '', CreatedAt: nowIso(), ReminderSentAt: ''
  };
  sheet.appendRow(hwSheetHeaders_(sheet).map(function (h) { return rec[h] != null ? rec[h] : ''; }));
  return { success: true, homeworkId: rec.HomeworkID };
}

function hwUpdate(p) {
  var h = hwAllHomework_().find(function (x) { return String(x.HomeworkID) === String(p.homeworkId); });
  if (!h) return { success: false, error: 'Không tìm thấy bài tập.' };
  var v = hwValidate_({ classId: h.ClassID, book: p.book || h.Book, test: p.test || h.Test, part: p.part || h.Part, deadline: p.deadline || hwIso_(h.Deadline) });
  if (v.error) return { success: false, error: v.error };
  var clash = hwAllHomework_().some(function (x) {
    return x.HomeworkID !== h.HomeworkID && String(x.ClassID).toUpperCase() === String(h.ClassID).toUpperCase() && hwBtpKey_(x.BookTestPart) === hwBtpKey_(v.btp);
  });
  if (clash) return { success: false, error: 'Lớp này đã có bài ' + v.btp + '.' };
  hwSetHwCell_(h._row, 'Book', v.book);
  hwSetHwCell_(h._row, 'Test', v.test);
  hwSetHwCell_(h._row, 'Part', v.part);
  hwSetHwCell_(h._row, 'BookTestPart', v.btp);
  if (p.note != null) hwSetHwCell_(h._row, 'Note', String(p.note).slice(0, 500));
  if (v.deadline !== hwIso_(h.Deadline)) {
    hwSetHwCell_(h._row, 'Deadline', v.deadline);
    hwSetHwCell_(h._row, 'ReminderSentAt', ''); // đổi hạn → cho phép nhắc lại theo hạn mới
  }
  return { success: true };
}

function hwDelete(p) {
  var h = hwAllHomework_().find(function (x) { return String(x.HomeworkID) === String(p.homeworkId); });
  if (!h) return { success: false, error: 'Không tìm thấy bài tập.' };
  hwSetHwCell_(h._row, 'Status', 'Deleted'); // soft delete — không đụng tới kết quả làm bài
  return { success: true };
}

function hwListForTeacher(p) {
  var cid = p.classId ? String(p.classId).toUpperCase() : '';
  var list = hwAllHomework_().filter(function (h) { return !cid || String(h.ClassID).toUpperCase() === cid; });
  var idx = hwSessionIndex_(), rosters = {};
  var data = list.map(function (h) {
    var key = String(h.ClassID).toUpperCase();
    var roster = rosters[key] || (rosters[key] = hwStudentsOf_(key));
    var btpKey = hwBtpKey_(h.BookTestPart), done = 0, partial = 0;
    roster.forEach(function (s) {
      var st = idx[s.studentId.toLowerCase() + '|' + btpKey];
      if (st && st.partsDone === 3) done++; else if (st && st.partsDone > 0) partial++;
    });
    var o = hwPublic_(h);
    o.total = roster.length; o.done = done; o.partial = partial; o.notStarted = roster.length - done - partial;
    return o;
  });
  data.sort(function (a, b) { return hwTime_(b.deadline) - hwTime_(a.deadline); });
  return { success: true, data: data };
}

function hwProgress(p) {
  var h = hwAllHomework_().find(function (x) { return String(x.HomeworkID) === String(p.homeworkId); });
  if (!h) return { success: false, error: 'Không tìm thấy bài tập.' };
  var idx = hwSessionIndex_(), btpKey = hwBtpKey_(h.BookTestPart), dl = hwTime_(h.Deadline);
  var rows = hwStudentsOf_(h.ClassID).map(function (s) {
    var st = idx[s.studentId.toLowerCase() + '|' + btpKey] || hwPartsOf_('', '', '');
    var completedAt = st.partsDone === 3 ? st.endTime : '';
    return {
      studentId: s.studentId, fullName: s.fullName, email: s.email,
      quizDone: st.quizDone, gapDone: st.gapDone, dictDone: st.dictDone, partsDone: st.partsDone, missing: st.missing,
      sessionId: st.sessionId || '', totalScore: st.totalScore != null ? st.totalScore : null,
      completedAt: completedAt, late: !!(completedAt && dl && hwTime_(completedAt) > dl)
    };
  });
  rows.sort(function (a, b) { return a.partsDone - b.partsDone || a.fullName.localeCompare(b.fullName); });
  return { success: true, homework: hwPublic_(h), data: rows };
}

function hwListForStudent(user) {
  if (!user.classId) return { success: true, data: [] };
  var cid = String(user.classId).toUpperCase(), now = Date.now();
  var list = hwAllHomework_().filter(function (h) { return h.Status === 'Active' && String(h.ClassID).toUpperCase() === cid; });
  if (!list.length) return { success: true, data: [] };
  var idx = hwSessionIndex_(user.studentId), sidKey = String(user.studentId).toLowerCase();
  var data = list.map(function (h) {
    var st = idx[sidKey + '|' + hwBtpKey_(h.BookTestPart)] || hwPartsOf_('', '', '');
    var o = hwPublic_(h), dl = hwTime_(h.Deadline);
    o.quizDone = st.quizDone; o.gapDone = st.gapDone; o.dictDone = st.dictDone;
    o.partsDone = st.partsDone; o.missing = st.missing;
    o.sessionId = st.sessionId || ''; o.totalScore = st.totalScore != null ? st.totalScore : null;
    o.completed = st.partsDone === 3; o.overdue = !o.completed && dl > 0 && now > dl;
    return o;
  }).filter(function (o) {
    // Bài xong: ẩn sau khi quá hạn 7 ngày. Bài chưa xong: hiện tới 30 ngày sau hạn (đánh dấu trễ).
    var dl = hwTime_(o.deadline);
    return o.completed ? (now - dl < 7 * 864e5) : (now - dl < 30 * 864e5);
  });
  data.sort(function (a, b) { return (a.completed - b.completed) || (hwTime_(a.deadline) - hwTime_(b.deadline)); });
  return { success: true, data: data };
}

// Gắn HomeworkID vào session mới khi SV bắt đầu từ banner (chỉ nhận nếu đúng lớp + đúng bài)
function hwResolveHomeworkId_(user, homeworkId, bookTestPart) {
  if (!homeworkId) return '';
  var h = hwAllHomework_().find(function (x) { return String(x.HomeworkID) === String(homeworkId); });
  if (!h || String(h.ClassID).toUpperCase() !== String(user.classId || '').toUpperCase()) return '';
  return hwBtpKey_(h.BookTestPart) === hwBtpKey_(bookTestPart) ? String(h.HomeworkID) : '';
}

// ─── REMINDERS ───────────────────────────────────────────────
function hwSendDueReminders_() {
  var now = Date.now(), win = HW.REMIND_BEFORE_HOURS * 3600e3, sent = 0;
  hwAllHomework_().forEach(function (h) {
    if (h.Status !== 'Active' || hwHas_(h.ReminderSentAt)) return;
    var dl = hwTime_(h.Deadline);
    if (!dl || dl <= now || dl - now > win) return;
    var r = hwRemind_(h);
    if (r.ok) { hwSetHwCell_(h._row, 'ReminderSentAt', nowIso()); sent += r.sent; }
  });
  return sent;
}
function hwRemindNow(p) {
  var h = hwAllHomework_().find(function (x) { return String(x.HomeworkID) === String(p.homeworkId); });
  if (!h) return { success: false, error: 'Không tìm thấy bài tập.' };
  var r = hwRemind_(h);
  if (!r.ok) return { success: false, error: r.error };
  hwSetHwCell_(h._row, 'ReminderSentAt', nowIso());
  return { success: true, sent: r.sent, skippedNoEmail: r.noEmail };
}
function hwRemind_(h) {
  var idx = hwSessionIndex_(), btpKey = hwBtpKey_(h.BookTestPart);
  var targets = hwStudentsOf_(h.ClassID).map(function (s) {
    return { s: s, st: idx[s.studentId.toLowerCase() + '|' + btpKey] || hwPartsOf_('', '', '') };
  }).filter(function (x) { return x.st.partsDone < 3; });
  var withEmail = targets.filter(function (x) { return x.s.email; });
  if (withEmail.length > MailApp.getRemainingDailyQuota())
    return { ok: false, error: 'Không đủ quota email hôm nay (' + MailApp.getRemainingDailyQuota() + ' còn lại, cần ' + withEmail.length + ').' };
  withEmail.forEach(function (x) {
    var started = x.st.partsDone > 0;
    var html =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A16;line-height:1.6">' +
      '<p>Chào <b>' + hwEsc_(x.s.fullName) + '</b>,</p>' +
      '<p>Bài luyện nghe <b>' + hwEsc_(h.BookTestPart) + '</b> sẽ hết hạn lúc <b style="color:#C8102E">' + hwFmt_(h.Deadline) + '</b>.</p>' +
      (started
        ? '<p>Bạn đã làm ' + x.st.partsDone + '/3 phần. Còn thiếu: <b style="color:#C8102E">' + x.st.missing.join(', ') + '</b>.</p>'
        : '<p>Bạn <b style="color:#C8102E">chưa bắt đầu</b> bài này (cần làm đủ: Quiz, Gap-fill, Dictation).</p>') +
      (h.Note ? '<p style="background:#fff8e6;border-left:3px solid #C9A84C;padding:8px 12px">📌 ' + hwEsc_(h.Note) + '</p>' : '') +
      '<p><a href="' + HW.APP_URL + '" style="background:#C8102E;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">▶ Vào làm bài</a></p>' +
      '<p style="color:#77776E;font-size:12px">Email tự động từ LisDictation — Language Hub.</p></div>';
    MailApp.sendEmail({ to: x.s.email, subject: '[LisDictation] Nhắc hạn nộp: ' + h.BookTestPart + ' (' + hwFmt_(h.Deadline) + ')', htmlBody: html, name: 'LisDictation' });
  });
  return { ok: true, sent: withEmail.length, noEmail: targets.length - withEmail.length };
}

// ─── REPORT DOC + EMAIL ──────────────────────────────────────
function hwExportForStudent(user, p) {
  var f = hwFindSession_(p.sessionId);
  if (!f || String(f.row[f.hdrs.indexOf('StudentID')]) !== String(user.studentId)) return { success: false, error: 'Không tìm thấy session.' };
  return hwExportSession_(p.sessionId, { email: true });
}

// Tạo Doc + gửi mail cho 1 session. Idempotent: đã có DocURL thì chỉ gửi lại mail nếu chưa gửi.
function hwExportSession_(sessionId, opts) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { success: false, error: 'Hệ thống đang bận, thử lại sau.' };
  try {
    var f = hwFindSession_(sessionId);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    var r = hwRowObj_(f);
    var parts = hwPartsOf_(r.QuizScore, r.GapFillScore, r.DictationAccuracy);
    if (parts.partsDone < 3) return { success: false, error: 'Bài chưa hoàn thành đủ 3 phần.' };
    var docUrl = String(r.DocURL || ''), docId = '';
    if (!docUrl) {
      if (!r.CorrectedScriptJSON) {
        // Chi tiết đã bị xoá trước đây (vd. nút Clear Data cũ) → đánh dấu để cron không thử lại mãi
        if (!hwHas_(r.DetailPurgedAt)) _setCell(f, 'DetailPurgedAt', 'no-detail');
        return { success: false, error: 'Không còn dữ liệu chi tiết để tạo Doc.' };
      }
      var doc = hwBuildDoc_(r);
      docUrl = doc.url; docId = doc.id;
      _setCell(f, 'DocURL', docUrl);
    }
    var emailed = false;
    if (opts && opts.email && !hwHas_(r.DocSentAt)) {
      var student = hwStudentById_(r.StudentID);
      if (student && student.email && MailApp.getRemainingDailyQuota() > 0) {
        hwEmailReport_(r, student, docId || hwDocIdFromUrl_(docUrl), docUrl);
        _setCell(f, 'DocSentAt', nowIso());
        emailed = true;
      } else if (!student || !student.email) {
        _setCell(f, 'DocSentAt', 'no-email'); // tránh cron thử lại mãi
      }
    }
    return { success: true, docUrl: docUrl, emailed: emailed };
  } finally { lock.releaseLock(); }
}
function hwDocIdFromUrl_(url) { var m = String(url).match(/\/d\/([\w-]+)/); return m ? m[1] : ''; }

function hwReportFolder_(className) {
  var props = PropertiesService.getScriptProperties();
  var root = null, id = props.getProperty('HW_REPORT_FOLDER_ID');
  if (id) { try { root = DriveApp.getFolderById(id); } catch (e) { root = null; } }
  if (!root) {
    var it = DriveApp.getFoldersByName(HW.REPORT_FOLDER);
    root = it.hasNext() ? it.next() : DriveApp.createFolder(HW.REPORT_FOLDER);
    props.setProperty('HW_REPORT_FOLDER_ID', root.getId());
  }
  if (!className) return root;
  var sub = root.getFoldersByName(className);
  return sub.hasNext() ? sub.next() : root.createFolder(className);
}

function hwBuildDoc_(r) {
  var sentences = hwJson_(r.CorrectedScriptJSON, []) || [];
  var cefr = hwJson_(r.CEFRJSON, {}) || {};
  var gloss = cefr.gloss || {};
  var collocs = hwJson_(r.CollocationJSON, []) || [];
  var quiz = hwJson_(r.QuizJSON, {}) || {};
  var gap = hwJson_(r.GapFillJSON, {}) || {};
  var dict = hwJson_(r.DictationJSON, {}) || {};
  var H = DocumentApp.ParagraphHeading;
  var RED = '#C8102E', GREEN = '#1A7A4A', GREY = '#77776E', NAVY = '#04245A';

  var title = 'LisDictation · ' + r.BookTestPart + ' · ' + r.StudentName + ' (' + r.StudentID + ')';
  var doc = DocumentApp.create(title);
  var body = doc.getBody();
  body.setMarginTop(42).setMarginBottom(42).setMarginLeft(54).setMarginRight(54);

  function heading(text) { body.appendParagraph(text).setHeading(H.HEADING1).editAsText().setForegroundColor(NAVY); }
  function para(text, color, size) {
    var p = body.appendParagraph(String(text));
    var t = p.editAsText();
    if (color) t.setForegroundColor(color);
    if (size) t.setFontSize(size);
    return p;
  }
  function table(rows) {
    var t = body.appendTable(rows.map(function (row) { return row.map(function (c) { return String(c == null ? '' : c); }); }));
    t.setBorderColor('#E8E8E4');
    var hdr = t.getRow(0);
    for (var i = 0; i < hdr.getNumCells(); i++) hdr.getCell(i).setBackgroundColor('#F4F4F2').editAsText().setBold(true);
    return t;
  }

  body.appendParagraph('LisDictation — ' + r.BookTestPart).setHeading(H.TITLE);
  para(r.StudentName + ' (' + r.StudentID + ') · ' + (r.ClassName || '') + ' · Hoàn thành ' + hwFmt_(r.EndTime) +
       (hwHas_(r.DurationMin) ? ' · ' + r.DurationMin + ' phút' : ''), GREY, 10);
  table([['Quiz', 'Gap-fill', 'Dictation', 'Total'],
         [r.QuizScore + '%', r.GapFillScore + '%', r.DictationAccuracy + '%', r.TotalScore + '%']]);

  // 1. Script
  heading('1. Listening Script');
  sentences.forEach(function (s, i) { para((i + 1) + '. ' + s); });

  // 2. Word levels
  heading('2. Word Levels (CEFR)');
  var counts = cefr.counts || {}, tot = cefr.total || 0;
  if (tot) para(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(function (lv) {
    return lv + ': ' + (counts[lv] || 0) + ' (' + Math.round((counts[lv] || 0) / tot * 100) + '%)';
  }).join('  ·  ') + '  —  ' + tot + ' words', GREY, 10);
  var byLevel = cefr.byLevel || {}, vocabRows = [['Level', 'Word', 'IPA', 'Nghĩa (VI)']];
  ['C2', 'C1', 'B2'].forEach(function (lv) {
    (byLevel[lv] || []).forEach(function (w) {
      var g = gloss[String(w).toLowerCase()] || {};
      vocabRows.push([lv, w, g.ipa || '', g.vi || '']);
    });
  });
  if (vocabRows.length > 1) table(vocabRows); else para('Không có từ B2+ trong bài.', GREY);

  // 3. Collocations
  heading('3. Phrases & Collocations');
  if (collocs.length) table([['Phrase', 'Nghĩa (VI)']].concat(collocs.map(function (c) { return [c.en || c[0] || '', c.vi || c[1] || '']; })));
  else para('—', GREY);

  // 4. Quiz
  heading('4. Quiz Review');
  var qs = quiz.questions || [], qa = quiz.answers || [];
  qs.forEach(function (q, i) {
    var chosen = qa[i], ok = chosen === q.a, opts = q.o || [];
    var p = para((ok ? '✓ ' : '✗ ') + (i + 1) + '. [' + (q.type === 'content' ? 'Content' : 'Vocab') + '] ' + q.q);
    p.editAsText().setBold(true).setForegroundColor(ok ? GREEN : RED);
    if (!ok) para('   Bạn chọn: ' + (opts[chosen] != null ? opts[chosen] : '—'), RED, 10);
    para('   Đáp án: ' + (opts[q.a] != null ? opts[q.a] : '—'), GREEN, 10);
    if (q.e) para('   ' + q.e, GREY, 10);
  });
  if (!qs.length) para('—', GREY);

  // 5. Gap-fill
  heading('5. Gap-fill Review');
  var ga = gap.answers || [];
  var wrong = ga.filter(function (a) { return !a.firstTryCorrect; });
  para('Đúng ngay lần đầu: ' + (ga.length - wrong.length) + '/' + ga.length, GREY, 10);
  if (wrong.length) {
    table([['Câu', 'Lần đầu bạn điền', 'Đáp án']].concat(wrong.map(function (a) {
      return [a.sentenceIdx + 1, a.firstTryGiven != null ? a.firstTryGiven : (a.given || ''), a.actual];
    })));
  }

  // 6. Dictation
  heading('6. Dictation Review');
  var da = dict.answers || [];
  sentences.forEach(function (s, i) {
    var typed = String((da[i] && da[i].typed) || '');
    var target = s.split(/\s+/).filter(Boolean), tw = typed.split(/\s+/).filter(Boolean);
    var errs = [];
    target.forEach(function (w, wi) {
      if (hwWordKey_(w) !== hwWordKey_(tw[wi])) errs.push(w + (tw[wi] ? ' (bạn: ' + tw[wi] + ')' : ' (thiếu)'));
    });
    var p = para((errs.length ? '✗ ' : '✓ ') + 'Câu ' + (i + 1) + ' — ' + (target.length - errs.length) + '/' + target.length + ' từ');
    p.editAsText().setBold(true).setForegroundColor(errs.length ? RED : GREEN);
    para('   Target: ' + s, null, 10);
    if (errs.length) {
      para('   Bạn gõ: ' + (typed || '—'), GREY, 10);
      para('   Cần sửa: ' + errs.join(', '), RED, 10);
    }
  });

  doc.saveAndClose();
  var file = DriveApp.getFileById(doc.getId());
  file.moveTo(hwReportFolder_(String(r.ClassName || r.ClassID || '')));
  if (HW.DOC_SHARING === 'link') file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { id: doc.getId(), url: doc.getUrl() };
}

function hwEmailReport_(r, student, docId, docUrl) {
  var attachments = [];
  try { attachments.push(DriveApp.getFileById(docId).getAs('application/pdf').setName('LisDictation - ' + r.BookTestPart + '.pdf')); } catch (e) {}
  var html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1A1A16;line-height:1.6">' +
    '<p>Chào <b>' + hwEsc_(student.fullName) + '</b>,</p>' +
    '<p>Bạn đã hoàn thành bài <b>' + hwEsc_(r.BookTestPart) + '</b>. Kết quả:</p>' +
    '<table style="border-collapse:collapse;font-size:14px">' +
    [['Quiz', r.QuizScore], ['Gap-fill', r.GapFillScore], ['Dictation', r.DictationAccuracy], ['Total', r.TotalScore]].map(function (x) {
      return '<tr><td style="padding:4px 16px 4px 0;color:#77776E">' + x[0] + '</td><td style="font-weight:bold">' + x[1] + '%</td></tr>';
    }).join('') + '</table>' +
    '<p>Bản tổng kết (script, từ vựng theo CEFR, collocations, lỗi Quiz/Gap-fill/Dictation) được đính kèm dạng PDF' +
    (HW.DOC_SHARING === 'link' ? ' và có trên Google Docs:</p><p><a href="' + docUrl + '" style="background:#04245A;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">📄 Mở bản tổng kết</a></p>' : '.</p>') +
    '<p style="color:#77776E;font-size:12px">Hãy lưu lại email này để ôn tập. Chi tiết bài làm trên hệ thống sẽ được dọn sau ' + HW.PURGE_AFTER_DAYS + ' ngày (điểm số vẫn được giữ).</p></div>';
  MailApp.sendEmail({
    to: student.email, subject: '[LisDictation] Kết quả bài ' + r.BookTestPart,
    htmlBody: html, attachments: attachments, name: 'LisDictation'
  });
}

// Cron: tạo Doc cho bài xong mà chưa có Doc; gửi lại mail bị lỡ (quota/lỗi mạng).
// Bài hoàn thành TRƯỚC khi cài module chỉ được tạo Doc (không gửi mail) để SV không nhận mail cũ hàng loạt.
function hwExportPending_() {
  var installedAt = hwTime_(getSetting('hw_installed_at')) || Date.now();
  var d = hwReadSessionCols_(['SessionID', 'EndTime', 'QuizScore', 'GapFillScore', 'DictationAccuracy', 'DocURL', 'DocSentAt', 'DetailPurgedAt']);
  var c = d.cols, done = 0, tries = 0;
  for (var i = 0; i < d.n && done < HW.EXPORT_BATCH && tries < HW.EXPORT_BATCH * 3; i++) {
    if (hwPartsOf_(c.QuizScore[i], c.GapFillScore[i], c.DictationAccuracy[i]).partsDone < 3) continue;
    var hasDoc = !!c.DocURL[i], sent = hwHas_(c.DocSentAt[i]);
    var isNew = hwTime_(c.EndTime[i]) >= installedAt;
    if (hasDoc && (sent || !isNew)) continue;
    if (!hasDoc && hwHas_(c.DetailPurgedAt[i])) continue;
    tries++;
    var r = hwExportSession_(c.SessionID[i], { email: isNew });
    if (r.success) done++;
  }
  return done;
}

// Deadline của bài được giao mà session thuộc về (theo HomeworkID, hoặc cùng lớp + cùng Book/Test/Part).
// Tính cả bài đã bị GV xoá khỏi Homework Book — deadline vẫn là mốc bảo vệ dữ liệu.
function hwDeadlineLookup_() {
  var sheet = getSheet(CONFIG.TABS.HOMEWORK), data = sheet.getDataRange().getValues();
  var byId = {}, byKey = {};
  if (data.length < 2) return function () { return 0; };
  var h = data[0], iId = h.indexOf('HomeworkID'), iCls = h.indexOf('ClassID'), iBtp = h.indexOf('BookTestPart'), iDl = h.indexOf('Deadline');
  data.slice(1).forEach(function (r) {
    var dl = hwTime_(r[iDl]);
    if (!dl) return;
    byId[String(r[iId])] = dl;
    var k = String(r[iCls]).toUpperCase() + '|' + hwBtpKey_(r[iBtp]);
    byKey[k] = Math.max(byKey[k] || 0, dl);
  });
  return function (homeworkId, classId, btp) {
    return byId[String(homeworkId || '')] || byKey[String(classId || '').toUpperCase() + '|' + hwBtpKey_(btp)] || 0;
  };
}

// Cron: xoá JSON chi tiết của bài đã có Doc. Mốc = max(ngày nộp, deadline bài tập) + PURGE_AFTER_DAYS,
// để GV luôn có ít nhất 10 ngày SAU deadline xem lại trang HTML. Điểm số giữ nguyên.
// KHÔNG BAO GIỜ xoá bài chưa có Doc hoặc chưa làm đủ 3 phần.
function hwPurgeOld_() {
  var keep = HW.PURGE_AFTER_DAYS * 864e5, now = Date.now();
  var deadlineOf = hwDeadlineLookup_();
  var d = hwReadSessionCols_(['SessionID', 'ClassID', 'BookTestPart', 'HomeworkID', 'EndTime', 'QuizScore', 'GapFillScore', 'DictationAccuracy', 'DocURL', 'DetailPurgedAt']);
  var c = d.cols, sheet = d.sheet, hdrs = d.hdrs, iId = hdrs.indexOf('SessionID');
  var cols = HW.DETAIL_COLS.map(function (n) { return hdrs.indexOf(n); }).filter(function (x) { return x >= 0; }).sort(function (a, b) { return a - b; });
  // gom các cột liền nhau thành từng dải để clear 1 lần/dải
  var runs = [];
  cols.forEach(function (ci) {
    var last = runs[runs.length - 1];
    if (last && ci === last.start + last.len) last.len++; else runs.push({ start: ci, len: 1 });
  });
  var purged = 0;
  for (var i = 0; i < d.n && purged < HW.PURGE_BATCH; i++) {
    if (!c.DocURL[i] || hwHas_(c.DetailPurgedAt[i])) continue;
    if (hwPartsOf_(c.QuizScore[i], c.GapFillScore[i], c.DictationAccuracy[i]).partsDone < 3) continue;
    var end = hwTime_(c.EndTime[i]);
    if (!end) continue;
    var anchor = Math.max(end, deadlineOf(c.HomeworkID[i], c.ClassID[i], c.BookTestPart[i]));
    if (now - anchor < keep) continue;
    var rowIdx = i + 2;
    // Hàng có thể bị dịch nếu SV xoá session trong lúc cron chạy → xác minh lại SessionID trước khi xoá
    if (String(sheet.getRange(rowIdx, iId + 1).getValue()) !== String(c.SessionID[i])) continue;
    runs.forEach(function (run) { sheet.getRange(rowIdx, run.start + 1, 1, run.len).clearContent(); });
    sheet.getRange(rowIdx, hdrs.indexOf('DetailPurgedAt') + 1).setValue(nowIso());
    purged++;
  }
  return purged;
}

// Session có thuộc 1 bài GV đã giao cho lớp của SV không (dùng để chặn SV tự xoá)
function hwIsAssigned_(user, homeworkId, bookTestPart) {
  if (homeworkId) return true;
  var cid = String(user.classId || '').toUpperCase(), key = hwBtpKey_(bookTestPart);
  return hwAllHomework_().some(function (h) {
    return String(h.ClassID).toUpperCase() === cid && hwBtpKey_(h.BookTestPart) === key;
  });
}
