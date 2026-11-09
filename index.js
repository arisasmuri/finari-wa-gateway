const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')
const express = require('express')

const app = express()
app.use(express.json())

let sock

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  sock = makeWASocket({ auth: state, printQRInTerminal: false })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      console.log('Scan QR code ini dengan WhatsApp kamu:')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp terhubung!')
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) connectToWhatsApp()
    }
  })
}

// Endpoint untuk kirim pesan dari web kamu
app.post('/send-message', async (req, res) => {
  const { number, message } = req.body
  try {
    const jid = number + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true, message: 'Pesan terkirim!' })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

app.get('/', (req, res) => res.send('WA Bot aktif!'))

connectToWhatsApp()
app.listen(3001, () => console.log('Server bot berjalan di port 3001'))