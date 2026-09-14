import { GoogleGenAI } from '@google/genai';

export async function execute(sock, m, chatJid, messageText, sender, isGroup, mutedUsers, warnings) {
    global.linksEnabled = global.linksEnabled !== undefined ? global.linksEnabled : false;
    global.cooldownEnabled = global.cooldownEnabled !== undefined ? global.cooldownEnabled : false;
    global.offlineMode = global.offlineMode !== undefined ? global.offlineMode : false;
    global.groupActive = global.groupActive !== undefined ? global.groupActive : true;
    global.botOwner = global.botOwner || "393534467571@s.whatsapp.net";
    global.geminiApiKey = global.geminiApiKey || process.env.GEMINI_API_KEY || "";
    
    global.protectedUsers = global.protectedUsers || new Set();
    global.extraOwners = global.extraOwners || new Set([global.botOwner]);

    // Icona del bot da includere nelle risposte
    const botArt = "🤖";

    const isOwner = (jid) => {
        if (!jid) return false;
        const cleanJid = jid.split('@')[0].replace(/[^0-9]/g, '');
        if (cleanJid === global.botOwner.split('@')[0].replace(/[^0-9]/g, '')) return true;
        for (const owner of global.extraOwners) {
            if (owner.split('@')[0].replace(/[^0-9]/g, '') === cleanJid) return true;
        }
        return m.key.fromMe;
    };

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

    const ensureBotIsAdmin = async () => {
        if (!isGroup) return true;
        try {
            const groupMetadata = await sock.groupMetadata(chatJid);
            const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const botParticipant = groupMetadata.participants.find(p => p.id.includes(botId.split('@')[0]));
            const isBotAdmin = botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');
            
            if (!isBotAdmin) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore: Il bot deve essere amministratore del gruppo per eseguire questo comando.` }, { quoted: m });
                return false;
            }
            return true;
        } catch (err) {
            console.error("Errore controllo admin:", err);
            return false;
        }
    };

    // 1. Gestione modalità offline in chat privata
    if (!isGroup && global.offlineMode && !isOwner(sender) && !m.key.fromMe) {
        await sock.sendMessage(chatJid, { text: `${botArt} Al momento Alessio non è disponibile. Ti risponderà appena possibile...` }, { quoted: m });
        return true;
    }

    // 2. Controllo gruppo attivo
    if (isGroup && !global.groupActive && !messageText.startsWith('!gruppo')) {
        return true;
    }

    // 3. Intercettazione utenti mutati
    if (isGroup && mutedUsers && mutedUsers.has(sender)) {
        try {
            await sock.sendMessage(chatJid, { delete: m.key });
        } catch (err) {
            console.error("Errore eliminazione messaggio utente mutato:", err);
        }
        return true;
    }

    const args = messageText.trim().split(/ +/);
    const command = args[0].toLowerCase();

    // Menu comandi
    if (command === '!commands' || command === '!menu') {
        const menuText = `${botArt} *LISTA COMANDI BOT* ${botArt}

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
!web [domanda] / !cerca [domanda]* - Naviga web tramite Google Gemini
!setgeminiak [chiave]* - Imposta la chiave API di Google Gemini (Solo Proprietario)

📌 Gruppo & Sicurezza:
!tagall / !tutti* - Manda un avviso a tutti
!poll Domanda? | Opz 1 | Opz 2* - Crea un sondaggio
!setname [nome]* - Cambia il nome del gruppo
!lockinfo* - Blocca le info del gruppo
!unlockinfo* - Sblocca le info del gruppo
!link on/off* - Attiva/disattiva cancellazione automatica link esterni
!cooldown on/off* - Attiva/disattiva il limite di tempo antispam
!offline / !assente* - Attiva la modalità offline
!online / !presente* - Disattiva la modalità offline
!protezione on/off* - Attiva/disattiva protezione proprietario/utente
!gruppo on/off* - Attiva/disattiva risposta bot nel gruppo (Solo Proprietario)
!setowner @utente* - Promuove un utente a proprietario (Solo Creatore Principale)
!removeowner @utente* - Rimuove i poteri di proprietario (Solo Creatore Principale)`;

        await sock.sendMessage(chatJid, { text: menuText }, { quoted: m });
        return true;
    }

    // Gestione Mute
    if (command === '!mute') {
        let targetJid = getTargetJid();
        if (!targetJid) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Per favore, tagga o rispondi a un utente da mutare.` }, { quoted: m });
            return true;
        }
        if (isOwner(targetJid) || global.protectedUsers.has(targetJid)) {
            await sock.sendMessage(chatJid, { text: `${botArt} Impossibile eseguire questa operazione per motivi tecnici messi dal proprietario` }, { quoted: m });
            return true;
        }
        if (mutedUsers) mutedUsers.add(targetJid);
        await sock.sendMessage(chatJid, { text: `${botArt} 🔇 L'utente @${targetJid.split('@')[0]} è stato mutato localmente.`, mentions: [targetJid] }, { quoted: m });
        return true;
    }

    // Gestione Unmute
    if (command === '!unmute') {
        let targetJid = getTargetJid();
        if (!targetJid) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Per favore, tagga o rispondi a un utente da smutare.` }, { quoted: m });
            return true;
        }
        if (mutedUsers) mutedUsers.delete(targetJid);
        await sock.sendMessage(chatJid, { text: `${botArt} 🔊 L'utente @${targetJid.split('@')[0]} è stato smutato con successo.`, mentions: [targetJid] }, { quoted: m });
        return true;
    }

    // Gestione Warn
    if (command === '!warn') {
        let targetJid = getTargetJid();
        if (!targetJid) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Per favore, tagga o rispondi a un utente.` }, { quoted: m });
            return true;
        }
        if (isOwner(targetJid) || global.protectedUsers.has(targetJid)) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Non puoi dare un avvertimento a un utente protetto o al proprietario!` }, { quoted: m });
            return true;
        }
        if (warnings) {
            const currentWarnings = (warnings.get(targetJid) || 0) + 1;
            warnings.set(targetJid, currentWarnings);

            if (currentWarnings === 1) {
                await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ @${targetJid.split('@')[0]}, hai ricevuto il 1° avvertimento (1/3).`, mentions: [targetJid] }, { quoted: m });
            } else if (currentWarnings === 2) {
                await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ @${targetJid.split('@')[0]}, questo è il tuo secondo avvertimento (2/3). Al terzo verrai bannato!`, mentions: [targetJid] }, { quoted: m });
            } else if (currentWarnings >= 3) {
                warnings.delete(targetJid);
                if (await ensureBotIsAdmin()) {
                    try {
                        await sock.groupParticipantsUpdate(chatJid, [targetJid], "remove");
                        await sock.sendMessage(chatJid, { text: `${botArt} 🚨 @${targetJid.split('@')[0]} è stato espulso per aver raggiunto 3 avvertimenti.`, mentions: [targetJid] });
                    } catch (err) {
                        await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante il ban dell'utente.` });
                    }
                }
            }
        }
        return true;
    }

    // Kick / Rimuovi
    if (command === '!kick' || command === '!rimuovi') {
        let targetJid = getTargetJid();
        if (!targetJid) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Tagga l'utente da rimuovere.` }, { quoted: m });
            return true;
        }
        if (isOwner(targetJid) || global.protectedUsers.has(targetJid)) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Non puoi rimuovere un utente protetto o il proprietario!` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            try {
                await sock.groupParticipantsUpdate(chatJid, [targetJid], "remove");
                await sock.sendMessage(chatJid, { text: `${botArt} 👋 Utente @${targetJid.split('@')[0]} rimosso con successo.`, mentions: [targetJid] });
            } catch (err) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Impossibile rimuovere l'utente.` });
            }
        }
        return true;
    }

    // Promuovi Admin
    if (command === '!promuovi') {
        let targetJid = getTargetJid();
        if (!targetJid) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Tagga l'utente da promuovere.` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            try {
                await sock.groupParticipantsUpdate(chatJid, [targetJid], "promote");
                await sock.sendMessage(chatJid, { text: `${botArt} ⭐ L'utente @${targetJid.split('@')[0]} è stato promosso ad amministratore.`, mentions: [targetJid] });
            } catch (err) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Impossibile promuovere l'utente.` });
            }
        }
        return true;
    }

    // Demuovi Admin
    if (command === '!demuovi' || command === '!quickdemote') {
        let targetJid = getTargetJid();
        if (!targetJid) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Tagga l'utente a cui togliere i poteri.` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            try {
                await sock.groupParticipantsUpdate(chatJid, [targetJid], "demote");
                await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ All'utente @${targetJid.split('@')[0]} sono stati revocati i poteri di amministratore.`, mentions: [targetJid] });
            } catch (err) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Impossibile rimuovere i poteri di admin.` });
            }
        }
        return true;
    }

    // Multidemote
    if (command === '!multidemote') {
        const mentionedJid = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (mentionedJid.length === 0) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Tagga almeno un utente a cui rimuovere i poteri.` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            try {
                await sock.groupParticipantsUpdate(chatJid, mentionedJid, "demote");
                await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ Poteri di admin rimossi con successo a tutti gli utenti selezionati.` });
            } catch (err) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante la rimozione multipla dei poteri.` });
            }
        }
        return true;
    }

    // Editgroup
    if (command === '!editgroup') {
        const status = args[1]?.toLowerCase();
        if (status !== 'on' && status !== 'off') {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Usa: !editgroup on oppure !editgroup off` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            await sock.groupSettingUpdate(chatJid, status === 'on' ? 'locked' : 'unlocked');
            await sock.sendMessage(chatJid, { text: `${botArt} ⚙️ Modifica informazioni gruppo impostata su: *${status}*` });
        }
        return true;
    }

    // Approva
    if (command === '!approva') {
        const status = args[1]?.toLowerCase();
        if (status !== 'on' && status !== 'off') {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Usa: !approva on oppure !approva off` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            await sock.groupJoinApprovalMode(chatJid, status === 'on' ? 'on' : 'off');
            await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ Approvazione nuovi membri impostata su: *${status}*` });
        }
        return true;
    }

    // Masskick / Svuotagruppo
    if (command === '!masskick' || command === '!svuotagruppo') {
        if (await ensureBotIsAdmin()) {
            try {
                const metadata = await sock.groupMetadata(chatJid);
                const participantsToRemove = metadata.participants
                    .filter(p => p.admin === null && !isOwner(p.id) && !global.protectedUsers.has(p.id))
                    .map(p => p.id);
                
                if (participantsToRemove.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participantsToRemove, "remove");
                    await sock.sendMessage(chatJid, { text: `${botArt} 🚨 Gruppo svuotato con successo da tutti i membri non amministratori.` });
                } else {
                    await sock.sendMessage(chatJid, { text: `${botArt} ℹ️ Nessun membro idoneo alla rimozione trovato.` });
                }
            } catch (err) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante lo svuotamento del gruppo.` });
            }
        }
        return true;
    }

    // Deletegroup / Eliminagruppo
    if (command === '!deletegroup' || command === '!eliminagruppo') {
        if (await ensureBotIsAdmin()) {
            try {
                const metadata = await sock.groupMetadata(chatJid);
                const participantsToRemove = metadata.participants
                    .filter(p => p.id !== sock.user.id && !isOwner(p.id))
                    .map(p => p.id);
                
                if (participantsToRemove.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participantsToRemove, "remove");
                }
                await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Eliminazione del gruppo in corso...` });
                await sock.groupLeave(chatJid);
            } catch (err) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Impossibile eliminare/abbandonare il gruppo.` });
            }
        }
        return true;
    }

    // Web / Cerca con Gemini
    if (command === '!web' || command === '!cerca') {
        const query = args.slice(1).join(' ');
        if (!query) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Inserisci una domanda o una ricerca da effettuare.` }, { quoted: m });
            return true;
        }
        if (!global.geminiApiKey) {
            await sock.sendMessage(chatJid, { text: `${botArt} ❌ Chiave API di Google Gemini non configurata. Impostala con !setgeminiak [chiave]` }, { quoted: m });
            return true;
        }
        try {
            const ai = new GoogleGenAI({ apiKey: global.geminiApiKey });
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: query,
                config: {
                    tools: [{ googleSearch: {} }]
                }
            });
            await sock.sendMessage(chatJid, { text: `${botArt} ${response.text || "Nessun risultato trovato."}` }, { quoted: m });
        } catch (err) {
            console.error("Errore Gemini Web Search:", err);
            await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante l'elaborazione della ricerca web.` }, { quoted: m });
        }
        return true;
    }

    // Set Gemini API Key
    if (command === '!setgeminiak') {
        if (!isOwner(sender)) {
            await sock.sendMessage(chatJid, { text: `${botArt} Al momento non puoi usare questo comando perché questo comando è riservato al proprietario.` }, { quoted: m });
            return true;
        }
        const newKey = args[1];
        if (!newKey) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Specifica la chiave API da impostare.` }, { quoted: m });
            return true;
        }
        global.geminiApiKey = newKey;
        await sock.sendMessage(chatJid, { text: `${botArt} ✅ Chiave API di Google Gemini aggiornata con successo.` }, { quoted: m });
        return true;
    }

    // Tagall / Tutti
    if (command === '!tagall' || command === '!tutti') {
        try {
            const groupMetadata = await sock.groupMetadata(chatJid);
            const participants = groupMetadata.participants;
            let textToSend = `${botArt} *AVVISO GENERALE* ${botArt}\n\n`;
            let mentions = [];
            for (const p of participants) {
                textToSend += `@${p.id.split('@')[0]} `;
                mentions.push(p.id);
            }
            await sock.sendMessage(chatJid, { text: textToSend, mentions: mentions }, { quoted: m });
        } catch (err) {
            console.error("Errore tagall:", err);
        }
        return true;
    }

    // Poll
    if (command === '!poll') {
        const pollInput = args.slice(1).join(' ');
        if (!pollInput) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Formato non valido. Usa: !poll Domanda? | Opz 1 | Opz 2` }, { quoted: m });
            return true;
        }
        const parts = pollInput.split('|').map(p => p.trim());
        const question = parts[0];
        const options = parts.slice(1);
        if (options.length < 2) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Inserire almeno due opzioni separate da |.` }, { quoted: m });
            return true;
        }
        await sock.sendMessage(chatJid, {
            poll: {
                name: question,
                values: options
            }
        });
        return true;
    }

    // Setname
    if (command === '!setname') {
        const newName = args.slice(1).join(' ');
        if (!newName) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Specifica il nuovo nome del gruppo.` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            try {
                await sock.groupUpdateSubject(chatJid, newName);
                await sock.sendMessage(chatJid, { text: `${botArt} ✅ Titolo aggiornato in: *${newName}*` });
            } catch (err) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante l'aggiornamento del titolo.` });
            }
        }
        return true;
    }

    // Lockinfo / Unlockinfo
    if (command === '!lockinfo') {
        if (await ensureBotIsAdmin()) {
            await sock.groupSettingUpdate(chatJid, 'locked');
            await sock.sendMessage(chatJid, { text: `${botArt} 🔒 Informazioni del gruppo bloccate (solo admin).` });
        }
        return true;
    }

    if (command === '!unlockinfo') {
        if (await ensureBotIsAdmin()) {
            await sock.groupSettingUpdate(chatJid, 'unlocked');
            await sock.sendMessage(chatJid, { text: `${botArt} 🔓 Informazioni del gruppo sbloccate (tutti i membri).` });
        }
        return true;
    }

    // Protezione
    if (command === '!protezione') {
        if (!isOwner(sender)) {
            await sock.sendMessage(chatJid, { text: `${botArt} Al momento non puoi usare questo comando perché questo comando è riservato al proprietario.` }, { quoted: m });
            return true;
        }
        let status = args[1];
        let targetJid = getTargetJid();

        if (status === 'on') {
            if (targetJid) {
                global.protectedUsers.add(targetJid);
                await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ L'utente @${targetJid.split('@')[0]} ora è protetto ed è intoccabile come il proprietario!`, mentions: [targetJid] }, { quoted: m });
            } else {
                global.protectedUsers.add('general');
                await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ Protezione generale del gruppo ATTIVATA.` }, { quoted: m });
            }
        } else if (status === 'off') {
            if (targetJid) {
                global.protectedUsers.delete(targetJid);
                await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ Protezione rimossa per l'utente @${targetJid.split('@')[0]}`, mentions: [targetJid] }, { quoted: m });
            } else {
                global.protectedUsers.clear();
                await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ Protezione disattivata completamente.` }, { quoted: m });
            }
        }
        return true;
    }

    // Setowner
    if (command === '!setowner') {
        if (isOwner(sender)) {
            let targetJid = getTargetJid();
            if (targetJid) {
                global.extraOwners.add(targetJid);
                global.protectedUsers.add(targetJid);
                await sock.sendMessage(chatJid, { text: `${botArt} 👑 L'utente @${targetJid.split('@')[0]} è ora ufficialmente un proprietario del bot!`, mentions: [targetJid] }, { quoted: m });
            } else {
                await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Tagga un utente per renderlo proprietario.` }, { quoted: m });
            }
        } else {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Comando riservato al creatore principale del bot.` }, { quoted: m });
        }
        return true;
    }

    // Removeowner
    if (command === '!removeowner') {
        if (isOwner(sender)) {
            let targetJid = getTargetJid();
            if (targetJid) {
                global.extraOwners.delete(targetJid);
                await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ Rimossi i poteri di proprietario all'utente @${targetJid.split('@')[0]}`, mentions: [targetJid] }, { quoted: m });
            } else {
                await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Tagga un utente per rimuovere i poteri di proprietario.` }, { quoted: m });
            }
        } else {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Comando riservato al creatore principale del bot.` }, { quoted: m });
        }
        return true;
    }

    // Offline / Assente
    if (command === '!offline' || command === '!assente') {
        if (isOwner(sender)) {
            global.offlineMode = true;
            await sock.sendMessage(chatJid, { text: `${botArt} 🔴 Modalità offline attivata con successo.` }, { quoted: m });
        }
        return true;
    }

    // Online / Presente
    if (command === '!online' || command === '!presente') {
        if (isOwner(sender)) {
            global.offlineMode = false;
            await sock.sendMessage(chatJid, { text: `${botArt} 🟢 Alessio è ora disponibile per risponderti!` }, { quoted: m });
        }
        return true;
    }

    // Gruppo on/off
    if (command === '!gruppo') {
        let status = args[1];
        if (isOwner(sender)) {
            if (status === 'on' || status === 'off') {
                global.groupActive = (status === 'on');
                await sock.sendMessage(chatJid, { text: `${botArt} 🤖 Risposta del bot in questo gruppo impostata su: ${status}` }, { quoted: m });
            }
        } else {
            await sock.sendMessage(chatJid, { text: `${botArt} Al momento non puoi usare questo comando perché questo comando è riservato al proprietario.` }, { quoted: m });
        }
        return true;
    }

    return false;
}
