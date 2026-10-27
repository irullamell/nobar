# Piik Lite — Screen Sharing Privat, 100% di Vercel

Versi [Piik](https://github.com/TNTcraftHIM/Piik) yang disesuaikan agar **sepenuhnya berjalan di Vercel**:
frontend statis + backend serverless (Vercel Functions) + [Upstash Redis](https://upstash.com) —
tanpa server Go, tanpa WebSocket, tanpa VPS.

> **Kenapa bukan Piik asli?** Server Piik adalah proses Go yang butuh koneksi
> WebSocket persisten, state di memori, dan SFU (media relay). Vercel adalah
> platform serverless yang **tidak mendukung** hal-hal itu. Jadi signaling
> ditulis ulang memakai **SSE (Server-Sent Events) + HTTP POST** dengan state di
> Redis, dan media tetap **P2P (WebRTC)** — sesuai desain asli Piik yang
> "P2P-first". Fitur yang butuh SFU/proses persisten (remote control, room
> voice via server, media forwarding) tidak disertakan.

## Fitur

- 🎬 **Berbagi layar + audio** dari browser host (P2P WebRTC mesh, hingga 20 penonton).
- 🔒 **Invite-only secara default** — tidak ada daftar room publik; room hanya bisa
  dimasuki dengan **kode undangan 12 karakter** acak kriptografis (anti-tebak/enumerasi).
- 🔑 **Password room opsional** (di-hash sha256 + salt, tidak pernah disimpan polos).
- 🚫 **Host bisa Kick & Ban**:
  - **Kick** — keluarkan penonton (masih bisa masuk lagi lewat undangan).
  - **Ban** — keluarkan + larang masuk kembali (menempel pada identitas browser *dan* hash IP, per room). Bisa di-**unban** dari Daftar Ban.
- 💬 **Chat + reaksi emoji** realtime.
- 👑 **Kontrol host lengkap**: ganti nama room, set/hapus password, ubah batas penonton, tutup room.
- ⏱ Presence otomatis (heartbeat) — penonton yang mati/putus terdeteksi dan dibersihkan.
- 🛡 Rate limiting per IP/peer, validasi ketat semua input, secret dibanding timing-safe.

## Arsitektur

```
Browser host/viewer
   │  HTTPS
   ▼
Vercel
 ├─ Static frontend (React + Vite, folder dist/)
 └─ Serverless Functions (folder api/)
     ├─ POST /api/rooms                 buat room
     ├─ GET  /api/rooms/:code           info room (butuh tahu kodenya)
     ├─ POST /api/rooms/:code/join      join (cek ban + password + kapasitas)
     ├─ GET  /api/rooms/:code/events    SSE stream (signaling/chat/event)
     ├─ POST /api/rooms/:code/messages  kirim chat/reaksi/sinyal WebRTC
     ├─ POST /api/rooms/:code/host      aksi host: kick/ban/unban/password/tutup
     ├─ POST /api/rooms/:code/heartbeat presence
     └─ POST /api/rooms/:code/leave     keluar
   │
   ▼
Upstash Redis (room, peers, ban list, stream event, rate limit)
```

Media (video/audio layar) mengalir **langsung antar browser (P2P)** — server hanya
merelai signaling (SDP/ICE). Server menutup tiap koneksi SSE setelah ±50 detik;
klien menyambung ulang otomatis dengan cursor, jadi tidak ada event yang hilang.

## Cara Deploy ke Vercel (±10 menit)

### 1. Siapkan Redis (gratis)

1. Buka [Vercel Marketplace → Upstash Redis](https://vercel.com/marketplace?category=storage&search=redis) atau [console.upstash.com](https://console.upstash.com).
2. Buat database Redis (pilih region terdekat, mis. Singapore `ap-southeast-1`).
3. Catat **UPSTASH_REDIS_REST_URL** dan **UPSTASH_REDIS_REST_TOKEN**.

> Bila deploy lewat integrasi Vercel Marketplace, kedua variabel lingkungan
> terpasang otomatis.

### 2. Deploy

**Opsi A — lewat GitHub (disarankan):**

1. Push folder ini ke repository GitHub Anda.
2. Di [vercel.com/new](https://vercel.com/new), **Import** repo tersebut (framework Vite terdeteksi otomatis).
3. Buka **Settings → Environment Variables**, tambahkan:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. **Deploy**. Selesai — Anda dapat URL `https://nama-acak.vercel.app`.

**Opsi B — lewat CLI:**

```sh
npm install -g vercel
vercel login
vercel            # pertama kali: link project
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
vercel --prod
```

### 3. Pakai

1. Buka situs Anda → **Buat Room** → pilih nama, password (opsional), maks penonton.
2. Klik **Salin Undangan** → kirim link-nya ke teman (WhatsApp/Discord/dll).
3. Klik **Mulai Berbagi** → pilih layar/jendela/tab.
4. Teman membuka link, masukkan nama (+password bila ada) → gambar muncul otomatis.
5. Di panel **Peserta**, host bisa **Kick** atau **Ban** siapa pun.

## Pengembangan Lokal

```sh
npm install
npm run dev:api   # terminal 1: API lokal di :8787 (in-memory bila tanpa env Redis)
npm run dev       # terminal 2: frontend di :5173 (proxy /api ke :8787)
```

Smoke test end-to-end (39 pemeriksaan: password, ban, kick, kapasitas, dll.):

```sh
npm run dev:api   # jalankan dulu di terminal lain
npm run test:api
```

> Catatan: browser butuh **HTTPS atau localhost** untuk `getDisplayMedia`
> (berbagi layar). `localhost:5173` sudah memenuhi syarat.

## Keamanan — apa yang sudah dijaga

| Ancaman | Mitigasi |
| --- | --- |
| Orang asing masuk room | Tidak ada daftar/enumerasi room; kode 12 karakter acak kriptografis (~71 bit entropi); join wajib kode, plus password bila diaktifkan |
| Link undangan bocor | Host bisa set password, **kick**, **ban**, atau tutup room kapan saja |
| Penonton menyamar jadi host | Aksi moderasi butuh `hostToken` rahasia (disimpan ter-hash); broadcast hanya boleh host |
| Penyadapan sinyal antar viewer | Pesan `signal` tertarget — server hanya mengirim ke peer tujuan |
| Brute force | Rate limit per IP: create 20/jam, join 30/menit, info 60/menit, pesan 600/menit |
| Secret bocor via timing attack | Perbandingan token/password memakai `timingSafeEqual` |
| Room zombie | Semua key Redis ber-TTL 24 jam; presence di-prune otomatis (45 detik) |

**Batasan yang perlu diketahui (jujur):**

- **Ban bisa ditembus** oleh orang yang mengganti IP *dan* membersihkan storage browsernya — wajar untuk aplikasi tanpa akun. Untuk kontrol lebih ketat, aktifkan password room.
- **Tanpa TURN server**: pada jaringan yang sangat restriktif (simetris NAT, beberapa jaringan kampus/kantor), koneksi P2P bisa gagal. Solusinya tambahkan TURN (mis. [Open Relay](https://openrelay.xyz), Metered, atau Twilio) di `shared/protocol.ts` → `ICE_SERVERS`.
- **Uplink host** menentukan kualitas: 20 penonton berarti layar dikirim 20 kali dari koneksi host. Untuk kelompok besar, kurangi maks penonton atau self-host Piik asli yang punya SFU.
- SSE function dibatasi `maxDuration` (diset 60 detik; di paket Hobby dengan Fluid Compute bisa lebih). Klien reconnect otomatis, jadi ini transparan.

## Ingin fitur Piik lengkap (SFU, remote control, room voice)?

Gunakan [Piik asli](https://github.com/TNTcraftHIM/Piik) dan self-host server Go-nya
(Docker Compose/VPS), lalu taruh frontend-nya di Vercel sebagai situs terpisah.
Repo ini sengaja dibuat ringan agar **seluruhnya** hidup di Vercel + Redis gratis.

## Lisensi

MIT (mengikuti proyek Piik).
