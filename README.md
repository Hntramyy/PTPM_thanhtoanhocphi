# PTIT INT1448 — Lab 3: Kết nối và duy trì kết nối giữa các service

Triển khai hai service Node.js/Express, dữ liệu trong bộ nhớ, theo đề bài Lab 3.

## 1. Yêu cầu
- Node.js 18 trở lên
- npm
- Postman (không bắt buộc; có thể dùng curl)

## 2. Cài đặt và khởi chạy
Mở terminal tại thư mục dự án:

```bash
npm install
```

Terminal 1 — ngân hàng:
```bash
npm run bank
```

Terminal 2 — Fee Service:
```bash
npm run fee
```

Mặc định Fee Service chạy cổng 4001, ngân hàng cổng 4002. Dữ liệu được giữ trong RAM; khởi động lại service sẽ đặt lại dữ liệu.

## 3. API và kiểm thử nhanh
```bash
curl http://localhost:4001/students/1/fees
curl http://localhost:4001/students/2/fees
curl http://localhost:4001/students/3/fees
curl -i -X POST http://localhost:4001/students/1/payments -H 'Content-Type: application/json' -d '{"amount":100000}'
curl http://localhost:4002/stats
```

Các endpoint bổ sung: `GET /health` ở cả service; `GET /payments` và `GET /payments/:id` ở Fee Service.

## 4. Bốn tình huống theo đề

### Tình huống 1 — ngân hàng tắt rồi bật lại
1. Khởi động Fee Service, không khởi động ngân hàng.
2. Gọi `POST http://localhost:4001/students/1/payments` với `{"amount":100000}`. Kỳ vọng `503`, JSON có `error`, `paymentId`, `status: FAILED`, nhanh dưới 1,5 giây.
3. Gọi `GET /students/1/fees`, phải vẫn nhận `200`.
4. Khởi động ngân hàng rồi gửi một lệnh thanh toán mới; kỳ vọng `201 PAID`, không cần khởi động lại Fee Service.
5. Thử cấu hình `BANK_URL=http://localhost:4999 npm run fee` (dừng tiến trình Fee Service cũ trước). Kỳ vọng hành vi mất kết nối tương tự.

### Tình huống 2 — ngân hàng chậm 5 giây
Khởi động lại ngân hàng với:
```bash
DELAY_MS=5000 npm run bank
```
Gửi một khoản thanh toán. Fee Service có `BANK_TIMEOUT_MS=4000` mặc định, nên kỳ vọng `504`, `status: PENDING`, trong khoảng không quá 4,5 giây. Trong lúc 20 lệnh thanh toán chờ, gọi `GET /students/1/fees`; route này không gọi ngân hàng và cần phản hồi dưới 300 ms.

Ví dụ gửi song song trên macOS/Linux:
```bash
for i in $(seq 1 20); do curl -s -X POST http://localhost:4001/students/1/payments -H 'Content-Type: application/json' -d '{"amount":1000}' & done; wait
curl -w '\nfee lookup: %{time_total}s\n' http://localhost:4001/students/1/fees
```
Lưu ý: chạy các yêu cầu thử tải trên một sinh viên có đủ công nợ; mỗi yêu cầu tạo một lệnh thanh toán riêng.

### Tình huống 3 — keep-alive
Khởi động lại ngân hàng bình thường (`DELAY_MS=0 FAIL_RATE=0 DROP_RATE=0`), sau đó chạy:
```bash
npm run load
```
Script gửi 200 thanh toán, đồng thời tối đa 10 yêu cầu, mỗi khoản 1.000đ; in thời gian, số thành công/thất bại và thống kê `/stats` trước/sau. Agent keep-alive của Fee Service giới hạn tối đa 20 socket tới ngân hàng.

Sau đó đợi 6 giây rồi chạy lại một vài thanh toán. Nếu ngân hàng đã đóng socket nhàn rỗi, client cần tạo kết nối mới và yêu cầu vẫn thành công.

**Lưu ý về dữ liệu:** sinh viên 1 chỉ có 50.000.000đ; 200 × 1.000đ không vượt mức này nếu chạy trên dữ liệu sạch. Nếu đã thử nhiều lần, khởi động lại Fee Service để đặt lại công nợ.

### Tình huống 4(a) — ngân hàng trừ tiền rồi mất phản hồi
Khởi động lại ngân hàng:
```bash
DROP_RATE=0.3 npm run bank
```
Gửi 60 khoản thanh toán (mỗi khoản nên nhỏ, ví dụ 1.000đ), kiểm tra `GET /stats`, `GET /payments` và công nợ. Khi gặp `ECONNRESET`, Fee Service thử lại với cùng `Idempotency-Key`, nhờ vậy ngân hàng trả giao dịch cũ thay vì trừ tiền lần nữa. Nếu vẫn mất phản hồi sau số lần thử lại, API trả `504 PENDING`; không giảm công nợ cho lệnh đó vì chưa nhận được xác nhận.

### Tình huống 4(b) — lỗi 500 trước khi trừ tiền
Khởi động lại ngân hàng:
```bash
FAIL_RATE=0.3 npm run bank
```
Gửi 60 khoản thanh toán nhỏ. Fee Service thử lại lỗi 5xx với cùng idempotency key; ngân hàng chỉ ghi nhận một charge cho mỗi khóa. Đối chiếu số lệnh `PAID` với `charges` và `duplicates`.

### Tình huống 4(c) — vượt hạn mức
Đặt ngân hàng về chế độ bình thường, rồi gửi:
```bash
curl -i -X POST http://localhost:4001/students/1/payments -H 'Content-Type: application/json' -d '{"amount":25000000}'
```
Kỳ vọng `402`, `status: FAILED`; không retry phản hồi từ chối 402. Trong log/stats, ngân hàng nhận đúng một request cho lệnh thử này. Công nợ không thay đổi.

## 5. Ghi nhận số liệu báo cáo
Ghi số liệu thật từ mỗi lần chạy, không điền số liệu dự đoán:

Ảnh minh chứng cho từng tình huống được lưu trong `bao-cao/anh/`, mỗi tình huống một thư mục lớn. Với tình huống 4, lưu ảnh của cả ba nhánh (a), (b), (c) chung trong thư mục tình huống 4.

| Tình huống | Trước sửa | Sau sửa | Tiêu chí cần đối chiếu |
|---|---|---|---|
| 1. Ngân hàng tắt | HTTP, thời gian, Fee Service còn sống? | HTTP, thời gian; thử bật ngân hàng lại | 503 < 1,5 giây; GET fees 200; ngân hàng bật lại thanh toán 201 |
| 2. Ngân hàng chậm | Thời gian thanh toán; thời gian GET fees | Thời gian thanh toán; thời gian GET fees khi 20 lệnh chờ | 504/PENDING ≤ 4,5 giây; GET fees < 300 ms |
| 3. Kết nối | `connections` trước/sau, tổng thời gian | `connections` trước/sau, tổng thời gian | 200/200 PAID; TCP connections ≤ 20; hoạt động lại sau 6 giây |
| 4(a). DROP_RATE | PAID, charges, duplicates, công nợ | Các số liệu tương tự | duplicates = 0; ≥54/60 thành công; chưa xác nhận thì PENDING |
| 4(b). FAIL_RATE | PAID, charges, duplicates | Các số liệu tương tự | ≥54/60 thành công; không charge trùng |
| 4(c). Vượt hạn mức | HTTP, số request ngân hàng, công nợ | HTTP, số request ngân hàng, công nợ | 402; đúng một request; không retry |

Thư mục ảnh (đặt tên theo đề):
- `bao-cao/anh/01-ngan-hang-khong-ket-noi-duoc-roi-hoat-dong-lai/`
- `bao-cao/anh/02-ngan-hang-phan-hoi-rat-cham/`
- `bao-cao/anh/03-duy-tri-ket-noi/`
- `bao-cao/anh/04-dut-giua-chung-loi-tam-thoi-bi-tu-choi/` (gồm các nhánh a, b, c)

## 6. Giải thích thiết kế
- `http.Agent({ keepAlive: true, maxSockets: 20 })` tái sử dụng kết nối TCP và giới hạn số socket đồng thời tới ngân hàng.
- Timeout 4.000 ms thấp hơn giới hạn 4,5 giây của đề.
- `ECONNREFUSED`/lỗi DNS hoặc route mạng không tới được ngân hàng được xem là chưa gửi được giao dịch: trả 503.
- Timeout hoặc mất socket sau khi đã gửi yêu cầu là kết quả không chắc chắn: trả 504/PENDING, không giảm công nợ.
- Lỗi 500 và reset kết nối có thể được thử lại với cùng khóa idempotency; 400/402 không retry.
- Ngân hàng lưu giao dịch theo `Idempotency-Key`; lần gọi lặp lại trả kết quả cũ. `duplicates` biểu thị số lần trừ tiền trùng và phải luôn bằng 0.

## 7. Giới hạn của bản lab
Đây là bản thực hành dùng bộ nhớ RAM, không phải hệ thống thanh toán production. Trạng thái `PENDING` chưa có tác vụ đối soát tự động; trong hệ thống thật cần API tra cứu giao dịch theo reference hoặc quy trình reconciliation. Dữ liệu trong bộ nhớ bị đặt lại khi khởi động lại. Các kết quả thử tải và tỉ lệ thành công phụ thuộc lần chạy thực tế, không được xem là đã đạt trước khi đo.
