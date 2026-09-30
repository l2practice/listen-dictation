// ============================================================
// LisDictation — Report Docs + Auto-purge + New Practice (Reports.gs)
// Cùng project Apps Script với Code.gs (dùng chung CONFIG, getSheet, _setCell…).
//
// Chức năng (KHÔNG gửi mail cho SV):
//  1. Report Doc: SV nộp đủ 3 phần (Quiz, Gap-fill, Dictation) → tự tạo Google Doc
//     (script, word levels, collocations, quiz/gap-fill/dictation review).
//     SV mở từ cột "Details" (Open Docs) trong History.
//  2. Auto-purge: 10 ngày sau ngày hoàn thành → tự xoá JSON chi tiết trong sheet Sessions,
//     không báo SV. Điểm số giữ nguyên; GV bấm "Open Docs" để xem lại.
//  3. New Practice (GV): gom bài mới hoàn thành theo Lớp + Book/Test/Part, kèm khoảng ngày.
//     GV tick Done → ẩn; SV nộp thêm sau đó → nhóm hiện lại với khoảng ngày mới.
//
// Cài đặt (1 lần): chạy hàm rp_setup() trong editor → cấp quyền Docs/Drive/Trigger
//   → Deploy ▸ Manage deployments ▸ Edit ▸ Version: New version (giữ nguyên URL /exec).
// ============================================================

var RP = {
  PURGE_AFTER_DAYS: 10,
  EXPORT_BATCH: 8,          // số Doc tạo tối đa mỗi lần cron chạy (quota tạo Docs tài khoản cá nhân ~250/ngày)
  PURGE_BATCH: 80,
  NEW_PRACTICE_PER_CLASS: 2,       // tab New Practice: số bài mới nhất hiện cho mỗi lớp
  NEW_PRACTICE_BACKFILL_DAYS: 30,  // lần đầu cài: chỉ coi bài hoàn thành trong 30 ngày gần nhất là "mới"
  REPORT_FOLDER: 'LisDictation — Student Reports',
  // 'link' = ai có link đều xem được → SV mở được Doc từ app mà không cần được share riêng
  // 'private' = chỉ GV xem được Doc (SV bấm Open Docs sẽ bị Google từ chối)
  DOC_SHARING: 'link',
  TZ: 'Asia/Ho_Chi_Minh',
  DETAIL_COLS: ['ScriptText', 'CorrectedScriptJSON', 'CEFRJSON', 'CollocationJSON', 'QuizJSON', 'GapFillJSON', 'DictationJSON']
};

// ─── ROUTER (gọi từ routeAction trong Code.gs) ───────────────
function rpRoute(action, user, p) {
  p = p || {};
  try {
    if (action === 'session.exportReport') return rpExportForStudent(user, p);
    if (user.role === 'Teacher') {
      if (action === 'practice.new')      return rpNewPractice();
      if (action === 'practice.markDone') return rpMarkDone(user, p, true);
      if (action === 'practice.undoDone') return rpMarkDone(user, p, false);
    }
    return null; // không phải action của module này
  } catch (e) { return { success: false, error: e.message }; }
}

// ─── SETUP + CRON ────────────────────────────────────────────
function rp_setup() {
  getSheet(CONFIG.TABS.SESSIONS); // ensureColumns → thêm DocURL, DetailPurgedAt
  getSheet(CONFIG.TABS.REVIEWS);
  if (!getSetting('rp_new_since')) setSetting('rp_new_since', new Date(Date.now() - RP.NEW_PRACTICE_BACKFILL_DAYS * 864e5).toISOString());
  // xoá trigger cũ (kể cả 'hw_hourly' của bản Homework Book trước) rồi cài lại
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['hw_hourly', 'rp_hourly'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('rp_hourly').timeBased().everyHours(1).create();
  rpReportFolder_(); // tạo folder trước để kiểm tra quyền Drive
  Logger.log('Reports module ready. Trigger rp_hourly installed.');
}

// Chạy mỗi giờ: (1) tạo Doc cho bài đã xong mà chưa có Doc (2) xoá chi tiết > 10 ngày
function rp_hourly() {
  var res = {};
  try { res.exported = rpExportPending_(); } catch (e) { res.exportError = e.message; }
  try { res.purged = rpPurgeOld_(); } catch (e) { res.purgeError = e.message; }
  Logger.log(JSON.stringify(res));
  return res;
}

// ─── HELPERS ─────────────────────────────────────────────────
function rpTime_(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  var t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}
function rpIso_(v) { var t = rpTime_(v); return t ? new Date(t).toISOString() : ''; }
function rpHas_(v) { return v !== '' && v != null; }
function rpFmt_(v) { var t = rpTime_(v); return t ? Utilities.formatDate(new Date(t), RP.TZ, 'dd/MM/yyyy HH:mm') : '—'; }
// Khoá so khớp BookTestPart: "Cam17 · Test 1 · Part 4" ≡ "cam17 test 1 part 4"
function rpBtpKey_(s) { return String(s || '').toLowerCase().replace(/[·|,]/g, ' ').replace(/\s+/g, ' ').trim(); }
function rpJson_(v, fb) { if (!v) return fb; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return fb; } }
// Cùng quy tắc so từ với student.html (checkSentence): bỏ dấu câu/nháy/gạch, không phân biệt hoa thường
function rpWordKey_(w) {
  return String(w || '').replace(/[‘’ʼʹ]/g, "'").replace(/[^a-z0-9]/gi, '').toLowerCase();
}
// Cùng thuật toán với LD.alignWords (ld-common.js): so theo dãy từ, thiếu/thừa 1 từ không làm lệch cả câu
function rpAlignWords_(target, typed) {
  var words = function (s) { return String(s || '').split(/\s+/).filter(function (w) { return rpWordKey_(w); }); };
  var a = words(target), b = words(typed), ka = a.map(rpWordKey_), kb = b.map(rpWordKey_);
  var n = a.length, m = b.length, d = [], i, j;
  for (i = 0; i <= n; i++) d[i] = [i];
  for (j = 1; j <= m; j++) d[0][j] = j;
  for (i = 1; i <= n; i++) for (j = 1; j <= m; j++)
    d[i][j] = Math.min(d[i - 1][j - 1] + (ka[i - 1] === kb[j - 1] ? 0 : 1), d[i - 1][j] + 1, d[i][j - 1] + 1);
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
  return { ops: ops, correct: correct, total: n };
}
function rpSheetHeaders_(sheet) { return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]; }

// Đọc riêng vài cột của Sessions (tránh kéo cả JSON blob nặng)
function rpReadSessionCols_(names) {
  var sheet = getSheet(CONFIG.TABS.SESSIONS);
  var hdrs = rpSheetHeaders_(sheet), n = sheet.getLastRow() - 1, cols = {};
  names.forEach(function (name) {
    var c = hdrs.indexOf(name);
    cols[name] = (c >= 0 && n > 0) ? sheet.getRange(2, c + 1, n, 1).getValues().map(function (r) { return r[0]; }) : [];
  });
  return { sheet: sheet, hdrs: hdrs, n: Math.max(n, 0), cols: cols };
}

// Tìm 1 session theo ID mà chỉ đọc cột SessionID + đúng 1 hàng
function rpFindSession_(sessionId) {
  var sheet = getSheet(CONFIG.TABS.SESSIONS);
  var hdrs = rpSheetHeaders_(sheet), iId = hdrs.indexOf('SessionID'), n = sheet.getLastRow() - 1;
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
function rpRowObj_(f) { var o = {}; f.hdrs.forEach(function (h, i) { o[h] = f.row[i]; }); return o; }

// Tiến độ 3 phần của 1 hàng Sessions — dựa vào cột ĐIỂM (không phụ thuộc JSON, vì JSON bị xoá sau 10 ngày)
function rpPartsOf_(quizScore, gapScore, dictAcc) {
  var q = rpHas_(quizScore), g = rpHas_(gapScore), d = rpHas_(dictAcc);
  var missing = [];
  if (!q) missing.push('Quiz');
  if (!g) missing.push('Gap-fill');
  if (!d) missing.push('Dictation');
  return { quizDone: q, gapDone: g, dictDone: d, partsDone: 3 - missing.length, missing: missing };
}

// ─── REPORT DOC ──────────────────────────────────────────────
function rpExportForStudent(user, p) {
  var f = rpFindSession_(p.sessionId);
  if (!f || String(f.row[f.hdrs.indexOf('StudentID')]) !== String(user.studentId)) return { success: false, error: 'Không tìm thấy session.' };
  return rpExportSession_(p.sessionId);
}

// Tạo Google Doc cho 1 session đã xong đủ 3 phần. Idempotent: đã có DocURL thì trả lại link.
function rpExportSession_(sessionId) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { success: false, error: 'Hệ thống đang bận, thử lại sau.' };
  try {
    var f = rpFindSession_(sessionId);
    if (!f) return { success: false, error: 'Không tìm thấy session.' };
    var r = rpRowObj_(f);
    var parts = rpPartsOf_(r.QuizScore, r.GapFillScore, r.DictationAccuracy);
    if (parts.partsDone < 3) return { success: false, error: 'Bài chưa hoàn thành đủ 3 phần.' };
    var docUrl = String(r.DocURL || '');
    if (!docUrl) {
      if (!r.CorrectedScriptJSON) {
        // Chi tiết đã bị xoá trước đây (vd. nút Clear Data cũ) → đánh dấu để cron không thử lại mãi
        if (!rpHas_(r.DetailPurgedAt)) _setCell(f, 'DetailPurgedAt', 'no-detail');
        return { success: false, error: 'Không còn dữ liệu chi tiết để tạo Doc.' };
      }
      docUrl = rpBuildDoc_(r).url;
      _setCell(f, 'DocURL', docUrl);
    }
    return { success: true, docUrl: docUrl };
  } finally { lock.releaseLock(); }
}

function rpReportFolder_(className) {
  var props = PropertiesService.getScriptProperties();
  var root = null, id = props.getProperty('HW_REPORT_FOLDER_ID');
  if (id) { try { root = DriveApp.getFolderById(id); } catch (e) { root = null; } }
  if (!root) {
    var it = DriveApp.getFoldersByName(RP.REPORT_FOLDER);
    root = it.hasNext() ? it.next() : DriveApp.createFolder(RP.REPORT_FOLDER);
    props.setProperty('HW_REPORT_FOLDER_ID', root.getId());
  }
  if (!className) return root;
  var sub = root.getFoldersByName(className);
  return sub.hasNext() ? sub.next() : root.createFolder(className);
}

function rpBuildDoc_(r) {
  var sentences = rpJson_(r.CorrectedScriptJSON, []) || [];
  var cefr = rpJson_(r.CEFRJSON, {}) || {};
  var gloss = cefr.gloss || {};
  var collocs = rpJson_(r.CollocationJSON, []) || [];
  var quiz = rpJson_(r.QuizJSON, {}) || {};
  var gap = rpJson_(r.GapFillJSON, {}) || {};
  var dict = rpJson_(r.DictationJSON, {}) || {};
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
  para(r.StudentName + ' (' + r.StudentID + ') · ' + (r.ClassName || '') + ' · Hoàn thành ' + rpFmt_(r.EndTime) +
       (rpHas_(r.DurationMin) ? ' · ' + r.DurationMin + ' phút' : ''), GREY, 10);
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

  // 5. Gap-fill — toàn bộ script; ô điền được gạch dưới:
  //   đúng lần đầu → gạch dưới, đậm, xanh;  sai → từ SV điền gạch ngang đỏ đậm + từ đúng xanh bên cạnh
  heading('5. Gap-fill Review');
  var ga = gap.answers || [];
  var wrongCount = ga.filter(function (a) { return !a.firstTryCorrect; }).length;
  para('Đúng ngay lần đầu: ' + (ga.length - wrongCount) + '/' + ga.length, GREY, 10);
  var blanksBySentence = {};
  ga.forEach(function (a) { (blanksBySentence[a.sentenceIdx] = blanksBySentence[a.sentenceIdx] || {})[a.wordIdx] = a; });
  sentences.forEach(function (sent, si) {
    var blanks = blanksBySentence[si] || {};
    var text = (si + 1) + '. ', styles = [];
    // wordIdx của Gap-fill là chỉ số trong sent.split(/(\s+)/) — tách giống hệt student.html buildGapFill
    String(sent).split(/(\s+)/).forEach(function (tok, wi) {
      var b = blanks[wi];
      if (!b) { text += tok; return; }
      var m = tok.match(/^([^A-Za-z0-9']*)(.*?)([^A-Za-z0-9']*)$/);   // giữ dấu câu ngoài ô trống
      var core = m[2] || b.actual;
      text += m[1];
      if (b.firstTryCorrect) {
        styles.push({ s: text.length, e: text.length + core.length - 1, color: GREEN, underline: true });
        text += core;
      } else {
        var given = String(b.firstTryGiven != null ? b.firstTryGiven : (b.given || '')) || '(trống)';
        styles.push({ s: text.length, e: text.length + given.length - 1, color: RED, strike: true });
        text += given + ' ';
        styles.push({ s: text.length, e: text.length + core.length - 1, color: GREEN, underline: true });
        text += core;
      }
      text += m[3];
    });
    var t = body.appendParagraph(text).editAsText();
    styles.forEach(function (st) {
      t.setBold(st.s, st.e, true).setForegroundColor(st.s, st.e, st.color);
      if (st.underline) t.setUnderline(st.s, st.e, true);
      if (st.strike) t.setStrikethrough(st.s, st.e, true);
    });
  });

  // 6. Dictation
  heading('6. Dictation Review');
  var da = dict.answers || [];
  sentences.forEach(function (s, i) {
    var typed = String((da[i] && da[i].typed) || '');
    var al = rpAlignWords_(s, typed), errs = [];
    al.ops.forEach(function (o) {
      if (o.op === 'sub') errs.push(o.t + ' (bạn: ' + o.y + ')');
      else if (o.op === 'miss') errs.push(o.t + ' (thiếu)');
      else if (o.op === 'extra') errs.push('(thừa: ' + o.y + ')');
    });
    var p = para((errs.length ? '✗ ' : '✓ ') + 'Câu ' + (i + 1) + ' — ' + al.correct + '/' + al.total + ' từ');
    p.editAsText().setBold(true).setForegroundColor(errs.length ? RED : GREEN);
    para('   Target: ' + s, null, 10);
    if (errs.length) {
      para('   Bạn gõ: ' + (typed || '—'), GREY, 10);
      para('   Cần sửa: ' + errs.join(', '), RED, 10);
    }
  });

  doc.saveAndClose();
  var file = DriveApp.getFileById(doc.getId());
  file.moveTo(rpReportFolder_(String(r.ClassName || r.ClassID || '')));
  if (RP.DOC_SHARING === 'link') file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { id: doc.getId(), url: doc.getUrl() };
}

// Cron: tạo Doc cho bài đã xong đủ 3 phần mà chưa có Doc (SV đóng tab ngay sau khi nộp, bài cũ trước khi cài…)
function rpExportPending_() {
  var d = rpReadSessionCols_(['SessionID', 'QuizScore', 'GapFillScore', 'DictationAccuracy', 'DocURL', 'DetailPurgedAt']);
  var c = d.cols, done = 0, tries = 0;
  for (var i = 0; i < d.n && done < RP.EXPORT_BATCH && tries < RP.EXPORT_BATCH * 3; i++) {
    if (rpPartsOf_(c.QuizScore[i], c.GapFillScore[i], c.DictationAccuracy[i]).partsDone < 3) continue;
    if (c.DocURL[i] || rpHas_(c.DetailPurgedAt[i])) continue;
    tries++;
    var r = rpExportSession_(c.SessionID[i]);
    if (r.success) done++;
  }
  return done;
}

// Cron: xoá JSON chi tiết của bài đã có Doc, PURGE_AFTER_DAYS ngày sau ngày hoàn thành. Không báo SV.
// Điểm số giữ nguyên. KHÔNG BAO GIỜ xoá bài chưa có Doc hoặc chưa làm đủ 3 phần.
function rpPurgeOld_() {
  var cutoff = Date.now() - RP.PURGE_AFTER_DAYS * 864e5;
  var d = rpReadSessionCols_(['SessionID', 'EndTime', 'QuizScore', 'GapFillScore', 'DictationAccuracy', 'DocURL', 'DetailPurgedAt']);
  var c = d.cols, sheet = d.sheet, hdrs = d.hdrs, iId = hdrs.indexOf('SessionID');
  var cols = RP.DETAIL_COLS.map(function (n) { return hdrs.indexOf(n); }).filter(function (x) { return x >= 0; }).sort(function (a, b) { return a - b; });
  // gom các cột liền nhau thành từng dải để clear 1 lần/dải
  var runs = [];
  cols.forEach(function (ci) {
    var last = runs[runs.length - 1];
    if (last && ci === last.start + last.len) last.len++; else runs.push({ start: ci, len: 1 });
  });
  var purged = 0;
  for (var i = 0; i < d.n && purged < RP.PURGE_BATCH; i++) {
    if (!c.DocURL[i] || rpHas_(c.DetailPurgedAt[i])) continue;
    if (rpPartsOf_(c.QuizScore[i], c.GapFillScore[i], c.DictationAccuracy[i]).partsDone < 3) continue;
    var end = rpTime_(c.EndTime[i]);
    if (!end || end > cutoff) continue;
    var rowIdx = i + 2;
    // Hàng có thể bị dịch nếu SV xoá session trong lúc cron chạy → xác minh lại SessionID trước khi xoá
    if (String(sheet.getRange(rowIdx, iId + 1).getValue()) !== String(c.SessionID[i])) continue;
    runs.forEach(function (run) { sheet.getRange(rowIdx, run.start + 1, 1, run.len).clearContent(); });
    sheet.getRange(rowIdx, hdrs.indexOf('DetailPurgedAt') + 1).setValue(nowIso());
    purged++;
  }
  return purged;
}

// ─── NEW PRACTICE (GV) ───────────────────────────────────────
// Nhóm = Lớp + Book/Test/Part. "Mới" = bài hoàn thành đủ 3 phần SAU mốc GV đã tick Done
// cho nhóm đó (sheet Reviews), hoặc sau rp_new_since nếu nhóm chưa từng được tick.
function rpGroupKey_(classId, btp) { return String(classId || '').toUpperCase() + '|' + rpBtpKey_(btp); }

function rpReviews_() {
  var sheet = getSheet(CONFIG.TABS.REVIEWS), data = sheet.getDataRange().getValues(), map = {};
  if (data.length < 2) return { sheet: sheet, hdrs: data[0] || [], map: map };
  var h = data[0];
  data.slice(1).forEach(function (r, i) {
    var o = { _row: i + 2 };
    h.forEach(function (k, j) { o[k] = r[j]; });
    if (o.GroupKey) map[String(o.GroupKey)] = o;
  });
  return { sheet: sheet, hdrs: h, map: map };
}

function rpNewPractice() {
  var since = rpTime_(getSetting('rp_new_since'));
  var rv = rpReviews_().map;
  var d = rpReadSessionCols_(['ClassID', 'ClassName', 'BookTestPart', 'EndTime', 'QuizScore', 'GapFillScore', 'DictationAccuracy']);
  var c = d.cols, groups = {};
  for (var i = 0; i < d.n; i++) {
    if (rpPartsOf_(c.QuizScore[i], c.GapFillScore[i], c.DictationAccuracy[i]).partsDone < 3) continue;
    var end = rpTime_(c.EndTime[i]);
    if (!end) continue;
    var key = rpGroupKey_(c.ClassID[i], c.BookTestPart[i]);
    var reviewedUpTo = rv[key] ? rpTime_(rv[key].ReviewedUpTo) : since;
    if (end <= reviewedUpTo) continue;
    var g = groups[key] || (groups[key] = {
      groupKey: key, classId: String(c.ClassID[i]), className: String(c.ClassName[i] || classNameOf(c.ClassID[i])),
      bookTestPart: String(c.BookTestPart[i]), from: end, to: end
    });
    g.from = Math.min(g.from, end); g.to = Math.max(g.to, end);
  }
  var data = Object.keys(groups).map(function (k) {
    var g = groups[k];
    g.from = new Date(g.from).toISOString(); g.to = new Date(g.to).toISOString();
    return g;
  });
  data.sort(function (a, b) { return a.className.localeCompare(b.className) || rpTime_(b.to) - rpTime_(a.to); });
  // Mỗi lớp chỉ hiện RP.NEW_PRACTICE_PER_CLASS bài mới nhất (theo ngày hoàn thành gần nhất)
  var perClass = {};
  data = data.filter(function (g) {
    var k = String(g.classId).toUpperCase();
    perClass[k] = (perClass[k] || 0) + 1;
    return perClass[k] <= RP.NEW_PRACTICE_PER_CLASS;
  });
  return { success: true, data: data };
}

// Done: lưu mốc = bài mới nhất GV đang thấy (p.upTo), nên bài nộp SAU lúc tải trang vẫn hiện lại.
// Undo: trả về mốc trước đó.
function rpMarkDone(user, p, done) {
  if (!p.classId || !p.bookTestPart) return { success: false, error: 'Thiếu lớp hoặc bài.' };
  var key = rpGroupKey_(p.classId, p.bookTestPart), rv = rpReviews_(), cur = rv.map[key];
  var set = function (col, v) { var c = rv.hdrs.indexOf(col); if (c >= 0) rv.sheet.getRange(cur._row, c + 1).setValue(v); };
  if (!done) {
    if (!cur) return { success: true };
    set('ReviewedUpTo', cur.PrevReviewedUpTo || '');
    set('PrevReviewedUpTo', '');
    return { success: true };
  }
  var upTo = rpIso_(p.upTo) || nowIso();
  if (!cur) {
    var rec = { GroupKey: key, ClassID: String(p.classId).toUpperCase(), BookTestPart: p.bookTestPart, ReviewedUpTo: upTo,
                PrevReviewedUpTo: '', ReviewedAt: nowIso(), ReviewedBy: user.email || user.fullName || '' };
    rv.sheet.appendRow(rv.hdrs.map(function (h) { return rec[h] != null ? rec[h] : ''; }));
    return { success: true };
  }
  set('PrevReviewedUpTo', rpIso_(cur.ReviewedUpTo));
  set('ReviewedUpTo', upTo);
  set('ReviewedAt', nowIso());
  set('ReviewedBy', user.email || user.fullName || '');
  return { success: true };
}

// ─── CHẠY 1 LẦN: làm gọn DictationJSON cũ ────────────────────
// Bản cũ lưu mỗi câu kèm resultHtml (cả câu script dạng HTML). Hàm này giữ lại đúng
// typed/checked/attempted cho mọi session → sheet nhẹ đi đáng kể. Chạy lại nhiều lần cũng an toàn.
function rp_compactDictation() {
  var sheet = getSheet(CONFIG.TABS.SESSIONS), hdrs = rpSheetHeaders_(sheet);
  var c = hdrs.indexOf('DictationJSON'), n = sheet.getLastRow() - 1;
  if (c < 0 || n < 1) return 0;
  var vals = sheet.getRange(2, c + 1, n, 1).getValues(), changed = 0, before = 0, after = 0;
  vals.forEach(function (row, i) {
    if (!row[0]) return;
    var dj = rpJson_(row[0], null);
    if (!dj || !dj.answers) return;
    var out = JSON.stringify(Object.assign({}, dj, { answers: _compactDictAnswers(dj.answers) }));
    before += String(row[0]).length;
    after += out.length;
    // ghi từng ô đã đổi (không ghi đè cả cột) → không đè lên bài SV đang lưu cùng lúc
    if (out !== row[0]) { sheet.getRange(i + 2, c + 1).setValue(out); changed++; }
  });
  Logger.log('Compacted ' + changed + ' session(s): DictationJSON ' + before + ' → ' + after + ' characters.');
  return changed;
}
