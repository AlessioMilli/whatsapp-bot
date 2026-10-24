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

// Funzione per recuperare la chiave API di Google Gemini
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

// 📊 Variabili per il tracciamento dei crediti API
let successfulRequestsCount = 0;
let lastResetDate = new Date().toDateString();
let rateLimitResetTime = null;

// ⏰ Gestione degli orari di spegnimento/accensione automatici
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

let dailyAutomationInterval = setInterval(() => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (scheduleConfig.shutdownTime && currentTime === scheduleConfig.shutdownTime) {
        for (let [gId, conf] of groupsConfig.entries()) {
            conf.isInactive = true;
        }
    }

    if (scheduleConfig.startupTime && currentTime === scheduleConfig.startupTime) {
        for (let [gId, conf] of groupsConfig.entries()) {
            conf.isInactive = false;
        }
    }
}, 30000);

const blacklist = new Set();
const warnings = new Map();
const mutedUsers = new Set();
const cooldowns = new Map();
const aiCooldowns = new Map();

const customCommands = new Map();

if (fs.existsSync(CUSTOM_COMMANDS_FILE)) {
    try {
        const savedCmds = JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE, 'utf8'));
        for (let [cmd, resp] of Object.entries(savedCmds)) {
            customCommands.set(cmd.toLowerCase(), resp);
        }
    } catch (e) {}
}

function saveCustomCommands() {
    try {
        const obj = {};
        for (let [cmd, resp] of customCommands.entries()) {
            obj[cmd] = resp;
        }
        fs.writeFileSync(CUSTOM_COMMANDS_FILE, JSON.stringify(obj, null, 2));
    } catch (e) {}
}

const savedGroups = new Map();
const groupMessages = new Map();
const botSentMessages = new Map();
const groupsConfig = new Map();

function getGroupConfig(chatJid) {
    if (!groupsConfig.has(chatJid)) {
        groupsConfig.set(chatJid, {
            linkFilter: false,
            photoFilter: false,
            photoRestrictedUsers: new Set(),
            cooldownEnabled: false,
            cooldownTime: 4000,
            waitingForTagAll: new Set(),
            waitingForSetName: new Set(),
            isInactive: false,
            isLocked: false,
            onlyAdminMode: false,
            welcomeEnabled: true,
            protectionEnabled: true,
            offlineMode: false,
            protectedUsers: new Set()
        });
    }
    return groupsConfig.get(chatJid);
}

let OWNER_JID = "393534467571@s.whatsapp.net";
global.extraOwners = global.extraOwners || new Set([OWNER_JID]);

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
                conf.photoFilter = gConf.photoFilter || false;
                if (gConf.photoRestrictedUsers) {
                    conf.photoRestrictedUsers = new Set(gConf.photoRestrictedUsers);
                }
                if (gConf.protectedUsers) {
                    conf.protectedUsers = new Set(gConf.protectedUsers);
                }
            }
        }
    } catch (e) {}
}

function saveBotState() {
    try {
        const stateObj = {
            extraOwners: Array.from(global.extraOwners),
            groupsConfig: {}
        };
        for (let [gId, conf] of groupsConfig.entries()) {
            stateObj.groupsConfig[gId] = {
                onlyAdminMode: conf.onlyAdminMode,
                photoFilter: conf.photoFilter,
                photoRestrictedUsers: Array.from(conf.photoRestrictedUsers),
                protectedUsers: Array.from(conf.protectedUsers)
            };
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(stateObj, null, 2));
    } catch (e) {}
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

const isProtected = (jid, config) => {
    return isOwner(jid) || config.protectedUsers.has(jid);
};

// ⏱️ MOSTRA "STA SCRIVENDO" CON RITARDO DI ESATTAMENTE 2 SECONDI
async function sendHumanMessage(sock, chatJid, content, options = {}) {
    try {
        await sock.presenceSubscribe(chatJid).catch(() => {});
        await sock.sendPresenceUpdate('composing', chatJid).catch(() => {});

        // Attesa di 2 secondi (2000 ms)
        await new Promise(resolve => setTimeout(resolve, 2000));

        await sock.sendPresenceUpdate('paused', chatJid).catch(() => {});

        return await sock.sendMessage(chatJid, typeof content === 'string' ? { text: content, ...options } : content);
    } catch (err) {
        console.error("Errore invio messaggio:", err);
        return await sock.sendMessage(chatJid, typeof content === 'string' ? { text: content, ...options } : content);
    }
}

export async function execute(sock, m, chatJid, messageText, sender, isGroup) {
    try {
        if (!chatJid) chatJid = m.key.remoteJid;
        if (isGroup === undefined) isGroup = chatJid.endsWith('@g.us');
        if (!sender) sender = m.key.participant || chatJid;

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

        if (isGroup && m.messageStubType === 27 && config.welcomeEnabled) {
            const newMemberJid = m.messageStubParameters?.[0];
            if (newMemberJid) {
                try {
                    const metadata = await sock.groupMetadata(chatJid);
                    const desc = metadata.desc ? metadata.desc.trim() : "";
                    const groupName = metadata.subject || "questo gruppo";
                    
                    let welcomeText = `Buongiorno @${newMemberJid.split('@')[0]} e benvenuto/a nel gruppo ${groupName}\n\n`;
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

        if (isGroup && m.message?.imageMessage && !isOwner(sender, sock)) {
            const isUserRestricted = config.photoRestrictedUsers && config.photoRestrictedUsers.has(sender);
            if (config.photoFilter || isUserRestricted) {
                try {
                    await sock.sendMessage(chatJid, { delete: m.key });
                    await sendHumanMessage(sock, chatJid, `⚠️ @${sender.split('@')[0]}, non puoi inviare foto in questo gruppo! Il messaggio è stato rimosso per tutelare la privacy.`, { mentions: [sender] });
                    return true;
                } catch (err) {}
            }
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
            } catch (e) {}
        }

        const args = messageText.trim().split(/ +/);
        const command = args[0].toLowerCase();
        const targetMention = getTargetJid();

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
                    await sendHumanMessage(sock, chatJid, `✅ Orario di riaccensione automatica aggiornata alle ore **${timeValue}**!`);
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
                            await sendHumanMessage(sock, chatJid, "⚠️ Inserisci il nome o il numero da cercare.\nEsempio: `!getjid utente Mario` oppure `!getjid numero 393331234567`");
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
- !antiphoto on/off (@utente) 📸 - Blocco automatico foto non autorizzate (globale o utente)
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

                await sendHumanMessage(sock, chatJid, `✅ Il numero +${targetPhone} è stato inserito nella blacklist permanente.`);
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
                
                const type = parts[0]?.trim()?.toLowerCase();
                const details = parts[1]?.trim();

                if (!type || !details || (type !== 'nuova' && type !== 'rimossa')) {
                    await sendHumanMessage(sock, chatJid, 
                        "⚠️ Uso non corretto del comando.\n\n" +
                        "📌 **Esempi di utilizzo:**\n" +
                        "• `!annuncio nuova !parla multimodale | Ora puoi inviare foto, vocali e video!`\n" +
                        "• `!annuncio rimossa Comando X | Rimosso per manutenzione.`"
                    );
                    return true;
                }

                try {
                    let announcementText = type === 'nuova' 
                        ? `✨ **AGGIORNAMENTO BOT: NUOVA FUNZIONE** ✨\n\n${details}\n\n🤖 *Prova subito a provarla qui in chat!*`
                        : `🛠 **AGGIORNAMENTO BOT: FUNZIONE RIMOSSA** 🛠\n\n${details}\n\n📌 *Ci scusiamo per il disagio.*`;

                    await sendHumanMessage(sock, chatJid, announcementText);
                } catch (error) {
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

                        let mimeType = activeType === 'audio' ? "audio/mp4" : activeType === 'video' ? "video/mp4" : "image/jpeg";

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
                        await sendHumanMessage(sock, chatJid, "⚠️ Scrivi una domanda, un argomento o allega un'immagine/audio/video dopo il comando.");
                        return true;
                    }

                    const partsArray = [{ text: userQuery }];
                    if (mediaInlineData) {
                        partsArray.push(mediaInlineData);
                    }

                    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ role: 'user', parts: partsArray }],
                            tools: [{ googleSearch: {} }]
                        })
                    });

                    const data = await response.json();
                    
                    let aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || 
                                     (data?.error?.message ? `⚠️ Errore API: ${data.error.message}` : "Mi dispiace, non sono riuscito a elaborare una risposta valida.");

                    await sendHumanMessage(sock, chatJid, `🤖 **Google Gemini IA (3.8 Flash)**:\n\n${aiResponse}`);
                } catch (error) {
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
                    await sendHumanMessage(sock, chatJid, "⚠️ Nessuna chiave API configurata!");
                    return true;
                }

                try {
                    const prompt = `Effettua una ricerca aggiornata e rispondi in modo preciso ed esauriente in italiano alla seguente richiesta: ${searchQuery}`;
                    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ role: 'user', parts: [{ text: prompt }] }],
                            tools: [{ googleSearch: {} }]
                        })
                    });

                    const data = await response.json();
                    let webAnswer = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Mi dispiace, non sono riuscito a elaborare una risposta valida.";

                    await sendHumanMessage(sock, chatJid, `🌐 **Risposta Gemini Web**:\n\n${webAnswer}`);
                } catch (error) {
                    await sendHumanMessage(sock, chatJid, "❌ Si è verificato un errore durante la richiesta.");
                }
                return true;
            }

            case '!ripeti':
            case '!flood': {
                if (!isGroup) return true;
                
                const inputArgs = messageText.replace(/^(?:!ripeti|!flood)/i, '').trim().split(/\s+/);
                
                if (inputArgs.length < 2) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Uso corretto: !ripeti [messaggio] [numero]");
                    return true;
                }

                const count = parseInt(inputArgs[inputArgs.length - 1], 10);
                if (isNaN(count) || count <= 0 || count > 20) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Inserisci un numero valido alla fine (massimo 20 volte).");
                    return true;
                }

                const textToRepeat = inputArgs.slice(0, inputArgs.length - 1).join(' ');

                for (let i = 1; i <= count; i++) {
                    await sendHumanMessage(sock, chatJid, `${textToRepeat} (!loop_${i} - ${i}/${count})`);
                }
                return true;
            }

            case '!clearsender':
            case '!cleardue': {
                if (!isGroup || !targetMention) {
                    await sendHumanMessage(sock, chatJid, "⚠ Tagga l'utente di cui vuoi cancellare i messaggi (es. !clearsender @utente).");
                    return true;
                }

                const chatMap = groupMessages.get(chatJid);
                if (!chatMap || !chatMap.has(targetMention) || chatMap.get(targetMention).length === 0) {
                    await sendHumanMessage(sock, chatJid, "⚠ Nessun messaggio recente trovato per questo utente.", { mentions: [targetMention] });
                    return true;
                }

                const userMsgs = chatMap.get(targetMention);
                for (let msgObj of userMsgs) {
                    try {
                        await sock.sendMessage(chatJid, { delete: { remoteJid: chatJid, fromMe: false, id: msgObj.id, participant: targetMention } });
                    } catch (err) {}
                }

                chatMap.set(targetMention, []);
                await sendHumanMessage(sock, chatJid, `✅ Messaggi dell'utente eliminati con successo.`, { mentions: [targetMention] });
                return true;
            }

            case '!clearmetutto':
            case '!botclean': {
                const botList = botSentMessages.get(chatJid);
                if (!botList || botList.length === 0) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Non ci sono messaggi inviati da me in questa chat.");
                    return true;
                }

                for (let msgObj of botList) {
                    try {
                        await sock.sendMessage(chatJid, { delete: { remoteJid: chatJid, fromMe: true, id: msgObj.id } });
                    } catch (e) {}
                }

                botSentMessages.set(chatJid, []);
                await sendHumanMessage(sock, chatJid, `✅ Ho eliminato tutti i miei messaggi.`);
                return true;
            }

            case '!mute': {
                if (!targetMention) return true;
                mutedUsers.add(targetMention);
                await sendHumanMessage(sock, chatJid, `🔇 L'utente è stato mutato.`, { mentions: [targetMention] });
                return true;
            }

            case '!unmute': {
                if (!targetMention) return true;
                const targetClean = targetMention.split('@')[0];
                for (let u of mutedUsers) {
                    if (u === targetMention || u.split('@')[0] === targetClean) mutedUsers.delete(u);
                }
                await sendHumanMessage(sock, chatJid, `🔊 L'utente può tornare a scrivere.`, { mentions: [targetMention] });
                return true;
            }

            case '!warn': {
                if (!targetMention) return true;
                if (isProtected(targetMention, config)) {
                    await sendHumanMessage(sock, chatJid, `Non puoi ammonire un utente protetto! 🛡️`, { mentions: [targetMention] });
                    return true;
                }

                const currentWarns = (warnings.get(targetMention + chatJid) || 0) + 1;
                warnings.set(targetMention + chatJid, currentWarns);

                if (currentWarns < 3) {
                    await sendHumanMessage(sock, chatJid, `⚠ Avvertimento ${currentWarns}/3 registrato.`, { mentions: [targetMention] });
                } else {
                    warnings.delete(targetMention + chatJid);
                    await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                    await sendHumanMessage(sock, chatJid, `🚨 3 avvertimenti superati: utente espulso.`, { mentions: [targetMention] });
                }
                return true;
            }

            case '!rimuovi':
            case '!kick': {
                if (!isGroup || !targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                await sendHumanMessage(sock, chatJid, `Utente rimosso con successo.`, { mentions: [targetMention] });
                return true;
            }

            case '!masskick':
            case '!svuotagruppo': {
                if (!isGroup) return true;
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants.filter(p => !p.admin && !isProtected(p.id, config)).map(p => p.id);
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove");
                    await sendHumanMessage(sock, chatJid, "🧹 Membri non admin rimossi.");
                }
                return true;
            }

            case '!deletegroup':
            case '!eliminagruppo': {
                if (!isGroup) return true;
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants.filter(p => !isProtected(p.id, config)).map(p => p.id);
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove").catch(() => {});
                }
                await sock.groupLeave(chatJid);
                return true;
            }

            case '!promuovi': {
                if (!isGroup || !targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "promote");
                await sendHumanMessage(sock, chatJid, `Utente promosso ad admin.`, { mentions: [targetMention] });
                return true;
            }

            case '!demuovi':
            case '!quickdemote': {
                if (!isGroup || !targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "demote");
                await sendHumanMessage(sock, chatJid, `Poteri revocati.`, { mentions: [targetMention] });
                return true;
            }

            case '!multidemote': {
                if (!isGroup) return true;
                const targets = getAllMentionedJids();
                if (targets.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, targets, "demote");
                    await sendHumanMessage(sock, chatJid, `Admin multipli rimossi.`);
                }
                return true;
            }

            case '!editgroup': {
                if (!isGroup) return true;
                const mode = args[1];
                if (mode === 'on') {
                    await sock.groupSettingUpdate(chatJid, 'locked');
                    await sendHumanMessage(sock, chatJid, "🔒 Info modificabili solo dagli admin.");
                } else if (mode === 'off') {
                    await sock.groupSettingUpdate(chatJid, 'unlocked');
                    await sendHumanMessage(sock, chatJid, "🔓 Info modificabili da tutti.");
                }
                return true;
            }

            case '!chiedialessio': {
                const userMessage = messageText.replace(/^!chiedialessio/i, '').trim();
                if (userMessage) {
                    await sendHumanMessage(sock, OWNER_JID, `✉ Supporto da gruppo:\nUtente: @${sender.split('@')[0]}\nTesto:${userMessage}`, { mentions: [sender] });
                    await sendHumanMessage(sock, chatJid, "✉ Messaggio inoltrato ad Alessio.");
                }
                return true;
            }

            case '!tagall':
            case '!tutti': {
                if (isGroup) {
                    const inlineText = messageText.replace(/^(?:!tagall|!tutti)/i, '').trim();
                    const metadata = await sock.groupMetadata(chatJid);
                    const participants = metadata.participants.map(p => p.id);

                    if (!inlineText) {
                        config.waitingForTagAll.add(sender);
                        await sendHumanMessage(sock, chatJid, "📢 Scrivi il testo dell'avviso da inviare a tutti:");
                    } else {
                        let text = `📢 Attenzione a tutti ragazzi\n\n${inlineText}\n\n`;
                        for (let p of participants) text += `@${p.split('@')[0]} `;
                        await sendHumanMessage(sock, chatJid, text, { mentions: participants });
                    }
                }
                return true;
            }

            case '!poll': {
                const pollData = messageText.replace(/^!poll/i, '').trim().split(/\s+/);
                if (pollData[0] && pollData.slice(1).length > 1) {
                    await sock.sendMessage(chatJid, { poll: { name: pollData[0], values: pollData.slice(1) } });
                }
                return true;
            }

            case '!welcome': {
                if (isGroup) {
                    config.welcomeEnabled = args[1] === 'on';
                    await sendHumanMessage(sock, chatJid, `👋 Benvenuto ${args[1] === 'on' ? 'attivato' : 'disattivato'}.`);
                }
                return true;
            }

            case '!setname': {
                if (isGroup) {
                    const newName = messageText.replace(/^!setname/i, '').trim();
                    if (!newName) {
                        config.waitingForSetName.add(sender);
                        await sendHumanMessage(sock, chatJid, "🏷 Scrivi il nuovo nome per questo gruppo:");
                    } else {
                        await sock.groupUpdateSubject(chatJid, newName);
                        await sendHumanMessage(sock, chatJid, `🏷 Nome del gruppo aggiornato.`);
                    }
                }
                return true;
            }

            case '!link': {
                if (isGroup) {
                    config.linkFilter = args[1] === 'on';
                    await sendHumanMessage(sock, chatJid, `🌐 Filtro link ${args[1] === 'on' ? 'attivato' : 'disattivato'}.`);
                }
                return true;
            }

            case '!antiphoto': {
                if (!isGroup) return true;
                const mode = args[1]?.toLowerCase();

                if (mode === 'on') {
                    if (targetMention) {
                        config.photoRestrictedUsers.add(targetMention);
                        saveBotState();
                        await sendHumanMessage(sock, chatJid, `📸 Protezione anti-foto attivata per @${targetMention.split('@')[0]}.`, { mentions: [targetMention] });
                    } else {
                        config.photoFilter = true;
                        saveBotState();
                        await sendHumanMessage(sock, chatJid, "📸 Protezione anti-foto globale attivata nel gruppo.");
                    }
                } else if (mode === 'off') {
                    if (targetMention) {
                        config.photoRestrictedUsers.delete(targetMention);
                        saveBotState();
                        await sendHumanMessage(sock, chatJid, `📸 Protezione anti-foto disattivata per @${targetMention.split('@')[0]}.`, { mentions: [targetMention] });
                    } else {
                        config.photoFilter = false;
                        config.photoRestrictedUsers.clear();
                        saveBotState();
                        await sendHumanMessage(sock, chatJid, "📸 Protezione anti-foto completamente disattivata.");
                    }
                } else {
                    await sendHumanMessage(sock, chatJid, "⚠️ Uso: `!antiphoto on`, `!antiphoto on @utente`, `!antiphoto off`, `!antiphoto off @utente`");
                }
                return true;
            }

            case '!cooldown': {
                if (isGroup) {
                    config.cooldownEnabled = args[1] === 'on';
                    await sendHumanMessage(sock, chatJid, `⏱ Cooldown ${args[1] === 'on' ? 'attivato' : 'disattivato'}.`);
                }
                return true;
            }

            case '!aggiungiowner':
            case '!addowner':
            case '!nuovocoowner': {
                if (!isOwner(sender, sock) || !targetMention) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Tagga l'utente da promuovere ad owner.");
                    return true;
                }

                global.extraOwners.add(targetMention);
                config.protectedUsers.add(targetMention);
                saveBotState();

                await sendHumanMessage(sock, chatJid, `👑 Utente aggiunto tra i co-owner ed ora protetto.`, { mentions: [targetMention] });
                return true;
            }

            case '!rimuoviowner':
            case '!delowner': {
                if (!isOwner(sender, sock) || !targetMention) {
                    await sendHumanMessage(sock, chatJid, "⚠️ Tagga l'utente da rimuovere dai co-owner.");
                    return true;
                }

                global.extraOwners.delete(targetMention);
                config.protectedUsers.delete(targetMention);
                saveBotState();

                await sendHumanMessage(sock, chatJid, `🛡 Utente rimosso dai co-owner.`, { mentions: [targetMention] });
                return true;
            }

            case '!blockuser': {
                if (!isOwner(sender, sock) || !targetMention) return true;
                blacklist.add(targetMention);
                await sendHumanMessage(sock, chatJid, "🚫 Utente inserito nella blacklist globale.", { mentions: [targetMention] });
                return true;
            }

            case '!unblockuser': {
                if (!isOwner(sender, sock) || !targetMention) return true;
                blacklist.delete(targetMention);
                await sendHumanMessage(sock, chatJid, "✅ Utente rimosso dalla blacklist globale.", { mentions: [targetMention] });
                return true;
            }

            case '!cleandb': {
                if (!isOwner(sender, sock)) return true;
                warnings.clear();
                await sendHumanMessage(sock, chatJid, "🗄 Pulizia database completata.");
                return true;
            }

            case '!gruppo': {
                if (!isOwner(sender, sock)) return true;
                const action = args[1]?.toLowerCase();
                const targetGroupArg = args[2] || args.slice(2).join(' ');

                if (targetGroupArg && (action === 'off' || action === 'on')) {
                    let targetChatJid = targetGroupArg.trim();
                    if (!targetChatJid.endsWith('@g.us')) targetChatJid += '@g.us';

                    const targetConfig = getGroupConfig(targetChatJid);
                    targetConfig.isInactive = (action === 'off');
                    await sendHumanMessage(sock, chatJid, `🤖 Bot ${action === 'off' ? 'disattivato' : 'riattivato'} nel gruppo \`${targetChatJid}\``);
                    return true;
                }

                if (isGroup) {
                    config.isInactive = (action === 'off');
                    await sendHumanMessage(sock, chatJid, `🤖 Bot ${action === 'off' ? 'disattivato' : 'riattivato'} in questo gruppo.`);
                }
                return true;
            }
        }
    } catch (error) {
        console.error("Errore:", error);
    }
    return false;
}

export async function handleGroupParticipantsUpdate(sock, update) {
    const { id: chatJid, participants, action } = update;
    
    if (action === 'add') {
        const phoneBlacklist = loadPhoneBlacklist();
        for (let participantJid of participants) {
            const phoneNumber = participantJid.replace(/[^0-9]/g, '');
            if (phoneBlacklist.includes(phoneNumber)) {
                try {
                    await sock.groupParticipantsUpdate(chatJid, [participantJid], "remove");
                    await sock.sendMessage(chatJid, { text: `⚠ **Tentativo di elusione bloccato**: Il numero +${phoneNumber} è nella blacklist permanente.`, mentions: [participantJid] });
                } catch (e) {}
            }
        }
    }
}
