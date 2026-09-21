import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode';
import { execute as adminExecute } from './commands/admin.js';

// 1. Configurazione Server Express per UptimeRobot (24/7)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
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
        auth: state,
        printQRInTerminal: false // Disattiva il terminale per usare l'immagine vera quadrata
    });

    sock.ev.on('creds.update', saveCreds);

    // Gestione della connessione e del QR Code come immagine PNG quadrata
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📌 Generazione dell\'immagine del QR Code in corso...');
            
            // Salva il QR code come vera immagine PNG quadrata nella cartella del progetto
            qrcode.toFile('./qrcode.png', qr, {
                color: {
                    dark: '#000000',  // Punti neri
                    light: '#FFFFFF'  // Sfondo bianco
                },
                width: 300 // Dimensione dell'immagine in pixel (perfettamente quadrata)
            }, (err) => {
                if (err) {
                    console.error('Errore nella generazione del file immagine del QR:', err);
                    return;
                }
                console.log('✅ Immagine "qrcode.png" generata con successo! Aprila per scansionarla.');
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Connessione chiusa. Codice: ${statusCode}. Riconnessione: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot connesso e operativo con successo!');
        }
    });

    // Ascolto degli eventi sui partecipanti (benvenuto automatico gestito direttamente in admin.js)
    sock.ev.on('group-participants.update', async (event) => {
        try {
            if (event.action === 'add') {
                const fakeStubMsg = {
                    key: {
                        remoteJid: event.id,
                        fromMe: false,
                        participant: event.participants[0]
                    },
                    messageStubType: 27,
                    messageStubParameters: event.participants
                };
                await adminExecute(sock, fakeStubMsg, event.id, '', event.participants[0], true);
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

            // Se il messaggio NON è inviato da te, blocca canali, newsletter e bacheche
            if (!m.key.fromMe) {
                if (chatJid.endsWith('@newsletter') || chatJid.includes('@broadcast') || chatJid.includes('@lid')) {
                    return;
                }
            }

            const isGroup = chatJid.endsWith('@g.us');
            const ownerJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : "393534467571@s.whatsapp.net";

            // Assegnazione sicura del mittente
            let sender = m.key.fromMe ? ownerJid : (isGroup ? m.key.participant : chatJid);
            if (!sender) sender = ownerJid;

            const messageText = m.message.conversation || 
                                m.message.extendedTextMessage?.text || 
                                m.message.imageMessage?.caption || '';

            // RISPOSTA AUTOMATICA OFFLINE
            if (!isGroup && global.offlineMode && !m.key.fromMe && chatJid !== sock.user?.id) {
                await sock.sendMessage(chatJid, { 
                    text: "Al momento Alessio non è disponibile. Ti risponderà appena rientra nella chat." 
                }, { quoted: m });
                return; 
            }

            // Controllo Antispam / Cooldown
            if (global.cooldownEnabled && !m.key.fromMe) {
                const now = Date.now();
                const lastMessageTime = userCooldowns.get(sender) || 0;

                if (now - lastMessageTime < COOLDOWN_TIME) {
                    await sock.sendMessage(chatJid, { 
                        text: `⚠️ Piano con i messaggi! Attendi qualche secondo prima di scrivere di nuovo.` 
                    }, { quoted: m });
                    return; 
                }

                userCooldowns.set(sender, now);
            }

            // Esecuzione centralizzata tramite admin.js
            await adminExecute(sock, m, chatJid, messageText, sender, isGroup);
            
        } catch (err) {
            console.error('Errore durante la gestione del messaggio:', err);
        }
    });
}

startBot();
