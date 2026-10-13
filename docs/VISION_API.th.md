# คู่มือ `/v1/vision/*` — ส่งรูปภาพ/PDF ให้โมเดลอ่าน (Node.js edition)

ส่งรูปภาพหรือ PDF เป็น base64 ไปพร้อมคำถาม แล้วได้คำตอบเป็นข้อความล้วน ไม่มี footer `⚡ Antigravity Profile` ต่อท้าย

| | |
| :--- | :--- |
| Base URL (production) | `https://aiapiagybridge.mrserm.com` (nginx → Node bridge พอร์ต 8008) |
| แบบ OpenAI | `POST /v1/vision/chat/completions` |
| แบบ Anthropic | `POST /v1/vision/messages` |
| ชนิดไฟล์ | PNG, JPEG, GIF, WebP, HEIC/HEIF, PDF (รวม PDF สแกน) |
| ขนาดคำขอสูงสุด | 32 MB ทั้ง body (ไฟล์จริงราว 23 MB เพราะ base64 ใหญ่ขึ้น 1/3) |
| ไฟล์ต่อคำขอ | ใช้ 10 ไฟล์ล่าสุด ไฟล์ที่เก่ากว่านั้นจะถูกตัดออก |
| เวลาตอบ | ราว 10–30 วินาทีต่อคำขอ (โมเดลต้องเปิดดูไฟล์ก่อนตอบ) |

ถ้า bridge เปิดใช้ API key ให้ส่ง `Authorization: Bearer <key>` (หรือ `x-api-key: <key>`) มาด้วย
ดูว่าต้องใช้ key ไหมได้จาก `GET /health` → `auth_required`

---

## 1. แบบ OpenAI (`/v1/vision/chat/completions`)

ใส่ไฟล์ไว้ใน `content` ที่เป็น array ของ user message

- **รูปภาพ:** `{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<BASE64>"}}`
- **PDF:** `{"type": "file", "file": {"filename": "invoice.pdf", "file_data": "data:application/pdf;base64,<BASE64>"}}`

### curl

```bash
IMG=$(base64 < photo.jpg | tr -d '\n')
cat > req.json <<EOF
{
  "model": "gemini-3.8-flash",
  "messages": [{"role": "user", "content": [
    {"type": "text", "text": "ในภาพมีอะไร"},
    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,$IMG"}}
  ]}]
}
EOF
curl -s https://aiapiagybridge.mrserm.com/v1/vision/chat/completions \
  -H "Content-Type: application/json" \
  -d @req.json
```

ไฟล์ใหญ่ให้เขียน body ลงไฟล์แล้วส่งด้วย `-d @req.json` แบบข้างบน เพราะ base64 ยาวเกินกว่าจะใส่เป็น argument ของ shell ได้

### Python (OpenAI SDK)

ตั้ง `base_url` เป็น `.../v1/vision` แล้ว SDK จะส่งไปที่ `/v1/vision/chat/completions` เอง

```python
import base64
from openai import OpenAI

client = OpenAI(base_url="https://aiapiagybridge.mrserm.com/v1/vision", api_key="unused", timeout=600)

def data_url(path, mime):
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()

# รูปภาพ
r = client.chat.completions.create(
    model="gemini-3.8-flash",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "ในภาพมีอะไร"},
        {"type": "image_url", "image_url": {"url": data_url("photo.jpg", "image/jpeg")}},
    ]}],
)
print(r.choices[0].message.content)

# PDF
r = client.chat.completions.create(
    model="gemini-3.8-flash",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "สรุปเอกสารนี้ 3 ข้อ"},
        {"type": "file", "file": {"filename": "invoice.pdf", "file_data": data_url("invoice.pdf", "application/pdf")}},
    ]}],
)
print(r.choices[0].message.content)
```

`api_key` ใส่อะไรก็ได้ถ้า bridge ไม่เปิดใช้ key ถ้าเปิดใช้ ให้ใส่ key จริง

### Streaming

ใส่ `"stream": true` (หรือ `stream=True` ใน SDK) ระบบจะส่ง SSE ตามปกติ ระหว่างที่โมเดลเปิดไฟล์จะมีแค่ `: keep-alive` แล้วข้อความจึงตามมา

---

## 2. แบบ Anthropic (`/v1/vision/messages`)

- **รูปภาพ:** `{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<BASE64>"}}`
- **PDF:** `{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "<BASE64>"}}`

### curl

```bash
PDF=$(base64 < invoice.pdf | tr -d '\n')
cat > req.json <<EOF
{
  "model": "gemini-3.8-flash",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": [
    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "$PDF"}},
    {"type": "text", "text": "ยอดรวมในเอกสารนี้เท่าไร"}
  ]}]
}
EOF
curl -s https://aiapiagybridge.mrserm.com/v1/vision/messages \
  -H "Content-Type: application/json" \
  -d @req.json
```

### Python (Anthropic SDK)

Anthropic SDK ต่อ `/v1/messages` ท้าย `base_url` เสมอ จึงชี้ไปที่ `/v1/vision/messages` ไม่ได้
ให้ใช้ endpoint ปกติแล้วปิด footer ด้วย header แทน ผลที่ได้เหมือนกัน (ดูข้อ 3)

```python
import base64
from anthropic import Anthropic

client = Anthropic(
    base_url="https://aiapiagybridge.mrserm.com",
    api_key="unused",
    default_headers={"X-Antigravity-Footer": "off"},
    timeout=600,
)
img = base64.b64encode(open("photo.png", "rb").read()).decode()
r = client.messages.create(
    model="gemini-3.8-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": img}},
        {"type": "text", "text": "ในภาพมีอะไร"},
    ]}],
)
print(r.content[0].text)
```

---

## 3. เปิด/ปิด footer

| ที่ไหน | ค่าเริ่มต้น | วิธีเปลี่ยน |
| :--- | :--- | :--- |
| `/v1/vision/*` | ปิด | header `X-Antigravity-Footer: on` หรือ body `"antigravity_footer": true` |
| `/v1/chat/completions`, `/v1/messages` | เปิด | header `X-Antigravity-Footer: off` หรือ body `"antigravity_footer": false` |

- ถ้าส่งทั้ง header และ body ระบบจะใช้ header
- ถ้าตั้ง `ANTIGRAVITY_HIDE_PROFILE_STATUS=1` บนเซิร์ฟเวอร์ footer จะปิดทุก endpoint และคำขอเปิดเองไม่ได้

endpoint ปกติ (`/v1/chat/completions`, `/v1/messages`) ก็รับรูปและ PDF ได้เหมือนกัน
`/v1/vision/*` ต่างกันแค่ค่าเริ่มต้นของ footer

---

## 4. เลือกโมเดล

ใช้โมเดลแชตจาก `GET /v1/models` ได้ทุกตัว เช่น `gemini-3.8-flash`, `gemini-3.8-flash-high`, `gemini-3.1-pro`,
`claude-sonnet-5-5`, `claude-opus-5-5`

**ห้ามใช้โมเดลสร้างรูป** (`gemini-3.1-flash-image`, `nano-banana`, `imagen-*`, `gemini-image`) กับ endpoint นี้
คำขอที่ใช้โมเดลกลุ่มนี้จะไปเข้าระบบสร้างรูปแทน และไฟล์แนบจะไม่ถูกส่งไปให้โมเดลอ่าน

---

## 5. ข้อควรรู้

- **URL รูปภายนอก (`https://...`) bridge ไม่ดาวน์โหลดให้** โมเดลจะเห็นแค่ข้อความว่ามีลิงก์ ต้องแปลงเป็น base64 ก่อนส่งเสมอ
- **แนบหลายไฟล์ได้** ทั้งในข้อความเดียวและกระจายหลายข้อความ ถ้าไฟล์เดียวกันส่งซ้ำ ระบบจะเก็บไว้ครั้งเดียว
- **แชตหลายรอบ:** ไฟล์ที่อยู่ใน history จะถูกส่งให้โมเดลดูใหม่ทุกรอบ (สูงสุด 10 ไฟล์ล่าสุด) ถ้าไม่ต้องใช้รูปเก่าแล้ว ให้ตัดออกจาก history เพื่อให้ตอบเร็วขึ้นและประหยัด quota
- **Content type ไม่ต้องตรงเป๊ะ:** ระบบดูชนิดไฟล์จาก byte จริง ถ้าส่ง `image/jpeg` มาแต่ไฟล์เป็น PNG ก็ยังใช้ได้
- **Timeout ฝั่ง client:** ตั้งอย่างน้อย 120 วินาที (แนะนำ 600) ถ้าส่งไฟล์ใหญ่จากเน็ตที่อัปโหลดช้า เวลาอัปโหลดจะนับรวมด้วย
  เคยเจอว่า body 28 MB อัปโหลดจากเน็ตบ้านไม่ทันเวลา ทั้งที่ส่งจากเซิร์ฟเวอร์ใช้เวลาแค่ 14 วินาที
- ไฟล์ถูกเขียนลงโฟลเดอร์ชั่วคราว `/tmp/agy-attach-*` (เปิดได้เฉพาะเจ้าของ) และถูกลบทันทีเมื่อคำขอจบ

---

## 6. Error ที่อาจเจอ

| HTTP | ข้อความ | สาเหตุ / วิธีแก้ |
| :--- | :--- | :--- |
| 400 | `Attachment N: unsupported type '...'` | ชนิดไฟล์ไม่รองรับ (เช่น BMP, TIFF, DOCX) ให้แปลงเป็น PNG/JPEG/PDF ก่อน |
| 400 | `Attachment N: the data is not valid base64` | base64 เสีย หรือส่ง data URL ที่ไม่มี `;base64,` |
| 401 | `Invalid or missing API key` | bridge เปิดใช้ key อยู่ ให้ใส่ `Authorization: Bearer <key>` |
| 413 | nginx `Request Entity Too Large` หรือ `Payload too large` | body เกิน 32 MB ให้ย่อรูปหรือแยกส่งหลายคำขอ |
| 500 | `CLI tool execution blocked ...` | โมเดลพยายามเปิดไฟล์อื่นที่ไม่ใช่ไฟล์แนบ ให้ลองส่งใหม่ |
| 500 | `All agy profile execution attempts failed` | ทุกบัญชีติด quota หรือมีปัญหา ดู `GET /health` → `profiles` |

---

## 7. ตรวจสอบฝั่งเซิร์ฟเวอร์ (สำหรับผู้ดูแล)

```bash
journalctl -u antigravity-bridge-node.service --since "-10 min" | grep -E "REQUEST\] /v1/vision|ATTACHMENT VIEW|DONE\] /v1/vision|FAILED"
```

คำขอปกติจะมี 3 บรรทัดนี้:

```
[REQUEST] /v1/vision/chat/completions model=gemini-3.8-flash ... attachments=1 footer=false ...
[ATTACHMENT VIEW] profile=...: agy opens an attached file: view_file {"AbsolutePath":"/tmp/agy-attach-XXXX/attachment-1.jpg"}
[DONE] /v1/vision/chat/completions profile=... elapsed=13.5s ...
```

- `attachments=0` แปลว่า bridge ไม่พบไฟล์ในคำขอ ให้เช็กรูปแบบ part ในข้อ 1–2
- มี `[REQUEST]` แต่ไม่มี `[ATTACHMENT VIEW]` แปลว่าโมเดลไม่ได้เปิดไฟล์

ปรับค่าได้ผ่าน `.env` แล้ว restart service:

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
| :--- | :--- | :--- |
| `ANTIGRAVITY_MAX_BODY_MB` | `32` | ขนาด body สูงสุดของ bridge (ถ้าจะเกิน 32 ต้องแก้ `client_max_body_size` ของ nginx ด้วย) |
| `ANTIGRAVITY_MAX_ATTACHMENTS` | `10` | จำนวนไฟล์ล่าสุดที่ส่งให้โมเดลต่อคำขอ |
| `ANTIGRAVITY_HIDE_PROFILE_STATUS` | `0` | `1` ปิด footer ทุก endpoint |

### วิธีการทำงานเบื้องหลัง

`agy` (CLI ที่ bridge เรียก) รับ input เป็นข้อความอย่างเดียว ส่ง block รูปภาพตรง ๆ ไม่ได้
bridge จึงทำ 4 ขั้นตอนนี้:

1. ถอด base64 เป็นไฟล์ในโฟลเดอร์ชั่วคราว
2. แทนที่ part รูปในข้อความด้วยบรรทัดที่บอกตำแหน่งไฟล์ แล้วสั่งให้โมเดลเปิดไฟล์นั้นด้วย tool `view_file`
3. `view_file` ของ agy ส่งรูปหรือ PDF ให้ Gemini/Claude เป็น inline media part
4. bridge อนุญาตให้ `view_file` อ่านได้เฉพาะไฟล์แนบของคำขอนั้น tool อื่นยังถูกบล็อกเหมือนเดิม
