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

// 🤖 STRATEGIA ANTI-BAN CORRETTA: Sottoscrizione + Digitazione finta rapida (2-3 secondi)
async function sendHumanMessage(sock, chatJid, content, options = {}) {
    try {
        await sock.presenceSubscribe(chatJid);
        await new Promise(resolve => setTimeout(resolve, 500));

        await sock.sendPresenceUpdate('composing', chatJid);

        // Ritardo casuale impostato tra 2000 ms (2 secondi) e 3000 ms (3 secondi)
        const randomDelay = Math.floor(Math.random() * (3000 - 2000 + 1)) + 2000;
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
                    scheduleConfig.startupTime = timeValue;
                    saveScheduleConfig();
                    await sendHumanMessage(sock, chatJid, `✅ Orario di riaccensione automatica aggiornato alle ore **${timeValue}**!`);
                } else {
                    await sendHumanMessage(sock, chatJid, "⚠️ Specifica se vuoi cambiare 'spegnimento' o 'accensione'.");
                }
                return true;
            }

            case '!onlyadmin':
            case '!soloadmin': {
                if (!isGroup) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Questo comando può essere utilizzato solo all'interno dei gruppi.");
                    return true;
                }

                if (!isOwner(sender, sock)) {
                    await sendHumanMessage(sock, chatJid, "⛔ Comando riservato esclusivamente al proprietario del bot.");
                    return true;
                }

                const action = args[1]?.toLowerCase();
                if (action === 'on') {
                    config.onlyAdminMode = true;
                    saveBotState();
                    
                    let respText = `🔒 **Modalità Solo Admin Attivata!**\n\nDa questo momento il bot risponderà esclusivamente ai comandi inviati dagli **amministratori del gruppo** (e al proprietario del bot).`;
                    if (targetMention) {
                        respText += `\n\n📌 *Configurato per l'utente/gruppo:* @${targetMention.split('@')[0]}`;
                        await sendHumanMessage(sock, chatJid, respText, { mentions: [targetMention] });
                    } else {
                        await sendHumanMessage(sock, chatJid, respText);
                    }
                } else if (action === 'off') {
                    config.onlyAdminMode = false;
                    saveBotState();
                    await sendHumanMessage(sock, chatJid, `🔓 **Modalità Solo Admin Disattivata!**\nTutti i partecipanti del gruppo possono nuovamente utilizzare i comandi del bot.`);
                } else {
                    await sendHumanMessage(sock, chatJid, "⚠️ Utilizzo corretto:\n• `!onlyadmin on` (o con `@utente`)\n• `!onlyadmin off`");
                }
                return true;
            }

            case '!aggiungicomando':
            case '!addcmd':
            case '!nuovocomando': {
                if (!isOwner(sender, sock)) {
                    await sendHumanMessage(sock, chatJid, "⛔ Comando riservato al proprietario.");
                    return true;
                }

                const content = messageText.replace(/^(?:!aggiungicomando|!addcmd|!nuovocomando)/i, '').trim();
                const parts = content.split(/\s+/);
                
                let newCmd = parts[0] ? parts[0].toLowerCase() : "";
                let responseText = parts.slice(1).join(' ').trim();

                if (!newCmd || !newCmd.startsWith('!') || !responseText) {
                    const randomNum = Math.floor(Math.random() * 1000);
                    newCmd = `!comando_${randomNum}`;
                    responseText = `🤖 Ecco un comando inventato automaticamente dal bot! Tutto funziona alla perfezione.`;
                }

                customCommands.set(newCmd, responseText);
                saveCustomCommands();

                await sendHumanMessage(sock, chatJid, `✅ **Comando aggiunto con successo!**\n\n• **Comando:** \`${newCmd}\`\n• **Risposta:** ${responseText}\n\nIl comando è stato integrato nel database locale e salvato permanentemente.`);
                return true;
            }

            case '!rimuovicomando':
            case '!delcmd':
            case '!eliminacomando': {
                if (!isOwner(sender, sock)) {
                    await sendHumanMessage(sock, chatJid, "⛔ Comando riservato al proprietario.");
                    return true;
                }

                const targetCmd = args[1] ? args[1].toLowerCase() : "";
                if (!targetCmd) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Specifica il comando da rimuovere.\nEsempio: `!rimuovicomando !regole`");
                    return true;
                }

                if (customCommands.has(targetCmd)) {
                    customCommands.delete(targetCmd);
                    saveCustomCommands();
                    await sendHumanMessage(sock, chatJid, `✅ Il comando \`${targetCmd}\` è stato rimosso con successo dal database.`);
                } else {
                    await sendHumanMessage(sock, chatJid, `⚠️ Il comando \`${targetCmd}\` non esiste tra i comandi personalizzati.`);
                }
                return true;
            }

            case '!aggiornacodice':
            case '!ricarica':
            case '!reload': {
                if (!isOwner(sender, sock)) {
                    await sendHumanMessage(sock, chatJid, "⛔ Comando riservato al proprietario.");
                    return true;
                }
                saveBotState();
                saveCustomCommands();
                saveScheduleConfig();
                await sendHumanMessage(sock, chatJid, "🔄 **Codice e stato aggiornati con successo!**\nTutte le protezioni, gli orari automatici e i comandi personalizzati sono stati salvati permanentemente.");
                return true;
            }

            case '!getjid': {
                if (args[1] && args[1].toLowerCase() === 'gruppo') {
                    try {
                        const groups = await sock.groupFetchAllParticipating();
                        const groupList = Object.values(groups);

                        if (groupList.length === 0) {
                            await sendHumanMessage(sock, chatJid, "❌ Il bot non è presente in alcun gruppo.");
                            return true;
                        }

                        const searchTerms = args.slice(2).join(' ').toLowerCase().trim();

                        if (searchTerms.length > 0) {
                            const matchedGroups = groupList.filter(g => 
                                g.subject.toLowerCase().includes(searchTerms)
                            );

                            if (matchedGroups.length === 0) {
                                await sendHumanMessage(sock, chatJid, `❌ Nessun gruppo trovato corrispondente a: *"${searchTerms}"*`);
                                return true;
                            }

                            let response = `🔍 *Risultati della ricerca per "${searchTerms}":*\n\n`;
                            matchedGroups.forEach((group, index) => {
                                response += `${index + 1}. *${group.subject}*\n   ID: \`${group.id}\`\n\n`;
                            });

                            await sendHumanMessage(sock, chatJid, response);
                            return true;
                        }

                        let response = "📋 *Lista di tutti i gruppi del bot:*\n\n";
                        groupList.forEach((group, index) => {
                            response += `${index + 1}. *${group.subject}*\n   ID: \`${group.id}\`\n\n`;
                        });

                        await sendHumanMessage(sock, chatJid, response);
                    } catch (error) {
                        console.error("Errore nel recupero dei gruppi:", error);
                        await sendHumanMessage(sock, chatJid, "❌ Errore durante il recupero della lista dei gruppi.");
                    }
                    return true;
                }

                if ((args[1] && ['utente', 'numero'].includes(args[1].toLowerCase())) || targetMention) {
                    try {
                        if (targetMention) {
                            await sendHumanMessage(sock, chatJid, `👤 *JID dell'utente taggato:* \`${targetMention}\``, { mentions: [targetMention] });
                            return true;
                        }

                        const searchType = args[1].toLowerCase();
                        const userQuery = args.slice(2).join(' ').replace(/[^0-9a-zA-Z]/g, '').trim();
                        
                        if (!userQuery) {
                            await sendHumanMessage(sock, chatJid, "⚠️ Inserisci il nome o il numero da cercare.\nEsempio: `!getjid utente Mario` oppure `!getjid numero 393331234567` me");
                            return true;
                        }

                        const groups = await sock.groupFetchAllParticipating();
                        let foundUsers = [];

                        for (let gId in groups) {
                            try {
                                const metadata = await sock.groupMetadata(gId);
                                for (let p of metadata.participants) {
                                    let phoneClean = p.id.replace(/[^0-9]/g, '');
                                    if (searchType === 'numero') {
                                        if (phoneClean.includes(userQuery)) {
                                            if (!foundUsers.some(u => u.id === p.id)) {
                                                foundUsers.push({ id: p.id, groupName: metadata.subject });
                                            }
                                        }
                                    } else {
                                        if (p.id.toLowerCase().includes(userQuery.toLowerCase())) {
                                            if (!foundUsers.some(u => u.id === p.id)) {
                                                foundUsers.push({ id: p.id, groupName: metadata.subject });
                                            }
                                        }
                                    }
                                }
                            } catch (e) {}
                        }

                        if (foundUsers.length === 0) {
                            await sendHumanMessage(sock, chatJid, `❌ Nessun utente trovato per: *"${userQuery}"* nei gruppi del bot.`);
                            return true;
                        }

                        let resText = `🔍 *Risultati ricerca per "${userQuery}":*\n\n`;
                        foundUsers.slice(0, 10).forEach((u, i) => {
                            resText += `${i + 1}. JID: \`${u.id}\`\n   Gruppo: ${u.groupName}\n\n`;
                        });

                        await sendHumanMessage(sock, chatJid, resText);
                    } catch (err) {
                        console.error("Errore ricerca utente/numero:", err);
                        await sendHumanMessage(sock, chatJid, "❌ Errore durante la ricerca.");
                    }
                    return true;
                }

                if (isGroup) {
                    await sendHumanMessage(sock, chatJid, `📌 *ID di questo gruppo:* \`${chatJid}\``);
                } else {
                    await sendHumanMessage(sock, chatJid, `👤 *Il tuo ID (JID):* \`${chatJid}\`\n\n💡 *Esempi di utilizzo:*\n• !getjid gruppo\n• !getjid numero <num>\n• !getjid utente <nome>\n• !getjid @utente`);
                }
                return true;
            }

            case '!commands':
            case '!aiuto':
            case '!menu': {
                let menuText = `📋 LISTA COMPLETA DEI COMANDI DEL BOT

🛑 GESTIONE MODERAZIONE E SANZIONI
- !mute @utente 🔇 - Muto perpetuo e cancellazione automatica messaggi
- !unmute @utente 🔊 - Revoca il muto perpetuo
- !warn @utente ⚠ - Gestione ammonizioni ad accumulo (3 livelli)
- !kick @utente (o !rimuovi) ❌ - Rimuove ed espelle immediatamente l'utente
- !banphone <numero> 🚫 - Inserisce il numero nella blacklist permanente e previene il re-ingresso
- !sblocconumero <numero> ✅ - Rimuove il numero dalla blacklist permanente
- !masskick (o !svuotagruppo) 🧹 - Rimuove tutti i partecipanti (lascia admin e bot)
- !deletegroup (o !eliminagruppo) 🗑 - Svuota ed elimina o abbandona il gruppo
- !clearalltesto [parola] 🔍 - Elimina per tutti i messaggi con la parola indicata
- !clearsender @utente (o !cleardue) 🧹 - Cancella tutti i messaggi scritti da un utente specifico

🤖 INTELLIGENZA ARTIFICIALE (GOOGLE GEMINI 3.8 FLASH)
- !setgeminiak [chiave] 🔑 - Imposta la chiave API direttamente in chat privata
- !parla [domanda/file] (o !ia) 💡 - Interagisci con Google Gemini (supporta testo, immagini/esercizi, audio/vocali, video e ricerca web)
- !cerca [query] (o !web) 🌐 - Cerca informazioni ed elabora risposte via web search

⚙️ GESTIONE AMMINISTRATORI E AUTOMAZIONE
- !impostaorario spegnimento/accensione [HH:MM] ⏰ - Cambia gli orari di stop/avvio automatico
- !promuovi @utente ⭐ - Promuove l'utente amministratore
- !demuovi @utente (o !quickdemote) 👤 - Rimuove subito i poteri di admin
- !multidemote @u1 @u2... 👥 - Rimuove i poteri di admin a più utenti insieme
- !onlyadmin on/off (@utente) 🔒 - Riserva l'uso dei comandi solo agli admin del gruppo
- !annuncio nuova/rimossa [dettagli] 📢 - Invia un annuncio locale nella chat corrente

⚙️ IMPOSTAZIONI E SICUREZZA GRUPPO
- !checkadmin 🔍 - Verifica istantanea dei permessi amministrativi nel gruppo
- !gruppo on/off [ID_gruppo] 🤖 - Attiva/disattiva il bot nel gruppo (anche da remoto)
- !editgroup on/off ✏ - Gestisce la modifica info gruppo
- !approva on/off 📋 - Gestisce approvazione nuovi membri
- !addmember on/off ➕ - Gestisce restrizione aggiunta partecipanti
- !history on/off 📜 - Invio cronologia messaggi ai nuovi membri
- !invitelink on/off 🔗 - Accesso tramite link d'invito
- !setname [nome] 🏷 - Cambia istantaneamente il nome del gruppo
- !lockinfo / !unlockinfo 🔒 - Blocca o sblocca i dettagli del gruppo
- !link on/off 🌐 - Cancellazione automatica link esterni
- !antiphoto on/off 📸 - Blocco automatico foto non autorizzate
- !cooldown on/off ⏱ - Limite tempo antispam tra comandi

🆔 IDENTIFICAZIONE, AGGIORNAMENTO E COMANDI EXTRA
- !getjid 📌 - Mostra il JID unico della chat corrente
- !getjid gruppo [nome] 📋 - Cerca JID gruppi
- !getjid numero <num> / !getjid utente <nome> / !getjid @utente 👤 - Cerca JID utente
- !aggiornacodice (o !reload) 🔄 - Salva e aggiorna le protezioni e lo stato del bot
- !aggiungicomando [!cmd] [testo] ➕ - Aggiunge un comando personalizzato
- !rimuovicomando [!cmd] 🗑️ - Rimuove un comando personalizzato
- !cleandb 🗄️ - Pulisce e azzera il database degli avvertimenti

💬 SUPPORTO E BENVENUTO
- !commands (o !aiuto / !menu) 📖 - Mostra questo menu comandi
- !chiedialessio [mess] ✉️ - Invia una domanda diretta al supporto
- !tagall (o !tutti) [messaggio] 📢 - Avviso con menzione di tutti i partecipanti
- !poll [domanda] [opz 1] [opz 2] 📊 - Sondaggio interattivo
- !welcome on/off 👋 - Gestisce il benvenuto automatico
- !ripeti [messaggio] [numero] (o !flood) 🔁 - Ripete un messaggio più volte con etichetta progressiva
- !clearmetutto (o !botclean) 🗑️ - Cancella tutti i messaggi inviati dal bot in questa chat`;

                if (isOwner(sender, sock)) {
                    menuText += `\n\n🚀 COMANDI ESCLUSIVI OWNER\n1. !inspect @utente 🔍 - Mostra la scheda informativa dell'utente nel database\n2. !lockgroup / !unlockgroup`;
                }

                if (customCommands.size > 0) {
                    menuText += `\n\n✨ **COMANDI PERSONALIZZATI AGGIUNTI:**\n`;
                    for (let cmd of customCommands.keys()) {
                        menuText += `• \`${cmd}\`\n`;
                    }
                }

                await sendHumanMessage(sock, chatJid, menuText);
                return true;
            }

            case '!setgeminiak':
            case '!setapi': {
                if (isGroup) {
                    await sendHumanMessage(sock, chatJid, "🔒 Per motivi di sicurezza, puoi impostare la chiave API inviandomi questo comando **unicamente in chat privata**.");
                    return true;
                }

                if (!isOwner(sender, sock)) {
                    await sendHumanMessage(sock, chatJid, "⛔ Non hai i permessi per configurare la chiave API.");
                    return true;
                }

                const newKey = messageText.replace(/^(?:!setgeminiak|!setapi)/i, '').trim();

                if (!newKey) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Inserisci la chiave API dopo il comando.\nEsempio: !setgeminiak la_tua_chiave_qui");
                    return true;
                }

                try {
                    const configData = { apiKey: newKey };
                    fs.writeFileSync('./config_ai.json', JSON.stringify(configData, null, 2));
                    global.geminiApiKey = newKey;
                    
                    await sendHumanMessage(sock, chatJid, "✅ **Chiave API di Google Gemini salvata con successo!**\nTutte le funzionalità dell'intelligenza artificiale sono ora sbloccate e pronte all'uso.");
                } catch (err) {
                    console.error("Errore salvataggio chiave API:", err);
                    await sendHumanMessage(sock, chatJid, "❌ Si è verificato un errore durante il salvataggio della chiave.");
                }
                return true;
            }

            case '!banphone':
            case '!ban numero': {
                if (!isOwner(sender, sock)) {
                    await sendHumanMessage(sock, chatJid, "⛔ Questo comando è riservato esclusivamente al proprietario.");
                    return true;
                }

                const targetPhone = args[1]?.replace(/[^0-9]/g, '');
                if (!targetPhone) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Inserisci un numero valido.\nEsempio: !banphone 393331234567");
                    return true;
                }

                let phoneBlacklist = loadPhoneBlacklist();
                if (!phoneBlacklist.includes(targetPhone)) {
                    phoneBlacklist.push(targetPhone);
                    savePhoneBlacklist(phoneBlacklist);
                }

                if (isGroup) {
                    try {
                        const metadata = await sock.groupMetadata(chatJid);
                        const participantToKick = metadata.participants.find(p => p.id.includes(targetPhone));
                        if (participantToKick) {
                            await sock.groupParticipantsUpdate(chatJid, [participantToKick.id], "remove");
                        }
                    } catch (e) {}
                }

                await sendHumanMessage(sock, chatJid, `✅ Il numero +${targetPhone} è stato inserito nella blacklist permanente. Se proveranno ad aggiungerlo, il bot lo ribannerà all'istante.`);
                return true;
            }

            case '!sblocconumero':
            case '!unblockphone': {
                if (!isOwner(sender, sock)) {
                    await sendHumanMessage(sock, chatJid, "⛔ Questo comando è riservato esclusivamente al proprietario.");
                    return true;
                }

                const targetPhone = args[1]?.replace(/[^0-9]/g, '');
                if (!targetPhone) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Inserisci il numero da sbloccare.\nEsempio: !sblocconumero 393331234567");
                    return true;
                }

                let phoneBlacklist = loadPhoneBlacklist();
                const index = phoneBlacklist.indexOf(targetPhone);

                if (index !== -1) {
                    phoneBlacklist.splice(index, 1);
                    savePhoneBlacklist(phoneBlacklist);
                    await sendHumanMessage(sock, chatJid, `✅ Il numero +${targetPhone} è stato rimosso dalla blacklist permanente.`);
                } else {
                    await sendHumanMessage(sock, chatJid, `⚠️ Il numero +${targetPhone} non è presente nella blacklist.`);
                }
                return true;
            }

            case '!annuncio':
            case '!news': {
                if (!isOwner(sender, sock)) {
                    await sendHumanMessage(sock, chatJid, "⛔ Questo comando è riservato esclusivamente al proprietario del bot.");
                    return true;
                }

                const rawArgs = messageText.replace(/^(?:!annuncio|!news)/i, '').trim();
                const parts = rawArgs.split('|');
                
                const type = parts[0]?.trim()?.toLowerCase(); // 'nuova' o 'rimossa'
                const details = parts[1]?.trim(); // Il nome e la descrizione

                if (!type || !details || (type !== 'nuova' && type !== 'rimossa')) {
                    await sendHumanMessage(sock, chatJid, 
                        "⚠️ Uso non corretto del comando.\n\n" +
                        "📌 **Esempi di utilizzo:**\n" +
                        "• Per una nuova funzione:\n`!annuncio nuova !parla multimodale | Ora puoi inviare foto, vocali e video e il bot li analizzerà!`\n\n" +
                        "• Per una funzione rimossa:\n`!annuncio rimossa Comando X | Rimosso per manutenzione dei server.`"
                    );
                    return true;
                }

                try {
                    let announcementText = "";
                    if (type === 'nuova') {
                        announcementText = `✨ **AGGIORNAMENTO BOT: NUOVA FUNZIONE** ✨\n\n${details}\n\n🤖 *Prova subito a provarla qui in chat!*`;
                    } else {
                        announcementText = `🛠 **AGGIORNAMENTO BOT: FUNZIONE RIMOSSA** 🛠\n\n${details}\n\n📌 *Ci scusiamo per il disagio.*`;
                    }

                    // Invia il messaggio unicamente nel gruppo in cui è stato digitato il comando
                    await sendHumanMessage(sock, chatJid, announcementText);

                } catch (error) {
                    console.error("Errore durante l'invio dell'annuncio:", error);
                    await sendHumanMessage(sock, chatJid, "❌ Si è verificato un errore durante l'invio dell'annuncio.");
                }
                return true;
            }

            case '!parla':
            case '!ia': {
                const GEMINI_API_KEY = getApiKey();
                if (!GEMINI_API_KEY) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Nessuna chiave API configurata! Imposta la variabile GEMINI_API_KEY su Render o inviami in chat privata il comando !setgeminiak <tua_chiave>.");
                    return true;
                }

                if (!isOwner(sender, sock)) {
                    const now = Date.now();
                    const lastAiTime = aiCooldowns.get(sender) || 0;
                    const cooldownTimeMs = 15000;
                    
                    if (now - lastAiTime < cooldownTimeMs) {
                        const secondsLeft = Math.ceil((cooldownTimeMs - (now - lastAiTime)) / 1000);
                        await sendHumanMessage(sock, chatJid, `⏳ Attendi altri ${secondsLeft} secondi prima di usare nuovamente il comando IA.`, { mentions: [sender] });
                        return true;
                    }
                    aiCooldowns.set(sender, now);
                }

                try {
                    const msgType = m.message?.imageMessage ? 'image' :
                                    m.message?.audioMessage ? 'audio' :
                                    m.message?.videoMessage ? 'video' : null;

                    const quotedMsg = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    const quotedType = quotedMsg?.imageMessage ? 'image' :
                                       quotedMsg?.audioMessage ? 'audio' :
                                       quotedMsg?.videoMessage ? 'video' : null;

                    let mediaInlineData = null;
                    let activeType = msgType || quotedType;

                    if (activeType) {
                        const messageToDownload = msgType ? m : { message: quotedMsg };
                        const buffer = await downloadMediaMessage(
                            messageToDownload,
                            'buffer',
                            {},
                            { logger: console }
                        );

                        let mimeType = "image/jpeg";
                        if (activeType === 'audio') mimeType = "audio/mp4";
                        if (activeType === 'video') mimeType = "video/mp4";

                        mediaInlineData = {
                            inlineData: {
                                data: buffer.toString("base64"),
                                mimeType: mimeType
                            }
                        };
                    }

                    let userQuery = messageText.replace(/^(?:!parla|!ia)/i, '').trim();

                    if (!userQuery && mediaInlineData) {
                        if (activeType === 'audio') {
                            userQuery = "Trascrivi fedelmente questo audio/vocale in italiano e riassumine i punti chiave.";
                        } else if (activeType === 'video') {
                            userQuery = "Ascolta l'audio e guarda le immagini di questo video, trascrivi ciò che viene detto e descrivine il contenuto.";
                        } else if (activeType === 'image') {
                            userQuery = "Analizza questa immagine, risolvi l'esercizio passo dopo passo o spiega il testo presente in essa.";
                        }
                    } else if (!userQuery) {
                        await sendHumanMessage(sock, chatJid, "⚠️ Scrivi una domanda, un argomento o allega un'immagine/audio/video dopo il comando.\nEsempio: `!parla cos'è un buco nero?` oppure allega una foto con `!parla risolvi`.");
                        return true;
                    }

                    await sendHumanMessage(sock, chatJid, "⏳ Elaborazione in corso (analisi file e ricerca web se necessaria)...");

                    const partsArray = [{ text: userQuery }];
                    if (mediaInlineData) {
                        partsArray.push(mediaInlineData);
                    }

                    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            contents: [{
                                role: 'user',
                                parts: partsArray
                            }],
                            tools: [{ googleSearch: {} }]
                        })
                    });

                    const data = await response.json();
                    
                    let aiResponse = "";
                    let isSuccess = false;

                    if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                        aiResponse = data.candidates[0].content.parts[0].text;
                        isSuccess = true;
                    } else if (data?.error?.message) {
                        aiResponse = `⚠️ Errore API: ${data.error.message}`;
                        if (data.error.code === 429) {
                            rateLimitResetTime = new Date(Date.now() + 60000);
                        }
                    } else {
                        aiResponse = "Mi dispiace, non sono riuscito a elaborare una risposta valida.";
                    }

                    if (isSuccess) {
                        const currentDate = new Date().toDateString();
                        if (currentDate !== lastResetDate) {
                            successfulRequestsCount = 0;
                            lastResetDate = currentDate;
                        }
                        successfulRequestsCount++;
                    }

                    let statusInfo = `\n\n📊 *Statistiche Chiave API:*`;
                    statusInfo += `\n• Richieste riuscite oggi: \`${successfulRequestsCount} / 1500 RPD\``;
                    
                    if (rateLimitResetTime && Date.now() < rateLimitResetTime.getTime()) {
                        const secondsLeft = Math.ceil((rateLimitResetTime.getTime() - Date.now()) / 1000);
                        statusInfo += `\n⏳ *Limite superato!* Operatività ristabilita tra circa: \`${secondsLeft} secondi\``;
                    } else {
                        statusInfo += `\n• Limite chiave gratuita: \`15 RPM / 1.500 RPD\``;
                    }

                    await sendHumanMessage(sock, chatJid, `🤖 **Google Gemini IA (3.8 Flash)**:\n\n${aiResponse}${statusInfo}`);

                } catch (error) {
                    console.error("Errore API Gemini:", error);
                    await sendHumanMessage(sock, chatJid, "❌ Si è verificato un errore durante la connessione con Google Gemini.");
                }
                return true;
            }

            case '!cerca':
            case '!web': {
                const searchQuery = messageText.replace(/^(?:!cerca|!web)/i, '').trim();

                if (!searchQuery) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Inserisci cosa desideri cercare.\nEsempio: !cerca quando è nato lyon wgf");
                    return true;
                }

                const GEMINI_API_KEY = getApiKey();
                if (!GEMINI_API_KEY) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Nessuna chiave API configurata! Imposta la variabile GEMINI_API_KEY su Render o inviami in chat privata il comando !setgeminiak <tua_chiave>.");
                    return true;
                }

                if (!isOwner(sender, sock)) {
                    const now = Date.now();
                    const lastAiTime = aiCooldowns.get(sender) || 0;
                    const cooldownTimeMs = 15000;
                    
                    if (now - lastAiTime < cooldownTimeMs) {
                        const secondsLeft = Math.ceil
