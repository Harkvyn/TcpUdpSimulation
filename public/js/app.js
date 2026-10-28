/**
 * TCP/UDP LAN Lab – Frontend App
 * Mengelola WebSocket ke server, UI chat, dan visualisasi paket
 */

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
let ws         = null;
let proto      = 'tcp';          // 'tcp' | 'udp'
let lossRate   = 0;
let localIp    = '—';
let targetIp   = '';
let config     = {};
let txGroups   = {};             // id → { el, pkts, stats }

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);

const elStatus       = $('#connStatus');
const elLocalIp      = $('#localIp');
const elSenderIp     = $('#senderIpLabel');
const elReceiverIp   = $('#receiverIpLabel');
const elTopoBadge    = $('#topoBadge');
const elWire         = $('#wireFlow');
const elBtnTcp       = $('#btnTcp');
const elBtnUdp       = $('#btnUdp');
const elTargetIp     = $('#targetIp');
const elLossRate     = $('#lossRate');
const elLossLabel    = $('#lossLabel');
const elTcpInfo      = $('#tcpInfo');
const elUdpInfo      = $('#udpInfo');
const elBtnSend      = $('#btnSend');
const elProtoLabel   = $('#protoLabel');
const elChatInput    = $('#chatInput');
const elChatMessages = $('#chatMessages');
const elVisBody      = $('#visBody');
const elVisStats     = $('#visStats');
const elBtnClear     = $('#btnClear');
const elModalOverlay = $('#modalOverlay');
const elModalTitle   = $('#modalTitle');
const elModalBody    = $('#modalBody');
const elModalClose   = $('#modalClose');

// ─── WebSocket connection ─────────────────────────────────────────────────────
function connectWS() {
  const host = location.hostname;
  ws = new WebSocket(`ws://${host}:3001`);

  setStatus('connecting');

  ws.onopen = () => {
    setStatus('connected');
    ws.send(JSON.stringify({ action: 'get_ip' }));
  };

  ws.onmessage = (ev) => {
    try { handleServerMsg(JSON.parse(ev.data)); }
    catch (e) { console.error('WS message parse error:', e); }
  };

  ws.onclose = () => {
    setStatus('disconnected');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();
}

function setStatus(s) {
  const dot  = elStatus.querySelector('.dot');
  const text = { connected:'Terhubung ke server', disconnected:'Terputus – mencoba ulang…', connecting:'Menghubungkan…' };
  dot.className = `dot ${s}`;
  elStatus.lastChild.textContent = ' ' + text[s];
}

// ─── Server message dispatcher ───────────────────────────────────────────────
function handleServerMsg(msg) {
  switch (msg.type) {
    // Initial config
    case 'config':
      config = msg;
      break;

    case 'local_ip':
      localIp = msg.ip;
      elLocalIp.textContent = msg.ip;
      elSenderIp.textContent = msg.ip;
      break;

    // ── TCP flow ──────────────────────────────────────────────────────────
    case 'tcp_conn_established':
      addSysMsg(`🔗 TCP: Koneksi ke ${msg.targetIp}:${msg.targetPort} terbentuk (3-way handshake)`);
      startWireAnim('tcp');
      break;

    case 'tcp_send_plan':
      createTxGroup(msg);
      break;

    case 'tcp_segment_sent':
      updatePacket(msg.id, msg.segmentIndex, msg.dropped ? 'dropped' : 'pending', msg);
      break;

    case 'tcp_ack':
      updatePacket(msg.id, msg.segmentIndex, 'acked', msg);
      break;

    case 'tcp_done':
      finalizeTx(msg);
      stopWireAnim();
      break;

    case 'tcp_error':
      addSysMsg(`❌ TCP error: ${msg.error}`, 'error');
      stopWireAnim();
      break;

    // ── UDP flow ──────────────────────────────────────────────────────────
    case 'udp_send_plan':
      createTxGroup(msg);
      break;

    case 'udp_fragment_sent':
      updatePacket(msg.id, msg.fragmentIndex, msg.dropped ? 'dropped' : 'pending', msg);
      break;

    case 'udp_ack':
      updatePacket(msg.id, msg.fragmentIndex, 'acked', msg);
      break;

    case 'udp_done':
      finalizeTx(msg);
      stopWireAnim();
      break;

    case 'udp_error':
      addSysMsg(`❌ UDP error: ${msg.error}`, 'error');
      stopWireAnim();
      break;

    // ── Remote side (when this machine is the receiver) ───────────────────
    case 'tcp_segment_received':
      handleRemoteReceive(msg, 'tcp');
      break;

    case 'udp_fragment_received':
      handleRemoteReceive(msg, 'udp');
      break;

    case 'tcp_connected':
      addSysMsg(`📡 Laptop lain terhubung via TCP: ${msg.remote}`);
      elReceiverIp.textContent = msg.remote.split(':')[0];
      break;

    case 'tcp_disconnected':
      addSysMsg(`🔌 TCP koneksi ${msg.remote} ditutup`);
      break;
  }
}

// ─── Create a transmission group (visual container for one send operation) ───
function createTxGroup(plan) {
  const isTcp   = plan.type === 'tcp_send_plan';
  const isUdp   = plan.type === 'udp_send_plan';
  const count   = isTcp ? plan.totalSegments : plan.totalFragments;
  const itemKey = isTcp ? 'segments' : 'fragments';

  // Remove empty placeholder
  const empty = elVisBody.querySelector('.vis-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'tx-group';
  el.id = `tx-${plan.id}`;

  // Header
  const preview = (isTcp ? plan.segments[0]?.data : plan.fragments[0]?.data) || '';
  const protoName = isTcp ? 'TCP' : 'UDP';

  el.innerHTML = `
    <div class="tx-header">
      <span class="tx-proto ${protoName.toLowerCase()}">${protoName}</span>
      <span class="tx-msg">${escHtml(preview.slice(0, 60))}${preview.length > 60 ? '…' : ''}</span>
      <span class="tx-summary">
        <span class="tx-ok" id="ok-${plan.id}">0 ✓</span>
        <span class="tx-fail" id="fail-${plan.id}">0 ✗</span>
      </span>
    </div>
    ${buildLayerDiagram(plan, isTcp)}
    <div class="tx-packets" id="pkts-${plan.id}"></div>`;

  elVisBody.prepend(el);
  elVisBody.scrollTop = 0;

  // Pre-create packet chips
  const pktsEl = el.querySelector(`#pkts-${plan.id}`);
  const pkts   = {};

  for (let i = 0; i < count; i++) {
    const item = (isTcp ? plan.segments : plan.fragments)[i];
    const chip = createPktChip(i, item, isTcp, count);
    pktsEl.appendChild(chip);
    pkts[i] = chip;
  }

  txGroups[plan.id] = { el, pkts, okCount: 0, failCount: 0, plan, isTcp };
}

function buildLayerDiagram(plan, isTcp) {
  if (isTcp) {
    return `
    <div class="tx-layers">
      <div class="layer-block">
        <div class="layer-name">App Layer</div>
        <div class="layer-val">${plan.totalBytes} B</div>
      </div>
      <div class="layer-arrow">→</div>
      <div class="layer-block">
        <div class="layer-name">TCP (Transport)</div>
        <div class="layer-val">Segmentasi &le;${plan.mss} B/segmen</div>
      </div>
      <div class="layer-arrow">→</div>
      <div class="layer-block">
        <div class="layer-name">IP (Network)</div>
        <div class="layer-val">${plan.totalSegments} segmen</div>
      </div>
      <div class="layer-arrow">→</div>
      <div class="layer-block">
        <div class="layer-name">Ethernet</div>
        <div class="layer-val">MTU 1500 B</div>
      </div>
    </div>`;
  } else {
    const needsFrag = plan.needsFragmentation;
    return `
    <div class="tx-layers">
      <div class="layer-block">
        <div class="layer-name">App Layer</div>
        <div class="layer-val">${plan.totalBytes} B</div>
      </div>
      <div class="layer-arrow">→</div>
      <div class="layer-block">
        <div class="layer-name">UDP (Transport)</div>
        <div class="layer-val">Header 8B + data</div>
      </div>
      <div class="layer-arrow">→</div>
      <div class="layer-block">
        <div class="layer-name">IP (Network)</div>
        <div class="layer-val">${needsFrag ? `Fragmentasi: ${plan.totalFragments} fragmen` : 'Tidak perlu fragmentasi'}</div>
      </div>
      <div class="layer-arrow">→</div>
      <div class="layer-block">
        <div class="layer-name">Ethernet</div>
        <div class="layer-val">MTU 1500 B</div>
      </div>
    </div>`;
  }
}

function createPktChip(index, item, isTcp, total) {
  const chip = document.createElement('div');
  chip.className = `pkt state-pending${isTcp ? '' : ' udp-frag'}`;
  chip.dataset.index = index;
  chip.dataset.isTcp = isTcp;
  chip.innerHTML = `
    <div class="pkt-header-bar">${isTcp ? `SEG ${index + 1}` : `FRAG ${index + 1}`}</div>
    <div class="pkt-body">
      <div class="pkt-index">${index + 1}/${total}</div>
      <div class="pkt-size">${item?.size || 0} B</div>
      <div class="pkt-status-icon">⏳</div>
    </div>`;

  chip.addEventListener('click', () => showPktDetail(index, chip, item, isTcp));
  return chip;
}

// ─── Update a packet chip's state ────────────────────────────────────────────
function updatePacket(txId, index, state, msg) {
  const group = txGroups[txId];
  if (!group) return;
  const chip = group.pkts[index];
  if (!chip) return;

  const icons = { pending:'⏳', acked:'✅', dropped:'❌', timeout:'⚠️' };
  chip.className = `pkt state-${state}${group.isTcp ? '' : ' udp-frag'}`;
  chip.querySelector('.pkt-status-icon').textContent = icons[state] || '?';

  // Update summary counters
  if (state === 'acked') {
    group.okCount++;
    document.getElementById(`ok-${txId}`).textContent = `${group.okCount} ✓`;
  } else if (state === 'dropped' || state === 'timeout') {
    group.failCount++;
    document.getElementById(`fail-${txId}`).textContent = `${group.failCount} ✗`;
  }

  // Fly animation: create a floating bubble moving toward receiver
  if (state === 'pending' || state === 'dropped') {
    spawnFlyingPacket(chip, state, group.isTcp ? 'tcp' : 'udp');
  }
}

// ─── Finalize after all ACKs timeout ─────────────────────────────────────────
function finalizeTx(msg) {
  const group = txGroups[msg.id];
  if (!group) return;

  const missing = msg.missing || [];
  for (const idx of missing) {
    updatePacket(msg.id, idx, 'timeout', {});
  }

  const total   = group.isTcp ? msg.totalSegments : msg.totalFragments;
  const success = total - missing.length;
  const allOk   = missing.length === 0;

  // Add chat bubble showing result
  const text = group.plan
    ? (group.isTcp
        ? (group.plan.segments?.map(s => s.data).join('') || '')
        : (group.plan.fragments?.map(f => f.data).join('') || ''))
    : '';

  addChatBubble(text || '[pesan]', 'me', group.isTcp ? 'tcp' : 'udp', {
    total,
    success,
    failed: missing.length,
  });

  addSysMsg(
    allOk
      ? `✅ Semua ${total} ${group.isTcp ? 'segmen' : 'fragmen'} berhasil dikirim & di-ACK`
      : `⚠️ ${success}/${total} berhasil · ${missing.length} timeout (gagal): fragmen [${missing.map(i => i + 1).join(', ')}]`,
    allOk ? 'success' : 'warn'
  );
}

// ─── Handle incoming data (this machine = receiver) ──────────────────────────
let remoteGroups = {};

function handleRemoteReceive(msg, protoName) {
  const isTcp  = protoName === 'tcp';
  const index  = isTcp ? msg.segmentIndex  : msg.fragmentIndex;
  const total  = isTcp ? msg.totalSegments : msg.totalFragments;
  const gid    = msg.id;

  if (!remoteGroups[gid]) {
    remoteGroups[gid] = { received: {}, total, isTcp, data: [] };
    addSysMsg(`📨 ${protoName.toUpperCase()} masuk dari ${msg.remote}: ${total} ${isTcp ? 'segmen' : 'fragmen'}`);

    // Build a RX group in vis panel
    const empty = elVisBody.querySelector('.vis-empty');
    if (empty) empty.remove();

    const rxEl = document.createElement('div');
    rxEl.className = 'tx-group';
    rxEl.id = `rx-${gid}`;
    rxEl.innerHTML = `
      <div class="tx-header">
        <span class="tx-proto ${protoName}">↙ ${protoName.toUpperCase()} MASUK</span>
        <span class="tx-msg">dari ${msg.remote}</span>
        <span class="tx-summary">
          <span class="tx-ok" id="rxok-${gid}">0 ✓</span>
          <span class="tx-fail" id="rxfail-${gid}">0 ✗</span>
        </span>
      </div>
      <div class="tx-packets" id="rxpkts-${gid}"></div>`;
    elVisBody.prepend(rxEl);

    txGroups[gid + '-rx'] = { el: rxEl, pkts: {}, okCount: 0, failCount: 0, isTcp };
  }

  const rg   = remoteGroups[gid];
  const rxGp = txGroups[gid + '-rx'];
  const pktsEl = document.getElementById(`rxpkts-${gid}`);

  if (pktsEl && !rxGp.pkts[index]) {
    const chip = document.createElement('div');
    chip.className = `pkt state-${msg.dropped ? 'dropped' : 'acked'}${isTcp ? '' : ' udp-frag'}`;
    chip.innerHTML = `
      <div class="pkt-header-bar">${isTcp ? `SEG ${index + 1}` : `FRAG ${index + 1}`}</div>
      <div class="pkt-body">
        <div class="pkt-index">${index + 1}/${total}</div>
        <div class="pkt-size">${(msg.data || '').length} B</div>
        <div class="pkt-status-icon">${msg.dropped ? '❌' : '✅'}</div>
      </div>`;
    pktsEl.appendChild(chip);
    rxGp.pkts[index] = chip;

    if (msg.dropped) {
      rxGp.failCount++;
      const el = document.getElementById(`rxfail-${gid}`);
      if (el) el.textContent = `${rxGp.failCount} ✗`;
    } else {
      rxGp.okCount++;
      const el = document.getElementById(`rxok-${gid}`);
      if (el) el.textContent = `${rxGp.okCount} ✓`;
      rg.data[index] = msg.data;
    }
  }

  // Check if all received
  if (Object.keys(rxGp.pkts).length >= total) {
    const fullMsg = rg.data.join('');
    if (fullMsg) {
      addChatBubble(fullMsg, 'them', protoName);
    }
  }
}

// ─── Flying packet animation ──────────────────────────────────────────────────
function spawnFlyingPacket(originEl, state, protoName) {
  const rect = originEl.getBoundingClientRect();
  const fly  = document.createElement('div');
  fly.className = `pkt-flying${protoName === 'udp' ? ' udp' : ''}`;
  fly.textContent = protoName === 'tcp' ? '📦' : '📬';
  fly.style.left = rect.left + rect.width / 2 - 25 + 'px';
  fly.style.top  = rect.top  + rect.height / 2 - 20 + 'px';
  document.body.appendChild(fly);
  setTimeout(() => fly.remove(), 750);
}

// ─── Packet detail modal ──────────────────────────────────────────────────────
function showPktDetail(index, chip, item, isTcp) {
  if (!item) return;
  const state = chip.className.match(/state-(\w+)/)?.[1] || 'unknown';
  const stateLabels = { pending:'Menunggu ACK', acked:'ACK diterima ✓', dropped:'Dijatuhkan ✗', timeout:'Timeout ⚠️', unknown:'?' };

  elModalTitle.textContent = isTcp ? `Segmen TCP #${index + 1}` : `Fragmen UDP/IP #${index + 1}`;

  const headerDiagram = isTcp
    ? `<div class="header-diagram">
        <div class="hd-field ip-hdr"><div class="hd-name">IP Header</div><div class="hd-val">20 B</div></div>
        <div class="hd-field tcp-hdr"><div class="hd-name">TCP Header</div><div class="hd-val">20 B</div></div>
        <div class="hd-field data-fld"><div class="hd-name">Data (payload)</div><div class="hd-val">${item.size} B</div></div>
       </div>`
    : `<div class="header-diagram">
        <div class="hd-field ip-hdr"><div class="hd-name">IP Header</div><div class="hd-val">20 B</div></div>
        <div class="hd-field udp-hdr"><div class="hd-name">UDP Header</div><div class="hd-val">8 B</div></div>
        <div class="hd-field data-fld"><div class="hd-name">Data (payload)</div><div class="hd-val">${item.size} B</div></div>
       </div>`;

  const moreInfo = !isTcp ? `
    <div class="modal-field">
      <label>More Fragments Flag</label>
      <div class="val">${item.moreFragments ? '1 (masih ada fragmen berikutnya)' : '0 (fragmen terakhir)'}</div>
    </div>
    <div class="modal-field">
      <label>Fragment Offset</label>
      <div class="val">${item.fragmentOffset ?? 0} bytes</div>
    </div>` : '';

  elModalBody.innerHTML = `
    <div class="modal-field">
      <label>Status</label>
      <div class="val">${stateLabels[state]}</div>
    </div>
    <div class="modal-field">
      <label>Ukuran payload</label>
      <div class="val">${item.size} bytes</div>
    </div>
    <div class="modal-field">
      <label>Ukuran total (incl. headers)</label>
      <div class="val">${item.size + (isTcp ? 40 : 28)} bytes</div>
    </div>
    <div class="modal-field">
      <label>Struktur paket (diagram header)</label>
      ${headerDiagram}
    </div>
    ${moreInfo}
    <div class="modal-field">
      <label>Konten data (payload)</label>
      <div class="val">${escHtml(item.data || '(kosong)')}</div>
    </div>
    <div class="modal-field">
      <label>Penjelasan</label>
      <div class="val" style="color:var(--text2); font-size:12px;">${isTcp
        ? `TCP memecah data menjadi <b>segmen</b> berukuran ≤ MSS (1460 byte). Setiap segmen dibungkus header TCP (seq/ack number, flags) lalu header IP, total overhead = 40 byte.`
        : `UDP tidak melakukan segmentasi. Data yang melebihi MTU akan difragmentasi oleh <b>IP Layer</b>. Header UDP hanya 8 byte (Src Port, Dst Port, Length, Checksum). Jika satu fragmen hilang, seluruh datagram tidak dapat direkonstruksi.`
      }</div>
    </div>`;

  elModalOverlay.classList.remove('hidden');
}

elModalClose.addEventListener('click',  () => elModalOverlay.classList.add('hidden'));
elModalOverlay.addEventListener('click', (e) => { if (e.target === elModalOverlay) elModalOverlay.classList.add('hidden'); });

// ─── Chat UI ──────────────────────────────────────────────────────────────────
function addChatBubble(text, side, protoName, stats) {
  const el = document.createElement('div');
  el.className = `chat-bubble ${side}${protoName === 'udp' ? ' udp' : ''}`;
  const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  let meta = `<span>${time}</span> <span class="badge ${protoName}">${protoName.toUpperCase()}</span>`;
  if (stats) {
    meta += ` <span style="color:var(--green)">${stats.success}/${stats.total} ✓</span>`;
    if (stats.failed > 0) meta += ` <span style="color:var(--red)">${stats.failed} ✗</span>`;
  }
  el.innerHTML = `${escHtml(text)}<div class="bubble-meta">${meta}</div>`;
  elChatMessages.appendChild(el);
  elChatMessages.scrollTop = elChatMessages.scrollHeight;
}

function addSysMsg(text, level) {
  const el = document.createElement('div');
  el.className = 'chat-system';
  const colors = { error: 'var(--red)', warn: 'var(--yellow)', success: 'var(--green)' };
  if (colors[level]) el.style.color = colors[level];
  el.innerHTML = escHtml(text);
  elChatMessages.appendChild(el);
  elChatMessages.scrollTop = elChatMessages.scrollHeight;
}

// ─── Wire animation ───────────────────────────────────────────────────────────
function startWireAnim(p) {
  elWire.className = `wire-flow active-${p}`;
  elTopoBadge.textContent = p.toUpperCase();
  elTopoBadge.style.color = p === 'tcp' ? 'var(--tcp)' : 'var(--udp)';
  elTopoBadge.style.borderColor = p === 'tcp' ? 'var(--tcp)' : 'var(--udp)';
}
function stopWireAnim() {
  elWire.className = 'wire-flow';
  elTopoBadge.style.color = '';
  elTopoBadge.style.borderColor = '';
}

// ─── Send message ─────────────────────────────────────────────────────────────
function sendMessage() {
  const text = elChatInput.value.trim();
  if (!text) return;

  targetIp = elTargetIp.value.trim();
  if (!targetIp) {
    alert('Masukkan IP tujuan terlebih dahulu!');
    elTargetIp.focus();
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    addSysMsg('❌ Tidak terhubung ke server!', 'error');
    return;
  }

  elReceiverIp.textContent = targetIp;
  startWireAnim(proto);

  ws.send(JSON.stringify({
    action:     proto === 'tcp' ? 'send_tcp' : 'send_udp',
    targetIp,
    text,
    lossRate:   lossRate / 100,
  }));

  elChatInput.value = '';
  elChatInput.focus();
}

elBtnSend.addEventListener('click', sendMessage);
elChatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ─── Protocol switch ──────────────────────────────────────────────────────────
function setProto(p) {
  proto = p;
  elBtnTcp.classList.toggle('active', p === 'tcp');
  elBtnUdp.classList.toggle('active', p === 'udp');
  elTcpInfo.classList.toggle('hidden', p !== 'tcp');
  elUdpInfo.classList.toggle('hidden', p !== 'udp');
  elBtnSend.classList.toggle('udp', p === 'udp');
  elProtoLabel.textContent = p.toUpperCase();
  elTopoBadge.textContent = p.toUpperCase();
}

elBtnTcp.addEventListener('click', () => setProto('tcp'));
elBtnUdp.addEventListener('click', () => setProto('udp'));

// ─── Loss rate slider ─────────────────────────────────────────────────────────
elLossRate.addEventListener('input', () => {
  lossRate = +elLossRate.value;
  elLossLabel.textContent = `${lossRate}%`;
  elLossLabel.style.color = lossRate > 0 ? 'var(--red)' : '';
});

// ─── Clear vis panel ──────────────────────────────────────────────────────────
elBtnClear.addEventListener('click', () => {
  elVisBody.innerHTML = '<div class="vis-empty">Belum ada pengiriman. Kirim pesan untuk melihat visualisasi.</div>';
  txGroups = {};
  remoteGroups = {};
  elVisStats.innerHTML = '';
});

// ─── Utility ──────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
connectWS();
setProto('tcp');
