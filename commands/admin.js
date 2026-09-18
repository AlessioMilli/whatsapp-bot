import { GoogleGenAI } from "@google/genai";
import { DisconnectReason } from '@whiskeysockets/baileys';

// Strutture dati in memoria per tracciare lo stato
const mutedUsers = new Set();
const warnings = new Map(); // key: userId, value: count
const cooldowns = new Map(); // key: userId, value: timestamp

// Configurazioni di stato del gruppo e globali
const groupSettings = {
    linkFilter: false,
    cooldownEnabled: false,
    cooldownTime: 4000, // 4 secondi di cooldown
    waitingForTagAll: new Set(),
    waitingForSetName: new Set(),
    inactiveGroups: new Set()
};

// Dati del proprietario principale
const OWNER_JID = "3935344667571@s.whatsapp.net";
const OWNER_PHONE = "+39 35344667571";
const OWNER_NAME = "@Alessio";

global.extraOwners = global.extraOwners || new Set([OWNER_JID]);
global.protectedUsers = global.protectedUsers || new Set([OWNER_JID]);
global.protectionEnabled = global.protectionEnabled !== undefined ? global.protectionEnabled : true;

const isOwner = (jid, sock) => {
    return jid === OWNER_JID || global.extraOwners.has(jid) || jid === sock?.user?.id;
};

const isProtected = (jid) => {
    return jid === OWNER_JID || global.protectedUsers.has(jid);
};

// Funzione di utilità per verificare se il bot è amministratore del gruppo
async function ensureBotIsAdmin(sock, chatJid) {
    try {
        const metadata = await sock.groupMetadata(chatJid);
        const botId = sock.user?.id?.split(':')[0] + '@s.whatsapp.net' || sock.user?.id;
        const botParticipant = metadata.participants.find(p => p.id === botId || p.id.includes(sock.user?.id?.split('@')[0]));
        const isAdmin = botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');
        return isAdmin;
    } catch (e) {
        return false;
    }
}

export async function execute(sock, m, chatJid, messageText, sender, isGroup) {
    try {
        if (!chatJid) {
            chatJid = m.key.remoteJid;
        }
        if (isGroup === undefined) {
            isGroup = chatJid.endsWith('@g.us');
        }
        if (!sender) {
            sender = m.key.participant || chatJid;
        }

        // Configurazioni globali iniziali
        global.linksEnabled = global.linksEnabled !== undefined ? global.linksEnabled : false;
        global.cooldownEnabled = global.cooldownEnabled !== undefined ? global.cooldownEnabled : false;
        global.offlineMode = global.offlineMode !== undefined ? global.offlineMode : false;
        global.groupActive = global.groupActive !== undefined ? global.groupActive : true;
        global.botOwner = global.botOwner || OWNER_JID;
        global.geminiApiKey = global.geminiApiKey || "AQ.Ab8RN6KM0ueX86cDiau4euGb-jBJvQQsx6_z3zUE2S4jI3QveQ";

        const getTargetJid = () => {
            let targetJid = m.message?.extendedTextMessage?.contextInfo?.participant || m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!targetJid) {
                const query = messageText.split(' ')[1];
                if (query) {
                    let cleanQuery = query.startsWith('@') ? query.slice(1) : query;
                    targetJid = cleanQuery.includes('@') ? cleanQuery : cleanQuery + '@s.whatsapp.net';
                }
            }
            return targetJid;
        };

        const getAllMentionedJids = () => {
            let mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentions.length === 0) {
                const parts = messageText.trim().split(/ +/).slice(1);
                for (let p of parts) {
                    let clean = p.startsWith('@') ? p.slice(1) : p;
                    if (clean) mentions.push(clean.includes('@') ? clean : clean + '@s.whatsapp.net');
                }
            }
            return mentions;
        };

        // 👋 1. Gestione Evento Partecipanti (Benvenuto automatico)
        if (isGroup && m.messageStubType === 27) {
            const newMemberJid = m.messageStubParameters?.[0];
            if (newMemberJid) {
                try {
                    const metadata = await sock.groupMetadata(chatJid);
                    const desc = metadata.desc ? metadata.desc.trim() : "";
                    
                    let welcomeText = `👋 Benvenuto/a @${newMemberJid.split('@')[0]}!\n\n`;
                    if (desc) {
                        welcomeText += `📌 Leggi attentamente le regole del gruppo: ${desc}`;
                    } else {
                        welcomeText += `⚠️ Nota: In questo specifico gruppo al momento non sono presenti regole.`;
                    }

                    await sock.sendMessage(chatJid, {
                        text: welcomeText,
                        mentions: [newMemberJid]
                    });
                } catch (err) {
                    console.error("Errore nell'invio del messaggio di benvenuto:", err);
                }
            }
            return true;
        }

        if (!messageText) {
            messageText = m.message?.conversation || 
                        m.message?.extendedTextMessage?.text || 
                        m.message?.imageMessage?.caption || '';
        }
        
        if (!messageText) return false;

        const args = messageText.trim().split(/ +/);
        const command = args[0].toLowerCase();
        const targetMention = getTargetJid();

        // Controllo se il gruppo è disattivato tramite !gruppo off (tranne per il proprietario o per riattivarlo)
        if (isGroup && groupSettings.inactiveGroups.has(chatJid)) {
            if (command === '!gruppo' && args[1] === 'on' && isOwner(sender, sock)) {
                // Lascia procedere per riattivare
            } else {
                return false;
            }
        }

        // Controllo utenti mutati localmente
        if (isGroup && mutedUsers.has(sender)) {
            await sock.sendMessage(chatJid, { delete: m.key }).catch(() => {});
            return true;
        }

        // Sistema Antispam / Cooldown
        if (groupSettings.cooldownEnabled && isGroup && !isOwner(sender, sock)) {
            const now = Date.now();
            const lastTime = cooldowns.get(sender) || 0;
            if (now - lastTime < groupSettings.cooldownTime) {
                return true; // Ignora se in cooldown
            }
            cooldowns.set(sender, now);
        }

        // Gestione stati in attesa (!tutti / !setname)
        if (groupSettings.waitingForTagAll && groupSettings.waitingForTagAll.has(sender)) {
            groupSettings.waitingForTagAll.delete(sender);
            const announcementText = messageText.trim();
            const metadata = await sock.groupMetadata(chatJid);
            const participants = metadata.participants.map(p => p.id);
            
            await sock.sendMessage(chatJid, {
                text: `📢 *Avviso Generale*\n\n${announcementText}`,
                mentions: participants
            });
            return true;
        }

        if (groupSettings.waitingForSetName && groupSettings.waitingForSetName.has(sender)) {
            groupSettings.waitingForSetName.delete(sender);
            const newTitle = messageText.trim();
            if (newTitle) {
                if (isGroup) {
                    const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                    if (!botAdmin) {
                        await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                        return true;
                    }
                    await sock.groupUpdateSubject(chatJid, newTitle);
                    await sock.sendMessage(chatJid, { text: `✅ Titolo del gruppo aggiornato con successo in: *${newTitle}*` });
                }
            }
            return true;
        }

        // Filtro link esterni (!link on)
        if (isGroup && groupSettings.linkFilter && !isOwner(sender, sock)) {
            const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
            if (urlRegex.test(messageText)) {
                await sock.sendMessage(chatJid, { delete: m.key }).catch(() => {});
                await sock.sendMessage(chatJid, { 
                    text: `Ragazzi, sono il chatbot di moderazione di ${OWNER_NAME} (${OWNER_PHONE}). Se volete inviare link esterni dovete prima contattare il proprietario` 
                });
                return true;
            }
        }

        // Gestione offline in chat privata
        if (!isGroup && global.offlineMode && !isOwner(sender, sock) && !m.key.fromMe) {
            await sock.sendMessage(chatJid, { text: "Al momento Alessio non è disponibile. Ti risponderà appena possibile..." }, { quoted: m });
            return true;
        }

        // --- GESTIONE COMANDI ---
        switch (command) {
            case '!commands':
            case '!menu': {
                const menuText = `🤖 LISTA COMANDI BOT 🤖

!mute @utente* - Silenzia un utente localmente
!unmute @utente* - Rimuove il muto all'utente
!warn @utente* - Dà un avvertimento (3 = ban)
!rimuovi / !kick @utente* - Espelle dal gruppo
!promuovi @utente* - Rende amministratore
!demuovi @utente* - Toglie i poteri di admin
!multidemote @utente1 @utente2* - Rimuove i poteri di admin a più utenti taggati
!editgroup on/off* - Attiva/disattiva modifica info gruppo per i soli admin
!approva on/off* - Attiva/disattiva l'approvazione dei nuovi membri
!addmember on/off* - Attiva/disattiva la restrizione per aggiungere altri membri (solo admin)
!history on/off* - Attiva/disattiva l'invio della cronologia dei messaggi ai nuovi membri (solo admin)
!invitelink on/off* - Attiva/disattiva l'accesso tramite link d'invito al gruppo (solo admin)
!quickdemote @utente* - Comando rapido per rimuovere i poteri di admin taggando l'utente
!masskick / !svuotagruppo* - Rimuove istantaneamente tutti i partecipanti dal gruppo (Solo admin)
!deletegroup / !eliminagruppo* - Svuota ed elimina/abbandona il gruppo (Solo admin)

📌 Intelligenza Artificiale & Web:
!web [domanda] / !cerca [domanda]* - Naviga sul web tramite le API di Google Gemini
!setgeminiak [chiave]* - Imposta la chiave API di Google Gemini (Solo Proprietario)

📌 Gruppo & Sicurezza:
!tagall / !tutti* - Manda un avviso a tutti
!poll Domanda? | Opz 1 | Opz 2* - Crea un sondaggio
!setname [nome]* - Cambia il nome del gruppo
!lockinfo* - Blocca le info del gruppo
!unlockinfo* - Sblocca le info del gruppo
!link on* - Attiva la cancellazione automatica dei link esterni
!link off* - Disattiva la cancellazione automatica dei link
!cooldown on/off* - Attiva/disattiva il limite di tempo antispam tra i comandi
!offline / !assente* - Attiva la modalità offline (usabile ovunque dal proprietario)
!online / !presente* - Disattiva la modalità offline
!protezione on/off* - Attiva/disattiva la protezione generale o su uno specifico utente (@utente)
!gruppo on/off* - Attiva/disattiva la risposta del bot in questo specifico gruppo (Solo Proprietario)
!setowner @utente* - Promuove un utente a proprietario del bot (Solo Creatore Principale)
!removeowner @utente* - Rimuove i poteri di proprietario a un utente (Solo Creatore Principale)`;

                await sock.sendMessage(chatJid, { text: menuText });
                return true;
            }

            // --- SEZIONE 1: MODERAZIONE AVANZATA ---
            case '!mute': {
                if (!targetMention) return true;
                if (isProtected(targetMention) || targetMention === OWNER_JID) {
                    if (global.protectionEnabled) {
                        await sock.sendMessage(chatJid, { text: "Impossibile eseguire questa azione perché sono stato programmato per proteggere il mio capo, essendo lui stesso ad avermi creato" });
                    } else {
                        await sock.sendMessage(chatJid, { text: "Impossibile eseguire questa operazione per motivi tecnici messi dal proprietario" });
                    }
                    return true;
                }
                mutedUsers.add(targetMention);
                await sock.sendMessage(chatJid, { text: `🔇 L'utente è stato mutato localmente.` });
                return true;
            }

            case '!unmute': {
                if (!targetMention) return true;
                mutedUsers.delete(targetMention);
                await sock.sendMessage(chatJid, { text: `🔊 Muto rimosso definitivamente all'utente.` });
                return true;
            }

            case '!warn': {
                if (!targetMention) return true;
                if (isProtected(targetMention)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Non puoi dare un avvertimento a un utente protetto o al proprietario!" });
                    return true;
                }

                const currentWarns = (warnings.get(targetMention) || 0) + 1;
                warnings.set(targetMention, currentWarns);

                if (currentWarns === 2) {
                    await sock.sendMessage(chatJid, {
                        text: `⚠️ @${targetMention.split('@')[0]}, questo è il tuo secondo avvertimento (2/3). Al terzo verrai bannato!`,
                        mentions: [targetMention]
                    });
                } else if (currentWarns >= 3) {
                    warnings.set(targetMention, 0);
                    const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                    if (!botAdmin) {
                        await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                        return true;
                    }
                    await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                    await sock.sendMessage(chatJid, { text: `🚫 Utente bannato automaticamente dopo il terzo avvertimento.` });
                } else {
                    await sock.sendMessage(chatJid, { text: `⚠️ Avvertimento registrato (${currentWarns}/3).` });
                }
                return true;
            }

            case '!rimuovi':
            case '!kick': {
                if (!targetMention) return true;
                if (isProtected(targetMention)) {
                    await sock.sendMessage(chatJid, { text: "❌ Impossibile espellere questo utente in quanto protetto o proprietario." });
                    return true;
                }
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                await sock.sendMessage(chatJid, { text: `👢 Utente espulso dal gruppo.` });
                return true;
            }

            case '!promuovi': {
                if (!targetMention) return true;
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "promote");
                await sock.sendMessage(chatJid, { text: `🎉 L'utente è stato nominato amministratore.` });
                return true;
            }

            case '!demuovi':
            case '!quickdemote': {
                if (!targetMention) return true;
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "demote");
                await sock.sendMessage(chatJid, { text: `📉 Poteri di amministratore rimossi all'utente.` });
                return true;
            }

            case '!multidemote': {
                const targets = getAllMentionedJids();
                if (targets.length === 0) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Tagga almeno un utente a cui rimuovere i poteri di admin." });
                    return true;
                }
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, targets, "demote");
                await sock.sendMessage(chatJid, { text: `📉 Poteri di admin rimossi a ${targets.length} utenti in un colpo solo.` });
                return true;
            }

            case '!editgroup': {
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                if (mode === 'on') {
                    await sock.groupSettingUpdate(chatJid, 'locked');
                    await sock.sendMessage(chatJid, { text: "🔒 Modifica informazioni del gruppo riservata ai soli admin." });
                } else if (mode === 'off') {
                    await sock.groupSettingUpdate(chatJid, 'unlocked');
                    await sock.sendMessage(chatJid, { text: "🔓 Modifica informazioni del gruppo aperta a tutti." });
                }
                return true;
            }

            case '!approva': {
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                if (mode === 'on' || mode === 'off') {
                    await sock.groupJoinApprovalMode(chatJid, mode === 'on' ? 'on' : 'off').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `🛡️ Approvazione nuovi membri impostata su: ${mode}` });
                }
                return true;
            }

            case '!addmember': {
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                if (mode === 'on' || mode === 'off') {
                    await sock.groupAddMode(chatJid, mode === 'on' ? 'admin_add' : 'all_member_add').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `👥 Restrizione aggiunta membri impostata su: ${mode}` });
                }
                return true;
            }

            case '!history': {
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                if (mode === 'on' || mode === 'off') {
                    await sock.groupMemberAddMode(chatJid, mode === 'on' ? 'prompt' : 'no_prompt').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `📜 Cronologia messaggi per nuovi membri impostata su: ${mode}` });
                }
                return true;
            }

            case '!invitelink': {
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                await sock.sendMessage(chatJid, { text: `🔗 Link d'invito aggiornato/impostato su: ${mode}` });
                return true;
            }

            case '!masskick':
            case '!svuotagruppo': {
                if (!isGroup) return true;
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants
                    .filter(p => !p.admin && p.id !== sock.user?.id && !isProtected(p.id))
                    .map(p => p.id);
                
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove");
                    await sock.sendMessage(chatJid, { text: "🧹 Gruppo svuotato con successo da tutti i partecipanti non admin." });
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️ Nessun partecipante rimuovibile trovato." });
                }
                return true;
            }

            case '!deletegroup':
            case '!eliminagruppo': {
                if (!isGroup) return true;
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                await sock.sendMessage(chatJid, { text: "⚠️ Svuotamento e eliminazione del gruppo in corso..." });
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants.filter(p => p.id !== sock.user?.id && !isProtected(p.id)).map(p => p.id);
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove").catch(() => {});
                }
                await sock.groupLeave(chatJid);
                return true;
            }

            // --- SEZIONE 2: INTELLIGENZA ARTIFICIALE & WEB ---
            case '!web':
            case '!cerca': {
                const query = messageText.replace(/^!(web|cerca)/i, '').trim();
                if (!query) {
                    await sock.sendMessage(chatJid, { text: "Cosa desideri cercare sul web?" });
                    return true;
                }

                await sock.sendMessage(chatJid, { text: "🤖 Sto elaborando la ricerca online con Google Gemini..." });

                try {
                    const ai = new GoogleGenAI({ apiKey: global.geminiApiKey });
                    const response = await ai.models.generateContent({
                        model: 'gemini-3.6-flash',
                        contents: query,
                    });
                    
                    const responseText = response.text || "Nessuna risposta generata.";
                    await sock.sendMessage(chatJid, { text: `🌍 *Risultato Web*:\n${responseText}` });
                } catch (error) {
                    console.error("Errore API Gemini:", error);
                    await sock.sendMessage(chatJid, { text: `❌ Errore durante la comunicazione con i server di Google Gemini.` });
                }
                return true;
            }

            case '!setgeminiak': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Questo comando è riservato esclusivamente al Proprietario." });
                    return true;
                }
                const key = messageText.slice(13).trim();
                if (!key) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Inserisci una chiave API valida dopo il comando." });
                    return true;
                }
                global.geminiApiKey = key;
                await sock.sendMessage(chatJid, { text: "✅ Chiave API di Google Gemini aggiornata con successo in memoria!" });
                return true;
            }

            // --- SEZIONE 3: GRUPPO & SICUREZZA ---
            case '!tagall':
            case '!tutti': {
                groupSettings.waitingForTagAll.add(sender);
                await sock.sendMessage(chatJid, { text: "Cosa vorresti scrivere nell'avviso?" });
                return true;
            }

            case '!poll': {
                const pollContent = messageText.replace(/^!poll/i, '').trim();
                const parts = pollContent.split('|').map(p => p.trim());
                const question = parts[0];
                const options = parts.slice(1);
                if (question && options.length > 0) {
                    await sock.sendMessage(chatJid, { poll: { name: question, values: options } });
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️ Formato non valido. Usa: !poll Domanda? | Opz 1 | Opz 2" });
                }
                return true;
            }

            case '!setname': {
                groupSettings.waitingForSetName.add(sender);
                await sock.sendMessage(chatJid, { text: "Cosa vuoi che metto sul titolo del gruppo?" });
                return true;
            }

            case '!lockinfo': {
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                await sock.groupSettingUpdate(chatJid, 'locked');
                await sock.sendMessage(chatJid, { text: "🔒 Informazioni del gruppo bloccate." });
                return true;
            }

            case '!unlockinfo': {
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando." });
                    return true;
                }
                await sock.groupSettingUpdate(chatJid, 'unlocked');
                await sock.sendMessage(chatJid, { text: "🔓 Informazioni del gruppo sbloccate." });
                return true;
            }

            case '!link': {
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    groupSettings.linkFilter = (mode === 'on');
                    await sock.sendMessage(chatJid, { text: `🛡️ Filtro link esterni: ${mode}` });
                }
                return true;
            }

            case '!cooldown': {
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    groupSettings.cooldownEnabled = (mode === 'on');
                    await sock.sendMessage(chatJid, { text: `⏱️ Cooldown antispam tra i comandi: ${mode}` });
                }
                return true;
            }

            case '!offline':
            case '!assente': {
                if (isOwner(sender, sock)) {
                    global.offlineMode = true;
                    await sock.sendMessage(chatJid, { text: "🔴 Modalità offline attivata." });
                }
                return true;
            }

            case '!online':
            case '!presente': {
                if (isOwner(sender, sock)) {
                    global.offlineMode = false;
                    await sock.sendMessage(chatJid, { text: "🟢 Modalità offline disattivata." });
                }
                return true;
            }

            case '!protezione': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al proprietario." });
                    return true;
                }
                const status = args[1];
                if (status === 'on') {
                    global.protectionEnabled = true;
                    if (targetMention) {
                        global.protectedUsers.add(targetMention);
                        await sock.sendMessage(chatJid, { text: `🛡️ Utente protetto aggiunto con successo.` });
                    } else {
                        await sock.sendMessage(chatJid, { text: "🛡️ Protezione generale del bot attivata." });
                    }
                } else if (status === 'off') {
                    global.protectionEnabled = false;
                    if (targetMention) {
                        global.protectedUsers.delete(targetMention);
                        await sock.sendMessage(chatJid, { text: `🛡️ Protezione rimossa per l'utente.` });
                    } else {
                        await sock.sendMessage(chatJid, { text: "🛡️ Protezione generale disattivata." });
                    }
                }
                return true;
            }

            case '!gruppo': {
                const status = args[1];
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "Al momento non puoi usare questo comando perché questo comando è riservato al proprietario." });
                    return true;
                }
                if (status === 'on' || status === 'off') {
                    global.groupActive = (status === 'on');
                    if (status === 'off') {
                        groupSettings.inactiveGroups.add(chatJid);
                    } else {
                        groupSettings.inactiveGroups.delete(chatJid);
                    }
                    await sock.sendMessage(chatJid, { text: `🤖 Risposta del bot in questo gruppo impostata su: ${status}` });
                }
                return true;
            }

            case '!setowner': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al creatore principale del bot." });
                    return true;
                }
                if (targetMention) {
                    global.extraOwners.add(targetMention);
                    global.protectedUsers.add(targetMention);
                    await sock.sendMessage(chatJid, { text: `👑 L'utente è stato promosso a proprietario del bot.`, mentions: [targetMention] });
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente per impostarlo come proprietario." });
                }
                return true;
            }

            case '!removeowner': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al creatore principale del bot." });
                    return true;
                }
                if (targetMention) {
                    global.extraOwners.delete(targetMention);
                    global.protectedUsers.delete(targetMention);
                    await sock.sendMessage(chatJid, { text: `🛡️ Poteri di proprietario rimossi all'utente.`, mentions: [targetMention] });
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente per rimuovere i poteri di proprietario." });
                }
                return true;
            }
        }

    } catch (error) {
        console.error("Errore nell'esecuzione dei comandi:", error);
    }
    return false;
}
