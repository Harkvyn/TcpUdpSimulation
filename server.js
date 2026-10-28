/**
 * TCP/UDP Lab Server
 * Simulasi real TCP & UDP over LAN dengan visualisasi web
 *
 * Arsitektur:
 *  - HTTP server  → serve frontend
 *  - WebSocket    → bridge browser ↔ socket layer (realtime events)
 *  - TCP server   → socket SOCK_STREAM (port 7001)
 *  - UDP server   → socket SOCK_DGRAM  (port 7002)
 */

'use strict';

const express    = require('express');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const net        = require('net');
const dgram      = require('dgram');
const path       = require('path');
const os         = require('os');

// ─── Ports ───────────────────────────────────────────────────────────────────
const HTTP_PORT = 3000;
const TCP_PORT  = 7001;
const UDP_PORT  = 7002;
const WS_PORT   = 3001;

// ─── MTU / MSS constants (bytes) ─────────────────────────────────────────────
const MTU       = 1500;  // Ethernet MTU
const IP_HDR    = 20;    // IP header size
const UDP_HDR   = 8;     // UDP header size
const TCP_HDR   = 20;    // TCP header size (minimal, no options)
const MAX_UDP_PAYLOAD = MTU - IP_HDR - UDP_HDR;  // 1472 bytes
const MSS             = MTU - IP_HDR - TCP_HDR;  // 1460 bytes

// ─── App ─────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── WebSocket server (port 3001) ────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT });
const browsers = new Set();          // connected browser clients

wss.on('connection', (ws) => {
  browsers.add(ws);
  ws.on('close', () => browsers.delete(ws));
  ws.on('message', (raw) => {
    try { handleBrowserMsg(ws, JSON.parse(raw)); }
    catch (e) { console.error('WS parse error', e.message); }
  });
  // Send welcome / config info
  send(ws, { type: 'config', mtu: MTU, mss: MSS, maxUdpPayload: MAX_UDP_PAYLOAD,
              tcpPort: TCP_PORT, udpPort: UDP_PORT, httpPort: HTTP_PORT });
});

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of browsers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ─── TCP Server ──────────────────────────────────────────────────────────────
const tcpServer = net.createServer();
tcpServer.listen(TCP_PORT, '0.0.0.0', () =>
  console.log(`[TCP] Listening on port ${TCP_PORT}`));

tcpServer.on('connection', (socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[TCP] Connected: ${remote}`);
  broadcast({ type: 'tcp_connected', remote });

  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString();
    // Messages are newline-delimited JSON
    const lines = buf.split('\n');
    buf = lines.pop();                          // keep incomplete tail
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleTcpMessage(socket, msg, remote);
      } catch (e) {
        console.error('[TCP] JSON parse error:', e.message);
      }
    }
  });

  socket.on('close',  () => { broadcast({ type: 'tcp_disconnected', remote }); });
  socket.on('error',  (e) => { broadcast({ type: 'tcp_error', remote, error: e.message }); });
});

function handleTcpMessage(socket, msg, remote) {
  // msg: { id, segmentIndex, totalSegments, data, timestamp, lossRate }
  const { id, segmentIndex, totalSegments, data, timestamp, lossRate = 0 } = msg;

  // Simulate random packet loss (server-side drop)
  const dropped = Math.random() < lossRate;

  broadcast({
    type:          'tcp_segment_received',
    id,
    segmentIndex,
    totalSegments,
    data,
    timestamp,
    remote,
    dropped,
    receivedAt:    Date.now(),
  });

  if (!dropped) {
    // Send ACK back to sender
    const ack = JSON.stringify({
      type:         'ACK',
      id,
      segmentIndex,
      receivedAt:   Date.now(),
    }) + '\n';
    socket.write(ack);
  }
  // If dropped: no ACK → sender will timeout
}

// ─── UDP Server ──────────────────────────────────────────────────────────────
const udpServer = dgram.createSocket('udp4');

udpServer.on('message', (msgBuf, rinfo) => {
  const remote = `${rinfo.address}:${rinfo.port}`;
  let msg;
  try { msg = JSON.parse(msgBuf.toString()); }
  catch (e) { console.error('[UDP] JSON parse error:', e.message); return; }

  const { id, fragmentIndex, totalFragments, data, timestamp, lossRate = 0,
          moreFragments, fragmentOffset, originalSize } = msg;

  const dropped = Math.random() < lossRate;

  broadcast({
    type:           'udp_fragment_received',
    id,
    fragmentIndex,
    totalFragments,
    data,
    timestamp,
    remote,
    dropped,
    moreFragments,
    fragmentOffset,
    originalSize,
    receivedAt:     Date.now(),
    headerSize:     UDP_HDR,
    ipHeaderSize:   IP_HDR,
  });

  if (!dropped) {
    // Send ACK datagram back
    const ack = Buffer.from(JSON.stringify({
      type:        'ACK',
      id,
      fragmentIndex,
      receivedAt:  Date.now(),
    }));
    udpServer.send(ack, rinfo.port, rinfo.address);
  }
});

udpServer.bind(UDP_PORT, '0.0.0.0', () =>
  console.log(`[UDP] Listening on port ${UDP_PORT}`));

// ─── Browser → Server messages (via WebSocket) ───────────────────────────────
// The browser tells server to initiate TCP/UDP connections to a target IP.
// This lets the HOST machine act as the "sender" on behalf of the browser.

const tcpClients = new Map();   // wsId → net.Socket

function handleBrowserMsg(ws, msg) {
  switch (msg.action) {
    case 'send_tcp': sendTcp(ws, msg); break;
    case 'send_udp': sendUdp(ws, msg); break;
    case 'get_ip':   send(ws, { type: 'local_ip', ip: getLocalIP() }); break;
    default: console.warn('Unknown browser action:', msg.action);
  }
}

// ─── TCP Sender ──────────────────────────────────────────────────────────────
function sendTcp(ws, { targetIp, targetPort = TCP_PORT, text, lossRate = 0 }) {
  const textBytes = Buffer.from(text, 'utf8');
  const totalBytes = textBytes.length;
  const segments = [];

  // Segment data according to MSS
  for (let offset = 0; offset < totalBytes; offset += MSS) {
    segments.push(textBytes.slice(offset, offset + MSS));
  }
  const totalSegments = segments.length;
  const msgId = `tcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Notify browser: "here are the segments we are about to send"
  send(ws, {
    type: 'tcp_send_plan',
    id: msgId,
    totalBytes,
    totalSegments,
    mss: MSS,
    segments: segments.map((seg, i) => ({
      index: i,
      size:  seg.length,
      data:  seg.toString('utf8'),
    })),
  });

  // Open TCP connection and stream segments
  const client = net.connect({ host: targetIp, port: targetPort }, () => {
    send(ws, { type: 'tcp_conn_established', id: msgId, targetIp, targetPort });

    let idx = 0;
    function sendNext() {
      if (idx >= totalSegments) return;
      const seg  = segments[idx];
      const drop = Math.random() < lossRate;

      const payload = JSON.stringify({
        id:            msgId,
        segmentIndex:  idx,
        totalSegments,
        data:          seg.toString('utf8'),
        timestamp:     Date.now(),
        lossRate,
      }) + '\n';

      send(ws, {
        type:          'tcp_segment_sent',
        id:            msgId,
        segmentIndex:  idx,
        totalSegments,
        size:          seg.length,
        dropped:       drop,
        timestamp:     Date.now(),
      });

      if (!drop) {
        client.write(payload);
      }

      idx++;
      // small delay between segments for visual effect
      setTimeout(sendNext, 120);
    }
    sendNext();
  });

  // Listen for ACKs from server
  let ackBuf = '';
  const ackMap = new Map();
  client.on('data', (chunk) => {
    ackBuf += chunk.toString();
    const lines = ackBuf.split('\n');
    ackBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ack = JSON.parse(line);
        if (ack.type === 'ACK') {
          ackMap.set(ack.segmentIndex, ack);
          send(ws, { type: 'tcp_ack', id: msgId, segmentIndex: ack.segmentIndex, receivedAt: ack.receivedAt });
        }
      } catch (e) {}
    }
  });

  // After 3 seconds, check for missing ACKs and report
  setTimeout(() => {
    const missing = [];
    for (let i = 0; i < totalSegments; i++) {
      if (!ackMap.has(i)) missing.push(i);
    }
    send(ws, { type: 'tcp_done', id: msgId, totalSegments, missing });
    client.end();
  }, 3000 + totalSegments * 150);

  client.on('error', (e) => {
    send(ws, { type: 'tcp_error', id: msgId, error: e.message });
  });
}

// ─── UDP Sender ──────────────────────────────────────────────────────────────
function sendUdp(ws, { targetIp, targetPort = UDP_PORT, text, lossRate = 0 }) {
  const textBytes  = Buffer.from(text, 'utf8');
  const totalBytes = textBytes.length;
  const msgId      = `udp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // UDP fragments: if data > MAX_UDP_PAYLOAD, IP layer would fragment
  // We simulate this by splitting into IP-fragment-sized chunks
  const fragments = [];
  for (let offset = 0; offset < totalBytes; offset += MAX_UDP_PAYLOAD) {
    fragments.push(textBytes.slice(offset, offset + MAX_UDP_PAYLOAD));
  }
  const totalFragments = fragments.length;

  send(ws, {
    type: 'udp_send_plan',
    id:   msgId,
    totalBytes,
    totalFragments,
    maxUdpPayload: MAX_UDP_PAYLOAD,
    udpHeaderSize: UDP_HDR,
    ipHeaderSize:  IP_HDR,
    // Note: if totalFragments === 1, no IP fragmentation needed
    needsFragmentation: totalFragments > 1,
    fragments: fragments.map((frag, i) => ({
      index:          i,
      size:           frag.length,
      moreFragments:  i < totalFragments - 1,
      fragmentOffset: i * MAX_UDP_PAYLOAD,
      data:           frag.toString('utf8'),
    })),
  });

  const udpClient  = dgram.createSocket('udp4');
  const ackMap     = new Map();

  udpClient.on('message', (buf) => {
    try {
      const ack = JSON.parse(buf.toString());
      if (ack.type === 'ACK') {
        ackMap.set(ack.fragmentIndex, ack);
        send(ws, { type: 'udp_ack', id: msgId, fragmentIndex: ack.fragmentIndex, receivedAt: ack.receivedAt });
      }
    } catch (e) {}
  });

  udpClient.bind(() => {
    let idx = 0;
    function sendNext() {
      if (idx >= totalFragments) {
        // After timeout check for missing ACKs
        setTimeout(() => {
          const missing = [];
          for (let i = 0; i < totalFragments; i++) {
            if (!ackMap.has(i)) missing.push(i);
          }
          send(ws, { type: 'udp_done', id: msgId, totalFragments, missing });
          udpClient.close();
        }, 2000);
        return;
      }

      const frag = fragments[idx];
      const drop = Math.random() < lossRate;

      const payload = Buffer.from(JSON.stringify({
        id:             msgId,
        fragmentIndex:  idx,
        totalFragments,
        data:           frag.toString('utf8'),
        timestamp:      Date.now(),
        lossRate,
        moreFragments:  idx < totalFragments - 1,
        fragmentOffset: idx * MAX_UDP_PAYLOAD,
        originalSize:   totalBytes,
      }));

      send(ws, {
        type:           'udp_fragment_sent',
        id:             msgId,
        fragmentIndex:  idx,
        totalFragments,
        size:           frag.length,
        dropped:        drop,
        moreFragments:  idx < totalFragments - 1,
        fragmentOffset: idx * MAX_UDP_PAYLOAD,
        timestamp:      Date.now(),
      });

      if (!drop) {
        udpClient.send(payload, targetPort, targetIp);
      }

      idx++;
      setTimeout(sendNext, 150);
    }
    sendNext();
  });

  udpClient.on('error', (e) => {
    send(ws, { type: 'udp_error', id: msgId, error: e.message });
  });
}

// ─── Utilities ───────────────────────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ─── API ─────────────────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  res.json({ ip: getLocalIP(), mtu: MTU, mss: MSS,
             maxUdpPayload: MAX_UDP_PAYLOAD,
             tcpPort: TCP_PORT, udpPort: UDP_PORT, wsPort: WS_PORT });
});

// ─── Start HTTP ───────────────────────────────────────────────────────────────
server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\n🚀  TCP/UDP Lab running!`);
  console.log(`   Web UI  → http://${getLocalIP()}:${HTTP_PORT}`);
  console.log(`   TCP     → port ${TCP_PORT}`);
  console.log(`   UDP     → port ${UDP_PORT}`);
  console.log(`   WS      → port ${WS_PORT}\n`);
});
