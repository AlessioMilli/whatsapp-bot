import { DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import fs from 'fs';

// 📂 Percorsi dei file di database locale
const PHONE_BLACKLIST_FILE = './phone_blacklist.json';
const STATE_FILE = './bot_state.json';
const CUSTOM_COMMANDS_FILE = './custom_commands.json';
const SCHEDULE_FILE = './bot_schedule.json';

function loadPhoneBlacklist() {
    if (!fs.existsSync(PHONE_BLACKLIST_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(PHONE_BLACKLIST_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function savePhoneBlacklist(blacklist) {
    fs.writeFileSync(PHONE_BLACKLIST_FILE, JSON.stringify(blacklist, null, 2));
}

// Funzione per recuperare la chiave API di Google Gemini (da Render, da globale o da file locale)
function getApiKey() {
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
    if (global.geminiApiKey) return global.geminiApiKey;
    if (fs.existsSync('./config_ai.json')) {
        try {
            const data = JSON.parse(fs.readFileSync('./config_ai.json', 'utf8'));
            if (data && data.apiKey) return data.apiKey;
        } catch (e) {}
    }
    return "";
}

// 📊 Variabili per il tracciamento dei crediti e dei limiti API gratuiti
let successfulRequestsCount = 0;
let lastResetDate = new Date().toDateString();
let rateLimitResetTime = null;

// ⏰ Gestione degli orari di spegnimento/accensione automatici (default: 21:30 e 13:30)
let scheduleConfig = {
    shutdownTime: "21:30",
    startupTime: "13:30"
};

if (fs.existsSync(SCHEDULE_FILE)) {
    try {
        const savedSchedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        if (savedSchedule.shutdownTime) scheduleConfig.shutdownTime = savedSchedule.shutdownTime;
        if (savedSchedule.startupTime) scheduleConfig.startupTime = savedSchedule.startupTime;
    } catch (e) {}
}

function saveScheduleConfig() {
    try {
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleConfig, null, 2));
    } catch (e) {}
}

// Controllo automatico in background degli orari programmati (ogni 30 secondi)
let dailyAutomationInterval = setInterval(() => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (scheduleConfig.shutdownTime && currentTime === scheduleConfig.shutdownTime) {
        for (let [gId, conf] of groupsConfig.entries()) {
            conf.isInactive = true;
        }
        console.log(`🌙 [AUTOMAZIONE] Orario di spegnimento raggiunto (${currentTime}). Bot disattivato automaticamente.`);
    }

    if (scheduleConfig.startupTime && currentTime === scheduleConfig.startupTime) {
        for (let [gId, conf] of groupsConfig.entries()) {
            conf.isInactive = false;
        }
        console.log(`☀️ [AUTOMAZIONE] Orario di riaccensione raggiunto (${currentTime}). Bot riattivato automaticamente.`);
    }
}, 30000);

// Strutture dati globali di base
const blacklist = new Set();
const warnings = new Map();
const mutedUsers = new Set();
const cooldowns = new Map();
const aiCooldowns = new Map(); // Cooldown specifico per i comandi IA (15 secondi)

// Mappa per i comandi personalizzati dinamici (comando -> risposta)
const customCommands = new Map();

// Caricamento dei comandi personalizzati salvati
if (fs.existsSync(CUSTOM_COMMANDS_FILE)) {
    try {
        const savedCmds = JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE, 'utf8'));
        for (let [cmd, resp] of Object.entries(savedCmds)) {
            customCommands.set(cmd.toLowerCase(), resp);
        }
    } catch (e) {
        console.error("Errore nel caricamento dei comandi personalizzati:", e);
    }
}

function saveCustomCommands() {
    try {
        const obj = {};
        for (let [cmd, resp] of customCommands.entries()) {
            obj[cmd] = resp;
        }
        fs.writeFileSync(CUSTOM_COMMANDS_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {
        console.error("Errore nel salvataggio dei comandi personalizzati:", e);
    }
}

// Archivi globali per il tracciamento in tempo reale dei messaggi
const savedGroups = new Map();
const groupMessages = new Map();     // Traccia i messaggi degli utenti nei gruppi (chatJid -> Map<senderJid, Array>)
const botSentMessages = new Map();   // Traccia i messaggi inviati dal bot (chatJid -> Array)

// Gestione delle configurazioni specifiche per ogni singolo gruppo (chatJid -> impostazioni)
const groupsConfig = new Map();

function getGroupConfig(chatJid) {
    if (!groupsConfig.has(chatJid)) {
        groupsConfig.set(chatJid, {
            linkFilter: false,
            photoFilter: false,
            cooldownEnabled: false,
            cooldownTime: 4000,
            waitingForTagAll: new Set(),
            waitingForSetName: new Set(),
            isInactive: false,
            isLocked: false,
            onlyAdminMode: false, // 🔒 Riservato solo agli admin se attivo
            welcomeEnabled: true,
            protectionEnabled: true,
            offlineMode: false,
            protectedUsers: new Set()
        });
    }
    return groupsConfig.get(chatJid);
}

// Il tuo numero impostato per il bot
let OWNER_JID = "393534467571@s.whatsapp.net";
global.extraOwners = global.extraOwners || new Set([OWNER_JID]);

// Caricamento dello stato salvato (protezioni, co-owner e impostazioni gruppo) se esiste
if (fs.existsSync(STATE_FILE)) {
    try {
        const savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (savedState.extraOwners) {
            savedState.extraOwners.forEach(id => global.extraOwners.add(id));
        }
        if (savedState.groupsConfig) {
            for (let [gId, gConf] of Object.entries(savedState.groupsConfig)) {
                let conf = getGroupConfig(gId);
                conf.onlyAdminMode = gConf.onlyAdminMode || false;
                if (gConf.protectedUsers) {
                    conf.protectedUsers = new Set(gConf.protectedUsers);
                }
            }
        }
    } catch (e) {
        console.error("Errore nel caricamento dello stato salvato:", e);
    }
}

// Funzione per salvare lo stato persistente
function saveBotState() {
    try {
        const stateObj = {
            extraOwners: Array.from(global.extraOwners),
            groupsConfig: {}
        };
        for (let [gId, conf] of groupsConfig.entries()) {
            stateObj.groupsConfig[gId] = {
                onlyAdminMode: conf.onlyAdminMode,
                protectedUsers: Array.from(conf.protectedUsers)
            };
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateObj, null, 2));
    } catch (e) {
        console.error("Errore nel salvataggio dello stato:", e);
    }
}

const isOwner = (jid, sock) => {
    if (!jid) return false;
    const cleanJid = jid.replace(/[^0-9]/g, '');
    const cleanOwner = OWNER_JID.replace(/[^0-9]/g, '');
    if (cleanJid === cleanOwner) return true;
    for (let extra of global.extraOwners) {
        if (extra.replace(/[^0-9]/g, '') === cleanJid) return true;
    }
    if (sock?.user?.id && sock.user.id.replace(/[^0-9]/g, '') === cleanJid) return true;
    return false;
};

// Funzione di protezione aggiornata: il proprietario e gli extraOwners sono protetti SEMPRE
const isProtected = (jid, config) => {
    return isOwner(jid) || config.protectedUsers.has(jid);
};

// 🤖 STRATEGIA ANTI-BAN CORRETTA: Sottoscrizione + Digitazione finta (3-6 secondi)
async function sendHumanMessage(sock, chatJid, content, options = {}) {
    try {
        await sock.presenceSubscribe(chatJid);
        await new Promise(resolve => setTimeout(resolve, 500));

        await sock.sendPresenceUpdate('composing', chatJid);

        const randomDelay = Math.floor(Math.random() * (6000 - 3000 + 1)) + 3000;
        await new Promise(resolve => setTimeout(resolve, randomDelay));

        await sock.sendPresenceUpdate('paused', chatJid);

        return await sock.sendMessage(chatJid, typeof content === 'string' ? { text: content, ...options } : content);
    } catch (err) {
        console.error("Errore invio presenza:", err);
        return await sock.sendMessage(chatJid, typeof content === 'string' ? { text: content, ...options } : content);
    }
}

export async function execute(sock, m, chatJid, messageText, sender, isGroup) {
    try {
        if (!chatJid) chatJid = m.key.remoteJid;
        if (isGroup === undefined) isGroup = chatJid.endsWith('@g.us');
        if (!sender) sender = m.key.participant || chatJid;

        // 🔍 SALVATAGGIO AUTOMATICO ID GRUPPO
        if (isGroup) {
            if (!savedGroups.has(chatJid)) {
                try {
                    const metadata = await sock.groupMetadata(chatJid);
                    savedGroups.set(chatJid, {
                        id: chatJid,
                        subject: metadata.subject || "Gruppo senza nome",
                        lastActive: Date.now()
                    });
                } catch (e) {
                    savedGroups.set(chatJid, { id: chatJid, subject: "Gruppo", lastActive: Date.now() });
                }
            } else {
                savedGroups.get(chatJid).lastActive = Date.now();
            }
        }

        // 📝 TRACCIAMENTO IN TEMPO REALE DEI MESSAGGI DEGLI UTENTI
        if (isGroup && chatJid && sender && m.key && m.key.id) {
            if (!groupMessages.has(chatJid)) groupMessages.set(chatJid, new Map());
            let chatMap = groupMessages.get(chatJid);
            if (!chatMap.has(sender)) chatMap.set(sender, []);
            
            let userMsgs = chatMap.get(sender);
            const isAudio = !!m.message?.audioMessage;
            
            userMsgs.push({
                id: m.key.id,
                text: messageText || "",
                isAudio: isAudio,
                key: m.key
            });
            if (userMsgs.length > 250) userMsgs.shift();
        }

        // 📝 TRACCIAMENTO IN TEMPO REALE DEI MESSAGGI DEL BOT
        if (chatJid && m.key && m.key.fromMe && m.key.id) {
            if (!botSentMessages.has(chatJid)) botSentMessages.set(chatJid, []);
            let botList = botSentMessages.get(chatJid);
            if (!botList.some(item => item.id === m.key.id)) {
                botList.push({
                    id: m.key.id,
                    key: m.key
                });
                if (botList.length > 300) botList.shift();
            }
        }

        // 🥷 Controllo presenza di Aleh (+39 392 491 1895) nel gruppo
        const alehJid = "3924911895@s.whatsapp.net";
        if (isGroup && !isOwner(sender, sock)) {
            try {
                const metadata = await sock.groupMetadata(chatJid);
                const isAlehPresent = metadata.participants.some(p => p.id.includes(alehJid.split('@')[0]));
                if (isAlehPresent) {
                    return true; 
                }
            } catch (e) {}
        }

        const config = getGroupConfig(chatJid);

        if (blacklist.has(sender) && !isOwner(sender, sock)) return true;

        const getTargetJid = () => {
            let targetJid = m.message?.extendedTextMessage?.contextInfo?.participant || m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!targetJid && messageText) {
                const parts = messageText.trim().split(/ +/);
                if (parts[1]) {
                    let cleanQuery = parts[1].startsWith('@') ? parts[1].slice(1) : parts[1];
                    targetJid = cleanQuery.includes('@') ? cleanQuery : cleanQuery + '@s.whatsapp.net';
                }
            }
            return targetJid;
        };

        const getAllMentionedJids = () => {
            let mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentions.length === 0 && messageText) {
                const parts = messageText.trim().split(/ +/).slice(1);
                for (let p of parts) {
                    let clean = p.startsWith('@') ? p.slice(1) : p;
                    if (clean) mentions.push(clean.includes('@') ? clean : clean + '@s.whatsapp.net');
                }
            }
            return mentions;
        };

        // 👋 Benvenuto automatico
        if (isGroup && m.messageStubType === 27 && config.welcomeEnabled) {
            const newMemberJid = m.messageStubParameters?.[0];
            if (newMemberJid) {
                try {
                    const metadata = await sock.groupMetadata(chatJid);
                    const desc = metadata.desc ? metadata.desc.trim() : "";
                    const groupName = metadata.subject || "questo gruppo";
                    
                    let welcomeText = `Buongiorno @${newMemberJid.split('@')[0]} e benvenuto/a nel gruppo${groupName}\n\n`;
                    if (desc) welcomeText += `Leggi con attenzione le regole: ${desc}`;

                    await sendHumanMessage(sock, chatJid, welcomeText, { mentions: [newMemberJid] });
                } catch (err) {}
            }
            return true;
        }

        if (!messageText) {
            messageText = m.message?.conversation || 
                        m.message?.extendedTextMessage?.text || 
                        m.message?.imageMessage?.caption || 
                        (m.message?.audioMessage ? "[Messaggio Vocale]" : '');
        }

        // 📸 CONTROLLO ANTIPHOTO
        if (isGroup && config.photoFilter && m.message?.imageMessage && !isOwner(sender, sock)) {
            try {
                await sock.sendMessage(chatJid, { delete: m.key });
                await sendHumanMessage(sock, chatJid, `⚠️ @${sender.split('@')[0]}, non puoi inviare foto senza autorizzazione! Il messaggio è stato rimosso automaticamente per tutelare la privacy.`, { mentions: [sender] });
                return true;
            } catch (err) {}
        }

        if (isGroup && !m.key.fromMe) {
            const senderClean = sender.split('@')[0];
            if (mutedUsers.has(sender) || Array.from(mutedUsers).some(id => id.split('@')[0] === senderClean)) {
                if (!isOwner(sender, sock)) {
                    try { await sock.sendMessage(chatJid, { delete: m.key }); } catch (err) {}
                    return true;
                }
            }
        }

        if (isGroup && config.isLocked && !m.key.fromMe) {
            if (!isOwner(sender, sock)) {
                try {
                    await sock.sendMessage(chatJid, { delete: m.key });
                    return true;
                } catch (e) {}
            }
        }

        if (!messageText) return false;

        // 🔒 CONTROLLO MODALITÀ ONLY ADMIN
        if (isGroup && config.onlyAdminMode && messageText.startsWith('!') && !isOwner(sender, sock)) {
            try {
                const metadata = await sock.groupMetadata(chatJid);
                const senderNumber = sender.replace(/[^0-9]/g, '');
                
                const participant = metadata.participants.find(p => p.id.replace(/[^0-9]/g, '') === senderNumber);
                const isUserAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

                if (!isUserAdmin) {
                    await sendHumanMessage(sock, chatJid, `⚠️ In questo gruppo la gestione dei comandi del bot è riservata unicamente agli **amministratori**.`, { mentions: [sender] });
                    return true;
                }
            } catch (e) {
                console.error("Errore verifica admin per onlyAdminMode:", e);
            }
        }

        const args = messageText.trim().split(/ +/);
        const command = args[0].toLowerCase();
        const targetMention = getTargetJid();

        // 🧠 Controllo se è un comando personalizzato dinamico
        if (customCommands.has(command)) {
            const customResponse = customCommands.get(command);
            await sendHumanMessage(sock, chatJid, customResponse);
            return true;
        }

        if (isGroup && config.isInactive) {
            if (command === '!gruppo' && args[1] === 'on' && isOwner(sender, sock)) {
                config.isInactive = false;
            } else {
                if (!isOwner(sender, sock)) {
                    if (messageText.startsWith('!')) {
                        await sendHumanMessage(sock, chatJid, `🌙 Il bot è in pausa programmata e si riaccenderà automaticamente domani alle ${scheduleConfig.startupTime}!`);
                    }
                    return true;
                }
            }
        }

        if (config.cooldownEnabled && isGroup && !isOwner(sender, sock)) {
            const now = Date.now();
            const lastTime = cooldowns.get(sender + chatJid) || 0;
            if (now - lastTime < config.cooldownTime) return true;
            cooldowns.set(sender + chatJid, now);
        }

        if (config.waitingForTagAll && config.waitingForTagAll.has(sender)) {
            config.waitingForTagAll.delete(sender);
            const announcementText = messageText.trim();
            const metadata = await sock.groupMetadata(chatJid);
            const participants = metadata.participants.map(p => p.id);
            
            let text = `📢 Attenzione a tutti ragazzi\n\n${announcementText}\n\n`;
            for (let p of participants) text += `@${p.split('@')[0]} `;

            await sendHumanMessage(sock, chatJid, text, { mentions: participants });
            return true;
        }

        if (config.waitingForSetName && config.waitingForSetName.has(sender)) {
            config.waitingForSetName.delete(sender);
            const newTitle = messageText.trim();
            if (newTitle && isGroup) {
                await sock.groupUpdateSubject(chatJid, newTitle);
                await sendHumanMessage(sock, chatJid, `🏷 Il nome del gruppo è stato aggiornato in modo perfetto`);
            }
            return true;
        }

        if (isGroup && config.linkFilter && !isOwner(sender, sock)) {
            const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
            if (urlRegex.test(messageText)) {
                await sock.sendMessage(chatJid, { delete: m.key }).catch(() => {});
                await sendHumanMessage(sock, chatJid, `⚠ Non puoi inviare link esterni in questo gruppo se prima non chiedi il permesso`);
                return true;
            }
        }

        if (targetMention && isProtected(targetMention, config) && ['!mute', '!warn', '!kick', '!rimuovi', '!demuovi', '!quickdemote', '!multidemote', '!clearsender', '!cleardue'].includes(command)) {
            await sendHumanMessage(sock, chatJid, `🛡 Questo utente è protetto in questo gruppo`);
            return true;
        }

        switch (command) {
            case '!impostaorario':
            case '!setorario': {
                if (!isOwner(sender, sock)) {
                    await sendHumanMessage(sock, chatJid, "⛔ Comando riservato esclusivamente al proprietario.");
                    return true;
                }

                const action = args[1]?.toLowerCase();
                const timeValue = args[2];

                if (!action || !timeValue || !timeValue.includes(':')) {
                    await sendHumanMessage(sock, chatJid, `⚠️ Uso corretto:\n• \`!impostaorario spegnimento 22:00\`\n• \`!impostaorario accensione 14:00\`\n\n📌 *Orari attuali:* Spegnimento: ${scheduleConfig.shutdownTime}, Riaccensione:${scheduleConfig.startupTime}`);
                    return true;
                }

                if (action === 'spegnimento' || action === 'spegni') {
                    scheduleConfig.shutdownTime = timeValue;
                    saveScheduleConfig();
                    await sendHumanMessage(sock, chatJid, `✅ Orario di spegnimento automatico aggiornato alle ore **${timeValue}**!`);
                } else if (action === 'accensione' || action === 'riaccensione') {
                    scheduleConfig.s
