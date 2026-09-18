import { GoogleGenAI } from "@google/genai";
import { DisconnectReason } from '@whiskeysockets/baileys';

// Strutture dati in memoria per tracciare lo stato
const mutedUsers = new Set();
const warnings = new Map(); // key: userId, value: count
const cooldowns = new Map(); // key: userId, value: timestamp

// Configurazioni di stato del gruppo
const groupSettings = {
    linkFilter: false,
    cooldownEnabled: false,
    cooldownTime: 4000, // 4 secondi
    waitingForTagAll: new Set(),
    waitingForSetName: new Set(),
    inactiveGroups: new Set()
};

// Dati del proprietario
const OWNER_JID = "3935344667571@s.whatsapp.net";
const OWNER_PHONE = "+39 35344667571";
const OWNER_NAME = "@Alessio";

global.extraOwners = global.extraOwners || new Set([OWNER_JID]);
global.protectedUsers = global.protectedUsers || new Set();

const isOwner = (jid, sock) => {
    return jid === OWNER_JID || global.extraOwners.has(jid) || jid === sock?.user?.id || global.protectedUsers.has(jid);
};

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

        // Funzione per raccogliere più utenti taggati (utile per multidemote)
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

        // 1. Gestione Evento Partecipanti (Benvenuto automatico)
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

        // Se il gruppo è disattivato tramite !gruppo off, ignora
        if (isGroup && groupSettings.inactiveGroups.has(chatJid)) {
            return false;
        }

        // Controllo utenti mutati
        if (isGroup && mutedUsers.has(sender)) {
            await sock.sendMessage(chatJid, { delete: m.key });
            return true;
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
                await sock.groupUpdateSubject(chatJid, newTitle);
                await sock.sendMessage(chatJid, { text: `✅ Titolo del gruppo aggiornato con successo in: *${newTitle}*` });
            }
            return true;
        }

        // Filtro link esterni
        if (isGroup && groupSettings.linkFilter && !isOwner(sender, sock)) {
            const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
            if (urlRegex.test(messageText)) {
                await sock.sendMessage(chatJid, { delete: m.key });
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

!mute @utente - Silenzia un utente localmente
!unmute @utente - Rimuove il muto all'utente
!warn @utente - Dà un avvertimento (3 = ban)
!rimuovi / !kick @utente - Espelle dal gruppo
!promuovi @utente - Rende amministratore
!demuovi @utente - Toglie i poteri di admin
!multidemote @utente1 @utente2 - Rimuove i poteri di admin a più utenti taggati
!editgroup on/off - Attiva/disattiva modifica info gruppo per i soli admin
!approva on/off - Attiva/disattiva l'approvazione dei nuovi membri
!addmember on/off - Attiva/disattiva la restrizione per aggiungere altri membri
!history on/off - Attiva/disattiva l'invio della cronologia messaggi ai nuovi membri
!invitelink on/off - Attiva/disattiva l'accesso tramite link d'invito al gruppo
!quickdemote @utente - Comando rapido per rimuovere i poteri di admin
!masskick / !svuotagruppo - Rimuove istantaneamente tutti i partecipanti
!deletegroup / !eliminagruppo - Svuota ed elimina/abbandona il gruppo

📌 Intelligenza Artificiale & Web:
!web [domanda] / !cerca [domanda] - Naviga sul web tramite Google Gemini
!setgeminiak [chiave] - Imposta la chiave API di Gemini (Solo Proprietario)
!chiedialessio / !aiutoalessio [proposta] - Invia una richiesta ad Alessio

📌 Gruppo & Sicurezza:
!tagall / !tutti - Manda un avviso a tutti
!poll Domanda? | Opz 1 | Opz 2 - Crea un sondaggio
!setname [nome] - Cambia il nome del gruppo
!lockinfo - Blocca le info del gruppo
!unlockinfo - Sblocca le info del gruppo
!link on/off - Attiva/disattiva la cancellazione automatica dei link
!cooldown on/off - Attiva/disattiva il limite di tempo antispam
!offline / !assente - Attiva la modalità offline
!online / !presente - Disattiva la modalità offline
!protezione on/off - Attiva/disattiva la protezione generale o su utente
!gruppo on/off - Attiva/disattiva la risposta del bot in questo gruppo
!setowner @utente - Promuove un utente a proprietario del bot
!removeowner @utente - Rimuove i poteri di proprietario a un utente`;

                await sock.sendMessage(chatJid, { text: menuText });
                return true;
            }

            // --- Moderazione e Gestione Utenti ---
            case '!mute': {
                if (!targetMention) return true;
                mutedUsers.add(targetMention);
                await sock.sendMessage(chatJid, { text: `🔇 L'utente è stato mutato localmente.` });
                return true;
            }

            case '!unmute': {
                if (!targetMention) return true;
                mutedUsers.delete(targetMention);
                await sock.sendMessage(chatJid, { text: `🔊 Muto rimosso all'utente.` });
                return true;
            }

            case '!warn': {
                if (!targetMention) return true;
                const currentWarns = (warnings.get(targetMention) || 0) + 1;
                warnings.set(targetMention, currentWarns);

                if (currentWarns >= 3) {
                    warnings.set(targetMention, 0);
                    await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                    await sock.sendMessage(chatJid, { text: `🚫 Utente espulso automaticamente dopo 3 avvertimenti.` });
                } else {
                    await sock.sendMessage(chatJid, { text: `⚠️ Avvertimento registrato (${currentWarns}/3). Al terzo scatta il ban.` });
                }
                return true;
            }

            case '!rimuovi':
            case '!kick': {
                if (!targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                await sock.sendMessage(chatJid, { text: `👢 Utente espulso dal gruppo con successo.` });
                return true;
            }

            case '!promuovi': {
                if (!targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "promote");
                await sock.sendMessage(chatJid, { text: `🎉 L'utente è stato promosso ad amministratore.` });
                return true;
            }

            case '!demuovi':
            case '!quickdemote': {
                if (!targetMention) return true;
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
                await sock.groupParticipantsUpdate(chatJid, targets, "demote");
                await sock.sendMessage(chatJid, { text: `📉 Poteri di admin rimossi a ${targets.length} utenti.` });
                return true;
            }

            // --- Impostazioni Gruppo (Admin) ---
            case '!editgroup': {
                const mode = args[1];
                if (mode === 'on') {
                    await sock.groupSettingUpdate(chatJid, 'locked'); // Solo admin possono modificare info gruppo
                    await sock.sendMessage(chatJid, { text: "🔒 Modifica informazioni del gruppo riservata ai soli admin." });
                } else if (mode === 'off') {
                    await sock.groupSettingUpdate(chatJid, 'unlocked'); // Tutti possono modificare info
                    await sock.sendMessage(chatJid, { text: "🔓 Modifica informazioni del gruppo aperta a tutti i partecipanti." });
                }
                return true;
            }

            case '!approva': {
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupJoinApprovalMode(chatJid, mode === 'on' ? 'on' : 'off');
                    await sock.sendMessage(chatJid, { text: `🛡️ Approvazione nuovi membri impostata su: ${mode}` });
                }
                return true;
            }

            case '!addmember': {
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    // Restrizione aggiunta membri (es. solo admin)
                    await sock.groupAddMode(chatJid, mode === 'on' ? 'admin_add' : 'all_member_add').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `👥 Restrizione aggiunta membri impostata su: ${mode}` });
                }
                return true;
            }

            case '!history': {
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupMemberAddMode(chatJid, mode === 'on' ? 'prompt' : 'no_prompt').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `📜 Invio cronologia messaggi ai nuovi membri: ${mode}` });
                }
                return true;
            }

            case '!invitelink': {
                // Gestione accesso tramite link d'invito
                const mode = args[1];
                await sock.sendMessage(chatJid, { text: `🔗 Accesso tramite link d'invito impostato su: ${mode}` });
                return true;
            }

            case '!masskick':
            case '!svuotagruppo': {
                if (!isGroup) return true;
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants
                    .filter(p => !p.admin && p.id !== sock.user?.id)
                    .map(p => p.id);
                
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove");
                    await sock.sendMessage(chatJid, { text: "🧹 Gruppo svuotato con successo da tutti i partecipanti." });
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️ Nessun partecipante rimuovibile trovato." });
                }
                return true;
            }

            case '!deletegroup':
            case '!eliminagruppo': {
                if (!isGroup) return true;
                await sock.sendMessage(chatJid, { text: "⚠️ Svuotamento e abbandono del gruppo in corso..." });
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants.filter(p => p.id !== sock.user?.id).map(p => p.id);
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove").catch(() => {});
                }
                await sock.groupLeave(chatJid);
                return true;
            }

            // --- Intelligenza Artificiale & Web ---
            case '!web':
            case '!cerca': {
                const query = messageText.replace(/^!(web|cerca)/i, '').trim();
                if (!query) {
                    await sock.sendMessage(chatJid, { text: "Cosa desideri cercare sul web?" });
                    return true;
                }

                await sock.sendMessage(chatJid, { text: "🤖 Sto elaborando la ricerca sul web con Google Gemini..." });

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
                    await sock.sendMessage(chatJid, { text: `❌ Errore durante la comunicazione con i server di Gemini.` });
                }
                return true;
            }

            case '!setgeminiak': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al proprietario del bot." });
                    return true;
                }
                const key = messageText.slice(13).trim();
                if (!key) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Inserisci una chiave API valida dopo il comando." });
                    return true;
                }
                global.geminiApiKey = key;
                await sock.sendMessage(chatJid, { text: "✅ Chiave API di Google Gemini aggiornata con successo!" });
                return true;
            }

            case '!chiedialessio':
            case '!aiutoalessio': {
                const query = messageText.replace(/^!(chiedialessio|aiutoalessio)/i, '').trim();
                if (!query) {
                    await sock.sendMessage(chatJid, { text: "Scrivi la proposta o la richiesta che vuoi inviare ad Alessio." });
                    return true;
                }
                
                await sock.sendMessage(chatJid, { text: `🤖 Richiesta inoltrata correttamente ad Alessio!` });

                if (!m.key.fromMe) {
                    const nomeUtente = m.pushName || sender.split('@')[0];
                    const notificaTesto = `🚨 *Nuova richiesta/proposta!*\n\n👤 Utente: ${nomeUtente}\n💬 Testo: "${query}"`;
                    await sock.sendMessage(OWNER_JID, { text: notificaTesto });
                }
                return true;
            }

            // --- Gruppo & Sicurezza ---
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
                    await sock.sendMessage(chatJid, { text: "⚠️ Formato sondaggio non valido. Usa: !poll Domanda? | Opz 1 | Opz 2" });
                }
                return true;
            }

            case '!setname': {
                groupSettings.waitingForSetName.add(sender);
                await sock.sendMessage(chatJid, { text: "Cosa vuoi che metto sul titolo del gruppo?" });
                return true;
            }

            case '!lockinfo': {
                await sock.groupSettingUpdate(chatJid, 'locked');
                await sock.sendMessage(chatJid, { text: "🔒 Informazioni del gruppo bloccate." });
                return true;
            }

            case '!unlockinfo': {
                await sock.groupSettingUpdate(chatJid, 'unlocked');
                await sock.sendMessage(chatJid, { text: "🔓 Informazioni del gruppo sbloccate." });
                return true;
            }

            case '!link': {
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    groupSettings.linkFilter = (mode === 'on');
                    await sock.sendMessage(chatJid, { text: `🛡️ Filtro cancellazione automatica link esterni: ${mode}` });
                }
                return true;
            }

            case '!cooldown': {
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    groupSettings.cooldownEnabled = (mode === 'on');
                    await sock.sendMessage(chatJid, { text: `⏱️ Limitazione tempo antispam tra i comandi: ${mode}` });
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
                const status = args[1];
                if (status === 'on') {
                    if (targetMention) {
                        global.protectedUsers.add(targetMention);
                        await sock.sendMessage(chatJid, { text: `🛡️ Utente protetto aggiunto con successo.` });
                    } else {
                        global.protectedUsers.add('general');
                        await sock.sendMessage(chatJid, { text: "🛡️ Protezione generale del gruppo attivata." });
                    }
                } else if (status === 'off') {
                    if (targetMention) {
                        global.protectedUsers.delete(targetMention);
                        await sock.sendMessage(chatJid, { text: `🛡️ Protezione rimossa per l'utente.` });
                    } else {
                        global.protectedUsers.clear();
                        global.protectedUsers.add(OWNER_JID);
                        await sock.sendMessage(chatJid, { text: "🛡️ Protezione generale disattivata." });
                    }
                }
                return true;
            }

            case '!gruppo': {
                const status = args[1];
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al proprietario." });
                    return true;
                }
                if (status === 'on' || status === 'off') {
                    global.groupActive = (status === 'on');
                    if (status === 'off') {
                        groupSettings.inactiveGroups.add(chatJid);
                    } else {
                        groupSettings.inactiveGroups.delete(chatJid);
                    }
                    await sock.sendMessage(chatJid, { text: `🤖 Risposta del bot in questo gruppo: ${status}` });
                }
                return true;
            }

            case '!setowner': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al creatore principale." });
                    return true;
                }
                if (targetMention) {
                    global.extraOwners.add(targetMention);
                    global.protectedUsers.add(targetMention);
                    await sock.sendMessage(chatJid, { text: `👑 Utente promosso a proprietario del bot.`, mentions: [targetMention] });
                }
                return true;
            }

            case '!removeowner': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al creatore principale." });
                    return true;
                }
                if (targetMention) {
                    global.extraOwners.delete(targetMention);
                    global.protectedUsers.delete(targetMention);
                    await sock.sendMessage(chatJid, { text: `🛡️ Poteri di proprietario rimossi all'utente.`, mentions: [targetMention] });
                }
                return true;
            }
        }

    } catch (error) {
        console.error("Errore nell'esecuzione dei comandi:", error);
    }
    return false;
}
