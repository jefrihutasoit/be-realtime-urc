# be-realtime-urc

Backend realtime OEE untuk `oee-realtime-urc` (Next.js). Express 5 + Socket.IO + TypeScript.

## Menjalankan

```bash
npm install
cp .env.example .env   # sesuaikan bila perlu
npm run db:seed        # opsional: isi mesin contoh 1A & 1B bila tabel masih kosong
npm run dev            # http://localhost:4000, auto-reload
npm run build && npm start
```

Butuh MySQL/MariaDB (mis. XAMPP). Database (`DB_NAME`, default `OEE-URC-Cibitung`) dan tabelnya
dibuat otomatis saat server start lewat migration di `src/db/migrations.ts` (`npm run db:migrate`
untuk menjalankan manual). Migration yang sudah jalan tercatat di tabel `schema_migrations`;
jangan ubah migration lama, tambahkan yang baru.

Di frontend (`oee-realtime-urc/.env.local`):

```
NEXT_PUBLIC_API_URL=http://localhost:4000/api
NEXT_PUBLIC_WS_URL=http://localhost:4000
```

## Struktur

```
src/
  server.ts              HTTP + Socket.IO + poller
  app.ts                 Express app, CORS, error handler
  config/env.ts          konfigurasi dari .env
  services/shift-store.ts    master shift (tabel shifts) + shift yang sedang berjalan
  routes/                REST API
  socket/                event Socket.IO
  services/gateway.ts    driver gateway: "database" (baca tag_values) atau "random"
  services/tag-value-store.ts  akses tabel tag_values
  db/                    koneksi MySQL, migration, script migrate/seed
  services/machine-store.ts  registry mesin (MySQL: machines, machine_monitoring_tags)
  services/oee-engine.ts perhitungan OEE per shift
  services/oee-state-store.ts  simpan state OEE run tiap 10 detik (tabel oee_run_states) + saat shutdown,
                         dipulihkan saat start sehingga restart tidak me-reset OEE shift berjalan
  services/poller.ts     baca tag tiap POLL_INTERVAL_MS lalu broadcast
  types/                 sama dengan types di frontend
```

## REST API (`/api`)

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/health` | health check |
| GET | `/machines` | daftar mesin |
| GET | `/machines/:id` | detail satu mesin |
| GET | `/machines/:id/history?limit=` | log output/reject (dengan kenaikan per pembacaan) dan event perubahan status |
| GET | `/machines/:id/timeline` | timeline status shift berjalan (segmen RUN/STOP/OFF + total detik) |
| POST | `/machines` | tambah mesin (`MachineInput`) |
| PATCH | `/machines/:id` | ubah sebagian |
| DELETE | `/machines/:id` | hapus |
| GET | `/skus` | daftar SKU |
| POST | `/skus` | tambah SKU (`SkuInput`) |
| PATCH | `/skus/:id` | ubah sebagian |
| DELETE | `/skus/:id` | hapus (file foto ikut dihapus) |
| GET | `/shifts` | daftar shift (`Shift`) |
| GET | `/shifts/current` | shift yang sedang berjalan (`ShiftPeriod`, atau "No shift") |
| POST | `/shifts` | tambah shift (`{ name, start: "HH:mm", end: "HH:mm" }`) |
| PATCH | `/shifts/:id` | ubah shift |
| DELETE | `/shifts/:id` | hapus shift |
| GET | `/settings/status-definition` | definisi status global (`StatusDefinition`) |
| PUT | `/settings/status-definition` | simpan definisi status |
| GET | `/settings/oee` | setting OEE global (`OeeSettings`): start counting, tipe counter, restart saat SKU ganti, pause saat Off, sumber reject untuk Quality (tag / Reject Input / keduanya), Off saat run = Breakdown, aturan finish run |
| PUT | `/settings/oee` | simpan setting OEE global; perubahan selain aturan finish, sumber reject dan nama mesin memulai OEE run baru. `machineLabelEnabled` + `machineLabel` (mis. "Bagger") = nama pengganti "Machine" di dashboard |
| GET | `/rejects/types` | daftar tipe reject (`RejectType`) |
| POST | `/rejects/types` | daftarkan tipe reject (`{ name, sortOrder? }`) |
| PATCH | `/rejects/types/:id` | ubah tipe reject |
| DELETE | `/rejects/types/:id` | hapus tipe reject (409 bila sudah dipakai data reject) |
| GET | `/rejects?date=YYYY-MM-DD&shiftId=` | data reject per mesin untuk tanggal (dan shift) tsb |
| POST | `/rejects/validate` | cek sheet reject (`RejectUploadInput`): baris dengan SKU wajib cocok dengan mesin terdaftar dan SKU master (SKU + produk); baris tanpa SKU dilewati dengan warning |
| POST | `/rejects/upload` | simpan sheet reject; ditolak (400) bila belum valid. Tipe reject baru dibuat otomatis, data mesin yang sudah ada untuk tanggal+shift tsb diganti |
| GET | `/rejects/manual/dates` | tanggal yang boleh diinput manual (3 hari terakhir, waktu server) |
| GET | `/rejects/manual/skus?machineId=&date=&shiftId=` | SKU yang jalan di mesin tsb pada shift itu (dari tag product) |
| POST | `/rejects/manual` | simpan input manual (`ManualRejectInput`); 1 data per tanggal+shift+mesin+SKU, disimpan ulang = diganti |
| DELETE | `/rejects/:id` | hapus satu data reject |
| GET | `/summary?date=YYYY-MM-DD` | ringkasan 1 hari produksi (mulai shift pertama, 24 jam): OEE, output, reject, tren per jam, top reject, downtime per tipe, OEE per mesin. Dari tabel `oee_hourly` yang diisi engine tiap 10 detik |
| GET | `/downtime?date=YYYY-MM-DD` | downtime hasil upload untuk tanggal tsb |
| POST | `/downtime/validate` | cek sheet downtime (`DowntimeUploadInput`); hanya mesin yang diverifikasi: 1 baris 1 mesin, harus persis sama dengan nomor mesin terdaftar |
| POST | `/downtime/upload` | simpan sheet downtime; baris dengan tanggal+mesin+bagger+start yang sama diganti |
| DELETE | `/downtime/:id` | hapus satu baris downtime |
| GET | `/backup` | export semua settingan (`SettingsBackup`): mesin + tag, SKU (tanpa foto), shift, status definition, posisi mesin di layout, tipe reject |
| POST | `/backup/validate` | cek backup + ringkasan perubahan (tambah/ubah/hapus) tanpa menyimpan |
| POST | `/backup/restore` | ganti semua settingan dengan backup (1 transaksi); ditolak (400) bila belum valid. Data dicocokkan lewat machine No / SKU ID / nama shift / nama tipe reject sehingga id & histori tetap |
| POST | `/tag-values` | push nilai tag (`{ tagName, value, timestamp? }`), dipakai menu Simulator |
| GET | `/tag-values/latest` | nilai terakhir semua tag yang terdaftar di mesin |
| GET | `/tag-values/recent?limit=` | push terbaru |
| GET | `/gateway/tags` | daftar tag gateway |
| GET | `/oee` | snapshot OEE terakhir (`MachineOee[]`) |
| GET | `/oee/:machineId/monitoring` | nilai monitoring tag terakhir |

Foto SKU dikirim sebagai data URL (`photo`), disimpan sebagai file di `UPLOAD_DIR/skus/`
(default `uploads/skus/`, tidak masuk git) dan disajikan di `/uploads/skus/<file>`. Database hanya
menyimpan nama file. `photo: null` menghapus foto; tidak mengirim `photo` berarti foto tetap.

## Database (menu Settings → Database, khusus Engineering)

| Method | Path | Keterangan |
| --- | --- | --- |
| GET | `/database/stats` | jumlah baris & ukuran per tabel |
| GET | `/database/backup` | backup seluruh isi database (`.jsonl.gz`, di-stream); tanpa `user_sessions` & `schema_migrations` |
| POST | `/database/restore` | body = file backup (`application/gzip`); mengganti seluruh isi database dalam 1 transaksi. Ditolak bila versi schema (migration) berbeda |
| POST | `/database/clear/preview` | `{ from, to }` (YYYY-MM-DD): jumlah data yang akan terhapus |
| POST | `/database/clear` | `{ from, to, confirm: "DELETE" }`: hapus tag values, OEE per jam, reject dan downtime dalam rentang tanggal |
| POST | `/database/initialize` | `{ confirm: "INITIALIZE", keepUsers }`: kosongkan database seperti instalasi baru (shift default, akun default) |

Selama restore / initialize / clear, poller berhenti sementara. Foto SKU & gambar layout (folder `uploads`) tidak
ikut backup database; initialize menghapusnya.

## Login & role

Data dashboard (`GET /machines`, `/oee`, `/shifts`, `/skus`, `/layout`, `/summary`) bisa dibaca tanpa login
(tamu). Endpoint lain butuh header `Authorization: Bearer <token>` dari `POST /auth/login`. Membaca data boleh
untuk semua user yang login; perubahan dicek per permission di
`src/middleware/auth.ts`. Role: **Engineering** (akun tersembunyi, dibuat dari `ENGINEERING_USERNAME` /
`ENGINEERING_PASSWORD`; satu-satunya yang bisa Machine Management, Status Definition, Backup & Restore,
Simulator), **Admin**, **Engineer**, **Operator** (permission diatur di User Management). Saat tabel user
masih kosong dibuat Admin `admin` / `admin123`; ganti password setelah login.

| Method | Path | Keterangan |
| --- | --- | --- |
| POST | `/auth/login` | `{ username, password }` → `{ token, user }` |
| POST | `/auth/logout` | hapus sesi |
| GET | `/auth/me` | user yang login + permission |
| POST | `/auth/password` | ganti password sendiri `{ currentPassword, newPassword }` |
| GET/POST/PATCH/DELETE | `/users` | kelola user (akun Engineering hanya tampil & bisa dikelola oleh akun Engineering) |
| GET/PUT | `/users/roles` | permission per role |

Error selalu berbentuk `{ "error": "..." }` (400 validasi, 404, 409 konflik).

## Socket.IO

| Arah | Event | Payload |
| --- | --- | --- |
| server → client | `oee:update` | `MachineOee[]`, tiap poll + saat connect |
| server → client | `monitoring:update` | `MachineMonitoring`, hanya ke subscriber mesin itu |
| client → server | `monitoring:subscribe` | `machineId` |
| client → server | `monitoring:unsubscribe` | `machineId` |

## Data tag dari gateway

`GATEWAY_MODE=database` (default): gateway menulis setiap pembacaan ke tabel `tag_values`
(`tag_name`, `tag_value` sebagai teks, `recorded_at`). Poller mengambil baris terbaru per tag
(berdasarkan `id`) setiap `POLL_INTERVAL_MS`. Menu **Simulator** di frontend menulis ke tabel yang
sama lewat `POST /api/tag-values`, jadi bisa dipakai untuk mencoba sebelum gateway asli terpasang.
`GATEWAY_MODE=random` memakai nilai acak di memori (tanpa database).

- **Status**: nilai tag status → RUN/STOP/OFF lewat Status Definition.
- **Output / Reject**: counter kumulatif. Output shift = kenaikan sejak nilai terakhir sebelum shift
  mulai (0 bila belum ada data sebelumnya). Nilai turun = counter di-reset.
- **Product**: nilai dicocokkan dengan SKU ID di master SKU (tidak peka huruf besar/kecil; angka
  `10.0` = `10`). Nama/foto SKU tampil di dashboard dan Output per Minute SKU dipakai untuk
  Performance; tanpa SKU yang cocok dipakai `IDEAL_RATE_PPM`.

## Shift

Shift diatur di menu **Settings → Shift Management** (tabel `shifts`, default Shift 1 06:00–14:00,
Shift 2 14:00–22:00, Shift 3 22:00–06:00). Jam memakai waktu lokal server; jam selesai lebih kecil
dari jam mulai berarti melewati tengah malam. Shift tidak boleh tumpang tindih dan namanya unik.
Waktu yang tidak tercakup shift mana pun dianggap periode "No shift". OEE, baseline counter, dan
timeline operasi di-reset setiap pergantian periode.

## Aturan OEE per mesin

Diatur di form mesin (Settings → Machine Management → bagian **OEE Calculation**), disimpan di
kolom `oee_start_mode`, `reset_on_sku_change`, `pause_when_off`, `counter_mode` tabel `machines`.

| Pengaturan | Pilihan | Default |
|---|---|---|
| Start counting | `sku`: hanya saat tag Product berisi SKU ID yang terdaftar di master SKU; `always`: selalu (SKU tidak dikenal memakai `IDEAL_RATE_PPM`) | `sku` |
| Restart OEE when SKU changes | SKU berganti = perhitungan baru. Hanya dicek saat mesin tidak Off | ya |
| Pause while machine is Off | waktu Off tidak dihitung; kalau tidak, Off = downtime di Availability | ya |
| Output & reject tags | `cumulative`: counter terus naik, yang dihitung kenaikannya; `direct`: nilai tag = total apa adanya | `cumulative` |

Satu "perhitungan" berjalan sampai pergantian shift, pergantian SKU (bila aktif), atau perubahan
pengaturan OEE mesin. `GET /api/oee` mengirim `counting`, `waitingFor` (`NO_SKU`,
`UNREGISTERED_SKU`, `MACHINE_OFF`), `runStart`, dan `runSku`.

## Perhitungan OEE (per shift)

- **Availability** = waktu RUN / waktu yang dihitung (waktu jeda tidak termasuk)
- **Performance** = output aktual / ideal output, dengan ideal output = Σ(menit sejak sesi OEE dimulai, RUN dan STOP, tanpa waktu jeda × output per menit SKU yang sedang jalan)
- **Quality** = (output − reject) / output
- **OEE** = A × P × Q

Status mesin diambil dari nilai tag `STATUS` sesuai **Status Definition** global (menu Settings,
tabel `app_settings`): daftar nilai untuk RUN, STOP, OFF, dan status untuk nilai yang tidak terdaftar.
Default: 1 = RUN, 0 = STOP, lainnya = OFF. Tag yang tidak terbaca selalu OFF. `OUTPUT`/`REJECT` adalah counter kumulatif PLC; bila nilainya turun dianggap counter di-reset. `PRODUCT` berisi kode produk/SKU yang sedang jalan (sudah diregistrasi per mesin, belum dipakai untuk menentukan SKU di OEE).

## Belum dikerjakan

- Driver gateway asli (OPC UA / MQTT / Modbus) — tambahkan di `services/gateway.ts`, pilih lewat `GATEWAY_MODE`
- Histori OEE ke database (registry mesin sudah di MySQL; state OEE shift berjalan masih in-memory)
- SKU aktif dari production plan (sekarang placeholder)
- Planned downtime, ideal rate per mesin/SKU
- Autentikasi
