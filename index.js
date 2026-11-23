const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const express = require('express');
const session = require('express-session');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: 'finari-wa-dashboard-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const PORT = process.env.PORT || 3001;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const AUTH_DIR = process.env.AUTH_DIR || './auth_info_baileys';
const LOG_FILE = path.join(__dirname, 'logs.json');

let sock = null;
let qrCodeString = null;
let isConnected = false;

function loadLogs() {
  try {
    if (fs.existsSync(LOG_FILE)) return fs.readJsonSync(LOG_FILE);
  } catch (e) {}
  return [];
}

function saveLogs() {
  try { fs.writeJsonSync(LOG_FILE, messageLogs); } catch (e) {}
}

let messageLogs = loadLogs();

function getConfig() {
  try {
    return fs.readJsonSync(CONFIG_FILE);
  } catch (e) {
    return {
      dashboard_password: 'FinAri2026',
      webhook_url: '',
      webhook_connect: '',
      webhook_message_status: '',
      webhook_chaining: '',
      gateway_secret: 'WA_Bot_Finari2026',
      auto_read: false,
      silent_read: false,
      inbox: false,
      autoreply_personal: true,
      autoreply_group: false,
      quick_reply: false,
      forward_attachment: false,
      forward_attachment_number: '',
      autodelete_message: false
    };
  }
}

function saveConfig(data) {
  fs.writeJsonSync(CONFIG_FILE, data, { spaces: 2 });
}

function addLog(type, from, message) {
  const log = {
    type,
    from,
    message: message.substring(0, 300),
    time: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
  };
  messageLogs.unshift(log);
  if (messageLogs.length > 100) messageLogs.pop();
  saveLogs();
}

function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

async function startWhatsAppGateway() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state, printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    const config = getConfig();

    if (qr) {
      qrCodeString = qr;
      console.log('[WA Gateway] QR Code baru dihasilkan.');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[WA Gateway] Terputus. Reconnect: ${shouldReconnect}`);
      if (config.webhook_connect) {
        fetch(config.webhook_connect, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'disconnected', time: new Date().toISOString() })
        }).catch(() => {});
      }
      if (shouldReconnect) setTimeout(startWhatsAppGateway, 3000);
    } else if (connection === 'open') {
      isConnected = true;
      qrCodeString = null;
      console.log('✅ [WA Gateway] Terhubung ke WhatsApp!');
      if (config.webhook_connect) {
        fetch(config.webhook_connect, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'connected', time: new Date().toISOString() })
        }).catch(() => {});
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (m.type !== 'notify') return;
      const config = getConfig();

      for (const msg of m.messages) {
        if (msg.key.fromMe && !config.quick_reply) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        const isGroup = remoteJid.endsWith('@g.us');
        if (isGroup && !config.autoreply_group) continue;
        if (!isGroup && !config.autoreply_personal && !msg.key.fromMe) continue;

        const sender = remoteJid;

        if (config.auto_read && !config.silent_read) {
          await sock.readMessages([msg.key]);
        }

        let textMessage = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        let fileUrl = '';

        const imageMessage = msg.message?.imageMessage;
        if (imageMessage) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
              logger: console,
              reuploadRequest: sock.updateMediaMessage
            });
            const mimeType = imageMessage.mimetype || 'image/jpeg';
            fileUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
            if (!textMessage) textMessage = imageMessage.caption || '';

            if (config.forward_attachment && config.forward_attachment_number) {
              let fwNum = config.forward_attachment_number.replace(/[^0-9]/g, '');
              if (fwNum.startsWith('0')) fwNum = '62' + fwNum.slice(1);
              await sock.sendMessage(`${fwNum}@s.whatsapp.net`, { image: buffer, caption: textMessage || '' });
            }
          } catch (err) {
            console.error('[WA Gateway] Gagal download media:', err);
          }
        }

        // Ambil senderPn dari lidMapping jika tersedia
        let senderPn = msg.key.senderPn || msg.key.participantPn || '';
        if (!senderPn && sender?.endsWith('@lid') && sock.signalRepository?.lidMapping?.getPNForLID) {
          try { senderPn = await sock.signalRepository.lidMapping.getPNForLID(sender); } catch {}
        }

        const pushName = msg.pushName || '';
        const messageId = msg.key.id || '';

        console.log(`[WA Gateway] Pesan dari: ${sender} | senderPn: ${senderPn} | pushName: ${pushName}`);

        if (config.inbox) {
          addLog('inbound', senderPn || sender, textMessage || '[gambar]');
        }

        if (config.webhook_url) {
          fetch(config.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender, senderPn, pushName, messageId, message: textMessage, url: fileUrl })
          }).catch(err => console.error('[WA Gateway] Webhook error:', err.message));
        }

        if (config.webhook_chaining) {
          fetch(config.webhook_chaining, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender, senderPn, pushName, messageId, message: textMessage, url: fileUrl, source: 'chaining' })
          }).catch(() => {});
        }

        if (config.autodelete_message) {
          setTimeout(async () => {
            try {
              await sock.chatModify({ delete: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] }, remoteJid);
            } catch (e) {}
          }, 5000);
        }
      }
    } catch (err) {
      console.error('[WA Gateway] Error upsert:', err);
    }
  });

  sock.ev.on('message-receipt.update', async (updates) => {
    const config = getConfig();
    if (!config.webhook_message_status) return;
    for (const update of updates) {
      fetch(config.webhook_message_status, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: update.key.id, to: update.key.remoteJid, status: update.receipt.type, time: new Date().toISOString() })
      }).catch(() => {});
    }
  });
}

// =================== HTML TEMPLATE ===================

function getLayout(title, content, activePage = '') {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — WA Gateway</title>
  <style>
    :root {
      --bg: #0f1117; --surface: #16181f; --surface2: #1c1f28;
      --border: #2a2d3a; --border-hover: #3d4155;
      --text: #e8eaf0; --text-muted: #6b7280; --text-dim: #9ca3af;
      --green: #22c55e; --green-dim: #16a34a; --green-bg: rgba(34,197,94,0.08);
      --red: #ef4444; --red-bg: rgba(239,68,68,0.08);
      --blue: #3b82f6; --blue-bg: rgba(59,130,246,0.08);
      --yellow: #f59e0b; --radius: 10px; --radius-sm: 6px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; }
    a { text-decoration: none; color: inherit; }
    .sidebar { position: fixed; top: 0; left: 0; width: 220px; height: 100vh; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; z-index: 100; }
    .sidebar-brand { padding: 20px; border-bottom: 1px solid var(--border); }
    .sidebar-brand .logo { display: flex; align-items: center; gap: 10px; }
    .sidebar-brand .logo-icon { width: 32px; height: 32px; background: var(--green-bg); border: 1px solid var(--green); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 16px; }
    .sidebar-brand .logo-text { font-size: 15px; font-weight: 600; }
    .sidebar-brand .logo-sub { font-size: 11px; color: var(--text-muted); margin-top: 1px; }
    .sidebar-nav { flex: 1; padding: 12px 0; overflow-y: auto; }
    .nav-section { padding: 0 12px; margin-bottom: 4px; }
    .nav-label { font-size: 10px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; padding: 8px 8px 4px; }
    .nav-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-sm); color: var(--text-dim); font-size: 13px; transition: all .15s; margin-bottom: 2px; }
    .nav-item:hover { background: var(--surface2); color: var(--text); }
    .nav-item.active { background: var(--green-bg); color: var(--green); border: 1px solid rgba(34,197,94,0.2); }
    .nav-item .nav-icon { font-size: 15px; width: 18px; text-align: center; }
    .sidebar-footer { padding: 12px; border-top: 1px solid var(--border); }
    .sidebar-footer a { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius-sm); color: var(--text-muted); font-size: 13px; transition: all .15s; }
    .sidebar-footer a:hover { background: var(--red-bg); color: var(--red); }
    .main { margin-left: 220px; min-height: 100vh; }
    .topbar { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--surface); position: sticky; top: 0; z-index: 50; }
    .topbar-title { font-size: 15px; font-weight: 600; }
    .status-pill { display: flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 500; }
    .status-pill.connected { background: var(--green-bg); color: var(--green); border: 1px solid rgba(34,197,94,0.3); }
    .status-pill.disconnected { background: var(--red-bg); color: var(--red); border: 1px solid rgba(239,68,68,0.3); }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .status-dot.pulse { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .content { padding: 24px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
    .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .card-title { font-size: 13px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
    .gap-16 { display: flex; flex-direction: column; gap: 16px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
    .stat-label { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
    .stat-value { font-size: 22px; font-weight: 700; }
    .stat-value.green { color: var(--green); }
    .stat-value.red { color: var(--red); }
    .stat-value.blue { color: var(--blue); }
    .form-group { margin-bottom: 14px; }
    .form-group:last-child { margin-bottom: 0; }
    label.field-label { display: block; font-size: 12px; font-weight: 500; color: var(--text-dim); margin-bottom: 6px; }
    input[type=text], input[type=password], input[type=url], input[type=tel] { width: 100%; padding: 9px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 13px; transition: border-color .15s; }
    input:focus { outline: none; border-color: var(--green); }
    input::placeholder { color: var(--text-muted); }
    .input-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: var(--radius-sm); border: none; font-size: 13px; font-weight: 500; cursor: pointer; transition: all .15s; }
    .btn-primary { background: var(--green); color: #000; }
    .btn-primary:hover { background: var(--green-dim); }
    .btn-danger { background: var(--red-bg); color: var(--red); border: 1px solid rgba(239,68,68,0.3); }
    .btn-danger:hover { background: var(--red); color: #fff; }
    .btn-secondary { background: var(--surface2); color: var(--text-dim); border: 1px solid var(--border); }
    .btn-secondary:hover { border-color: var(--border-hover); color: var(--text); }
    .btn-full { width: 100%; justify-content: center; padding: 10px; }
    .toggle-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); transition: all .15s; cursor: pointer; }
    .toggle-row:hover { border-color: var(--border-hover); }
    .toggle-row.on { border-color: rgba(34,197,94,0.3); background: var(--green-bg); }
    .toggle-info { flex: 1; }
    .toggle-name { font-size: 13px; font-weight: 500; color: var(--text); }
    .toggle-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .switch { position: relative; display: inline-block; width: 42px; height: 24px; flex-shrink: 0; margin-top: 1px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; inset: 0; background: var(--border); border-radius: 24px; transition: .25s; }
    .slider:before { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: .25s; }
    input:checked + .slider { background: var(--green); }
    input:checked + .slider:before { transform: translateX(18px); }
    .qr-container { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 24px; }
    .qr-box { background: #fff; padding: 12px; border-radius: var(--radius); display: inline-block; }
    .qr-box img { display: block; width: 200px; height: 200px; }
    .qr-steps { text-align: center; }
    .qr-steps p { font-size: 13px; color: var(--text-dim); }
    .qr-steps .step { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: var(--surface2); border-radius: 999px; font-size: 12px; color: var(--text-muted); margin: 4px 2px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 10px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
    td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--surface2); }
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; }
    .badge-in { background: var(--blue-bg); color: var(--blue); }
    .badge-out { background: var(--green-bg); color: var(--green); }
    .alert { padding: 10px 14px; border-radius: var(--radius-sm); font-size: 13px; margin-bottom: 16px; }
    .alert-success { background: var(--green-bg); color: var(--green); border: 1px solid rgba(34,197,94,0.3); }
    .alert-error { background: var(--red-bg); color: var(--red); border: 1px solid rgba(239,68,68,0.3); }
    .connected-card { display: flex; align-items: center; gap: 16px; padding: 20px; background: var(--green-bg); border: 1px solid rgba(34,197,94,0.2); border-radius: var(--radius); }
    .connected-icon { width: 48px; height: 48px; background: rgba(34,197,94,0.15); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; }
    .connected-info h3 { font-size: 15px; font-weight: 600; color: var(--green); }
    .connected-info p { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    @media(max-width: 768px) { .sidebar { transform: translateX(-100%); } .main { margin-left: 0; } .grid-2, .grid-3 { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-brand">
      <div class="logo">
        <div class="logo-icon">📱</div>
        <div>
          <div class="logo-text">WA Gateway</div>
          <div class="logo-sub">FinAri AI System</div>
        </div>
      </div>
    </div>
    <nav class="sidebar-nav">
      <div class="nav-section">
        <div class="nav-label">Menu</div>
        <a href="/" class="nav-item ${activePage === 'dashboard' ? 'active' : ''}"><span class="nav-icon">⊞</span> Dashboard</a>
        <a href="/settings" class="nav-item ${activePage === 'settings' ? 'active' : ''}"><span class="nav-icon">⚙</span> Pengaturan</a>
        <a href="/logs" class="nav-item ${activePage === 'logs' ? 'active' : ''}"><span class="nav-icon">≡</span> Log Pesan</a>
        <a href="/send" class="nav-item ${activePage === 'send' ? 'active' : ''}"><span class="nav-icon">↗</span> Kirim Pesan</a>
      </div>
    </nav>
    <div class="sidebar-footer">
      <a href="/logout"><span>⎋</span> Logout</a>
    </div>
  </div>
  <div class="main">
    <div class="topbar">
      <span class="topbar-title">${title}</span>
      <span class="status-pill ${isConnected ? 'connected' : 'disconnected'}">
        <span class="status-dot ${isConnected ? 'pulse' : ''}"></span>
        ${isConnected ? 'Terhubung' : 'Tidak Terhubung'}
      </span>
    </div>
    <div class="content">${content}</div>
  </div>
</body>
</html>`;
}

// =================== ROUTES ===================

app.get('/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — WA Gateway</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f1117; display: flex; justify-content: center; align-items: center; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrap { width: 100%; max-width: 360px; padding: 24px; }
    .brand { text-align: center; margin-bottom: 32px; }
    .brand-icon { width: 52px; height: 52px; background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.3); border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; margin: 0 auto 12px; }
    .brand h1 { font-size: 20px; font-weight: 700; color: #e8eaf0; }
    .brand p { font-size: 13px; color: #6b7280; margin-top: 4px; }
    .card { background: #16181f; border: 1px solid #2a2d3a; border-radius: 12px; padding: 24px; }
    .error { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; }
    label { display: block; font-size: 12px; font-weight: 500; color: #9ca3af; margin-bottom: 6px; }
    input { width: 100%; padding: 10px 12px; background: #0f1117; border: 1px solid #2a2d3a; border-radius: 6px; color: #e8eaf0; font-size: 14px; transition: border-color .15s; margin-bottom: 16px; }
    input:focus { outline: none; border-color: #22c55e; }
    button { width: 100%; padding: 10px; background: #22c55e; color: #000; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #16a34a; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="brand-icon">📱</div>
      <h1>WA Gateway</h1>
      <p>FinAri AI System</p>
    </div>
    <div class="card">
      ${req.query.error ? '<div class="error">Password salah, silakan coba lagi.</div>' : ''}
      <form method="POST" action="/login">
        <label>Password</label>
        <input type="password" name="password" placeholder="Masukkan password" autofocus />
        <button type="submit">Masuk</button>
      </form>
    </div>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const config = getConfig();
  if (req.body.password === config.dashboard_password) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/', requireLogin, async (req, res) => {
  const inbound = messageLogs.filter(l => l.type === 'inbound').length;
  const outbound = messageLogs.filter(l => l.type === 'outbound').length;
  let qrImage = '';
  if (qrCodeString) qrImage = await QRCode.toDataURL(qrCodeString);

  const content = `
    <div class="gap-16">
      <div class="grid-3">
        <div class="stat-card"><div class="stat-label">Status</div><div class="stat-value ${isConnected ? 'green' : 'red'}">${isConnected ? 'Online' : 'Offline'}</div></div>
        <div class="stat-card"><div class="stat-label">Pesan Masuk</div><div class="stat-value blue">${inbound}</div></div>
        <div class="stat-card"><div class="stat-label">Pesan Keluar</div><div class="stat-value green">${outbound}</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">Koneksi WhatsApp</span>
          ${isConnected ? '<a href="/disconnect"><button class="btn btn-danger">Disconnect</button></a>' : ''}
        </div>
        ${isConnected ? `
          <div class="connected-card">
            <div class="connected-icon">✓</div>
            <div class="connected-info"><h3>WhatsApp Terhubung</h3><p>Bot aktif dan siap menerima serta mengirim pesan.</p></div>
          </div>
        ` : qrImage ? `
          <div class="qr-container">
            <div class="qr-box"><img src="${qrImage}" /></div>
            <div class="qr-steps">
              <p style="font-weight:600;margin-bottom:8px">Scan QR Code dengan WhatsApp</p>
              <div>
                <span class="step">1. Buka WhatsApp</span>
                <span class="step">2. Perangkat Tertaut</span>
                <span class="step">3. Tautkan Perangkat</span>
                <span class="step">4. Scan QR</span>
              </div>
              <p style="margin-top:12px;color:#f59e0b;font-size:12px">QR akan expired dalam ~60 detik</p>
            </div>
          </div>
          <script>setTimeout(() => location.reload(), 30000);</script>
        ` : `
          <div style="text-align:center;padding:32px;color:#6b7280">
            <p>Memuat QR Code...</p>
            <script>setTimeout(() => location.reload(), 4000);</script>
          </div>
        `}
      </div>
      <div class="card">
        <div class="card-header">
          <span class="card-title">Log Terbaru</span>
          <a href="/logs"><button class="btn btn-secondary">Lihat Semua</button></a>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Tipe</th><th>Nomor</th><th>Pesan</th><th>Waktu</th></tr></thead>
            <tbody>
              ${messageLogs.slice(0, 5).map(l => `
                <tr>
                  <td><span class="badge ${l.type === 'inbound' ? 'badge-in' : 'badge-out'}">${l.type === 'inbound' ? '↙ Masuk' : '↗ Keluar'}</span></td>
                  <td style="color:#9ca3af;font-family:monospace">${l.from}</td>
                  <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.message}</td>
                  <td style="color:#6b7280;font-size:12px;white-space:nowrap">${l.time}</td>
                </tr>
              `).join('') || '<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:24px">Belum ada log pesan</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  res.send(getLayout('Dashboard', content, 'dashboard'));
});

app.get('/settings', requireLogin, (req, res) => {
  const config = getConfig();
  const toggle = (name, label, desc) => `
    <label style="display:block;cursor:pointer">
      <div class="toggle-row ${config[name] ? 'on' : ''}" id="row-${name}">
        <div class="toggle-info">
          <div class="toggle-name">${label}</div>
          <div class="toggle-desc">${desc}</div>
        </div>
        <label class="switch">
          <input type="checkbox" name="${name}" ${config[name] ? 'checked' : ''} onchange="syncRow(this)">
          <span class="slider"></span>
        </label>
      </div>
    </label>`;

  const content = `
    <script>function syncRow(el) { document.getElementById('row-' + el.name).classList.toggle('on', el.checked); }</script>
    ${req.query.saved ? '<div class="alert alert-success">✓ Pengaturan berhasil disimpan.</div>' : ''}
    <form method="POST" action="/save-config">
      <div class="gap-16">
        <div class="card">
          <div class="card-header"><span class="card-title">Webhook</span></div>
          <div class="gap-16">
            <div class="form-group">
              <label class="field-label">Webhook URL — Pesan Masuk</label>
              <input type="url" name="webhook_url" value="${config.webhook_url}" placeholder="https://domain.com/api/whatsapp/webhook" />
              <p class="input-hint">Setiap pesan masuk akan dikirim ke URL ini via POST.</p>
            </div>
            <div class="form-group">
              <label class="field-label">Webhook Connect</label>
              <input type="url" name="webhook_connect" value="${config.webhook_connect}" placeholder="https://domain.com/api/whatsapp/connect" />
              <p class="input-hint">Notifikasi saat bot connect atau disconnect.</p>
            </div>
            <div class="form-group">
              <label class="field-label">Webhook Message Status</label>
              <input type="url" name="webhook_message_status" value="${config.webhook_message_status}" placeholder="https://domain.com/api/whatsapp/status" />
              <p class="input-hint">Notifikasi status pengiriman pesan.</p>
            </div>
            <div class="form-group">
              <label class="field-label">Webhook Chaining</label>
              <input type="url" name="webhook_chaining" value="${config.webhook_chaining}" placeholder="https://domain.com/api/whatsapp/chaining" />
              <p class="input-hint">Teruskan pesan ke bot atau sistem lain.</p>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Perilaku Bot</span></div>
          <div class="grid-2">
            ${toggle('auto_read', 'Auto Read', 'Otomatis tandai pesan sebagai sudah dibaca')}
            ${toggle('silent_read', 'Silent Read', 'Baca pesan tanpa menandai sudah dibaca')}
            ${toggle('inbox', 'Inbox', 'Simpan pesan masuk di log dashboard')}
            ${toggle('quick_reply', 'Quick Reply', 'Balas pesan dari nomor sendiri')}
            ${toggle('autoreply_personal', 'Autoreply Personal', 'Aktifkan autoreply untuk chat personal')}
            ${toggle('autoreply_group', 'Autoreply Group', 'Aktifkan autoreply untuk grup')}
            ${toggle('forward_attachment', 'Forward Attachment', 'Teruskan file/gambar ke nomor tertentu')}
            ${toggle('autodelete_message', 'Autodelete Message', 'Hapus riwayat pesan setelah diproses')}
          </div>
          <div class="form-group" style="margin-top:16px">
            <label class="field-label">Nomor Tujuan Forward Attachment</label>
            <input type="tel" name="forward_attachment_number" value="${config.forward_attachment_number}" placeholder="628123456789" />
            <p class="input-hint">Aktif hanya jika Forward Attachment diaktifkan.</p>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><span class="card-title">Keamanan</span></div>
          <div class="grid-2">
            <div class="form-group">
              <label class="field-label">Gateway Secret Token</label>
              <input type="text" name="gateway_secret" value="${config.gateway_secret}" placeholder="Token rahasia" />
              <p class="input-hint">Token untuk autentikasi request dari FinAri.</p>
            </div>
            <div class="form-group">
              <label class="field-label">Password Dashboard</label>
              <input type="password" name="dashboard_password" placeholder="Kosongkan jika tidak ingin mengubah" />
              <p class="input-hint">Kosongkan jika tidak ingin mengganti password.</p>
            </div>
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-full">Simpan Pengaturan</button>
      </div>
    </form>`;
  res.send(getLayout('Pengaturan', content, 'settings'));
});

app.post('/save-config', requireLogin, (req, res) => {
  const config = getConfig();
  config.webhook_url = req.body.webhook_url || '';
  config.webhook_connect = req.body.webhook_connect || '';
  config.webhook_message_status = req.body.webhook_message_status || '';
  config.webhook_chaining = req.body.webhook_chaining || '';
  config.gateway_secret = req.body.gateway_secret || config.gateway_secret;
  if (req.body.dashboard_password) config.dashboard_password = req.body.dashboard_password;
  config.auto_read = req.body.auto_read === 'on';
  config.silent_read = req.body.silent_read === 'on';
  config.inbox = req.body.inbox === 'on';
  config.autoreply_personal = req.body.autoreply_personal === 'on';
  config.autoreply_group = req.body.autoreply_group === 'on';
  config.quick_reply = req.body.quick_reply === 'on';
  config.forward_attachment = req.body.forward_attachment === 'on';
  config.forward_attachment_number = req.body.forward_attachment_number || '';
  config.autodelete_message = req.body.autodelete_message === 'on';
  saveConfig(config);
  res.redirect('/settings?saved=1');
});

app.get('/logs', requireLogin, (req, res) => {
  const content = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Log Pesan (${messageLogs.length} entri)</span>
        <a href="/clear-logs"><button class="btn btn-danger">Hapus Semua</button></a>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Tipe</th><th>Nomor</th><th>Pesan</th><th>Waktu</th></tr></thead>
          <tbody>
            ${messageLogs.map(l => `
              <tr>
                <td><span class="badge ${l.type === 'inbound' ? 'badge-in' : 'badge-out'}">${l.type === 'inbound' ? '↙ Masuk' : '↗ Keluar'}</span></td>
                <td style="color:#9ca3af;font-family:monospace">${l.from}</td>
                <td style="max-width:400px">${l.message}</td>
                <td style="color:#6b7280;font-size:12px;white-space:nowrap">${l.time}</td>
              </tr>
            `).join('') || '<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:32px">Belum ada log pesan</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
  res.send(getLayout('Log Pesan', content, 'logs'));
});

app.get('/clear-logs', requireLogin, (req, res) => { messageLogs = []; saveLogs(); res.redirect('/logs'); });

app.get('/send', requireLogin, (req, res) => {
  const content = `
    ${req.query.sent ? '<div class="alert alert-success">✓ Pesan berhasil dikirim.</div>' : ''}
    ${req.query.error ? '<div class="alert alert-error">✗ Gagal mengirim pesan. Pastikan bot terhubung.</div>' : ''}
    <div class="card" style="max-width:560px">
      <div class="card-header"><span class="card-title">Kirim Pesan Manual</span></div>
      <form method="POST" action="/send-manual">
        <div class="form-group">
          <label class="field-label">Nomor WhatsApp Tujuan</label>
          <input type="tel" name="number" placeholder="628123456789" required />
          <p class="input-hint">Format: 628xxx (awali dengan 62, bukan 0)</p>
        </div>
        <div class="form-group">
          <label class="field-label">Pesan</label>
          <input type="text" name="message" placeholder="Ketik pesan..." required />
        </div>
        <button type="submit" class="btn btn-primary btn-full" style="margin-top:4px">Kirim Pesan</button>
      </form>
    </div>`;
  res.send(getLayout('Kirim Pesan', content, 'send'));
});

app.post('/send-manual', requireLogin, async (req, res) => {
  if (!isConnected || !sock) return res.redirect('/send?error=1');
  try {
    let num = req.body.number.replace(/[^0-9]/g, '');
    if (num.startsWith('0')) num = '62' + num.slice(1);
    await sock.sendMessage(`${num}@s.whatsapp.net`, { text: req.body.message });
    addLog('outbound', num, req.body.message);
    res.redirect('/send?sent=1');
  } catch (err) { res.redirect('/send?error=1'); }
});

app.get('/disconnect', requireLogin, async (req, res) => {
  try { await sock?.logout(); } catch (e) {}
  isConnected = false;
  qrCodeString = null;
  const authPath = path.join(__dirname, AUTH_DIR);
  await fs.remove(authPath);
  setTimeout(startWhatsAppGateway, 2000);
  res.redirect('/');
});

// API ENDPOINT — SEND DARI FINARI
app.post('/send', async (req, res) => {
  try {
    const config = getConfig();
    const authHeader = req.headers.authorization;
    if (config.gateway_secret && authHeader !== config.gateway_secret) {
      return res.status(401).json({ status: false, reason: 'Unauthorized' });
    }
    const target = req.body.target || req.body.number || req.body.to;
    const message = req.body.message || req.body.text;
    if (!target || !message) return res.status(400).json({ status: false, reason: 'Target dan message wajib diisi' });
    if (!isConnected || !sock) return res.status(503).json({ status: false, reason: 'WA Gateway Offline' });

    let jid = target;
    if (!jid.includes('@')) {
      let cleanNum = jid.replace(/[^0-9]/g, '');
      if (cleanNum.startsWith('0')) cleanNum = '62' + cleanNum.slice(1);
      jid = `${cleanNum}@s.whatsapp.net`;
    }

    console.log(`[WA Gateway] Sending to JID: ${jid}`);
    await sock.sendMessage(jid, { text: message });
    addLog('outbound', jid.split('@')[0], message);

    let lid = null;
    if (!jid.endsWith('@lid') && sock.signalRepository?.lidMapping?.getLIDForPN) {
      try { lid = await sock.signalRepository.lidMapping.getLIDForPN(jid); } catch {}
    }

    return res.json({ status: true, message: 'Pesan berhasil dikirim', jid, lid });
  } catch (err) {
    console.error('[WA Gateway Send Error]', err);
    return res.status(500).json({ status: false, reason: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 WA Gateway running on port ${PORT}`);
  startWhatsAppGateway();
});