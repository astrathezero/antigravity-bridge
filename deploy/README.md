# 🐳 Docker + noVNC Deployment Guide
# Antigravity Bridge — Ubuntu 24.04 Server

## Architecture

```
Internet / AI Client
       │
       ▼ (Nginx + SSL  หรือ  SSH Tunnel)
┌────────────────────────────────────────────────────────┐
│  Docker Container: antigravity-bridge                  │
│                                                        │
│  noVNC :6080 ──▶ websockify ──▶ x11vnc :5900           │
│                                      │                 │
│                                   Xvfb :99             │
│                                      │                 │
│  Chromium ×N (profile0…profile9) ────┘                 │
│    └─ Antigravity Extension (SSE → Bridge)             │
│                                                        │
│  Bridge API :8000 (OpenAI-compatible endpoint)         │
└────────────────────────────────────────────────────────┘
```

---

## ขั้นตอน Deploy บน Ubuntu 24.04

### 1. ติดตั้ง Docker + Docker Compose

```bash
# บน Ubuntu 24.04
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
docker --version       # ตรวจสอบ
docker compose version # ตรวจสอบ
```

### 2. Clone Repository

```bash
git clone https://github.com/YOUR_USERNAME/antigravity-bridge.git
cd antigravity-bridge
```

### 3. ตั้งค่า Environment

```bash
cd deploy
cp .env.example .env
nano .env
```

ตัวอย่าง `.env`:
```env
NOVNC_PASSWORD=my_secure_password_here
CHROME_ACCOUNTS=2          # เปิด 2 Chrome windows (เพิ่มได้สูงสุด 10)
# CHROME_URLS=https://gemini.google.com/app,https://gemini.google.com/u/1/app
```

### 4. Build & Start

```bash
# จาก deploy/ directory
cd deploy
docker compose up -d --build

# ดู logs
docker compose logs -f
```

### 5. เปิด noVNC แล้ว Login Google

#### ผ่าน SSH Tunnel (ปลอดภัยที่สุด):
```bash
# จาก machine ของคุณ:
ssh -L 6080:127.0.0.1:6080 -L 8000:127.0.0.1:8000 user@YOUR_SERVER_IP
```
จากนั้นเปิด: **http://127.0.0.1:6080**

#### ผ่าน Nginx (ถ้าต้องการ public URL):
```nginx
server {
    listen 443 ssl;
    server_name vnc.yourdomain.com;

    # SSL (ใช้ certbot หรือ Cloudflare)
    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:6080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;
    }
}

server {
    listen 443 ssl;
    server_name api.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 6. Login Google Accounts ใน noVNC

เมื่อเปิด noVNC จะเห็น Chromium เปิดอยู่ N windows:

1. **Window 0** → `gemini.google.com/app` → Login account แรก
2. **Window 1** → `gemini.google.com/u/1/app` → Login account ที่สอง
3. ทำซ้ำสำหรับแต่ละ account

> **Tips:** Chrome จะ save cookies ไว้ใน `/app/chrome-data/profile0..9`  
> (mount เป็น Docker volume) → **ไม่ต้อง login ใหม่เมื่อ restart container**

### 7. ตรวจสอบสถานะ

```bash
# 1. ทดสอบและตรวจสอบสถานะ Docker + noVNC อัตโนมัติ:
bash deploy/test-docker.sh

# ดู logs ภายใน container:
bash deploy/test-docker.sh --logs

# Health check Bridge API
curl http://127.0.0.1:8000/health | python3 -m json.tool | grep -E "web_connected|account_email"

# Extension status
curl http://127.0.0.1:8000/extension/status

# ทดสอบ web channel
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web",
    "messages": [{"role": "user", "content": "Hello! What model are you?"}]
  }'
```

---

## การอัปเดต Extension (ไม่ต้อง rebuild image)

Extension mount เป็น volume — แก้ไขไฟล์แล้ว **reload extension ใน noVNC**:

1. เปิด noVNC → ในหน้าต่าง Chromium กด `F12` → Console
2. หรือไปที่ `chrome://extensions/` ใน Chromium แล้วกด 🔄 Reload

---

## การอัปเดต Bridge Server (`antigravity_bridge.py`)

ใช้ `safe_deploy.sh` บน host เสมอ (ห้ามแก้ตรง):

```bash
./safe_deploy.sh stage
# แก้ไข antigravity_bridge.py.staging
./safe_deploy.sh test
./safe_deploy.sh deploy
```

Container จะ hot-reload เพราะ `antigravity_bridge.py` mount เป็น read-only volume

---

## คำสั่ง Maintenance

```bash
# รีสตาร์ท browser ทั้งหมดโดยไม่เสีย session
docker exec antigravity-bridge supervisorctl restart browser

# ดู logs แบบ live
docker compose logs -f

# รีสตาร์ท container ทั้งหมด
docker compose restart

# หยุด noVNC (ประหยัด resources เมื่อไม่ใช้งาน)
docker exec antigravity-bridge supervisorctl stop x11vnc websockify

# เปิด noVNC อีกครั้ง
docker exec antigravity-bridge supervisorctl start x11vnc websockify

# เช็ค process ทั้งหมดใน container
docker exec antigravity-bridge supervisorctl status

# เพิ่ม Chrome windows (เช่น เพิ่มจาก 2 เป็น 5 accounts)
# แก้ CHROME_ACCOUNTS=5 ใน .env แล้ว:
docker compose up -d --force-recreate
```

---

## Troubleshooting

| ปัญหา | วิธีแก้ |
|-------|---------|
| `web_connected: false` ทุก profile | ตรวจสอบว่า login Google ครบทุก tab แล้วใน noVNC |
| Chromium crash วนซ้ำ | `docker exec antigravity-bridge cat /var/log/browser.log` |
| noVNC ไม่มีภาพ | `docker exec antigravity-bridge cat /var/log/xvfb_err.log` |
| Extension ไม่ connect | Reload extension ใน `chrome://extensions/` |
| Chrome login หาย | ตรวจสอบว่า volume `chrome-data` ไม่ถูกลบ |

---

## Security Checklist ก่อน Production

- [ ] ตั้ง `NOVNC_PASSWORD` ที่แข็งแกร่งใน `.env`
- [ ] ใช้ Nginx + SSL (ไม่เปิด port 6080/8000 ตรงสู่ internet)
- [ ] ปิด port 6080 เมื่อไม่ใช้ noVNC: `supervisorctl stop x11vnc websockify`
- [ ] ตั้ง UFW firewall: `ufw allow 22 && ufw allow 443 && ufw enable`
- [ ] ใส่ API key authentication บน port 8000 ถ้าเปิดสู่ internet
