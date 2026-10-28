# TCP/UDP LAN Lab 🌐

Simulasi **nyata** protokol TCP & UDP antara dua laptop melalui LAN, dengan visualisasi paket berbasis web.

## Fitur
- ✅ Socket TCP dan UDP **asli** (bukan simulasi)
- 📦 Visualisasi **segmentasi TCP** (data → segmen ≤ MSS 1460B)
- 📬 Visualisasi **fragmentasi UDP** via IP Layer (data > 1472B → fragmen)
- 🔴 Simulasi **packet loss** (paket mana yang gagal terlihat jelas)
- 💬 Chat real-time antara 2 laptop
- 🖥 Diagram layer (App → TCP/UDP → IP → Ethernet)
- 🔍 Klik tiap paket untuk melihat detail header

## Cara Menjalankan

### 1. Jalankan server di **kedua laptop**

```bash
cd tcp-udp-lab
npm install
npm start
```

Server akan menampilkan IP lokal:
```
🚀  TCP/UDP Lab running!
   Web UI  → http://192.168.1.5:3000
   TCP     → port 7001
   UDP     → port 7002
   WS      → port 3001
```

### 2. Buka browser di kedua laptop

```
http://<IP-LAPTOP-ANDA>:3000
```

### 3. Kirim pesan

1. **Pilih protokol**: TCP atau UDP
2. **Masukkan IP tujuan** (IP laptop lain, contoh: `192.168.1.10`)
3. Atur **Simulasi Packet Loss** jika ingin melihat paket gagal
4. Ketik pesan dan klik **Kirim**

---

## Visualisasi yang Ditampilkan

### TCP – Segmentasi
```
Application Layer (pesan 5000 byte)
        ↓
TCP Transport Layer → Dipecah menjadi 4 SEGMEN (≤ 1460 B tiap segmen)
        ↓
IP Network Layer → Setiap segmen dibungkus header IP
        ↓
Ethernet → Frame dikirim, MTU 1500 B
```
- Setiap segmen dapat ACK terpisah
- Segmen yang gagal ACK → timeout → ditandai kuning ⚠️
- Segmen yang ber-ACK → hijau ✅

### UDP – Tanpa Segmentasi (IP Fragmentasi)
```
Application Layer (pesan 5000 byte)
        ↓
UDP Transport Layer → Satu datagram + header 8 byte
        ↓
IP Network Layer → FRAGMENTASI jadi 4 fragmen (≤ 1472 B/fragmen)
        ↓
Ethernet → Frame dikirim, MTU 1500 B
```
- UDP tidak ada ACK otomatis
- Jika satu fragmen hilang → seluruh datagram rusak
- Fragmen gagal → merah ❌

---

## Ports yang Digunakan

| Komponen | Port |
|----------|------|
| Web UI (HTTP) | 3000 |
| WebSocket (realtime) | 3001 |
| TCP Socket | 7001 |
| UDP Socket | 7002 |

Pastikan firewall mengizinkan port ini:
```bash
# Linux (ufw)
sudo ufw allow 3000,3001,7001,7002/tcp
sudo ufw allow 7002/udp

# Linux (firewalld)
sudo firewall-cmd --add-port=3000-3001/tcp --permanent
sudo firewall-cmd --add-port=7001/tcp --permanent
sudo firewall-cmd --add-port=7002/udp --permanent
sudo firewall-cmd --reload
```

---

## Konstanta Jaringan

| Konstanta | Nilai | Penjelasan |
|-----------|-------|------------|
| MTU | 1500 B | Maximum Transmission Unit Ethernet |
| IP Header | 20 B | Header IP minimal |
| TCP Header | 20 B | Header TCP minimal |
| UDP Header | 8 B | Header UDP (tetap) |
| MSS (TCP) | **1460 B** | MTU − IP − TCP = max payload per segmen |
| Max UDP Payload | **1472 B** | MTU − IP − UDP = max payload sebelum fragmentasi IP |

---

## Cara Kerja Internal

```
Browser Laptop A  ←──WebSocket──→  Server Node.js (Laptop A)
                                         │
                                    ┌────▼────┐
                                    │ net.Socket (TCP)  port 7001
                                    │ dgram.Socket (UDP) port 7002
                                    └────┬────┘
                                         │  LAN
                                    ┌────▼────┐
                                    │ Server Node.js (Laptop B)
                                         │
Browser Laptop B  ←──WebSocket──→  (events via WS)
```
