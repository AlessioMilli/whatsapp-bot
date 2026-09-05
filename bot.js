import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';

const OWNER_JID = '393534467571@s.whatsapp.net';
const mutedUsers = new Set();
const warnings = new Map();

let isAwayGlobal = false; 
let specificAwayChat = null; 

global.linksEnabled = false; 
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const awayCooldowns = new Map();
const awayTimers = new Map();
const pausedChats = new Set();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ 
        auth: state, 
        logger: pino({ level: 'silent' }) 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Bot connesso correttamente!');
        }
    });

    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        if (action === 'add') {
            for (let user of participants) {
                let userStr = typeof user === 'string' ? user : (user.id || user);
                await sock.sendMessage(id, { text: `Benvenuto/a @${userStr.split('@')[0]} nel gruppo! Leggi attentamente le regole.`, mentions: [userStr] });
            }
        } else if (action === 'remove') {
            for (let user of participants) {
                let userStr = typeof user === 'string' ? user : (user.id || user);
                await sock.sendMessage(id, { text: `L'utente @${userStr.split('@')[0]} ha lasciato il gruppo o è stato rimosso.`, mentions: [userStr] });
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const chatJid = m.key.remoteJid;
        const messageText = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const sender = m.key.participant || m.key.remoteJid;
        const isGroup = chatJid.endsWith('@g.us');

        if ((messageText === '!offline' || messageText === '!assente') && m.key.fromMe) {
            awayCooldowns.clear();
            pausedChats.clear();
            for (let timer of awayTimers.values()) {
                clearTimeout(timer);
            }
            awayTimers.clear();

            if (chatJid === OWNER_JID || (!isGroup && chatJid === sender)) {
                isAwayGlobal = true;
                specificAwayChat = null;
                await sock.sendMessage(chatJid, { text: "🟢 Modalità offline ATTIVATA in modo globale per tutti." });
            } else if (!isGroup) {
                isAwayGlobal = false;
                specificAwayChat = chatJid;
                await sock.sendMessage(chatJid, { text: `🟢 Modalità offline ATTIVATA solo per questa chat privata.` });
            }
            return;
        }

        if ((messageText === '!online' || messageText === '!presente') && m.key.fromMe) {
            isAwayGlobal = false;
            specificAwayChat = null;
            awayCooldowns.clear();
            pausedChats.clear();
            for (let timer of awayTimers.values()) {
                clearTimeout(timer);
            }
            awayTimers.clear();
            await sock.sendMessage(chatJid, { text: "Alessio è ora disponibile per risponderti, quindi se gli vuoi mandare un messaggio è pronto per risponderti!" });
            return;
        }

        try {
            const adminModule = await import('./commands/admin.js');
            const handled = await adminModule.execute(sock, m, chatJid, messageText, sender, isGroup, mutedUsers, warnings);
            if (handled) return;
        } catch (err) {
            console.log("Errore caricamento modulo comandi:", err);
        }

        if (isGroup && (messageText === '!del' || messageText === '!cancella')) {
            const contextInfo = m.message.extendedTextMessage?.contextInfo;
            if (contextInfo && contextInfo.stanzaId) {
                try {
                    const targetParticipant = contextInfo.participant || contextInfo.remoteJid;
                    const targetMessageKey = {
                        remoteJid: chatJid,
                        id: contextInfo.stanzaId,
                        participant: targetParticipant
                    };
                    await sock.sendMessage(chatJid, { delete: targetMessageKey });
                    
                    const targetUserTag = targetParticipant ? targetParticipant.split('@')[0] : 'utente';
                    await sock.sendMessage(chatJid, { 
                        text: `🗑️ Messaggio di @${targetUserTag} eliminato su richiesta di @${sender.split('@')[0]}`, 
                        mentions: targetParticipant ? [targetParticipant, sender] : [sender] 
                    });
                } catch (e) {
                    console.log("Errore eliminazione manuale tramite comando:", e);
                }
                return;
            }
        }

        try {
            const bestemmiaModule = await import('./commands/cyber_module/bestemmiometro.js');
            if (bestemmiaModule && typeof bestemmiaModule.handleMessage === 'function') {
                await bestemmiaModule.handleMessage(sock, m);
            }
        } catch (err) {}

        if (isGroup && !m.key.fromMe && global.linksEnabled) {
            if (messageText.includes('http://') || messageText.includes('https://') || messageText.includes('chat.whatsapp.com')) {
                try {
                    await sock.sendMessage(chatJid, { delete: { remoteJid: chatJid, fromMe: false, id: m.key.id, participant: sender } });
                    await sock.sendMessage(chatJid, { text: `⚠️ @${sender.split('@')[0]}, i link esterni non sono permessi in questo gruppo!`, mentions: [sender] });
                } catch (e) {
                    console.log("Errore eliminazione link:", e);
                }
                return;
            }
        }

        const isBotMentionedInGroup = isGroup && (
            m.message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(sock.user?.id?.split(':')[0] + '@s.whatsapp.net') ||
            messageText.includes('@' + sock.user?.id?.split(':')[0]) ||
            messageText.includes('@' + OWNER_JID.split('@')[0])
        );

        const shouldTriggerAway = !m.key.fromMe && (
            (isAwayGlobal && (!isGroup || isBotMentionedInGroup)) || 
            (!isGroup && specificAwayChat === chatJid) ||
            (isGroup && specificAwayChat && isBotMentionedInGroup)
        );

        if (shouldTriggerAway) {
            if (pausedChats.has(chatJid)) {
                pausedChats.delete(chatJid);
                awayTimers.delete(chatJid);
            }

            const now = Date.now();
            const lastTime = awayCooldowns.get(chatJid) || 0;

            if (now - lastTime > 10000) {
                awayCooldowns.set(chatJid, now);
                await delay(1500);
                await sock.sendMessage(chatJid, { 
                    text: "Al momento Alessio Milli non è disponibile. Ti risponderà appena possibile non appena rientra nella tua chat." 
                });

                if (!awayTimers.has(chatJid)) {
                    const timer = setTimeout(async () => {
                        pausedChats.add(chatJid);
                        awayTimers.delete(chatJid);
                        try {
                            await sock.sendMessage(chatJid, { text: "Sono passati 10 minuti. Il sistema automatico si è bloccato per sicurezza e si riattiverà non appena mi invierai un nuovo messaggio." });
                        } catch (e) {
                            console.log("Errore invio messaggio blocco 10 minuti:", e);
                        }
                    }, 10 * 60 * 1000);

                    awayTimers.set(chatJid, timer);
                }
            }
            return;
        }

        if (mutedUsers.has(sender)) {
            try {
                await sock.sendMessage(chatJid, { delete: { remoteJid: chatJid, fromMe: false, id: m.key.id, participant: sender } });
            } catch (e) {
                console.log("Errore durante l'eliminazione:", e);
            }
            return;
        }

        if (messageText.startsWith('!bestemmiometro')) {
            try {
                const args = messageText.split(' ').slice(1);
                const bestemmiaModule = await import('./commands/cyber_module/bestemmiometro.js');
                await bestemmiaModule.execute(sock, m, args);
                return;
            } catch (err) {
                console.log("Errore esecuzione bestemmiometro:", err);
            }
        }
    });
}

startBot();