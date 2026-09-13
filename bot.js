import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { execute as adminExecute } from './commands/admin.js';
import { execute as geminiExecute } from './commands/gemini.js';
import { handleModeration as moderationExecute } from './commands/moderation.js';

// 1. Configurazione Server Express per UptimeRobot (24/7)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/ping', (req, res) => {
    res.status(200).send('Bot attivo e online!');
});

app.listen(PORT, () => {
    console.log(`Server Express in ascolto sulla porta ${PORT}`);
});

const mutedUsers = new Set();
const warnings = new Map();

// Mappa per tracciare il cooldown antispam degli utenti
const userCooldowns = new Map();
const COOLDOWN_TIME = 5000; // Tempo di attesa in millisecondi (5 secondi)

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connessione chiusa. Codice: ${statusCode}. Riconnessione: ${shouldReconnect}`);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('🤖 Bot connesso con successo!');
        }
    });

    // Ascolto degli eventi sui partecipanti (fondamentale per il benvenuto automatico)
    sock.ev.on('group-participants.update', async (event) => {
        try {
            if (event.action === 'add') {
                // Simula la struttura del messaggio stub per integrarsi con moderation.js
                const fakeStubMsg = {
                    key: {
                        remoteJid: event.id,
                        fromMe: false,
                        participant: event.participants[0]
                    },
                    messageStubType: 27,
                    messageStubParameters: event.participants
                };
                await moderationExecute(sock, fakeStubMsg, event.id, '', event.participants[0], true, mutedUsers, warnings);
            }
        } catch (err) {
            console.error('Errore nella gestione dei partecipanti:', err);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m || !m.message) return;

            const chatJid = m.key.remoteJid;
            if (!chatJid) return;

            const isGroup = chatJid.endsWith('@g.us');

            // Gestione pulita e centralizzata del mittente (gestisce anche i messaggi inviati da te)
            let sender = isGroup ? m.key.participant : chatJid;
            
            if (m.key.fromMe) {
                sender = "393534467571@s.whatsapp.net"; // Ti riconosce come proprietario ovunque scrivi
            } else if (!sender) {
                sender = "393534467571@s.whatsapp.net";
            }

            const messageText = m.message.conversation || 
                                m.message.extendedTextMessage?.text || 
                                m.message.imageMessage?.caption || '';

            // Gestione Modalità Offline in chat privata (esclude te stesso)
            if (!isGroup && global.offlineMode && !m.key.fromMe && sender !== global.botOwner) {
                await sock.sendMessage(chatJid, { 
                    text: "Al momento Alessio non è disponibile. Ti risponderà appena possibile." 
                }, { quoted: m });
                return; // Blocca gli altri comandi se sei offline in privato
            }

            // Controllo Antispam / Cooldown (esclude te stesso)
            if (global.cooldownEnabled && !m.key.fromMe) {
                const now = Date.now();
                const lastMessageTime = userCooldowns.get(sender) || 0;

                if (now - lastMessageTime < COOLDOWN_TIME) {
                    await sock.sendMessage(chatJid, { 
                        text: `⚠️ Piano con i messaggi! Attendi qualche secondo prima di scrivere di nuovo.` 
                    }, { quoted: m });
                    return; // Blocca l'esecuzione dei comandi successivi se l'utente spamma
                }

                userCooldowns.set(sender, now);
            }

            await moderationExecute(sock, m, chatJid, messageText, sender, isGroup, mutedUsers, warnings);
            await adminExecute(sock, m, chatJid, messageText, sender, isGroup, mutedUsers, warnings);
            await geminiExecute(sock, m, chatJid, messageText, sender, isGroup, mutedUsers, warnings);
        } catch (err) {
            console.error('Errore durante la gestione del messaggio:', err);
        }
    });
}

startBot();