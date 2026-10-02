/*───────────────────────────────────────────────────────────────
  LisDictation — Firebase data layer (ld-fbdata.js)

  LD.api(action, payload) lands here when Firebase is switched on
  (LD_FIREBASE in ld-common.js). Every action answers in the SAME shape
  the Apps Script backend returned, so the pages did not have to change.

    ACTIONS   answered here, straight from Firestore (fast, no Apps Script)
    GAS_FB    Apps Script, Firebase edition (gas/FirebaseLD.gs): creating
              accounts and resetting passwords need admin rights.

  Collections (see firestore.rules):
    users/{uid}          role 'student'|'teacher', studentId, fullName, classId,
                         teacherUid (students), email, phone, archived, createdAt
    loginIndex/{sha256}  sha256(lowercased email) → { sid }   (email sign-in)
    classes/{classId}    classId, className, academicYear, semester, teacherUid,
                         teacherName, teacherEmail, status, createdAt
    progress/{uid}       ONE doc per student: studentId, fullName, classId,
                         className, teacherUid, items { sessionId: light row }
                         → History, the teacher's Sessions tab and New Practice
                         read one small doc per student, never the details.
    details/{sessionId}  script + answers of one session (JSON strings), read
                         only when that session is opened. Kept for good once
                         finished (compact); only draft data is dropped.
    reviews/{id}         New Practice "Done" marks of a teacher.
───────────────────────────────────────────────────────────────*/
(function () {
'use strict';

const CFG = window.LD_FIREBASE || {};
const STUDENT_DOMAIN = CFG.studentDomain || 'students.lisdictation.app';
const NEW_PRACTICE_DAYS = 30;        // "new" = completed in the last 30 days and not marked Done
const NEW_PRACTICE_PER_CLASS = 2;    // New Practice shows the 2 newest exercises per class
const DRAFT_TTL_DAYS = 7;            // sessions never worked on (no part done) are removed after 7 days

let fs = null, auth = null, FV = null, _authReady = null;
function init() {
  if (fs) return;
  firebase.initializeApp(window.__FB_CONFIG || CFG.config);
  fs = firebase.firestore();
  auth = firebase.auth();
  if (window.__FB_EMU) {   // tests only
    auth.useEmulator('http://127.0.0.1:9099'); fs.useEmulator('127.0.0.1', 8080);
  }
  FV = firebase.firestore.FieldValue;
  _authReady = new Promise(res => { const off = auth.onAuthStateChanged(u => { off(); res(u); }); });
}
function authReady() { init(); return _authReady; }

// ── helpers ─────────────────────────────────
// Firebase refuses passwords under 6 characters; older accounts may have one.
// Every place that sets or checks a password pads it the same way (FirebaseLD.gs too).
function authPw(p) { p = String(p == null ? '' : p).trim(); return p.length >= 6 ? p : (p + '______').slice(0, 6); }
function loginEmailFor(studentId) {
  return String(studentId).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_') + '@' + STUDENT_DOMAIN;
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function genId(n, prefix) {
  const c = '0123456789ABCDEF'; let s = prefix || '';
  while (s.length < n) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
const ok   = data => (data === undefined ? { success: true } : Object.assign({ success: true }, data));
const fail = msg => ({ success: false, error: msg });
const str  = v => String(v == null ? '' : v).trim();
const low  = v => str(v).toLowerCase();
const has  = v => v !== '' && v != null;
const docs = qs => qs.docs.map(d => Object.assign({ _id: d.id }, d.data()));
const nowIso = () => new Date().toISOString();
const ms = v => { const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };
const json = (v, fb) => { if (!v) return fb; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return fb; } };
// "Cam17 · Test 1 · Part 4" ≡ "cam17 test 1 part 4"
const btpKey = s => low(s).replace(/[·|,]/g, ' ').replace(/\s+/g, ' ').trim();
const reportUrl = id => 'review.html?session=' + encodeURIComponent(id);

// ── short-lived memo (one page visit re-reads the same lists a lot) ──
const _memo = {};
async function memo(key, ttl, fn) {
  const h = _memo[key];
  if (h && Date.now() - h.t < ttl) return h.v;
  const v = await fn();
  _memo[key] = { t: Date.now(), v };
  return v;
}
function forget(prefix) { Object.keys(_memo).forEach(k => { if (!prefix || k.indexOf(prefix) === 0) delete _memo[k]; }); }

// ── current user ────────────────────────────
let _me = null;
async function me() {
  await authReady();
  const u = auth.currentUser;
  if (!u) throw new Error('SESSION_EXPIRED');
  if (_me && _me.uid === u.uid) return _me;
  const d = await fs.doc('users/' + u.uid).get();
  if (!d.exists) throw new Error('SESSION_EXPIRED');
  return (_me = Object.assign({ uid: u.uid }, d.data()));
}
async function teacher() {
  const t = await me();
  if (t.role !== 'teacher') throw Object.assign(new Error('Chỉ giáo viên mới dùng được chức năng này.'), { code: 'not-teacher' });
  return t;
}
async function className(classId) {
  if (!classId) return '';
  return memo('cls|' + classId, 300000, async () => {
    const d = await fs.doc('classes/' + classId).get();
    return d.exists ? (d.data().className || classId) : classId;
  });
}
function sessionUser(u, cname) {
  return { studentId: u.studentId || '', fullName: u.fullName || '', classId: u.classId || '', className: cname || '',
           email: u.email || '', role: u.role === 'teacher' ? 'Teacher' : 'Student' };
}

// ════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════
// Persistence SESSION = the sign-in ends when the tab closes (same as before).
async function signIn(email, password) {
  init();
  try { await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION); } catch (e) {}
  try { await auth.signInWithEmailAndPassword(email, authPw(password)); return null; }
  catch (e) {
    const c = e.code || '';
    if (/too-many-requests/.test(c)) return 'Đăng nhập sai quá nhiều lần. Vui lòng đợi vài phút.';
    if (/network/.test(c)) return 'Lỗi mạng — kiểm tra kết nối và thử lại.';
    return 'WRONG';
  }
}
async function studentLogin(p) {
  init();
  const id = str(p.studentId || p.login || p.email);
  if (!id || !p.password) return fail('Nhập đủ tài khoản và mật khẩu.');
  let sid = id;
  if (id.indexOf('@') >= 0) {
    const idx = await fs.doc('loginIndex/' + await sha256Hex(low(id))).get();
    if (!idx.exists) {
      // Not a student email → maybe a teacher signing in on the student form
      const err = await signIn(low(id), p.password);
      if (err && err !== 'WRONG') return fail(err);
      if (err) return fail('Sai tài khoản hoặc mật khẩu.');
      return finishLogin();
    }
    if (idx.data().multi) return fail('Email này gắn với nhiều tài khoản. Hãy đăng nhập bằng mã SV.');
    sid = idx.data().sid;
  }
  const err = await signIn(loginEmailFor(sid), p.password);
  if (err) return fail(err === 'WRONG' ? 'Sai tài khoản hoặc mật khẩu.' : err);
  return finishLogin();
}
async function finishLogin(requireTeacher) {
  _me = null; forget();
  const u = await me().catch(() => null);
  if (!u || u.archived || (requireTeacher && u.role !== 'teacher')) {
    await signOut();
    return fail(u && u.archived ? 'Tài khoản đã bị khoá. Liên hệ giảng viên.' : 'Sai tài khoản hoặc mật khẩu.');
  }
  return ok({ sessionToken: 'firebase', user: sessionUser(u, await className(u.classId)) });
}
async function teacherLogin(p) {
  const email = low(p.email);
  if (!email || !p.password) return fail('Nhập email và mật khẩu.');
  const err = await signIn(email, p.password);
  if (err) return fail(err === 'WRONG' ? 'Sai email hoặc mật khẩu.' : err);
  return finishLogin(true);
}
async function signOut() { init(); _me = null; forget(); try { await auth.signOut(); } catch (e) {} }

// ════════════════════════════════════════════
// STUDENT: sessions (progress/{uid}.items + details/{sessionId})
// ════════════════════════════════════════════
async function myProgress() {
  const u = await me();
  const d = await fs.doc('progress/' + u.uid).get();
  return d.exists ? d.data() : null;
}
// Fields the progress doc must always carry (the rules check class + teacher)
function progressHead(u, cname) {
  return { studentId: u.studentId || '', fullName: u.fullName || '', classId: u.classId || '',
           className: cname || '', teacherUid: u.teacherUid || '' };
}
function itemPatch(u, sessionId, patch) {
  const o = {};
  Object.keys(patch).forEach(k => { o['items.' + sessionId + '.' + k] = patch[k]; });
  return o;
}
async function sessionStart(p) {
  const u = await me(), id = genId(16, 'S'), now = nowIso(), cname = await className(u.classId);
  const batch = fs.batch();
  batch.set(fs.doc('details/' + id), { uid: u.uid, teacherUid: u.teacherUid || '', studentId: u.studentId || '', createdAt: now });
  batch.set(fs.doc('progress/' + u.uid), Object.assign(progressHead(u, cname), {
    items: { [id]: { bookTestPart: str(p.bookTestPart), classId: u.classId || '', className: cname, startTime: now, createdAt: now } }
  }), { merge: true });
  await batch.commit();
  return ok({ sessionId: id });
}
async function ownSession(sessionId) {
  const u = await me(), prog = await myProgress();
  const row = prog && prog.items && prog.items[sessionId];
  if (!row) throw new Error('Không tìm thấy session.');
  return { u, prog, row };
}
async function saveAnalysis(p) {
  await ownSession(p.sessionId);
  await fs.doc('details/' + p.sessionId).update({
    scriptText: String(p.scriptText || ''),
    correctedJSON: JSON.stringify(p.correctedSentences || []),
    cefrJSON: JSON.stringify(p.cefr || {}),
    collocJSON: JSON.stringify(p.collocations || [])
  });
  return ok();
}
// Quiz & Gap-fill: không cho lưu dở dang (đã chốt) — chỉ ghi khi làm đủ.
async function saveQuiz(p) {
  const answers = p.answers || [];
  if (answers.length !== 15) return fail('Quiz phải làm đủ 15/15 câu mới được lưu (hiện ' + answers.length + ').');
  const { u } = await ownSession(p.sessionId);
  const score = p.score != null ? p.score : Math.round((p.correct || 0) / 15 * 100);
  const batch = fs.batch();
  batch.update(fs.doc('details/' + p.sessionId), { quizJSON: JSON.stringify({ questions: p.questions || [], answers, correct: p.correct, total: 15, savedAt: nowIso() }) });
  batch.update(fs.doc('progress/' + u.uid), itemPatch(u, p.sessionId, { quizScore: score }));
  await batch.commit();
  return ok();
}
async function saveGapFill(p) {
  const answers = p.answers || [], total = p.total || answers.length;
  if (!total || answers.length !== total) return fail('Gap-fill phải điền hết mới được lưu (' + answers.length + '/' + total + ').');
  const { u } = await ownSession(p.sessionId);
  const score = p.score != null ? p.score : Math.round((p.correct || 0) / total * 100);
  const batch = fs.batch();
  batch.update(fs.doc('details/' + p.sessionId), { gapJSON: JSON.stringify({ answers, correct: p.correct, total, savedAt: nowIso() }) });
  batch.update(fs.doc('progress/' + u.uid), itemPatch(u, p.sessionId, { gapFillScore: score }));
  await batch.commit();
  return ok();
}
// Chỉ lưu câu SV gõ — câu gốc đã có trong correctedJSON.
function compactDict(answers) {
  return (answers || []).map(a => { a = a || {}; return { typed: String(a.typed || ''), checked: !!a.checked, attempted: !!(a.attempted || a.checked || a.resultHtml) }; });
}
async function saveDictationProgress(p) {
  const { u } = await ownSession(p.sessionId);
  const now = nowIso(), idx = p.currentSentenceIdx || 0;
  const batch = fs.batch();
  batch.update(fs.doc('details/' + p.sessionId), { dictJSON: JSON.stringify({ currentSentenceIdx: idx, answers: compactDict(p.answers), completed: false, savedAt: now }) });
  batch.update(fs.doc('progress/' + u.uid), itemPatch(u, p.sessionId, { dictInProgress: true, dictSavedAt: now, dictSentenceIdx: idx }));
  await batch.commit();
  return ok({ sessionId: p.sessionId });
}
// Bài xong đủ 3 phần → giữ bản tổng kết gọn VĨNH VIỄN, chỉ bỏ dữ liệu nháp:
// script thô dán vào + danh sách từ A1–B1 (bản tổng kết chỉ dùng từ B2 trở lên).
function compactCefr(cefrJSON) {
  const c = json(cefrJSON, {}) || {};
  const byLevel = {};
  ['B2', 'C1', 'C2'].forEach(lv => { if (c.byLevel && c.byLevel[lv]) byLevel[lv] = c.byLevel[lv]; });
  const gloss = {};
  Object.values(byLevel).forEach(list => list.forEach(w => { const g = c.gloss && c.gloss[String(w).toLowerCase()]; if (g) gloss[String(w).toLowerCase()] = g; }));
  return JSON.stringify({ total: c.total || 0, counts: c.counts || {}, byLevel, gloss });
}
async function finishDictation(p) {
  const { u, row } = await ownSession(p.sessionId);
  const det = await fs.doc('details/' + p.sessionId).get();
  const accuracy = p.accuracy != null ? p.accuracy : 0;
  const total = Math.round(((Number(row.quizScore) || 0) + (Number(row.gapFillScore) || 0) + accuracy) / 3);
  const end = nowIso(), start = ms(row.startTime);
  const batch = fs.batch();
  batch.update(fs.doc('details/' + p.sessionId), {
    dictJSON: JSON.stringify({ answers: compactDict(p.answers), accuracy, completed: true, savedAt: end }),
    cefrJSON: compactCefr(det.exists ? det.data().cefrJSON : ''),
    scriptText: FV.delete(),
    compact: true
  });
  batch.update(fs.doc('progress/' + u.uid), itemPatch(u, p.sessionId, {
    dictationAccuracy: accuracy, totalScore: total, endTime: end,
    durationMin: start ? Math.round((Date.now() - start) / 60000) : '',
    dictInProgress: false
  }));
  await batch.commit();
  return ok({ totalScore: total });
}
// Bản tổng kết xem ngay trong app (review.html) — không còn Google Doc
async function exportReport(p) {
  const { row } = await ownSession(p.sessionId);
  if (!has(row.dictationAccuracy)) return fail('Bài chưa hoàn thành đủ 3 phần.');
  return ok({ docUrl: row.docUrl || reportUrl(p.sessionId) });
}

// One light row → the shape the pages already use
function summary(id, r, head) {
  const quizDone = has(r.quizScore), gapDone = has(r.gapFillScore), dictDone = has(r.dictationAccuracy);
  const isComplete = quizDone && gapDone && dictDone;
  return {
    sessionId: id, studentId: head.studentId, studentName: head.fullName,
    classId: r.classId || head.classId, className: r.className || head.className,
    bookTestPart: r.bookTestPart || '', startTime: r.startTime || '', endTime: r.endTime || '',
    durationMin: has(r.durationMin) ? r.durationMin : '',
    quizScore: quizDone ? r.quizScore : null, gapFillScore: gapDone ? r.gapFillScore : null,
    dictationAccuracy: dictDone ? r.dictationAccuracy : null, totalScore: has(r.totalScore) ? r.totalScore : null,
    quizDone, gapDone, dictDone, isComplete, dictInProgress: !dictDone && !!r.dictInProgress,
    // Bài cũ từ Sheet đã bị dọn chi tiết thì còn link Google Doc; còn lại xem trong app
    docUrl: isComplete ? (r.docUrl || reportUrl(id)) : '', detailPurged: !!r.detailPurged
  };
}
const active = s => s.quizDone || s.gapDone || s.dictDone || s.dictInProgress;
const newestFirst = (a, b) => ms(b.startTime) - ms(a.startTime);

async function historySummary(p) {
  const u = await me(), prog = await myProgress();
  const items = (prog && prog.items) || {};
  const from = p && p.fromDate ? ms(p.fromDate) : 0;
  const rows = [], stale = [];
  Object.keys(items).forEach(id => {
    const s = summary(id, items[id], prog);
    if (!active(s)) {
      // Bài chỉ mới dán script, chưa làm phần nào, đã quá 7 ngày → dữ liệu nháp, dọn đi
      if (ms(s.startTime) && Date.now() - ms(s.startTime) > DRAFT_TTL_DAYS * 864e5) stale.push(id);
      return;
    }
    if (from && ms(s.startTime) < from) return;
    rows.push(s);
  });
  if (stale.length) {
    const batch = fs.batch();
    const patch = {};
    stale.forEach(id => { batch.delete(fs.doc('details/' + id)); patch['items.' + id] = FV.delete(); });
    batch.update(fs.doc('progress/' + u.uid), patch);
    batch.commit().catch(e => console.warn('[ld-fbdata] draft cleanup', e));
  }
  return ok({ data: rows.sort(newestFirst) });
}
async function inProgressTop5() {
  const prog = await myProgress(), items = (prog && prog.items) || {};
  const rows = Object.keys(items).map(id => ({ id, r: items[id] }))
    .filter(x => x.r.dictInProgress && !has(x.r.dictationAccuracy))
    .map(x => ({ sessionId: x.id, bookTestPart: x.r.bookTestPart || '', startTime: x.r.startTime || '',
                 savedAt: x.r.dictSavedAt || '', currentSentenceIdx: Number(x.r.dictSentenceIdx) || 0 }));
  rows.sort((a, b) => ms(b.savedAt || b.startTime) - ms(a.savedAt || a.startTime));
  return ok({ data: rows.slice(0, 5) });
}
// Ghép dòng tiến độ + chi tiết thành object giống Apps Script trả về
function sessionObject(id, row, head, det) {
  const s = summary(id, row, head), d = det || {};
  return {
    SessionID: id, StudentID: s.studentId, StudentName: s.studentName, ClassID: s.classId, ClassName: s.className,
    BookTestPart: s.bookTestPart, StartTime: s.startTime, EndTime: s.endTime, DurationMin: s.durationMin,
    QuizScore: has(row.quizScore) ? row.quizScore : '', GapFillScore: has(row.gapFillScore) ? row.gapFillScore : '',
    DictationAccuracy: has(row.dictationAccuracy) ? row.dictationAccuracy : '', TotalScore: has(row.totalScore) ? row.totalScore : '',
    DocURL: row.docUrl || (s.isComplete ? reportUrl(id) : ''), DetailPurgedAt: row.detailPurged ? (row.detailPurgedAt || 'yes') : '',
    ScriptText: d.scriptText || '',
    CorrectedScriptJSON: json(d.correctedJSON, null), CEFRJSON: json(d.cefrJSON, null),
    CollocationJSON: json(d.collocJSON, null), QuizJSON: json(d.quizJSON, null),
    GapFillJSON: json(d.gapJSON, null), DictationJSON: json(d.dictJSON, null)
  };
}
async function resumeSession(p) {
  const { prog, row } = await ownSession(p.sessionId);
  const det = await fs.doc('details/' + p.sessionId).get();
  return ok({ data: sessionObject(p.sessionId, row, prog, det.exists ? det.data() : null) });
}
async function deleteSession(p) {
  const { u, row } = await ownSession(p.sessionId);
  if (has(row.quizScore) && has(row.gapFillScore) && has(row.dictationAccuracy))
    return fail('Bài đã hoàn thành đủ 3 phần — không thể xoá.');
  const batch = fs.batch();
  batch.delete(fs.doc('details/' + p.sessionId));
  batch.update(fs.doc('progress/' + u.uid), { ['items.' + p.sessionId]: FV.delete() });
  await batch.commit();
  return ok();
}

// ════════════════════════════════════════════
// TEACHER
// ════════════════════════════════════════════
const myClasses  = t => memo('classes', 60000, async () => docs(await fs.collection('classes').where('teacherUid', '==', t.uid).get()));
const myStudents = t => memo('students', 60000, async () => docs(await fs.collection('users').where('teacherUid', '==', t.uid).get()));
const myProgressDocs = (t, classId) => memo('progress|' + (classId || '*'), 20000, async () => {
  let q = fs.collection('progress').where('teacherUid', '==', t.uid);
  if (classId) q = q.where('classId', '==', classId);
  return docs(await q.get());
});

async function getClasses() {
  const t = await teacher();
  const [classes, students] = await Promise.all([myClasses(t), myStudents(t)]);
  const data = classes.map(c => ({
    ClassID: c.classId || c._id, ClassName: c.className || c._id, AcademicYear: c.academicYear || '', Semester: c.semester || '',
    TeacherName: c.teacherName || '', TeacherEmail: c.teacherEmail || '', Status: c.status || 'Active', CreatedAt: c.createdAt || '',
    StudentCount: students.filter(s => s.role === 'student' && !s.archived && s.classId === (c.classId || c._id)).length
  }));
  data.sort((a, b) => String(a.ClassName).localeCompare(String(b.ClassName)));
  return ok({ data });
}
// Mã dễ đọc/gõ tay: LD- + 3 chữ + 3 số, bỏ ký tự dễ nhầm (như bản Apps Script)
async function createClass(p) {
  const t = await teacher();
  const name = str(p.className);
  if (!name) return fail('Nhập tên lớp.');
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ', N = '23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = 'LD-';
    for (let i = 0; i < 3; i++) code += A[Math.floor(Math.random() * A.length)];
    for (let i = 0; i < 3; i++) code += N[Math.floor(Math.random() * N.length)];
    const ref = fs.doc('classes/' + code);
    try {
      await fs.runTransaction(async tx => {
        if ((await tx.get(ref)).exists) throw new Error('TAKEN');
        tx.set(ref, { classId: code, className: name, academicYear: str(p.academicYear), semester: str(p.semester),
                      teacherUid: t.uid, teacherName: t.fullName || '', teacherEmail: t.email || '', status: 'Active', createdAt: nowIso() });
      });
      forget('classes');
      return ok({ classId: code, className: name });
    } catch (e) { if (e.message !== 'TAKEN') throw e; }
  }
  return fail('Không tạo được mã lớp — thử lại.');
}
async function setClassStatus(p) {
  await teacher();
  await fs.doc('classes/' + str(p.classId)).update({ status: p.status === 'Archived' ? 'Archived' : 'Active' });
  forget('classes');
  return ok();
}
async function getRoster(p) {
  const t = await teacher();
  const cname = await className(p.classId);
  const data = (await myStudents(t)).filter(s => s.role === 'student' && (!p.classId || s.classId === p.classId))
    .map(s => ({ studentId: s.studentId, fullName: s.fullName, email: s.email || '', phone: s.phone || '',
                 status: s.archived ? 'Archived' : 'Active', className: cname }));
  return ok({ data });
}
async function archiveStudent(p) {
  const t = await teacher();
  const s = (await myStudents(t)).find(x => str(x.studentId) === str(p.studentId));
  if (!s) return fail('Không tìm thấy SV.');
  await fs.doc('users/' + s._id).update({ archived: p.archived !== false });
  forget('students');
  return ok();
}
async function allRows(t, classId) {
  const out = [];
  (await myProgressDocs(t, classId)).forEach(pd => {
    const items = pd.items || {};
    Object.keys(items).forEach(id => {
      const s = summary(id, items[id], pd);
      s.uid = pd._id;
      if (!classId || s.classId === classId) out.push(s);
    });
  });
  return out;
}
async function filteredSessions(p) {
  const t = await teacher();
  if (!p || (!p.classId && !p.fromDate && !p.bookFilter)) return fail('Vui lòng chọn ít nhất một bộ lọc (lớp, ngày bắt đầu, hoặc book) trước khi tải.');
  const from = p.fromDate ? ms(p.fromDate) : 0, to = p.toDate ? ms(p.toDate + 'T23:59:59') : 0;
  const book = low(p.bookFilter);
  const testRe = p.testFilter ? new RegExp('Test\\s*' + str(p.testFilter) + '(\\s|$)', 'i') : null;
  const partRe = p.partFilter ? new RegExp('Part\\s*' + str(p.partFilter) + '(\\s|$)', 'i') : null;
  const data = (await allRows(t, p.classId || '')).filter(s => {
    if (!active(s)) return false;
    const st = ms(s.startTime);
    if (from && st < from) return false;
    if (to && st > to) return false;
    if (book && low(s.bookTestPart).indexOf(book) < 0) return false;
    if (testRe && !testRe.test(s.bookTestPart)) return false;
    if (partRe && !partRe.test(s.bookTestPart)) return false;
    return true;
  }).sort(newestFirst);
  return ok({ data, count: data.length });
}
async function sessionDetail(p) {
  const t = await teacher();
  const det = await fs.doc('details/' + str(p.sessionId)).get().catch(() => null);
  let uid = det && det.exists ? det.data().uid : '';
  let pd = uid ? (await myProgressDocs(t, '')).find(x => x._id === uid) : null;
  if (!pd) pd = (await myProgressDocs(t, '')).find(x => x.items && x.items[p.sessionId]);
  if (!pd || !pd.items || !pd.items[p.sessionId]) return fail('Không tìm thấy session.');
  return ok({ data: sessionObject(p.sessionId, pd.items[p.sessionId], pd, det && det.exists ? det.data() : null) });
}
async function exportSessions(p) {
  const t = await teacher();
  const from = p && p.fromDate ? ms(p.fromDate) : 0, to = p && p.toDate ? ms(p.toDate + 'T23:59:59') : 0;
  const rows = (await allRows(t, (p && p.classId) || '')).filter(s => active(s) &&
    (!from || ms(s.startTime) >= from) && (!to || ms(s.startTime) <= to)).sort(newestFirst);
  const cols = ['sessionId', 'studentId', 'studentName', 'className', 'bookTestPart', 'startTime', 'durationMin', 'quizScore', 'gapFillScore', 'dictationAccuracy', 'totalScore'];
  const lines = [cols.join(',')].concat(rows.map(d => cols.map(c => '"' + String(d[c] == null ? '' : d[c]).replace(/"/g, '""') + '"').join(',')));
  return ok({ csv: lines.join('\n') });
}

// ── New Practice: 2 bài mới nhất / lớp có bài hoàn thành mà GV chưa tick Done ──
async function reviewId(t, groupKey) { return t.uid + '_' + (await sha256Hex(groupKey)).slice(0, 32); }
async function newPractice() {
  const t = await teacher();
  const [rows, rv] = await Promise.all([
    allRows(t, ''),
    fs.collection('reviews').where('teacherUid', '==', t.uid).get().then(docs)
  ]);
  const reviewed = {};
  rv.forEach(r => { reviewed[r.groupKey] = ms(r.reviewedUpTo); });
  const since = Date.now() - NEW_PRACTICE_DAYS * 864e5, groups = {};
  rows.forEach(s => {
    if (!s.isComplete) return;
    const end = ms(s.endTime);
    if (!end) return;
    const key = str(s.classId).toUpperCase() + '|' + btpKey(s.bookTestPart);
    if (end <= (key in reviewed ? reviewed[key] : since)) return;
    const g = groups[key] || (groups[key] = { groupKey: key, classId: s.classId, className: s.className, bookTestPart: s.bookTestPart, from: end, to: end });
    g.from = Math.min(g.from, end); g.to = Math.max(g.to, end);
  });
  let data = Object.values(groups).map(g => Object.assign(g, { from: new Date(g.from).toISOString(), to: new Date(g.to).toISOString() }));
  data.sort((a, b) => String(a.className).localeCompare(String(b.className)) || ms(b.to) - ms(a.to));
  const perClass = {};
  data = data.filter(g => (perClass[g.classId] = (perClass[g.classId] || 0) + 1) <= NEW_PRACTICE_PER_CLASS);
  return ok({ data });
}
async function markDone(p, done) {
  const t = await teacher();
  if (!p.classId || !p.bookTestPart) return fail('Thiếu lớp hoặc bài.');
  const key = str(p.classId).toUpperCase() + '|' + btpKey(p.bookTestPart);
  const ref = fs.doc('reviews/' + await reviewId(t, key));
  const cur = await ref.get();
  if (!done) {
    if (cur.exists) await ref.update({ reviewedUpTo: cur.data().prevReviewedUpTo || '', prevReviewedUpTo: '' });
    return ok();
  }
  await ref.set({ teacherUid: t.uid, groupKey: key, classId: str(p.classId), bookTestPart: str(p.bookTestPart),
                  reviewedUpTo: p.upTo || nowIso(), prevReviewedUpTo: cur.exists ? (cur.data().reviewedUpTo || '') : '',
                  reviewedAt: nowIso() });
  return ok();
}

// ════════════════════════════════════════════
// APPS SCRIPT (admin): accounts + passwords
// ════════════════════════════════════════════
async function gas(action, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(window.LD.GAS, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload }), redirect: 'follow', signal: ctrl.signal
    });
    if (!r.ok) throw new Error('Network error ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const GAS_FB = {
  'auth.register':         p => gas('fb.register', p),
  'auth.registerTeacher':  p => gas('fb.registerTeacher', p),
  // Mật khẩu Firebase được mã hoá, không đọc lại được → gửi mật khẩu MỚI qua email
  'auth.forgotPassword':   p => gas('fb.forgotPassword', p)
};

const ACTIONS = {
  'auth.login': studentLogin, 'auth.teacherLogin': teacherLogin,
  'session.start': sessionStart, 'session.saveAnalysis': saveAnalysis, 'session.saveQuiz': saveQuiz,
  'session.saveGapFill': saveGapFill, 'session.saveDictationProgress': saveDictationProgress,
  'session.finishDictation': finishDictation, 'session.exportReport': exportReport,
  'student.getHistorySummary': historySummary, 'student.getInProgressTop5': inProgressTop5,
  'student.getInProgress': inProgressTop5, 'student.resumeSession': resumeSession, 'student.deleteSession': deleteSession,
  'teacher.getClasses': getClasses, 'teacher.createClass': createClass, 'teacher.setClassStatus': setClassStatus,
  'teacher.archiveClass': p => setClassStatus({ classId: p.classId, status: 'Archived' }),
  'teacher.getRoster': getRoster, 'teacher.archiveStudent': archiveStudent,
  'teacher.getFilteredSessions': filteredSessions, 'teacher.getSessionDetail': sessionDetail,
  'teacher.exportSessions': exportSessions,
  'practice.new': newPractice, 'practice.markDone': p => markDone(p, true), 'practice.undoDone': p => markDone(p, false)
};

async function call(action, payload) {
  init();
  payload = payload || {};
  try {
    if (ACTIONS[action]) return await ACTIONS[action](payload);
    if (GAS_FB[action]) return await GAS_FB[action](payload);
    return fail('Chức năng này không có trong bản Firebase: ' + action);
  } catch (e) {
    const code = (e && e.code) || '';
    if (e && (e.message === 'SESSION_EXPIRED' || /unauthenticated/i.test(code))) return fail('SESSION_EXPIRED');
    if (/permission[-_]denied/i.test(code)) return fail(auth && auth.currentUser ? 'Bạn không có quyền truy cập dữ liệu này.' : 'SESSION_EXPIRED');
    if (/unavailable|deadline-exceeded/i.test(code)) return fail('Không kết nối được máy chủ — kiểm tra mạng và thử lại.');
    console.error('[ld-fbdata] ' + action, e);
    return fail((e && e.message) || String(e));
  }
}

window.FB = { call, authReady, signOut, _helpers: { authPw, loginEmailFor, sha256Hex, btpKey } };
})();
