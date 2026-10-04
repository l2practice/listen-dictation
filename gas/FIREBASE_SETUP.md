# LisDictation — chuyển sang Firebase

Project: `listendictation-4c26e` (gói miễn phí Spark). Địa chỉ app không đổi: `l2practice.github.io/listen-dictation`.

Cho tới khi bật công tắc (bước D), app vẫn chạy bằng Google Sheet như cũ.

## A. Firebase console (console.firebase.google.com)
1. **Authentication ▸ Sign-in method ▸ Email/Password ▸ Enable.**
2. **Authentication ▸ Settings ▸ Authorized domains ▸ Add domain**: `l2practice.github.io`.
3. **Firestore Database ▸ Create database ▸ Production mode**, vùng **asia-southeast1 (Singapore)**.
4. **Firestore ▸ Rules**: dán toàn bộ file `firestore.rules`, rồi bấm **Publish**.

## B. Apps Script (Extensions ▸ Apps Script của sheet "Listen Dictation")
1. **⚙ Project Settings ▸ tick "Show appsscript.json manifest file in editor"**. Mở `appsscript.json`, dán nội dung `gas/appsscript.json`.
2. Dán đè `Code.gs`. **Thêm file mới `FirebaseLD`** và dán `gas/FirebaseLD.gs`. Giữ `Reports.gs`.
3. Chạy **`ldfb_0_TestConnection`** và cấp quyền. Log phải có 4 dòng `OK`.
4. **Deploy ▸ Manage deployments ▸ ✏️ Edit ▸ New version ▸ Deploy.** Bước này cần cho đăng ký và quên mật khẩu trên bản Firebase.

## C. Chuyển dữ liệu (chạy lần lượt; nên làm lúc ít SV đang làm bài)
| Hàm | Việc |
|---|---|
| `ldfb_1_IndexExemptions` | Tắt chỉ mục cho các cột chữ dài. **Đợi 5–10 phút** (Firestore ▸ Indexes ▸ Single field ▸ Exemptions báo xong). |
| `ldfb_2_Teachers` | Tài khoản GV, giữ nguyên email và mật khẩu cũ |
| `ldfb_3_Classes` | Lớp học |
| `ldfb_4_Students` | Tài khoản SV, giữ nguyên mã SV và mật khẩu cũ. Nếu log báo "Tạm dừng…" thì chạy lại. |
| `ldfb_5_Sessions` | Bài làm (Results, SessionDetails và tab Sessions cũ). Nếu báo "Tạm dừng…" thì chạy lại. |
| `ldfb_6_Reviews` | Dấu Done của tab New Practice |

- Chạy lại bước nào cũng an toàn.
- Google Sheet không bị sửa; nó được giữ làm bản sao lưu.
- Mật khẩu dưới 6 ký tự được tự đệm theo cùng một cách ở cả hai phía, nên SV vẫn gõ mật khẩu cũ như bình thường.

## D. Bật Firebase
Trong `ld-common.js`, đổi `enabled: false` thành `enabled: true` rồi đưa lên GitHub.

Ngay sau đó:
- Chạy lại **`ldfb_5_Sessions`** để lấy những bài SV làm trong lúc chuyển.
- Chạy **`ldfb_7_StopSheetJobs`** để tắt lịch chạy của bản Sheet.

Muốn quay lại bản Sheet: đổi về `enabled: false`.

## Dữ liệu trên Firestore
| Collection | Nội dung |
|---|---|
| `users/{uid}` | Hồ sơ SV và GV (role, studentId, fullName, classId, teacherUid, email, archived) |
| `loginIndex/{sha256(email)}` | Email → mã SV, dùng khi SV đăng nhập bằng email |
| `classes/{classId}` | Lớp (className, teacherUid, status) |
| `progress/{uid}` | **1 tài liệu cho mỗi SV**: dòng điểm của mọi bài (`items`). History, tab Sessions và New Practice chỉ đọc tài liệu này. |
| `details/{sessionId}` | Script và bài làm của 1 bài. Bài xong đủ 3 phần thì được **giữ vĩnh viễn** (bản tổng kết, xem ở `review.html`) và bị khoá, không sửa hay xoá được. |
| `reviews/{id}` | Dấu Done của GV |

- **Dọn dữ liệu nháp:** khi xong đủ 3 phần, app bỏ script thô và danh sách từ A1–B1. Bài chỉ mới dán script, chưa làm phần nào, sẽ tự xoá sau 7 ngày.
- **Mật khẩu:** Firebase lưu ở dạng mã hoá, không đọc lại được. Khi SV bấm "Quên mật khẩu", Apps Script đặt mật khẩu mới và gửi qua email.

## Quản lý SV và lớp (Edit, Archive)
Sửa thông tin SV, đổi mã SV, chuyển lớp, lưu trữ/khôi phục cả lớp đều chạy qua Apps Script (cần quyền quản trị Firebase). Sau khi cập nhật:
1. Dán đè `gas/FirebaseLD.gs` vào file `FirebaseLD` trong Apps Script.
2. **Deploy ▸ Manage deployments ▸ ✏️ Edit ▸ New version ▸ Deploy.**

Chưa deploy thì các nút Edit / Archive class / Restore class báo lỗi. Lưu trữ từng SV (nút Archive trong danh sách lớp) vẫn chạy được.

- **Đổi mã SV:** SV đăng nhập bằng mã mới, mật khẩu giữ nguyên. Bài làm cũ vẫn theo SV.
- **Chuyển lớp:** bài đã làm vẫn nằm ở lớp cũ trong tab Sessions; bài mới thuộc lớp mới.
- **Lưu trữ lớp:** mọi SV đang học trong lớp được lưu trữ cùng và không đăng nhập được. **Khôi phục lớp** chỉ mở lại những SV bị lưu trữ cùng lớp; SV đã lưu trữ riêng trước đó vẫn ở Student Archive.
- Các chức năng này chỉ có ở bản Firebase (không có ở bản Google Sheet cũ).
