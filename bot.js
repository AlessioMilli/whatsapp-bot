import express from 'express';
import fs from 'fs';
import path from 'path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import { execute as adminExecute } from './commands/admin.js';

// --- GESTIONE LETTURA CONFIG.JSON ---
const configPath = path.resolve('config.json');

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const rawData = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(rawData);
        }
    } catch (e) {
        console.error("Errore nella lettura del file config.json:", e);
    }
    return {};
}

// Carichiamo la configurazione all'avvio e la rendiamo globale
const savedConfig = loadConfig();
global.geminiApiKey = savedConfig.geminiApiKey || "";

// --- LISTA DI SICUREZZA DEI 14 GRUPPI BLOCCATI ---
const HARDCODED_DISABLED_GROUPS = [
    "120363426442572433@g.us",
    "120363410848657411@g.us",
    "120363413621287894@g.us",
    "120363412255572937@g.us",
    "120363410702791250@g.us",
    "120363428389061514@g.us",
    "120363431216750217@g.us",
    "120363411054241675@g.us",
    "120363427130136369@g.us",
    "120363411329771761@g.us",
    "120363332649453382@g.us",
    "120363407897822981@g.us",
    "120363412117305069@g.us",
    "120363428799360923@g.us"
];

// Funzione di verifica per controllare se un gruppo è bloccato
function isGroupDisabled(chatJid) {
    if (!chatJid) return false;
    
    // Controlla nella lista di sicurezza interna
    if (HARDCODED_DISABLED_GROUPS.includes(chatJid)) {
        return true;
    }

    // Controlla nel file config.json aggiornato
    try {
        const currentConfig = loadConfig();
        if (currentConfig.disabledGroups && Array.isArray(currentConfig.disabledGroups)) {
            return currentConfig.disabledGroups.includes(chatJid);
        }
    } catch (e) {
        console.error("Errore nel controllo dei gruppi disattivati:", e);
    }
    
    return false;
}

// 1. Configurazione Server Express per UptimeRobot e Pagina QR
const app = express();
const PORT = process.env.PORT || 10000;

// Variabile globale per memorizzare l'ultimo QR code attivo
let latestQR = "";

app.get('/', (req, res) => {
    res.status(200).send('Bot attivo e online!');
});

// Pagina web dedicata per scansionare il QR Code comodamente
app.get('/qr', async (req, res) => {
    if (!latestQR) {
        return res.send(`
            <html>
                <body style="font-family: Arial; text-align: center; margin-top: 50px; background: #121212; color: white;">
                    <h2>⏳ Nessun QR Code generato al momento o bot già connesso!</h2>
                    <p>Ricarica la pagina tra qualche secondo o riavvia il servizio se necessario.</p>
                </body>
            </html>
        `);
    }

    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`
            <html>
                <head>
                    <title>QR Code WhatsApp Bot</title>
                    <meta http-equiv="refresh" content="20">
                </head>
                <body style="font-family: Arial; text-align: center; margin-top: 40px; background: #121212; color: white;">
                    <h2>📱 Scansiona questo QR Code con WhatsApp</h2>
                    <p>Vai su <b>Impostazioni > Dispositivi collegati > Collega un dispositivo</b></p>
                    <div style="margin: 20px; background: white; display: inline-block; padding: 20px; border-radius: 10px;">
                        <img src="${qrImage}" alt="QR Code WhatsApp" style="width: 300px; height: 300px;" />
                    </div>
                    <p style="font-size: 12px; color: gray;">La pagina si aggiorna automaticamente per sicurezza.</p>
                </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send("Errore nella generazione grafica del QR code.");
    }
});

app.listen(PORT, () => {
    console.log(`Server Express in ascolto sulla porta ${PORT}`);
});

const userCooldowns = new Map();
const COOLDOWN_TIME = 5000;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Gestione della connessione e del QR Code tramite link web
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
            console.log(`\n========================================`);
            console.log(`🔗 APRI QUESTO LINK PER IL QR CODE:`);
            console.log(`${appUrl}/qr`);
            console.log(`========================================\n`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Connessione chiusa. Codice: ${statusCode}. Riconnessione: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot connesso e operativo con successo tramite QR Code!');
            latestQR = ""; // Pulisce il QR code una volta connesso con successo
        }
    });

    // Ascolto degli eventi sui partecipanti (benvenuto automatico bloccato se il gruppo è in lista nera)
    sock.ev.on('group-participants.update', async (event) => {
        try {
            // 🛑 SE IL GRUPPO È BLOCCATO, NON INVIA MAI IL BENVENUTO
            if (isGroupDisabled(event.id)) {
                return;
            }

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

            // 🛑 SE IL GRUPPO È NELLA LISTA DEI BLOCCATI, IGNORA COMPLETAMENTE OGGI E DOPO OGNI RIAVVIO
            if (isGroupDisabled(chatJid)) {
                return; 
            }

            if (!m.key.fromMe) {
                if (chatJid.endsWith('@newsletter') || chatJid.includes('@broadcast') || chatJid.includes('@lid')) {
                    return;
                }
            }

            const isGroup = chatJid.endsWith('@g.us');
            const ownerJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : "393534467571@s.whatsapp.net";

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
