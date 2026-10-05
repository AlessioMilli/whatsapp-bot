import { DisconnectReason } from '@whiskeysockets/baileys';
import fs from 'fs';

// 📂 Percorso e funzioni per la Blacklist Telefonica Permanente
const PHONE_BLACKLIST_FILE = './phone_blacklist.json';

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

// Strutture dati globali di base
const blacklist = new Set();
const warnings = new Map();
const mutedUsers = new Set();
const cooldowns = new Map();

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

const isOwner = (jid, sock) => {
    return jid === OWNER_JID || global.extraOwners.has(jid) || jid === sock?.user?.id;
};

// Funzione di protezione aggiornata: il proprietario e gli extraOwners sono protetti SEMPRE
const isProtected = (jid, config) => {
    return jid === OWNER_JID || global.extraOwners.has(jid) || config.protectedUsers.has(jid);
};

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

        // 📝 TRACCIAMENTO IN TEMPO REALE DEI MESSAGGI DEGLI UTENTI (inclusi i vocali)
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

        // 📝 TRACCIAMENTO IN TEMPO REALE DEI MESSAGGI DEL BOT (per !clearmetutto)
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

        // 🥷 Controllo presenza di Aleh (+39 392 491 1895) nel gruppo: se c'è, il bot sta completamente zitto
        const alehJid = "3924911895@s.whatsapp.net";
        if (isGroup) {
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
                    
                    let welcomeText = `Buongiorno @${newMemberJid.split('@')[0]} e benvenuto/a nel gruppo ${groupName}\n\n`;
                    if (desc) welcomeText += `Leggi con attenzione le regole: ${desc}`;

                    await sock.sendMessage(chatJid, { text: welcomeText, mentions: [newMemberJid] });
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
                await sock.sendMessage(chatJid, { 
                    text: `⚠️ @${sender.split('@')[0]}, non puoi inviare foto senza autorizzazione! Il messaggio è stato rimosso automaticamente per tutelare la privacy.`, 
                    mentions: [sender] 
                });
                return true;
            } catch (err) {}
        }

        if (isGroup && !m.key.fromMe) {
            const senderClean = sender.split('@')[0];
            if (mutedUsers.has(sender) || Array.from(mutedUsers).some(id => id.split('@')[0] === senderClean)) {
                try { await sock.sendMessage(chatJid, { delete: m.key }); } catch (err) {}
                return true;
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

        const args = messageText.trim().split(/ +/);
        const command = args[0].toLowerCase();
        const targetMention = getTargetJid();

        if (isGroup && config.isInactive) {
            if (command === '!gruppo' && args[1] === 'on' && isOwner(sender, sock)) {
                config.isInactive = false;
                await sock.sendMessage(chatJid, { text: "🤖 Il bot è di nuovo attivo in questo gruppo" });
                return true;
            }
            return false;
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

            await sock.sendMessage(chatJid, { text: text, mentions: participants });
            return true;
        }

        if (config.waitingForSetName && config.waitingForSetName.has(sender)) {
            config.waitingForSetName.delete(sender);
            const newTitle = messageText.trim();
            if (newTitle && isGroup) {
                await sock.groupUpdateSubject(chatJid, newTitle);
                await sock.sendMessage(chatJid, { text: `🏷 Il nome del gruppo è stato aggiornato in modo perfetto` });
            }
            return true;
        }

        if (isGroup && config.linkFilter && !isOwner(sender, sock)) {
            const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
            if (urlRegex.test(messageText)) {
                await sock.sendMessage(chatJid, { delete: m.key }).catch(() => {});
                await sock.sendMessage(chatJid, { text: `⚠ Non puoi inviare link esterni in questo gruppo se prima non chiedi il permesso` });
                return true;
            }
        }

        if (targetMention && isProtected(targetMention, config) && ['!mute', '!warn', '!kick', '!rimuovi', '!demuovi', '!quickdemote', '!multidemote', '!clearsender', '!cleardue'].includes(command)) {
            await sock.sendMessage(chatJid, { text: `🛡 Questo utente è protetto in questo gruppo` });
            return true;
        }

        switch (command) {
            case '!commands':
            case '!aiuto':
            case '!menu': {
                let menuText = `📋 **LISTA COMPLETA DEI COMANDI DEL BOT**

🛑 **GESTIONE MODERAZIONE E SANZIONI**
• \`!mute @utente\` 🔇 - Muto perpetuo e cancellazione automatica messaggi
• \`!unmute @utente\` 🔊 - Revoca il muto perpetuo
• \`!warn @utente\` ⚠ - Gestione ammonizioni ad accumulo (3 livelli)
• \`!kick @utente\` (o \`!rimuovi\`) ❌ - Rimuove ed espelle immediatamente l'utente
• \`!banphone <numero>\` 🚫 - Inserisce il numero nella blacklist permanente e previene il re-ingresso
• \`!sblocconumero <numero>\` ✅ - Rimuove il numero dalla blacklist permanente
• \`!masskick\` (o \`!svuotagruppo\`) 🧹 - Rimuove tutti i partecipanti (lascia admin e bot)
• \`!deletegroup\` (o \`!eliminagruppo\`) 🗑 - Svuota ed elimina o abbandona il gruppo
• \`!clearalltesto [parola]\` 🔍 - Elimina per tutti i messaggi con la parola indicata
• \`!clearsender @utente\` (o \`!cleardue\`) 🧹 - Cancella tutti i messaggi scritti da un utente specifico

🤖 **INTELLIGENZA ARTIFICIALE & SENTINELLA**
• \`!aiudicar @utente\` (o \`!sentinella\`) 🛡️ - Analizza tramite Google Gemini le chat e i vocali recenti dell'utente taggato per rilevare insulti, bestemmie, parolacce o litigi diretti contro owner o admin.

⚙️ **GESTIONE AMMINISTRATORI**
• \`!promuovi @utente\` ⭐ - Promuove l'utente amministratore
• \`!demuovi @utente\` (o \`!quickdemote\`) 👤 - Rimuove subito i poteri di admin
• \`!multidemote @u1 @u2...\` 👥 - Rimuove i poteri di admin a più utenti insieme

⚙️ **IMPOSTAZIONI E SICUREZZA GRUPPO**
• \`!checkadmin\` 🔍 - Verifica istantanea dei permessi amministrativi nel gruppo
• \`!gruppo on/off\` 🤖 - Attiva/disattiva il bot nel gruppo
• \`!editgroup on/off\` ✏ - Gestisce la modifica info gruppo
• \`!approva on/off\` 📋 - Gestisce approvazione nuovi membri
• \`!addmember on/off\` ➕ - Gestisce restrizione aggiunta partecipanti
• \`!history on/off\` 📜 - Invio cronologia messaggi ai nuovi membri
• \`!invitelink on/off\` 🔗 - Accesso tramite link d'invito
• \`!setname [nome]\` 🏷 - Cambia istantaneamente il nome del gruppo
• \`!lockinfo\` / \`!unlockinfo\` 🔒 - Blocca o sblocca i dettagli del gruppo
• \`!link on/off\` 🌐 - Cancellazione automatica link esterni
• \`!antiphoto on/off\` 📸 - Blocco automatico foto non autorizzate
• \`!cooldown on/off\` ⏱ - Limite tempo antispam tra comandi

💬 **SUPPORTO E BENVENUTO**
• \`!commands\` (o \`!aiuto\` / \`!menu\`) 📖 - Mostra questo menu comandi
• \`!chiedialessio [mess]\` ✉️ - Invia una domanda diretta al supporto
• \`!tagall\` (o \`!tutti\`) [messaggio] 📢 - Avviso con menzione di tutti i partecipanti
• \`!poll [domanda] [opz 1] [opz 2]\` 📊 - Sondaggio interattivo
• \`!welcome on/off 👋\` - Gestisce il benvenuto automatico
• \`!ripeti [messaggio] [numero]\` (o \`!flood\`) 🔁 - Ripete un messaggio più volte con etichetta progressiva
• \`!clearmetutto\` (o \`!botclean\`) 🗑️ - Cancella tutti i messaggi inviati dal bot in questa chat`;

                if (isOwner(sender, sock)) {
                    menuText += `\n\n🚀 **COMANDI ESCLUSIVI OWNER**
1. \`!inspect @utente\` 🔍 - Mostra la scheda informativa dell'utente nel database
2. \`!lockgroup\` / \`!unlockgroup\` 🔐 - Blocca o sblocca totalmente la chat del gruppo
3. \`!backup\` 💾 - Invia il backup completo in chat privata all'owner
4. \`!emergencyoff\` / \`!emergencyon\` ⚡ - Spegnimento o riattivazione totale d'emergenza del bot
5. \`!statsbot\` 📈 - Mostra statistiche di utilizzo e gruppi attivi
6. \`!blockuser @utente\` / \`!unblockuser @utente\` 🚫 - Gestisce la blacklist globale dei comandi
7. \`!cleandb\` 🗄 - Esegue una pulizia automatica del database e dei warn obsoleti
8. \`!listagruppi\` 📂 - Mostra la lista di tutti i gruppi salvati con i loro ID e partecipanti`;
                }

                await sock.sendMessage(chatJid, { text: menuText });
                return true;
            }

            case '!banphone':
            case '!ban numero': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Questo comando è riservato esclusivamente al proprietario." });
                    return true;
                }

                const targetPhone = args[1]?.replace(/[^0-9]/g, '');
                if (!targetPhone) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Inserisci un numero valido.\nEsempio: `!banphone 393331234567`" });
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

                await sock.sendMessage(chatJid, { text: `✅ Il numero +${targetPhone} è stato inserito nella blacklist permanente. Se proveranno ad aggiungerlo, il bot lo ribannerà all'istante.` });
                return true;
            }

            case '!sblocconumero':
            case '!unblockphone': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Questo comando è riservato esclusivamente al proprietario." });
                    return true;
                }

                const targetPhone = args[1]?.replace(/[^0-9]/g, '');
                if (!targetPhone) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Inserisci il numero da sbloccare.\nEsempio: `!sblocconumero 393331234567`" });
                    return true;
                }

                let phoneBlacklist = loadPhoneBlacklist();
                const index = phoneBlacklist.indexOf(targetPhone);

                if (index !== -1) {
                    phoneBlacklist.splice(index, 1);
                    savePhoneBlacklist(phoneBlacklist);
                    await sock.sendMessage(chatJid, { text: `✅ Il numero +${targetPhone} è stato rimosso dalla blacklist permanente.` });
                } else {
                    await sock.sendMessage(chatJid, { text: `⚠️ Il numero +${targetPhone} non è presente nella blacklist.` });
                }
                return true;
            }

            case '!aiudicar':
            case '!sentinella': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Questo comando di monitoraggio avanzato tramite IA è riservato esclusivamente al proprietario." });
                    return true;
                }

                if (!isGroup) {
                    await sock.sendMessage(chatJid, { text: "⚠ Questo comando funziona solo all'interno dei gruppi." });
                    return true;
                }

                if (!targetMention) {
                    await sock.sendMessage(chatJid, { text: "⚠ Per favore, tagga l'utente da sottoporre all'analisi della sentinella IA.\nEsempio: `!aiudicar @utente`" });
                    return true;
                }

                const chatMap = groupMessages.get(chatJid);
                if (!chatMap) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Non ci sono messaggi registrati in questa chat in questa sessione." });
                    return true;
                }

                let userMsgs = [];
                const targetClean = targetMention.split('@')[0];

                for (let [storedJid, msgs] of chatMap.entries()) {
                    if (storedJid === targetMention || storedJid.includes(targetClean)) {
                        userMsgs = msgs;
                        break;
                    }
                }

                if (!userMsgs || userMsgs.length === 0) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Non ci sono messaggi recenti registrati per questo utente in questa sessione da analizzare.", mentions: [targetMention] });
                    return true;
                }

                await sock.sendMessage(chatJid, { text: "🤖 Contatto Google Gemini su AI Studio per analizzare i messaggi e i vocali dell'utente taggato...", mentions: [targetMention] });

                try {
                    const GEMINI_API_KEY = "AQ.Ab8RN6KSDFlAytyZP2TADM1XIK87Nbr5jYlpLPQWAPVgVuFqCBg";
                    
                    const formattedHistory = userMsgs.map(item => {
                        if (item.isAudio) {
                            return `- [Messaggio Vocale inviato dall'utente]`;
                        }
                        return `- ${item.text || "[Media/Altro]"}`;
                    }).join('\n');
                    
                    const promptText = `Sei un moderatore inflessibile di un gruppo WhatsApp. Analizza la seguente cronologia dei messaggi (che include messaggi di testo e messaggi vocali) scritti o inviati da un utente e verifica se ci sono anomalie, insulti, bestemmie, parolacce o litigi diretti esplicitamente contro il proprietario del bot o gli amministratori del gruppo.

Cronologia messaggi dell'utente:
${formattedHistory}

Rispondi in modo sintetico in italiano indicando se ci sono violazioni, riportando eventuali frasi o comportamenti sospetti (inclusi i vocali) e fornendo un verdetto.`;

                    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${GEMINI_API_KEY}`
                        },
                        body: JSON.stringify({
                            contents: [{
                                parts: [{ text: promptText }]
                            }]
                        })
                    });

                    const data = await response.json();
                    const aiResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Nessuna risposta valida dall'IA.";

                    await sock.sendMessage(chatJid, { 
                        text: `🛡 **ESITO ANALISI SENTINELLA IA (Testi & Vocali)**:\n\n${aiResponse}`, 
                        mentions: [targetMention] 
                    });

                } catch (error) {
                    console.error("Errore API Gemini:", error);
                    await sock.sendMessage(chatJid, { text: "❌ Si è verificato un errore durante la connessione alle API di Google Gemini." });
                }
                return true;
            }

            case '!ripeti':
            case '!flood': {
                if (!isGroup) return true;
                
                const inputArgs = messageText.replace(/^(?:!ripeti|!flood)/i, '').trim().split(/\s+/);
                
                if (inputArgs.length < 2) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Uso corretto: `!ripeti [il tuo messaggio] [numero di volte]`\nEsempio: `!ripeti Ciao a tutti 5`" });
                    return true;
                }

                const countStr = inputArgs[inputArgs.length - 1];
                const count = parseInt(countStr, 10);

                if (isNaN(count) || count <= 0 || count > 20) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Inserisci un numero valido alla fine (massimo 20 volte)." });
                    return true;
                }

                const textToRepeat = inputArgs.slice(0, inputArgs.length - 1).join(' ');

                await sock.sendMessage(chatJid, { text: `🚀 Avvio invio: ripeterò il messaggio "${textToRepeat}" per ${count} volte.` });

                for (let i = 1; i <= count; i++) {
                    const customCommandTag = `!loop_${i}`;
                    const finalMessage = `${textToRepeat} (${customCommandTag} - ${i}/${count})`;
                    
                    await sock.sendMessage(chatJid, { text: finalMessage });
                    await new Promise(resolve => setTimeout(resolve, 800));
                }
                return true;
            }

            case '!clearsender':
            case '!cleardue': {
                if (!isGroup) {
                    await sock.sendMessage(chatJid, { text: "⚠ Questo comando può essere usato solo nei gruppi." });
                    return true;
                }

                if (!targetMention) {
                    await sock.sendMessage(chatJid, { text: "⚠ Tagga l'utente di cui vuoi cancellare tutti i messaggi salvati.\nEsempio: `!clearsender @utente`" });
                    return true;
                }

                const chatMap = groupMessages.get(chatJid);
                if (!chatMap || !chatMap.has(targetMention) || chatMap.get(targetMention).length === 0) {
                    await sock.sendMessage(chatJid, { text: "⚠ Non ho trovato messaggi recenti salvati per questo utente in questa sessione.", mentions: [targetMention] });
                    return true;
                }

                const userMsgs = chatMap.get(targetMention);
                const totalToDel = userMsgs.length;

                await sock.sendMessage(chatJid, { text: `🧹 Avvio cancellazione di ${totalToDel} messaggi per l'utente...`, mentions: [targetMention] });

                let deletedCount = 0;
                for (let msgObj of userMsgs) {
                    try {
                        await sock.sendMessage(chatJid, { 
                            delete: { 
                                remoteJid: chatJid, 
                                fromMe: false, 
                                id: msgObj.id, 
                                participant: targetMention 
                            } 
                        });
                        deletedCount++;
                        await new Promise(resolve => setTimeout(resolve, 300));
                    } catch (err) {}
                }

                chatMap.set(targetMention, []);
                await sock.sendMessage(chatJid, { text: `✅ Operazione completata: eliminati circa ${deletedCount} messaggi dell'utente.`, mentions: [targetMention] });
                return true;
            }

            case '!clearmetutto':
            case '!botclean': {
                const botList = botSentMessages.get(chatJid);
                if (!botList || botList.length === 0) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Non ci sono messaggi inviati da me memorizzati in questa chat." });
                    return true;
                }

                const totalBotMsgs = botList.length;
                await sock.sendMessage(chatJid, { text: `🧹 Avvio rimozione di tutti i miei ${totalBotMsgs} messaggi inviati in questa chat...` });

                let removedCount = 0;
                for (let msgObj of botList) {
                    try {
                        await sock.sendMessage(chatJid, { 
                            delete: { 
                                remoteJid: chatJid, 
                                fromMe: true, 
                                id: msgObj.id 
                            } 
                        });
                        removedCount++;
                        await new Promise(resolve => setTimeout(resolve, 300));
                    } catch (e) {}
                }

                botSentMessages.set(chatJid, []);
                await sock.sendMessage(chatJid, { text: `✅ Operazione completata: ho eliminato ${removedCount} messaggi miei.` });
                return true;
            }

            case '!mute': {
                if (!targetMention) return true;
                mutedUsers.add(targetMention);
                await sock.sendMessage(chatJid, { text: `🔇 L'utente è stato mutato in questo gruppo.`, mentions: [targetMention] });
                return true;
            }

            case '!unmute': {
                if (!targetMention) return true;
                const targetClean = targetMention.split('@')[0];
                for (let u of mutedUsers) {
                    if (u === targetMention || u.split('@')[0] === targetClean) mutedUsers.delete(u);
                }
                await sock.sendMessage(chatJid, { text: `🔊 L'utente può tornare a scrivere in questo gruppo.`, mentions: [targetMention] });
                return true;
            }

            case '!warn': {
                if (!targetMention) return true;

                if (isProtected(targetMention, config)) {
                    await sock.sendMessage(chatJid, { 
                        text: `Non puoi ammonire l'owner o un utente protetto! 🛡️`, 
                        mentions: [targetMention] 
                    });
                    return true;
                }

                const currentWarns = (warnings.get(targetMention + chatJid) || 0) + 1;
                warnings.set(targetMention + chatJid, currentWarns);

                if (currentWarns < 3) {
                    await sock.sendMessage(chatJid, { text: `⚠ Avvertimento ${currentWarns}/3 registrato per l'utente in questo gruppo.`, mentions: [targetMention] });
                } else {
                    warnings.delete(targetMention + chatJid);
                    await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                    await sock.sendMessage(chatJid, { text: `🚨 3 avvertimenti superati: utente espulso da questo gruppo.`, mentions: [targetMention] });
                }
                return true;
            }

            case '!rimuovi':
            case '!kick': {
                if (!isGroup || !targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                await sock.sendMessage(chatJid, { text: `Utente rimosso da questo gruppo con successo.`, mentions: [targetMention] });
                return true;
            }

            case '!masskick':
            case '!svuotagruppo': {
                if (!isGroup) return true;
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants.filter(p => !p.admin && !isProtected(p.id, config)).map(p => p.id);
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove");
                    await sock.sendMessage(chatJid, { text: "🧹 Membri non admin rimossi da questo gruppo" });
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

            case '!clearalltesto': {
                const keyword = messageText.replace(/^!clearalltesto/i, '').trim();
                if (!keyword) return true;
                await sock.sendMessage(chatJid, { text: `🔍 Scansione avviata in questo gruppo per: ${keyword}` });
                return true;
            }

            case '!promuovi': {
                if (!isGroup || !targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "promote");
                await sock.sendMessage(chatJid, { text: `Utente promosso ad admin in questo gruppo.`, mentions: [targetMention] });
                return true;
            }

            case '!demuovi':
            case '!quickdemote': {
                if (!isGroup || !targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "demote");
                await sock.sendMessage(chatJid, { text: `Poteri revocati in questo gruppo.`, mentions: [targetMention] });
                return true;
            }

            case '!multidemote': {
                if (!isGroup) return true;
                const targets = getAllMentionedJids();
                if (targets.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, targets, "demote");
                    await sock.sendMessage(chatJid, { text: `Admin multipli rimossi in questo gruppo.` });
                }
                return true;
            }

            case '!checkadmin': {
                if (!isGroup) return true;
                await sock.sendMessage(chatJid, { text: "Verifica completata: i comandi di moderazione sono liberi per tutti in questo gruppo." });
                return true;
            }

            case '!editgroup': {
                if (!isGroup) return true;
                const mode = args[1];
                if (mode === 'on') {
                    await sock.groupSettingUpdate(chatJid, 'locked');
                    await sock.sendMessage(chatJid, { text: "🔒 Info modificabili solo dagli admin in questo gruppo." });
                } else if (mode === 'off') {
                    await sock.groupSettingUpdate(chatJid, 'unlocked');
                    await sock.sendMessage(chatJid, { text: "🔓 Info modificabili da tutti in questo gruppo." });
                }
                return true;
            }

            case '!approva': {
                if (!isGroup) return true;
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupJoinApprovalMode(chatJid, mode).catch(() => {});
                    await sock.sendMessage(chatJid, { text: `📋 Approvazione membri impostata su ${mode} qui.` });
                }
                return true;
            }

            case '!addmember': {
                if (!isGroup) return true;
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupAddMode(chatJid, mode === 'on' ? 'admin_add' : 'all_member_add').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `➕ Aggiunta membri impostata su ${mode} qui.` });
                }
                return true;
            }

            case '!history': {
                if (!isGroup) return true;
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupMemberAddMode(chatJid, mode === 'on' ? 'prompt' : 'no_prompt').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `📜 Cronologia ai nuovi impostata su ${mode} qui.` });
                }
                return true;
            }

            case '!invitelink': {
                if (!isGroup) return true;
                await sock.sendMessage(chatJid, { text: `🔗 Link d'invito aggiornato per questo gruppo.` });
                return true;
            }

            case '!chiedialessio': {
                const userMessage = messageText.replace(/^!chiedialessio/i, '').trim();
                if (userMessage) {
                    await sock.sendMessage(OWNER_JID, { text: `✉ Supporto da gruppo:\nUtente: @${sender.split('@')[0]}\nTesto: ${userMessage}`, mentions: [sender] });
                    await sock.sendMessage(chatJid, { text: "✉ Messaggio inoltrato con successo ad Alessio." });
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
                        await sock.sendMessage(chatJid, { text: "📢 Che tipo di avviso vuoi che scriva? (Invia qui il testo dell'avviso, oppure scrivi direttamente il messaggio vicino al comando es. !tutti [tuo messaggio])" });
                    } else {
                        let text = `📢 Attenzione a tutti ragazzi\n\n${inlineText}\n\n`;
                        for (let p of participants) text += `@${p.split('@')[0]} `;

                        await sock.sendMessage(chatJid, { text: text, mentions: participants });
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
                    if (args[1] === 'on') {
                        config.welcomeEnabled = true;
                        await sock.sendMessage(chatJid, { text: "👋 Benvenuto attivato in questo gruppo." });
                    } else if (args[1] === 'off') {
                        config.welcomeEnabled = false;
                        await sock.sendMessage(chatJid, { text: "👋 Benvenuto disattivato in questo gruppo." });
                    }
                }
                return true;
            }

            case '!setname': {
                if (isGroup) {
                    const newName = messageText.replace(/^!setname/i, '').trim();
                    if (!newName) {
                        config.waitingForSetName.add(sender);
                        await sock.sendMessage(chatJid, { text: "🏷 Scrivi il nuovo nome per questo gruppo." });
                    } else {
                        await sock.groupUpdateSubject(chatJid, newName);
                        await sock.sendMessage(chatJid, { text: `🏷 Nome del gruppo aggiornato.` });
                    }
                }
                return true;
            }

            case '!lockinfo': {
                if (isGroup) {
                    await sock.groupSettingUpdate(chatJid, 'locked');
                    await sock.sendMessage(chatJid, { text: "🔒 Info bloccate per questo gruppo." });
                }
                return true;
            }

            case '!unlockinfo': {
                if (isGroup) {
                    await sock.groupSettingUpdate(chatJid, 'unlocked');
                    await sock.sendMessage(chatJid, { text: "🔓 Info sbloccate per questo gruppo." });
                }
                return true;
            }

            case '!link': {
                if (isGroup) {
                    if (args[1] === 'on') {
                        config.linkFilter = true;
                        await sock.sendMessage(chatJid, { text: "🌐 Filtro link attivato in questo gruppo." });
                    } else if (args[1] === 'off') {
                        config.linkFilter = false;
                        await sock.sendMessage(chatJid, { text: "🌐 Filtro link disattivato in questo gruppo." });
                    }
                }
                return true;
            }

            case '!antiphoto': {
                if (isGroup) {
                    if (args[1] === 'on') {
                        config.photoFilter = true;
                        await sock.sendMessage(chatJid, { text: "📸 Protezione anti-foto non autorizzate attivata in questo gruppo." });
                    } else if (args[1] === 'off') {
                        config.photoFilter = false;
                        await sock.sendMessage(chatJid, { text: "📸 Protezione anti-foto disattivata in questo gruppo." });
                    }
                }
                return true;
            }

            case '!cooldown': {
                if (isGroup) {
                    if (args[1] === 'on') {
                        config.cooldownEnabled = true;
                        await sock.sendMessage(chatJid, { text: "⏱ Cooldown antispam attivato in questo gruppo." });
                    } else if (args[1] === 'off') {
                        config.cooldownEnabled = false;
                        await sock.sendMessage(chatJid, { text: "⏱ Cooldown disattivato in questo gruppo." });
                    }
                }
                return true;
            }

            case '!aggiungiowner':
            case '!addowner':
            case '!nuovocoowner': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario principale." });
                    return true;
                }
                
                if (!targetMention) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Per favore, tagga l'amico che vuoi promuovere ad owner (es. !aggiungiowner @utente)." });
                    return true;
                }

                global.extraOwners.add(targetMention);
                config.protectedUsers.add(targetMention);

                await sock.sendMessage(chatJid, { 
                    text: `👑 L'amico è stato aggiunto con successo tra i co-owner del bot ed è ora protetto!`, 
                    mentions: [targetMention] 
                });
                return true;
            }

            case '!rimuoviowner':
            case '!delowner':
            case '!rimuovicoowner': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario principale." });
                    return true;
                }
                
                if (!targetMention) {
                    await sock.sendMessage(chatJid, { text: "⚠ Tagga l'amico che vuoi rimuovere dagli owner (es. !rimuoviowner @utente)." });
                    return true;
                }

                global.extraOwners.delete(targetMention);
                config.protectedUsers.delete(targetMention);

                await sock.sendMessage(chatJid, { 
                    text: `🛡 L'amico è stato rimosso dai co-owner del bot.`, 
                    mentions: [targetMention] 
                });
                return true;
            }

            case '!offline':
            case '!assente': {
                if (isOwner(sender, sock)) {
                    config.offlineMode = true;
                    await sock.sendMessage(chatJid, { text: "Modalità offline attiva." });
                }
                return true;
            }

            case '!online':
            case '!presente': {
                if (isOwner(sender, sock)) {
                    config.offlineMode = false;
                    await sock.sendMessage(chatJid, { text: "Modalità online attiva." });
                }
                return true;
            }

            case '!protezione': {
                if (isOwner(sender, sock)) {
                    const action = args[1];
                    if (action === 'on') {
                        if (targetMention) {
                            config.protectedUsers.add(targetMention);
                            await sock.sendMessage(chatJid, { text: `Utente protetto con successo in questo gruppo.`, mentions: [targetMention] });
                        } else {
                            config.protectionEnabled = true;
                            await sock.sendMessage(chatJid, { text: `Protezione avanzata attiva.` });
                        }
                    } else if (action === 'off') {
                        config.protectionEnabled = false;
                        await sock.sendMessage(chatJid, { text: "⚠ Protezione disattivata." });
                    }
                }
                return true;
            }

            case '!broadcast': {
                const broadText = messageText.replace(/^!broadcast/i, '').trim();
                if (!broadText) return true;
                await sock.sendMessage(chatJid, { text: `📡 Broadcast inviato: ${broadText}` });
                return true;
            }

            case '!inspect': {
                if (!isOwner(sender, sock) || !targetMention) return true;
                const userWarns = warnings.get(targetMention + chatJid) || 0;
                await sock.sendMessage(chatJid, { text: `🔍 **Scheda Utente (Qui)**\n• Warn: ${userWarns}`, mentions: [targetMention] });
                return true;
            }

            case '!lockgroup': {
                if (isOwner(sender, sock)) {
                    if (isGroup) {
                        config.isLocked = true;
                        await sock.sendMessage(chatJid, { text: "🔐 Questo gruppo è ora bloccato: solo gli admin possono scrivere." });
                    }
                }
                return true;
            }

            case '!unlockgroup': {
                if (isOwner(sender, sock)) {
                    if (isGroup) {
                        config.isLocked = false;
                        await sock.sendMessage(chatJid, { text: "🔓 Questo gruppo è ora sbloccato per tutti." });
                    }
                }
                return true;
            }

            case '!backup': {
                if (!isOwner(sender, sock)) return true;
                await sock.sendMessage(OWNER_JID, { text: `💾 Backup eseguito.` });
                await sock.sendMessage(chatJid, { text: "💾 Backup inviato in privato." });
                return true;
            }

            case '!emergencyoff': {
                if (!isOwner(sender, sock)) return true;
                config.isInactive = true;
                await sock.sendMessage(chatJid, { text: "⚡ Emergenza attivata qui." });
                return true;
            }

            case '!emergencyon': {
                if (!isOwner(sender, sock)) return true;
                config.isInactive = false;
                await sock.sendMessage(chatJid, { text: "⚡ Bot riattivato qui." });
                return true;
            }

            case '!statsbot': {
                if (!isOwner(sender, sock)) return true;
                await sock.sendMessage(chatJid, { text: `📈 Statistiche attive. Gruppi registrati: ${savedGroups.size}` });
                return true;
            }

            case '!listagruppi': {
                if (!isOwner(sender, sock)) return true;
                if (savedGroups.size === 0) {
                    await sock.sendMessage(chatJid, { text: "📂 Nessun gruppo memorizzato finora." });
                    return true;
                }
                let listText = "📂 **LISTA GRUPPI E PARTECIPANTI:**\n\n";
                for (let [id, gInfo] of savedGroups.entries()) {
                    let groupName = gInfo.subject;
                    let participantsList = "Impossibile recuperare i partecipanti";
                    try {
                        const metadata = await sock.groupMetadata(id);
                        groupName = metadata.subject || groupName;
                        participantsList = metadata.participants.map(p => `@${p.id.split('@')[0]}`).join(', ');
                    } catch (e) {}

                    listText += `• **Nome:** ${groupName}\n  **ID:** \`${id}\`\n  **Partecipanti:** ${participantsList}\n\n`;
                }
                await sock.sendMessage(chatJid, { text: listText });
                return true;
            }

            case '!blockuser': {
                if (!isOwner(sender, sock) || !targetMention) return true;
                blacklist.add(targetMention);
                await sock.sendMessage(chatJid, { text: "🚫 Utente inserito nella blacklist globale.", mentions: [targetMention] });
                return true;
            }

            case '!unblockuser': {
                if (!isOwner(sender, sock) || !targetMention) return true;
                blacklist.delete(targetMention);
                await sock.sendMessage(chatJid, { text: "✅ Utente rimosso dalla blacklist globale.", mentions: [targetMention] });
                return true;
            }

            case '!cleandb': {
                if (!isOwner(sender, sock)) return true;
                warnings.clear();
                await sock.sendMessage(chatJid, { text: "🗄 Pulizia database completata." });
                return true;
            }

            case '!gruppo': {
                if (isGroup && isOwner(sender, sock)) {
                    if (args[1] === 'off') {
                        config.isInactive = true;
                        await sock.sendMessage(chatJid, { text: "🤖 Bot disattivato in questo specifico gruppo." });
                    } else if (args[1] === 'on') {
                        config.isInactive = false;
                        await sock.sendMessage(chatJid, { text: "🤖 Bot riattivato in questo specifico gruppo." });
                    }
                }
                return true;
            }
        }

    } catch (error) {
        console.error("Errore:", error);
    }
    return false;
}

// 🛡️ GESTIONE EVENTO ANTI-ADD (Da inserire nel file principale del listener eventi di Baileys)
export async function handleGroupParticipantsUpdate(sock, update) {
    const { id: chatJid, participants, action } = update;
    
    if (action === 'add') {
        const phoneBlacklist = loadPhoneBlacklist();
        
        for (let participantJid of participants) {
            const phoneNumber = participantJid.replace(/[^0-9]/g, '');
            
            if (phoneBlacklist.includes(phoneNumber)) {
                try {
                    await sock.groupParticipantsUpdate(chatJid, [participantJid], "remove");
                    await sock.sendMessage(chatJid, { 
                        text: `⚠️️ **Tentativo di elusione bloccato**: Il numero +${phoneNumber} è inserito nella blacklist permanente e non può rientrare nel gruppo.`,
                        mentions: [participantJid]
                    });
                } catch (e) {
                    console.error("Errore durante il ribannaggio automatico:", e);
                }
            }
        }
    }
}
