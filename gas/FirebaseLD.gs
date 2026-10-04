/*───────────────────────────────────────────────────────────────
  LisDictation — Firebase edition, Apps Script side (FirebaseLD.gs)
  Thêm làm 1 file script trong cùng project với Code.gs.

  Dữ liệu nằm trong Firestore, trình duyệt đọc/ghi thẳng (ld-fbdata.js).
  File này chỉ giữ những việc cần quyền quản trị:
    • tài khoản: SV / GV đăng ký, quên mật khẩu (gửi mật khẩu mới qua email)
    • chuyển dữ liệu 1 lần Google Sheet → Firebase (chạy từ editor, theo bước)

  Làm việc với Firebase bằng tài khoản Google sở hữu script này → tài khoản đó
  phải là Owner của Firebase project (tạo project bằng chính tài khoản này).
  Cách làm theo bản Firebase của ArticuWrite / FluentTalk.

  CÁC BƯỚC CHUYỂN (chạy lần lượt trong editor; bước nào hết giờ thì chạy lại):
    ldfb_0_TestConnection   → kiểm tra kết nối Firestore + Auth
    ldfb_1_IndexExemptions  → tắt chỉ mục cho các cột chữ dài (lưu nhanh hơn). Đợi vài phút.
    ldfb_2_Teachers         → tài khoản GV (giữ email + mật khẩu cũ)
    ldfb_3_Classes          → lớp
    ldfb_4_Students         → tài khoản SV (giữ mã SV + mật khẩu cũ)
    ldfb_5_Sessions         → bài làm (Results/SessionDetails + tab Sessions cũ nếu còn)
    ldfb_6_Reviews          → dấu Done của tab New Practice
    ldfb_7_StopSheetJobs    → tắt lịch chạy rp_hourly của bản Sheet (sau khi bật Firebase)
  Google Sheet KHÔNG bị sửa: giữ làm bản sao lưu.
───────────────────────────────────────────────────────────────*/

var LDFB = {
  // Firebase console → Project settings → General
  PROJECT_ID: 'listendictation-4c26e',
  API_KEY:    'AIzaSyABj5BoT_Bz8aGJ6bys8LWCLAFhut5VJL8',
  // Phải khớp LD_FIREBASE.studentDomain trong ld-common.js
  STUDENT_DOMAIN: 'students.lisdictation.app',
  // Lớp trong Sheet không có email GV → gán cho GV này ('' = GV đầu tiên trong tab Users)
  DEFAULT_TEACHER_EMAIL: '',
  APP_URL: 'https://l2practice.github.io/listen-dictation/login.html'
};

// ── ROUTER (gọi từ routeAction trong Code.gs cho các action 'fb.*') ──
function fbRoute(action, p) {
  try {
    if (!LDFB.PROJECT_ID) return { success: false, error: 'Firebase chưa được cấu hình (LDFB.PROJECT_ID).' };
    if (action === 'fb.register')        return ldfbRegister(p || {});
    if (action === 'fb.registerTeacher') return ldfbRegisterTeacher(p || {});
    if (action === 'fb.forgotPassword')  return ldfbForgotPassword(p || {});
    // GV quản lý SV/lớp: cần quyền quản trị (đổi email đăng nhập, ghi hộ SV)
    if (action === 'fb.updateStudent')   return ldfbUpdateStudent(p || {});
    if (action === 'fb.archiveClass')    return ldfbSetClassArchived(p || {}, true);
    if (action === 'fb.restoreClass')    return ldfbSetClassArchived(p || {}, false);
    return { success: false, error: 'Unknown action: ' + action };
  } catch (e) { return { success: false, error: e.message }; }
}

// ════════════════════════════════════════════════════════════
// FIRESTORE (REST, bằng tài khoản chủ script — không bị rules giới hạn)
// ════════════════════════════════════════════════════════════
function fsBase() { return 'https://firestore.googleapis.com/v1/projects/' + LDFB.PROJECT_ID + '/databases/(default)/documents'; }
function fsName(path) { return 'projects/' + LDFB.PROJECT_ID + '/databases/(default)/documents/' + path; }
function gapi(method, url, payload) {
  var opt = { method: method, muteHttpExceptions: true, contentType: 'application/json',
              headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': LDFB.PROJECT_ID } };
  if (payload !== undefined) opt.payload = JSON.stringify(payload);
  var r = UrlFetchApp.fetch(url, opt), code = r.getResponseCode(), text = r.getContentText();
  var json = text ? JSON.parse(text) : {};
  if (code >= 300) {
    var msg = (json.error && (json.error.message || json.error.status)) || ('HTTP ' + code);
    var err = new Error(msg); err.code = code; throw err;
  }
  return json;
}
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v });
  if (v instanceof Date) return { stringValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}
function toFields(o) { var f = {}; Object.keys(o).forEach(function (k) { if (o[k] !== undefined) f[k] = toFs(o[k]); }); return f; }
function fromFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(f) { var o = {}; Object.keys(f || {}).forEach(function (k) { o[k] = fromFs(f[k]); }); return o; }
function docOf(d) { var o = fromFields(d.fields); o._id = d.name.split('/').pop(); return o; }
function fsGet(path) {
  try { return docOf(gapi('get', fsBase() + '/' + path)); }
  catch (e) { if (e.code === 404) return null; throw e; }
}
// where: [[field, op, value], ...]  op: EQUAL | LESS_THAN | ...
function fsQuery(col, where, limit) {
  var q = { from: [{ collectionId: col }] };
  if (where && where.length) {
    var filters = where.map(function (w) { return { fieldFilter: { field: { fieldPath: w[0] }, op: w[1], value: toFs(w[2]) } }; });
    q.where = filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters: filters } };
  }
  if (limit) q.limit = limit;
  var r = gapi('post', fsBase() + ':runQuery', { structuredQuery: q });
  return r.filter(function (x) { return x.document; }).map(function (x) { return docOf(x.document); });
}
function wSet(path, data) { return { update: { name: fsName(path), fields: toFields(data) } }; }
// Tên trường trong đường dẫn: bọc `…` khi không phải định danh thường (vd. mã bài bắt đầu bằng số)
function fp(seg) { return /^[A-Za-z_][A-Za-z_0-9]*$/.test(seg) ? seg : '`' + String(seg).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'; }
// Ghi GỘP: chỉ thay các trường liệt kê, giữ nguyên phần còn lại của tài liệu
function wMerge(path, data, maskPaths) {
  return { update: { name: fsName(path), fields: toFields(data) }, updateMask: { fieldPaths: maskPaths || Object.keys(data).map(fp) } };
}
// Những tài liệu (trong 1 collection) đã tồn tại — đọc theo lô 100
function fsExistingIds(col, ids) {
  var found = {};
  for (var i = 0; i < ids.length; i += 100) {
    var r = gapi('post', fsBase() + ':batchGet', { documents: ids.slice(i, i + 100).map(function (id) { return fsName(col + '/' + id); }), mask: { fieldPaths: ['uid'] } });
    r.forEach(function (x) { if (x.found) found[x.found.name.split('/').pop()] = true; });
  }
  return found;
}
// Tối đa 500 lệnh và ~10 MB mỗi lần commit: chia theo dung lượng (1 MB) và số lượng.
function fsCommit(writes) {
  var batch = [], size = 0, LIMIT = 1024 * 1024;
  function send() { if (batch.length) gapi('post', fsBase() + ':commit', { writes: batch }); batch = []; size = 0; }
  writes.forEach(function (w) {
    var s = JSON.stringify(w).length;
    if (batch.length && (size + s > LIMIT || batch.length >= 400)) send();
    batch.push(w); size += s;
  });
  send();
}

// ════════════════════════════════════════════════════════════
// FIREBASE AUTH (quản trị, bằng tài khoản chủ script)
// ════════════════════════════════════════════════════════════
function itk(path) { return 'https://identitytoolkit.googleapis.com/v1/projects/' + LDFB.PROJECT_ID + path; }
// Firebase không nhận mật khẩu dưới 6 ký tự. Đệm y hệt ld-fbdata.js.
function ldfbPw(p) { p = String(p == null ? '' : p).trim(); return p.length >= 6 ? p : (p + '______').slice(0, 6); }
function ldfbLoginEmailFor(studentId) { return String(studentId).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_') + '@' + LDFB.STUDENT_DOMAIN; }
function ldfbSha256(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
// Mã cố định: cùng 1 người luôn ra cùng 1 uid (chạy chuyển dữ liệu lại cũng an toàn).
function ldfbUidForStudent(studentId) { return 's' + ldfbSha256('sid:' + String(studentId).trim()).slice(0, 27); }
function ldfbUidForTeacher(email)     { return 't' + ldfbSha256('teacher:' + ldfbLow(email)).slice(0, 27); }
function ldfbLow(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function ldfbStr(v) { return String(v == null ? '' : v).trim(); }
function ldfbIso(v) { return v instanceof Date ? v.toISOString() : ldfbStr(v); }
function ldfbHas(v) { return v !== '' && v != null; }

function ldfbAuthCreate(uid, email, password) {
  return gapi('post', itk('/accounts'), { localId: uid, email: email, password: ldfbPw(password), emailVerified: false });
}
// claims nằm trong token đăng nhập: role ('teacher'|'student') cho firestore.rules
function ldfbAuthUpdate(uid, fields) {
  var body = { localId: uid };
  if (fields.email) body.email = fields.email;
  if (fields.password) body.password = ldfbPw(fields.password);
  if (fields.role) body.customAttributes = JSON.stringify({ role: fields.role });
  return gapi('post', itk('/accounts:update'), body);
}
function ldfbAuthLookupEmail(email) {
  try { return (gapi('post', itk('/accounts:lookup'), { email: [email] }).users || [])[0] || null; }
  catch (e) { return null; }
}
function ldfbRandomPassword() {
  var c = 'abcdefghjkmnpqrstuvwxyz23456789', s = '';
  for (var i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

// ════════════════════════════════════════════════════════════
// TÀI KHOẢN
// ════════════════════════════════════════════════════════════
function ldfbRegister(p) {
  var classId = ldfbStr(p.classId).toUpperCase();
  if (!classId) return { success: false, error: 'Cần nhập mã lớp — hỏi giảng viên.' };
  if (!ldfbStr(p.studentId) || !p.password || !ldfbStr(p.fullName)) return { success: false, error: 'Nhập đủ họ tên, mã SV và mật khẩu.' };
  var cls = fsGet('classes/' + classId);
  if (!cls) return { success: false, error: 'Mã lớp "' + classId + '" không tồn tại. Kiểm tra lại với giảng viên.' };
  if (cls.status === 'Archived') return { success: false, error: 'Lớp "' + (cls.className || classId) + '" hiện không mở đăng ký.' };

  var sid = ldfbStr(p.studentId), email = ldfbLow(p.email), uid = ldfbUidForStudent(sid);
  var taken = fsGet('users/' + uid);
  if (taken && ldfbStr(taken.studentId) === sid) return { success: false, error: 'Mã SV đã tồn tại.' };
  // uid này thuộc SV đã được GV sửa mã (uid giữ nguyên khi đổi mã) → cấp uid khác
  if (taken) uid = ldfbUidForStudent(sid + '|' + Utilities.getUuid());
  if (email && fsGet('loginIndex/' + ldfbSha256(email))) return { success: false, error: 'Email này đã được đăng ký.' };
  try { ldfbAuthCreate(uid, ldfbLoginEmailFor(sid), p.password); }
  catch (e) { if (/EXISTS|DUPLICATE/.test(e.message)) return { success: false, error: 'Mã SV đã tồn tại.' }; throw e; }
  ldfbAuthUpdate(uid, { role: 'student' });
  var writes = [wSet('users/' + uid, { role: 'student', studentId: sid, fullName: ldfbStr(p.fullName), classId: classId,
    teacherUid: cls.teacherUid || '', email: email, phone: ldfbStr(p.phone), archived: false, createdAt: new Date().toISOString() })];
  if (email) writes.push(wSet('loginIndex/' + ldfbSha256(email), { sid: sid, uid: uid }));
  fsCommit(writes);
  return { success: true, message: 'Chào mừng vào lớp ' + (cls.className || classId) + '! Đăng nhập ngay.' };
}

// Đăng ký GV tự do (như bản Sheet); khoá tài khoản lạ bằng cách đặt archived = true trong users.
function ldfbRegisterTeacher(p) {
  var email = ldfbLow(p.email);
  if (!email || !p.password || !ldfbStr(p.fullName)) return { success: false, error: 'Nhập đủ họ tên, email, mật khẩu.' };
  if (ldfbAuthLookupEmail(email)) return { success: false, error: 'Email đã tồn tại.' };
  var uid = ldfbUidForTeacher(email);
  ldfbAuthCreate(uid, email, p.password);
  ldfbAuthUpdate(uid, { role: 'teacher' });
  fsCommit([wSet('users/' + uid, { role: 'teacher', fullName: ldfbStr(p.fullName), email: email, phone: ldfbStr(p.phone),
    archived: false, createdAt: new Date().toISOString() })]);
  return { success: true, message: 'Tạo tài khoản GV thành công.' };
}

// Mật khẩu Firebase được mã hoá, không đọc lại được → đặt mật khẩu MỚI và gửi qua email.
function ldfbForgotPassword(p) {
  var email = ldfbLow(p.email);
  if (!email) return { success: false, error: 'Nhập email đã đăng ký.' };
  var uid = '', name = '', sid = '';
  var idx = fsGet('loginIndex/' + ldfbSha256(email));
  if (idx && idx.multi) return { success: false, error: 'Email này gắn với nhiều tài khoản. Liên hệ giảng viên để đặt lại mật khẩu.' };
  if (idx) {
    sid = idx.sid;
    var acc = ldfbAuthLookupEmail(ldfbLoginEmailFor(sid));
    uid = acc ? acc.localId : (idx.uid || ldfbUidForStudent(sid));
    var u = fsGet('users/' + uid); name = u ? u.fullName : '';
  } else {
    var t = ldfbAuthLookupEmail(email);
    if (t) { uid = t.localId; var tu = fsGet('users/' + uid); name = tu ? tu.fullName : ''; }
  }
  if (!uid) return { success: false, error: 'Không tìm thấy tài khoản với email này.' };
  var pw = ldfbRandomPassword();
  ldfbAuthUpdate(uid, { password: pw });
  try {
    MailApp.sendEmail({
      to: email, name: 'LisDictation', subject: '[LisDictation] Mật khẩu mới',
      body: 'Xin chào ' + (name || '') + ',\n\nMật khẩu mới của bạn: ' + pw + '\n' +
            (sid ? 'Mã SV: ' + sid + '\n' : '') + '\nĐăng nhập tại: ' + LDFB.APP_URL + '\n\n— LisDictation'
    });
  } catch (err) { return { success: false, error: 'Không gửi được email: ' + err.message }; }
  return { success: true, newPasswordSent: true };
}

// ════════════════════════════════════════════════════════════
// GV QUẢN LÝ SV / LỚP  (gọi từ teacher.html, kèm Firebase idToken của GV)
// ════════════════════════════════════════════════════════════
// Token còn hạn + đúng là GV đang hoạt động → uid của GV. Sai → SESSION_EXPIRED.
function ldfbTeacherUid_(idToken) {
  if (!idToken) throw new Error('SESSION_EXPIRED');
  var r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + LDFB.API_KEY, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify({ idToken: idToken }) });
  if (r.getResponseCode() >= 300) throw new Error('SESSION_EXPIRED');
  var acc = (JSON.parse(r.getContentText() || '{}').users || [])[0];
  if (!acc) throw new Error('SESSION_EXPIRED');
  var claims = {};
  try { claims = JSON.parse(acc.customAttributes || '{}'); } catch (e) {}
  var t = fsGet('users/' + acc.localId);
  if (claims.role !== 'teacher' || !t || t.role !== 'teacher' || t.archived) throw new Error('Chỉ giáo viên mới dùng được chức năng này.');
  return acc.localId;
}
function ldfbOwnClass_(tuid, classId) {
  var cls = classId ? fsGet('classes/' + classId) : null;
  return cls && cls.teacherUid === tuid ? cls : null;
}

// Sửa thông tin SV (mã SV, họ tên, email, SĐT) và/hoặc chuyển lớp.
// uid giữ nguyên → bài làm cũ vẫn theo SV. Đổi mã SV = đổi email đăng nhập trong Firebase Auth.
function ldfbUpdateStudent(p) {
  var tuid = ldfbTeacherUid_(p.idToken);
  var uid = ldfbStr(p.uid), s = uid ? fsGet('users/' + uid) : null;
  if (!s || s.role !== 'student' || s.teacherUid !== tuid) return { success: false, error: 'Không tìm thấy SV.' };

  var sid = ldfbStr(p.studentId), name = ldfbStr(p.fullName), email = ldfbLow(p.email), phone = ldfbStr(p.phone);
  var classId = ldfbStr(p.classId).toUpperCase() || s.classId;
  if (!sid || !name) return { success: false, error: 'Mã SV và họ tên không được để trống.' };
  if (/\s/.test(sid)) return { success: false, error: 'Mã SV không được có khoảng trắng.' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { success: false, error: 'Email không hợp lệ.' };

  var cls = ldfbOwnClass_(tuid, classId);
  if (!cls) return { success: false, error: 'Không tìm thấy lớp ' + classId + '.' };
  if (classId !== s.classId && cls.status === 'Archived') return { success: false, error: 'Không chuyển SV vào lớp đã lưu trữ.' };

  var oldSid = ldfbStr(s.studentId), oldEmail = ldfbLow(s.email);
  if (sid !== oldSid) {
    var other = ldfbAuthLookupEmail(ldfbLoginEmailFor(sid));
    if ((other && other.localId !== uid) || fsQuery('users', [['studentId', 'EQUAL', sid]], 2).some(function (x) { return x._id !== uid; }))
      return { success: false, error: 'Mã SV ' + sid + ' đã có người dùng.' };
  }
  if (email && email !== oldEmail) {
    var idx = fsGet('loginIndex/' + ldfbSha256(email));
    if (idx && (idx.multi || ldfbStr(idx.sid) !== oldSid)) return { success: false, error: 'Email này đã được tài khoản khác dùng.' };
  }

  if (sid !== oldSid) ldfbAuthUpdate(uid, { email: ldfbLoginEmailFor(sid) });

  var writes = [wMerge('users/' + uid, { studentId: sid, fullName: name, email: email, phone: phone, classId: classId })];
  // Chỉ mục email → mã SV: bỏ cái cũ (nếu đúng của SV này), ghi cái mới
  if (oldEmail && (oldEmail !== email || sid !== oldSid)) {
    var oldIdx = fsGet('loginIndex/' + ldfbSha256(oldEmail));
    if (oldIdx && !oldIdx.multi && ldfbStr(oldIdx.sid) === oldSid) writes.push({ delete: fsName('loginIndex/' + ldfbSha256(oldEmail)) });
  }
  if (email) writes.push(wSet('loginIndex/' + ldfbSha256(email), { sid: sid, uid: uid }));
  // Dòng đầu của progress (tên/mã/lớp hiện tại); từng bài vẫn giữ lớp lúc làm bài
  if (fsExistingIds('progress', [uid])[uid])
    writes.push(wMerge('progress/' + uid, { studentId: sid, fullName: name, classId: classId, className: cls.className || classId }));
  fsCommit(writes);
  return { success: true, student: { uid: uid, studentId: sid, fullName: name, email: email, phone: phone, classId: classId, className: cls.className || classId } };
}

// Lưu trữ cả lớp: khoá lớp + lưu trữ mọi SV đang học trong lớp (đánh dấu archivedBy 'class').
// Mở lại lớp: chỉ mở lại những SV bị lưu trữ CÙNG lớp; SV đã lưu trữ riêng trước đó vẫn ở Student Archive.
function ldfbSetClassArchived(p, archived) {
  var tuid = ldfbTeacherUid_(p.idToken);
  var classId = ldfbStr(p.classId).toUpperCase(), cls = ldfbOwnClass_(tuid, classId);
  if (!cls) return { success: false, error: 'Không tìm thấy lớp.' };
  var now = new Date().toISOString(), n = 0;
  var writes = [wMerge('classes/' + classId, archived ? { status: 'Archived', archivedAt: now } : { status: 'Active', archivedAt: '' })];
  fsQuery('users', [['classId', 'EQUAL', classId]]).forEach(function (u) {
    if (u.role !== 'student' || u.teacherUid !== tuid) return;
    if (archived && !u.archived) { writes.push(wMerge('users/' + u._id, { archived: true, archivedBy: 'class', archivedAt: now })); n++; }
    if (!archived && u.archived && u.archivedBy === 'class') { writes.push(wMerge('users/' + u._id, { archived: false, archivedBy: '', archivedAt: '' })); n++; }
  });
  fsCommit(writes);
  return { success: true, students: n };
}

// ════════════════════════════════════════════════════════════
// CHUYỂN DỮ LIỆU 1 LẦN  Google Sheet → Firebase
// Chạy từ editor, theo thứ tự. Bước nào cũng chạy lại được; bước nào hết giờ
// thì tự dừng gọn — chạy lại để làm tiếp. Google Sheet không bị sửa.
// ════════════════════════════════════════════════════════════
function ldfbLog(s) { Logger.log(s); return s; }
function ldfbCursor(key, v) {
  var P = PropertiesService.getScriptProperties();
  if (v === undefined) return parseInt(P.getProperty('ldfb_' + key) || '0', 10);
  P.setProperty('ldfb_' + key, String(v));
}
function ldfbRows(tab) {
  var sh = getSS().getSheetByName(tab);
  return sh ? sheetToObjects(sh) : [];
}

function ldfb_0_TestConnection() {
  var r = [];
  if (!LDFB.PROJECT_ID || !LDFB.API_KEY) return ldfbLog('Điền LDFB.PROJECT_ID và LDFB.API_KEY ở đầu file trước.');
  try { fsQuery('classes', [], 1); r.push('Firestore (admin)   OK'); } catch (e) { r.push('Firestore (admin)   LỖI: ' + e.message); }
  try { gapi('post', itk('/accounts:lookup'), { email: ['nobody@' + LDFB.STUDENT_DOMAIN] }); r.push('Firebase Auth admin OK'); }
  catch (e) { r.push('Firebase Auth admin LỖI: ' + e.message); }
  try { getSS().getName(); r.push('Google Sheet        OK'); } catch (e) { r.push('Google Sheet        LỖI: ' + e.message); }
  try { MailApp.getRemainingDailyQuota(); r.push('Mail                OK'); } catch (e) { r.push('Mail                LỖI: ' + e.message); }
  return ldfbLog(r.join('\n'));
}

// Bước 1 — các cột chữ dài không bao giờ được tìm kiếm: tắt chỉ mục (lưu nhanh hơn, và
// progress.items của SV làm nhiều bài không chạm giới hạn chỉ mục). Đợi vài phút cho
// Firestore → Indexes → Single field → Exemptions báo xong rồi mới chạy bước 5.
function ldfb_1_IndexExemptions() {
  var fields = [['progress', 'items'], ['details', 'scriptText'], ['details', 'correctedJSON'], ['details', 'cefrJSON'],
                ['details', 'collocJSON'], ['details', 'quizJSON'], ['details', 'gapJSON'], ['details', 'dictJSON']];
  var out = [];
  fields.forEach(function (f) {
    var url = 'https://firestore.googleapis.com/v1/projects/' + LDFB.PROJECT_ID +
      '/databases/(default)/collectionGroups/' + f[0] + '/fields/' + f[1] + '?updateMask=indexConfig';
    try { gapi('patch', url, { indexConfig: { indexes: [] } }); out.push(f.join('.') + '  đã yêu cầu'); }
    catch (e) { out.push(f.join('.') + '  LỖI: ' + e.message); }
  });
  return ldfbLog(out.join('\n'));
}

function ldfbTeachers_() {
  return ldfbRows(CONFIG.TABS.USERS).filter(function (u) { return u.Role === 'Teacher' && ldfbLow(u.Email); });
}
function ldfbDefaultTeacher_() {
  var t = ldfbTeachers_();
  return ldfbLow(LDFB.DEFAULT_TEACHER_EMAIL) || (t[0] ? ldfbLow(t[0].Email) : '');
}
function ldfbClassOwners_() {
  var def = ldfbDefaultTeacher_(), owner = {};
  ldfbRows(CONFIG.TABS.CLASSES).forEach(function (c) {
    var id = ldfbStr(c.ClassID).toUpperCase(); if (!id) return;
    owner[id] = { uid: ldfbUidForTeacher(ldfbLow(c.TeacherEmail) || def), name: ldfbStr(c.ClassName) || id };
  });
  return owner;
}

// Bước 2 — GV: giữ nguyên email + mật khẩu cũ.
function ldfb_2_Teachers() {
  var made = 0, writes = [];
  ldfbTeachers_().forEach(function (t) {
    var email = ldfbLow(t.Email), uid = ldfbUidForTeacher(email);
    try { ldfbAuthCreate(uid, email, String(t.Password == null ? '' : t.Password)); made++; }
    catch (e) { if (!/EXISTS|DUPLICATE/.test(e.message)) throw e; }
    ldfbAuthUpdate(uid, { role: 'teacher' });
    writes.push(wSet('users/' + uid, { role: 'teacher', fullName: ldfbStr(t.FullName), email: email, phone: ldfbStr(t.Phone),
      archived: String(t.Status) === 'Archived', createdAt: ldfbIso(t.RegisteredAt) }));
  });
  fsCommit(writes);
  return ldfbLog('Tài khoản GV mới tạo: ' + made + ', hồ sơ đã ghi: ' + writes.length);
}

// Bước 3 — lớp. Lớp không có email GV → GV mặc định.
function ldfb_3_Classes() {
  var def = ldfbDefaultTeacher_(), writes = [], orphan = 0;
  var names = {};
  ldfbTeachers_().forEach(function (t) { names[ldfbLow(t.Email)] = ldfbStr(t.FullName); });
  ldfbRows(CONFIG.TABS.CLASSES).forEach(function (c) {
    var id = ldfbStr(c.ClassID).toUpperCase(); if (!id) return;
    var email = ldfbLow(c.TeacherEmail) || def;
    if (!ldfbLow(c.TeacherEmail)) orphan++;
    writes.push(wSet('classes/' + id, { classId: id, className: ldfbStr(c.ClassName) || id, academicYear: ldfbStr(c.AcademicYear),
      semester: ldfbStr(c.Semester), teacherUid: ldfbUidForTeacher(email), teacherName: ldfbStr(c.TeacherName) || names[email] || '',
      teacherEmail: email, status: String(c.Status) === 'Archived' ? 'Archived' : 'Active', createdAt: ldfbIso(c.CreatedAt) }));
  });
  fsCommit(writes);
  return ldfbLog('Lớp: ' + writes.length + (orphan ? ' (' + orphan + ' lớp không có email GV → ' + def + ')' : ''));
}

// Bước 4 — SV: giữ nguyên mã SV / email và CÙNG mật khẩu cũ.
function ldfb_4_Students() {
  var t0 = Date.now(), owner = ldfbClassOwners_();
  var rows = ldfbRows(CONFIG.TABS.USERS).filter(function (u) { return u.Role !== 'Teacher' && ldfbStr(u.StudentID); });
  var start = ldfbCursor('stu'), made = 0, skipped = 0;
  for (var i = start; i < rows.length; i++) {
    if (Date.now() - t0 > 4.5 * 60000) { ldfbCursor('stu', i); return ldfbLog('Tạm dừng ở SV ' + i + '/' + rows.length + ' — chạy lại ldfb_4_Students để làm tiếp.'); }
    var sid = ldfbStr(rows[i].StudentID), uid = ldfbUidForStudent(sid);
    try { ldfbAuthCreate(uid, ldfbLoginEmailFor(sid), String(rows[i].Password == null || rows[i].Password === '' ? sid : rows[i].Password)); made++; }
    catch (e) { if (/EXISTS|DUPLICATE/.test(e.message)) skipped++; else { Logger.log('Tài khoản ' + sid + ': ' + e.message); continue; } }
    ldfbAuthUpdate(uid, { role: 'student' });
  }
  ldfbCursor('stu', 0);
  var writes = [], emails = {};
  rows.forEach(function (s) {
    var sid = ldfbStr(s.StudentID), classId = ldfbStr(s.ClassID).toUpperCase(), email = ldfbLow(s.Email);
    writes.push(wSet('users/' + ldfbUidForStudent(sid), { role: 'student', studentId: sid, fullName: ldfbStr(s.FullName),
      classId: classId, teacherUid: owner[classId] ? owner[classId].uid : '', email: email, phone: ldfbStr(s.Phone),
      archived: String(s.Status) === 'Archived', createdAt: ldfbIso(s.RegisteredAt) }));
    if (email) (emails[email] = emails[email] || []).push(sid);
  });
  Object.keys(emails).forEach(function (e) {
    writes.push(wSet('loginIndex/' + ldfbSha256(e), emails[e].length > 1 ? { sid: emails[e][0], multi: true } : { sid: emails[e][0] }));
  });
  fsCommit(writes);
  return ldfbLog('Tài khoản SV mới tạo: ' + made + ', đã có/bỏ qua: ' + skipped + ', hồ sơ đã ghi: ' + rows.length);
}

// Gom mọi bài làm trong Sheet từ CẢ 3 nguồn: tab Sessions cũ, SessionDetails, Results.
// Cùng 1 bài có ở nhiều nơi → ghép lại, ô nào có dữ liệu thì dùng (Results ưu tiên cho điểm,
// chi tiết lấy từ SessionDetails, thiếu thì lấy từ Sessions cũ) → không bỏ sót phần nào.
function ldfbAllSessions_() {
  var by = {}, order = [];
  var add = function (o) {
    var id = String(o.SessionID == null ? '' : o.SessionID).trim(); if (!id) return;
    if (!by[id]) { by[id] = {}; order.push(id); }
    var cur = by[id];
    Object.keys(o).forEach(function (k) { if (ldfbHas(o[k])) cur[k] = o[k]; });
  };
  ldfbRows(CONFIG.TABS.LEGACY).forEach(add);
  ldfbRows(CONFIG.TABS.DETAILS).forEach(add);
  ldfbRows(CONFIG.TABS.RESULTS).forEach(add);
  return order.map(function (id) { var o = by[id]; o.SessionID = id; return o; });
}
function ldfbCompactCefr_(cefrJSON) {
  var c = {};
  try { c = cefrJSON ? (typeof cefrJSON === 'object' ? cefrJSON : JSON.parse(cefrJSON)) : {}; } catch (e) { c = {}; }
  var byLevel = {}, gloss = {};
  ['B2', 'C1', 'C2'].forEach(function (lv) { if (c.byLevel && c.byLevel[lv]) byLevel[lv] = c.byLevel[lv]; });
  Object.keys(byLevel).forEach(function (lv) { byLevel[lv].forEach(function (w) { var k = String(w).toLowerCase(); if (c.gloss && c.gloss[k]) gloss[k] = c.gloss[k]; }); });
  return JSON.stringify({ total: c.total || 0, counts: c.counts || {}, byLevel: byLevel, gloss: gloss });
}

/* Bước 5 — bài làm. Mỗi bài thành: 1 dòng nhẹ trong progress/{uid}.items (điểm — History,
   tab Sessions, New Practice) + 1 tài liệu details/{sessionId} (script + bài làm). Bài đã xong
   3 phần được làm gọn (bỏ script thô) và khoá lại như bản tổng kết. details ghi trước
   (làm tiếp được nếu hết giờ), progress ghi sau cùng.                                       */
function ldfb_5_Sessions() {
  var t0 = Date.now(), owner = ldfbClassOwners_();
  var users = {};
  ldfbRows(CONFIG.TABS.USERS).forEach(function (u) { if (ldfbStr(u.StudentID)) users[ldfbStr(u.StudentID)] = u; });
  var all = ldfbAllSessions_(), start = ldfbCursor('ses'), writes = [];
  // Bài đã có trên Firebase (vd. SV làm tiếp sau khi bật Firebase) → không ghi đè
  var exists = fsExistingIds('details', all.slice(start).map(function (s) { return String(s.SessionID); }));
  for (var i = start; i < all.length; i++) {
    if (Date.now() - t0 > 4 * 60000) {
      fsCommit(writes); ldfbCursor('ses', i);
      return ldfbLog('Tạm dừng ở bài ' + i + '/' + all.length + ' — chạy lại ldfb_5_Sessions để làm tiếp.');
    }
    var s = all[i], sid = ldfbStr(s.StudentID);
    if (!sid || exists[String(s.SessionID)]) continue;
    if (!(s.CorrectedScriptJSON || s.QuizJSON || s.GapFillJSON || s.DictationJSON)) continue;  // không còn chi tiết
    var classId = ldfbStr((users[sid] && users[sid].ClassID) || s.ClassID).toUpperCase();
    var complete = ldfbHas(s.QuizScore) && ldfbHas(s.GapFillScore) && ldfbHas(s.DictationAccuracy);
    var dj = null;
    try { dj = s.DictationJSON ? JSON.parse(s.DictationJSON) : null; } catch (e) { dj = null; }
    if (dj && dj.answers) dj.answers = _compactDictAnswers(dj.answers);
    var d = { uid: ldfbUidForStudent(sid), teacherUid: owner[classId] ? owner[classId].uid : '', studentId: sid,
              correctedJSON: ldfbStr(s.CorrectedScriptJSON) || '[]', cefrJSON: complete ? ldfbCompactCefr_(s.CEFRJSON) : ldfbStr(s.CEFRJSON),
              collocJSON: ldfbStr(s.CollocationJSON), quizJSON: ldfbStr(s.QuizJSON), gapJSON: ldfbStr(s.GapFillJSON),
              dictJSON: dj ? JSON.stringify(dj) : '', compact: complete, createdAt: ldfbIso(s.CreatedAt || s.StartTime) };
    if (!complete && s.ScriptText) d.scriptText = String(s.ScriptText);
    writes.push(wSet('details/' + String(s.SessionID), d));
    if (writes.length >= 200) { fsCommit(writes); writes = []; ldfbCursor('ses', i + 1); }
  }
  fsCommit(writes);
  ldfbCursor('ses', 0);

  // progress: 1 tài liệu / SV, chứa dòng tóm tắt của mọi bài
  var prog = {};
  all.forEach(function (s) {
    var sid = ldfbStr(s.StudentID); if (!sid) return;
    var u = users[sid] || {}, classId = ldfbStr(u.ClassID || s.ClassID).toUpperCase();
    var p = prog[sid] || (prog[sid] = { studentId: sid, fullName: ldfbStr(u.FullName || s.StudentName), classId: classId,
      className: owner[classId] ? owner[classId].name : ldfbStr(s.ClassName), teacherUid: owner[classId] ? owner[classId].uid : '', items: {} });
    var dj = null;
    try { dj = s.DictationJSON ? JSON.parse(s.DictationJSON) : null; } catch (e) {}
    var row = { bookTestPart: ldfbStr(s.BookTestPart), classId: ldfbStr(s.ClassID).toUpperCase(), className: ldfbStr(s.ClassName),
                startTime: ldfbIso(s.StartTime), createdAt: ldfbIso(s.CreatedAt || s.StartTime) };
    ['EndTime'].forEach(function (k) { if (ldfbHas(s[k])) row.endTime = ldfbIso(s[k]); });
    if (ldfbHas(s.DurationMin)) row.durationMin = Number(s.DurationMin);
    if (ldfbHas(s.QuizScore)) row.quizScore = Number(s.QuizScore);
    if (ldfbHas(s.GapFillScore)) row.gapFillScore = Number(s.GapFillScore);
    if (ldfbHas(s.DictationAccuracy)) row.dictationAccuracy = Number(s.DictationAccuracy);
    if (ldfbHas(s.TotalScore)) row.totalScore = Number(s.TotalScore);
    if (!ldfbHas(s.DictationAccuracy) && (s.DictInProgress === true || (dj && dj.completed === false))) {
      row.dictInProgress = true;
      row.dictSavedAt = ldfbIso(s.DictSavedAt || (dj && dj.savedAt) || '');
      row.dictSentenceIdx = Number(s.DictSentenceIdx || (dj && dj.currentSentenceIdx) || 0);
    }
    // Bài cũ đã bị dọn chi tiết trong Sheet: còn link Google Doc thì giữ để mở
    if (!(s.CorrectedScriptJSON || s.QuizJSON || s.GapFillJSON || s.DictationJSON)) {
      row.detailPurged = true;
      if (s.DocURL) row.docUrl = String(s.DocURL);
    }
    p.items[String(s.SessionID)] = row;
  });
  // Ghi gộp từng bài (items.<mã bài>) → chạy lại sau khi đã bật Firebase cũng không xoá bài làm mới
  var pw = Object.keys(prog).map(function (sid) {
    var p = prog[sid], paths = ['studentId', 'fullName', 'classId', 'className', 'teacherUid'];
    Object.keys(p.items).forEach(function (id) { paths.push('items.' + fp(id)); });
    return wMerge('progress/' + ldfbUidForStudent(sid), p, paths);
  });
  fsCommit(pw);
  return ldfbLog('Bài làm: ' + all.length + ' bài của ' + pw.length + ' SV đã chuyển.');
}

// Bước 6 — dấu "Done" của tab New Practice
function ldfb_6_Reviews() {
  var owner = ldfbClassOwners_(), writes = [];
  ldfbRows(CONFIG.TABS.REVIEWS).forEach(function (r) {
    var classId = ldfbStr(r.ClassID).toUpperCase(); if (!classId || !owner[classId]) return;
    var key = classId + '|' + rpBtpKey_(r.BookTestPart), tuid = owner[classId].uid;
    writes.push(wSet('reviews/' + tuid + '_' + ldfbSha256(key).slice(0, 32), { teacherUid: tuid, groupKey: key, classId: classId,
      bookTestPart: ldfbStr(r.BookTestPart), reviewedUpTo: ldfbIso(r.ReviewedUpTo), prevReviewedUpTo: ldfbIso(r.PrevReviewedUpTo),
      reviewedAt: ldfbIso(r.ReviewedAt) }));
  });
  fsCommit(writes);
  return ldfbLog('Dấu Done đã chuyển: ' + writes.length);
}

// Bước 7 — sau khi đã bật Firebase trong ld-common.js: tắt lịch chạy của bản Sheet
function ldfb_7_StopSheetJobs() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['rp_hourly', 'hw_hourly'].indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); n++; }
  });
  return ldfbLog('Đã tắt ' + n + ' lịch chạy của bản Google Sheet.');
}
