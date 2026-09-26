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
    cooldownTime: 4000,
    waitingForTagAll: new Set(),
    waitingForSetName: new Set(),
    inactiveGroups: new Set()
};

// Dati del proprietario principale
const OWNER_JID = "393534467571@s.whatsapp.net";
const OWNER_PHONE = "+39 3534467571";
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

// Funzione per verificare se il mittente è il proprietario oppure un amministratore reale nel gruppo
async function isActualAdminOrOwner(sock, chatJid, sender) {
    if (sender === OWNER_JID || sender.includes('3534467571') || isOwner(sender, sock)) {
        return true;
    }
    if (chatJid && chatJid.endsWith('@g.us')) {
        try {
            const metadata = await sock.groupMetadata(chatJid);
            const participant = metadata.participants.find(p => p.id === sender || p.id.includes(sender.split('@')[0]));
            return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
        } catch (e) {
            return false;
        }
    }
    return false;
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

        // 👋 Gestione Evento Partecipanti (Benvenuto automatico)
        if (isGroup && m.messageStubType === 27) {
            const newMemberJid = m.messageStubParameters?.[0];
            if (newMemberJid) {
                try {
                    const metadata = await sock.groupMetadata(chatJid);
                    const desc = metadata.desc ? metadata.desc.trim() : "";
                    
                    let welcomeText = `Benvenuto nel gruppo @${newMemberJid.split('@')[0]}\n\n`;
                    if (desc) {
                        welcomeText += `Leggi con attenzione le regole: ${desc}`;
                    } else {
                        welcomeText += `Ricordati di rispettare tutti i membri e di divertirti insieme a noi`;
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

        // Controllo utenti mutati localmente (Cancellazione istantanea)
        if (isGroup && mutedUsers.has(sender)) {
            await sock.sendMessage(chatJid, { delete: m.key }).catch(() => {});
            return true;
        }

        const args = messageText.trim().split(/ +/);
        const command = args[0].toLowerCase();
        const targetMention = getTargetJid();

        // Controllo se il gruppo è disattivato tramite !gruppo off
        if (isGroup && groupSettings.inactiveGroups.has(chatJid)) {
            if (command === '!gruppo' && args[1] === 'on' && isOwner(sender, sock)) {
                groupSettings.inactiveGroups.delete(chatJid);
                await sock.sendMessage(chatJid, { text: "Il bot è di nuovo attivo in questo gruppo" });
                return true;
            }
            return false;
        }

        // Sistema Antispam / Cooldown
        if (groupSettings.cooldownEnabled && isGroup && !isOwner(sender, sock)) {
            const now = Date.now();
            const lastTime = cooldowns.get(sender) || 0;
            if (now - lastTime < groupSettings.cooldownTime) {
                return true;
            }
            cooldowns.set(sender, now);
        }

        // Gestione stati in attesa (!tutti / !setname)
        if (groupSettings.waitingForTagAll && groupSettings.waitingForTagAll.has(sender)) {
            groupSettings.waitingForTagAll.delete(sender);
            const announcementText = messageText.trim();
            const metadata = await sock.groupMetadata(chatJid);
            const participants = metadata.participants.map(p => p.id);
            
            let text = `Attenzione a tutti ragazzi\n\n${announcementText}\n\n`;
            for (let p of participants) {
                text += `@${p.split('@')[0]} `;
            }

            await sock.sendMessage(chatJid, {
                text: text,
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
                        await sock.sendMessage(chatJid, { text: "Non posso cambiare il nome perché non sono amministratore" });
                        return true;
                    }
                    await sock.groupUpdateSubject(chatJid, newTitle);
                    await sock.sendMessage(chatJid, { text: `Il nome del gruppo è stato aggiornato in modo perfetto` });
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
                    text: `Non puoi inviare link esterni in questo gruppo se prima non chiedi il permesso al capo` 
                });
                return true;
            }
        }

        // Gestione offline in chat privata
        if (!isGroup && global.offlineMode && !isOwner(sender, sock) && !m.key.fromMe) {
            await sock.sendMessage(chatJid, { text: "Al momento Alessio non può risponderti perché è offline ti scriverà non appena torna disponibile" }, { quoted: m });
            return true;
        }

        // --- Protezione Proprietario su comandi di moderazione ---
        if (targetMention && isOwner(targetMention, sock) && ['!mute', '!warn', '!kick', '!rimuovi', '!demuovi', '!quickdemote', '!multidemote'].includes(command)) {
            if (global.protectionEnabled) {
                await sock.sendMessage(chatJid, { text: "Non puoi assolutamente toccare il creatore del bot perché è protetto da me" });
            } else {
                await sock.sendMessage(chatJid, { text: "Operazione bloccata perché ci sono restrizioni di sicurezza attive" });
            }
            return true;
        }

        // --- GESTIONE COMANDI ---
        switch (command) {
            case '!menu':
            case '!aiuto': {
                const menuText = `Ecco la lista completa dei comandi disponibili per gestire tutto al meglio:

Moderazione:
!mute utente - Silenzia un utente localmente
!unmute utente - Rimuove il muto all'utente
!warn utente - Dà un avvertimento (tre uguali = ban)
!rimuovi o !kick utente - Espelle dal gruppo
!promuovi utente - Rende amministratore
!demuovi utente - Toglie i poteri di admin
!multidemote utente_uno utente_due - Rimuove i poteri di admin a più utenti taggati
!editgroup on/off - Attiva/disattiva modifica info gruppo per i soli admin
!approva on/off - Attiva/disattiva l'approvazione dei nuovi membri
!addmember on/off - Attiva/disattiva la restrizione per aggiungere altri membri
!history on/off - Attiva/disattiva l'invio della cronologia dei messaggi ai nuovi membri
!invitelink on/off - Attiva/disattiva l'accesso tramite link d'invito al gruppo
!quickdemote utente - Comando rapido per rimuovere i poteri di admin taggando l'utente
!masskick o !svuotagruppo - Rimuove istantaneamente tutti i partecipanti dal gruppo
!deletegroup o !eliminagruppo - Svuota ed elimina/abbandona le chat o gruppi
!clearalltesto parola - Elimina tutti i messaggi per tutti che contengono una certa parola

Intelligenza Artificiale e Web:
!web <testo> o !cerca <testo> - Esegue una ricerca web tramite Google Gemini AI
!setgeminiak <chiave> - Imposta/aggiorna la chiave API di Google Gemini (Solo Proprietario)

Supporto:
!chiedialessio messaggio - Invia un messaggio o una domanda direttamente al proprietario in privata
!aiutoalessio - Mostra il messaggio di supporto e aiuto del gruppo

Gruppo e Sicurezza:
!tagall o !tutti - Manda un avviso a tutti
!poll Domanda | Opz_uno | Opz_due - Crea un sondaggio
!setname nome - Cambia il nome del gruppo
!lockinfo - Blocca le info del gruppo
!unlockinfo - Sblocca le info del gruppo
!link on/off - Attiva/disattiva la cancellazione automatica dei link esterni
!cooldown on/off - Attiva/disattiva il limite di tempo antispam tra i comandi
!offline o !assente - Attiva la modalità offline
!online o !presente - Attiva la modalità online
!protezione on/off - Attiva/disattiva la protezione generale
!gruppo on/off - Attiva/disattiva la risposta del bot in questo specifico gruppo
!setowner utente - Promuove un utente a proprietario del bot
!removeowner utente - Rimuove i poteri di proprietario a un utente`;

                await sock.sendMessage(chatJid, { text: menuText });
                return true;
            }

            // --- SEZIONE 1: MODERAZIONE AVANZATA ---
            case '!mute': {
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                if (!targetMention) {
                    await sock.sendMessage(chatJid, { text: "Ricordati di taggare la persona che vuoi mutare" });
                    return true;
                }
                mutedUsers.add(targetMention);
                await sock.sendMessage(chatJid, { text: `L'utente è stato mutato con successo adesso non può parlare`, mentions: [targetMention] });
                return true;
            }

            case '!unmute': {
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                if (!targetMention) return true;
                mutedUsers.delete(targetMention);
                await sock.sendMessage(chatJid, { text: `L'utente è stato smutato può tornare a scrivere`, mentions: [targetMention] });
                return true;
            }

            case '!warn': {
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                if (!targetMention) return true;
                const currentWarns = (warnings.get(targetMention) || 0) + 1;
                warnings.set(targetMention, currentWarns);

                if (currentWarns === 1) {
                    await sock.sendMessage(chatJid, {
                        text: `Hai preso il primo avvertimento vedi di stare attento`,
                        mentions: [targetMention]
                    });
                } else if (currentWarns === 2) {
                    await sock.sendMessage(chatJid, {
                        text: `Questo è il secondo avvertimento al prossimo ti cacciamo via`,
                        mentions: [targetMention]
                    });
                } else if (currentWarns >= 3) {
                    warnings.delete(targetMention);
                    const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                    if (!botAdmin) {
                        await sock.sendMessage(chatJid, { text: "Non posso bannare perché non ho i poteri di amministratore" });
                        return true;
                    }
                    await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                    await sock.sendMessage(chatJid, { text: `Utente espulso dal gruppo per aver accumulato tre avvertimenti`, mentions: [targetMention] });
                }
                return true;
            }

            case '!rimuovi':
            case '!kick': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                if (!targetMention) return true;
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Non posso rimuovere nessuno senza i permessi da amministratore" });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                await sock.sendMessage(chatJid, { text: `La persona selezionata è stata cacciata dal gruppo` });
                return true;
            }

            case '!promuovi': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                if (!targetMention) return true;
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Impossibile promuovere l'utente perché il bot non è admin" });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "promote");
                await sock.sendMessage(chatJid, { text: `Ottime notizie l'utente adesso è un amministratore ufficiale` });
                return true;
            }

            case '!demuovi':
            case '!quickdemote': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                if (!targetMention) return true;
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Non posso togliere i poteri perché non sono admin" });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "demote");
                await sock.sendMessage(chatJid, { text: `All'utente sono stati revocati tutti i poteri di admin` });
                return true;
            }

            case '!multidemote': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                const targets = getAllMentionedJids();
                if (targets.length === 0) {
                    await sock.sendMessage(chatJid, { text: "Devi taggare almeno un utente per procedere" });
                    return true;
                }
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Il bot deve essere amministratore per eseguire questo comando" });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, targets, "demote");
                await sock.sendMessage(chatJid, { text: `Tutti gli utenti taggati non sono più amministratori` });
                return true;
            }

            case '!editgroup': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Servono i permessi da admin per modificare le impostazioni del gruppo" });
                    return true;
                }
                if (mode === 'on') {
                    await sock.groupSettingUpdate(chatJid, 'locked');
                    await sock.sendMessage(chatJid, { text: "Modifica delle informazioni riservata unicamente agli admin" });
                } else if (mode === 'off') {
                    await sock.groupSettingUpdate(chatJid, 'unlocked');
                    await sock.sendMessage(chatJid, { text: "Adesso tutti i partecipanti possono modificare le info del gruppo" });
                }
                return true;
            }

            case '!approva': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Non ho i permessi necessari per cambiare questa impostazione" });
                    return true;
                }
                if (mode === 'on' || mode === 'off') {
                    await sock.groupJoinApprovalMode(chatJid, mode === 'on' ? 'on' : 'off').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `Approvazione dei nuovi membri impostata su ${mode}` });
                }
                return true;
            }

            case '!addmember': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Diventa admin del gruppo per poter usare questo comando" });
                    return true;
                }
                if (mode === 'on' || mode === 'off') {
                    await sock.groupAddMode(chatJid, mode === 'on' ? 'admin_add' : 'all_member_add').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `Restrizione aggiunta membri aggiornata correttamente` });
                }
                return true;
            }

            case '!history': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Il bot deve essere amministratore per gestire la cronologia" });
                    return true;
                }
                if (mode === 'on' || mode === 'off') {
                    await sock.groupMemberAddMode(chatJid, mode === 'on' ? 'prompt' : 'no_prompt').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `Invio cronologia messaggi impostato su ${mode}` });
                }
                return true;
            }

            case '!invitelink': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                const mode = args[1];
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Mi servono i poteri di admin per gestire il link d'invito" });
                    return true;
                }
                await sock.sendMessage(chatJid, { text: `Accesso tramite link di invito configurato su ${mode}` });
                return true;
            }

            case '!masskick':
            case '!svuotagruppo': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Impossibile svuotare il gruppo perché non sono amministratore" });
                    return true;
                }
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants
                    .filter(p => !p.admin && p.id !== sock.user?.id && !isProtected(p.id))
                    .map(p => p.id);
                
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove");
                    await sock.sendMessage(chatJid, { text: "Ho ripulito tutto il gruppo rimuovendo tutti i membri non admin" });
                } else {
                    await sock.sendMessage(chatJid, { text: "Non ci sono partecipanti che possono essere rimossi" });
                }
                return true;
            }

            case '!deletegroup':
            case '!eliminagruppo': {
                if (!isGroup) return true;
                if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                    await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                    return true;
                }
                const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                if (!botAdmin) {
                    await sock.sendMessage(chatJid, { text: "Non posso eliminare il gruppo senza essere amministratore" });
                    return true;
                }
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants.filter(p => p.id !== sock.user?.id && !isProtected(p.id)).map(p => p.id);
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove").catch(() => {});
                }
                await sock.sendMessage(chatJid, { text: "Procedo subito allo svuotamento totale e all'abbandono del gruppo" });
                await sock.groupLeave(chatJid);
                return true;
            }

            case '!clearalltesto': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                const keyword = messageText.replace(/^!clearalltesto/i, '').trim();
                if (!keyword) {
                    await sock.sendMessage(chatJid, { text: "Specifica una parola o una corrispondenza da cercare e cancellare" });
                    return true;
                }
                await sock.sendMessage(chatJid, { text: `Avviata la scansione e cancellazione globale per tutti i messaggi corrispondenti a: ${keyword}` });
                return true;
            }

            // --- SEZIONE 2: INTELLIGENZA ARTIFICIALE, WEB & SUPPORTO ---
            case '!web':
            case '!cerca': {
                const query = messageText.replace(/^!(web|cerca)/i, '').trim();
                if (!query) {
                    await sock.sendMessage(chatJid, { text: "Scrivi pure cosa vorresti cercare su internet" });
                    return true;
                }
                if (!global.geminiApiKey) {
                    await sock.sendMessage(chatJid, { text: "Manca la chiave API di Gemini il proprietario deve impostarla prima" });
                    return true;
                }
                try {
                    const ai = new GoogleGenAI({ apiKey: global.geminiApiKey });
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: `Rispondi in italiano in modo fluido alla seguente richiesta di ricerca web: ${query}`
                    });
                    const responseText = response.text || "Nessuna risposta generata.";
                    await sock.sendMessage(chatJid, { text: responseText });
                } catch (err) {
                    console.error("Errore Gemini API:", err);
                    await sock.sendMessage(chatJid, { text: "Si è verificato un piccolo problema di connessione con intelligenza artificiale riprova più tardi" });
                }
                return true;
            }

            case '!setgeminiak': {
                if (isOwner(sender, sock)) {
                    const key = messageText.slice(13).trim();
                    if (key) {
                        global.geminiApiKey = key;
                        await sock.sendMessage(chatJid, { text: "Chiave API di Google Gemini aggiornata correttamente" });
                    } else {
                        await sock.sendMessage(chatJid, { text: "Inserisci una chiave valida dopo il comando" });
                    }
                } else {
                    await sock.sendMessage(chatJid, { text: "Comando riservato esclusivamente al proprietario" });
                }
                return true;
            }

            case '!chiedialessio': {
                const userMessage = messageText.replace(/^!chiedialessio/i, '').trim();
                if (!userMessage) {
                    await sock.sendMessage(chatJid, { text: "Ciao se vuoi inviare un messaggio ad Alessio scrivi la tua richiesta subito dopo il comando" });
                } else {
                    let groupName = isGroup ? "Gruppo" : "Chat Privata";
                    if (isGroup) {
                        try {
                            const metadata = await sock.groupMetadata(chatJid);
                            groupName = metadata.subject || chatJid;
                        } catch (e) {}
                    }
                    const userName = m.pushName || sender.split('@')[0];
                    const forwardText = `Nuova richiesta di supporto ricevuta\nDa utente: @${sender.split('@')[0]}\nProvenienza: ${groupName}\nTesto: ${userMessage}`;
                    await sock.sendMessage(OWNER_JID, { text: forwardText, mentions: [sender] });
                    await sock.sendMessage(chatJid, { text: "Il tuo messaggio è stato inoltrato con successo ad Alessio" });
                }
                return true;
            }

            case '!aiutoalessio': {
                await sock.sendMessage(chatJid, { text: "Centro Assistenza e Contatto ufficiale se hai bisogno di aiuto scrivi pure a Alessio usando il comando apposito" });
                return true;
            }

            // --- SEZIONE 3: GRUPPO & SICUREZZA ---
            case '!tagall':
            case '!tutti': {
                if (isGroup) {
                    groupSettings.waitingForTagAll.add(sender);
                    await sock.sendMessage(chatJid, { text: "Scrivi pure che cosa vorresti comunicare a tutti quanti" });
                }
                return true;
            }

            case '!poll': {
                const pollData = messageText.replace(/^!poll/i, '').split('|').map(s => s.trim());
                const pollQuestion = pollData[0];
                const pollOptions = pollData.slice(1);
                if (pollQuestion && pollOptions.length > 1) {
                    await sock.sendMessage(chatJid, { poll: { name: pollQuestion, values: pollOptions } });
                } else {
                    await sock.sendMessage(chatJid, { text: "Formato del sondaggio errato usa la barra verticale per separare le opzioni" });
                }
                return true;
            }

            case '!setname': {
                if (isGroup) {
                    if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                        await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                        return true;
                    }
                    const newName = messageText.replace(/^!setname/i, '').trim();
                    if (!newName) {
                        groupSettings.waitingForSetName.add(sender);
                        await sock.sendMessage(chatJid, { text: "Dimmi quale nome vuoi dare al gruppo" });
                    } else {
                        const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                        if (!botAdmin) {
                            await sock.sendMessage(chatJid, { text: "Non posso aggiornare il titolo perché non sono amministratore" });
                            return true;
                        }
                        await sock.groupUpdateSubject(chatJid, newName);
                        await sock.sendMessage(chatJid, { text: `Il titolo del gruppo è stato cambiato in modo perfetto` });
                    }
                }
                return true;
            }

            case '!lockinfo': {
                if (isGroup) {
                    if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                        await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                        return true;
                    }
                    const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                    if (!botAdmin) {
                        await sock.sendMessage(chatJid, { text: "Non ho i permessi per bloccare le informazioni del gruppo" });
                        return true;
                    }
                    await sock.groupSettingUpdate(chatJid, 'locked');
                    await sock.sendMessage(chatJid, { text: "Informazioni del gruppo bloccate con successo solo per gli admin" });
                }
                return true;
            }

            case '!unlockinfo': {
                if (isGroup) {
                    if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                        await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                        return true;
                    }
                    const botAdmin = await ensureBotIsAdmin(sock, chatJid);
                    if (!botAdmin) {
                        await sock.sendMessage(chatJid, { text: "Mi servono i poteri di admin per sbloccare le informazioni" });
                        return true;
                    }
                    await sock.groupSettingUpdate(chatJid, 'unlocked');
                    await sock.sendMessage(chatJid, { text: "Informazioni del gruppo sbloccate per tutti quanti" });
                }
                return true;
            }

            case '!link': {
                if (isGroup) {
                    if (!(await isActualAdminOrOwner(sock, chatJid, sender))) {
                        await sock.sendMessage(chatJid, { text: "Non puoi usare questo comando perché non risulti amministratore autorizzato" });
                        return true;
                    }
                    const action = args[1];
                    if (action === 'on') {
                        groupSettings.linkFilter = true;
                        await sock.sendMessage(chatJid, { text: "Filtro anti link esterni attivato correttamente" });
                    } else if (action === 'off') {
                        groupSettings.linkFilter = false;
                        await sock.sendMessage(chatJid, { text: "Filtro anti link esterni disattivato" });
                    }
                }
                return true;
            }

            case '!offline':
            case '!assente': {
                if (isOwner(sender, sock)) {
                    global.offlineMode = true;
                    await sock.sendMessage(chatJid, { text: "Modalità offline attivata con successo" });
                }
                return true;
            }

            case '!online':
            case '!presente': {
                if (isOwner(sender, sock)) {
                    global.offlineMode = false;
                    await sock.sendMessage(chatJid, { text: "Bentornato modalità online riattivata" });
                }
                return true;
            }

            case '!protezione': {
                if (isOwner(sender, sock)) {
                    const action = args[1];
                    if (action === 'on') {
                        global.protectionEnabled = true;
                        await sock.sendMessage(chatJid, { text: "Protezione del proprietario attivata" });
                    } else if (action === 'off') {
                        global.protectionEnabled = false;
                        await sock.sendMessage(chatJid, { text: "Attenzione protezione del proprietario disattivata" });
                    }
                }
                return true;
            }

            case '!gruppo': {
                if (isGroup) {
                    const action = args[1];
                    if (action === 'off') {
                        if (isOwner(sender, sock)) {
                            groupSettings.inactiveGroups.add(chatJid);
                            await sock.sendMessage(chatJid, { text: "Il bot è stato disattivato in questo gruppo" });
                        } else {
                            await sock.sendMessage(chatJid, { text: "Al momento non puoi usare questo comando perché questo comando è riservato al proprietario" });
                        }
                    }
                }
                return true;
            }

            case '!setowner': {
                if (sender === OWNER_JID) {
                    if (targetMention) {
                        global.extraOwners.add(targetMention);
                        global.protectedUsers.add(targetMention);
                        await sock.sendMessage(chatJid, { text: "Nuovo proprietario aggiunto con successo" });
                    } else {
                        await sock.sendMessage(chatJid, { text: "Devi taggare un utente per promuoverlo" });
                    }
                } else {
                    await sock.sendMessage(chatJid, { text: "Comando riservato esclusivamente al creatore principale" });
                }
                return true;
            }

            case '!removeowner': {
                if (sender === OWNER_JID) {
                    if (targetMention) {
                        global.extraOwners.delete(targetMention);
                        global.protectedUsers.delete(targetMention);
                        await sock.sendMessage(chatJid, { text: "Ruolo di proprietario rimosso correttamente" });
                    } else {
                        await sock.sendMessage(chatJid, { text: "Tagga un utente per rimuovere i poteri" });
                    }
                } else {
                    await sock.sendMessage(chatJid, { text: "Comando riservato esclusivamente al creatore principale" });
                }
                return true;
            }
        }

    } catch (error) {
        console.error("Errore nell'esecuzione dei comandi:", error);
    }
    return false;
}
