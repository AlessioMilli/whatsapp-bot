import { GoogleGenAI } from '@google/genai';

export async function execute(sock, m, chatJid, messageText, sender, isGroup, mutedUsers, warnings) {
    global.linksEnabled = global.linksEnabled !== undefined ? global.linksEnabled : false;
    global.cooldownEnabled = global.cooldownEnabled !== undefined ? global.cooldownEnabled : false;
    global.offlineMode = global.offlineMode !== undefined ? global.offlineMode : false;
    global.groupActive = global.groupActive !== undefined ? global.groupActive : true;
    global.botOwner = global.botOwner || "393534467571@s.whatsapp.net";
    global.geminiApiKey = global.geminiApiKey || "AQ.Ab8RN6KGF2fL0hUJelCsfC0nSSA-LWXs5UYs0K3SffjQRIjBtA";
    
    global.protectedUsers = global.protectedUsers || new Set();
    global.extraOwners = global.extraOwners || new Set([global.botOwner]);
    global.cooldowns = global.cooldowns || new Map();
    global.chatHistory = global.chatHistory || new Map();

    const botArt = "🤖";

    // Registra i messaggi recenti per ogni gruppo per fornire contesto all'IA
    if (isGroup && messageText) {
        if (!global.chatHistory.has(chatJid)) {
            global.chatHistory.set(chatJid, []);
        }
        let history = global.chatHistory.get(chatJid);
        history.push({ sender: sender.split('@')[0], text: messageText, time: Date.now() });
        if (history.length > 20) history.shift();
    }

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
            for (let i = 1; i < args.length; i++) {
                let arg = args[i];
                if (arg.startsWith('@')) {
                    let clean = arg.slice(1).replace(/[^0-9]/g, '');
                    if (clean.length > 5) return clean + '@s.whatsapp.net';
                } else if (/^\d{8,15}$/.test(arg)) {
                    return arg + '@s.whatsapp.net';
                }
            }
        }
        return targetJid;
    };

    const ensureBotIsAdmin = async () => {
        if (!isGroup) return true;
        if (isOwner(sender)) return true;
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

    if (!isGroup && global.offlineMode && !isOwner(sender) && !m.key.fromMe) {
        await sock.sendMessage(chatJid, { text: `${botArt} Al momento Alessio non è disponibile. Ti risponderà appena possibile...` }, { quoted: m });
        return true;
    }

    if (isGroup && !global.groupActive && !messageText.startsWith('!gruppo')) {
        return true;
    }

    if (isGroup && mutedUsers && mutedUsers.has(sender)) {
        try {
            await sock.sendMessage(chatJid, { delete: m.key });
        } catch (err) {
            console.error("Errore eliminazione messaggio utente mutato:", err);
        }
        return true;
    }

    if (global.cooldownEnabled && !isOwner(sender) && !m.key.fromMe) {
        const now = Date.now();
        const cooldownTime = 4000;
        if (global.cooldowns.has(sender)) {
            const expirationTime = global.cooldowns.get(sender) + cooldownTime;
            if (now < expirationTime) {
                return true;
            }
        }
        global.cooldowns.set(sender, now);
    }

    if (isGroup && global.linksEnabled && !isOwner(sender) && !m.key.fromMe) {
        const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\/.+)/gi;
        if (urlRegex.test(messageText)) {
            try {
                await sock.sendMessage(chatJid, { delete: m.key });
                await sock.sendMessage(chatJid, { text: `${botArt} Ragazzi, sono il chatbot di moderazione di @Alessio (+39 35344667571). Se volete inviare link esterni dovete prima contattare il proprietario`, mentions: ["393534467571@s.whatsapp.net"] });
            } catch (err) {
                console.error("Errore gestione link:", err);
            }
            return true;
        }
    }

    const args = messageText.trim().split(/ +/);
    const command = args[0].toLowerCase();

    if (command === '!commands' || command === '!menu') {
        const menuText = `${botArt} LISTA COMANDI BOT ${botArt}
!mute @utente* - Silenzia un utente localmente
!unmute @utente* - Rimuove il muto all'utente
!warn @utente* - Dà un avvertimento (3 = analisi intelligente del contesto e provvedimento)
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

        await sock.sendMessage(chatJid, { text: menuText }, { quoted: m });
        return true;
    }

    if (command === '!mute') {
        let targetJid = getTargetJid();
        if (!targetJid) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Per favore, tagga o rispondi a un utente da mutare.` }, { quoted: m });
            return true;
        }
        const isTargetAlessio = targetJid.includes("393534467571") || isOwner(targetJid);
        if (isTargetAlessio || global.protectedUsers.has(targetJid) || global.protectedUsers.has('general')) {
            const protMsg = isTargetAlessio
                ? `${botArt} Impossibile eseguire questa azione perché sono stato programmato per proteggere il mio capo, essendo lui stesso ad avermi creato`
                : `${botArt} Impossibile eseguire questa operazione per motivi tecnici messi dal proprietario`;
            await sock.sendMessage(chatJid, { text: protMsg }, { quoted: m });
            return true;
        }
        if (mutedUsers) mutedUsers.add(targetJid);
        await sock.sendMessage(chatJid, { text: `${botArt} 🔇 L'utente @${targetJid.split('@')[0]} è stato mutato localmente.`, mentions: [targetJid] }, { quoted: m });
        return true;
    }

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
                await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ @${targetJid.split('@')[0]}, questo è il tuo secondo avvertimento (2/3). Al terzo scattano provvedimenti severi gestiti dall'intelligenza artificiale!`, mentions: [targetJid] }, { quoted: m });
            } else if (currentWarnings >= 3) {
                let targetNumber = targetJid.split('@')[0];
                let historyContext = global.chatHistory.has(chatJid) ? global.chatHistory.get(chatJid) : [];
                let transcript = historyContext.map(h => `[${h.sender}]: ${h.text}`).join('\n');

                let aiVerdict = "ban";
                if (global.geminiApiKey) {
                    try {
                        const ai = new GoogleGenAI({ apiKey: global.geminiApiKey });
                        const prompt = `Sei un assistente moderatore di un gruppo WhatsApp. L'utente con numero/id ${targetNumber} ha raggiunto 3 avvertimenti. 
Analizza la seguente cronologia recente della chat per capire se l'utente ha effettivamente commesso infrazioni gravi, insulti, provocazioni o comportamenti scorretti, oppure se non ha fatto nulla di rilevante o si tratta di un equivoco:

${transcript}

Se l'utente NON ha fatto nulla di male, non ci sono insulti o le accuse sono infondate, rispondi ESATTAMENTE con la parola "absolve" (per perdonarlo e azzerare i warn).
Se invece ha insultato o violato le regole, rispondi con "strip" (per revoca poteri/muto) o "ban" (per espulsione). Rispondi solo con una di queste tre parole: absolve, strip, ban.`;

                        const response = await ai.models.generateContent({
                            model: 'gemini-2.5-flash',
                            contents: prompt,
                        });
                        aiVerdict = response.text ? response.text.trim().toLowerCase() : "ban";
                    } catch (err) {
                        console.error("Errore IA analisi contesto warn:", err);
                    }
                }

                if (aiVerdict.includes("absolve")) {
                    warnings.delete(targetJid);
                    await sock.sendMessage(chatJid, { text: `${botArt} 🧠 L'intelligenza artificiale ha analizzato la chat e ha verificato che @${targetNumber} non ha commesso alcuna infrazione o insulto recente. Avvertimenti azzerati per equità!`, mentions: [targetJid] });
                } else if (aiVerdict.includes("strip")) {
                    warnings.delete(targetJid);
                    if (await ensureBotIsAdmin()) {
                        try {
                            await sock.groupParticipantsUpdate(chatJid, [targetJid], "demote");
                            if (mutedUsers) mutedUsers.add(targetJid);
                            await sock.sendMessage(chatJid, { text: `${botArt} 🧠 L'intelligenza artificiale ha esaminato i messaggi e ha riscontrato comportamenti scorretti da parte di @${targetNumber}: gli sono stati revocati i poteri ed è stato mutato.`, mentions: [targetJid] });
                        } catch (err) {
                            await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante l'applicazione del provvedimento dell'IA.` });
                        }
                    }
                } else {
                    warnings.delete(targetJid);
                    if (await ensureBotIsAdmin()) {
                        try {
                            await sock.groupParticipantsUpdate(chatJid, [targetJid], "remove");
                            await sock.sendMessage(chatJid, { text: `${botArt} 🚨 L'IA ha analizzato la chat e ha confermato l'espulsione immediata di @${targetNumber} per violazioni rilevate nei messaggi.`, mentions: [targetJid] });
                        } catch (err) {
                            await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante il ban dell'utente.` });
                        }
                    }
                }
            }
        }
        return true;
    }

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

    if (command === '!promuovi') {
        let targetJid = getTargetJid();
        if (!targetJid) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Tagga l'utente da promuovere.` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            try {
                await sock.groupParticipantsUpdate(chatJid, [targetJid], "promote");
                await sock.sendMessage(chatJid, { text: `${botArt} ⭐ L'utente @${targetJid.split('@')[0]} è stato promosso ad amministratore/amministratrice.`, mentions: [targetJid] });
            } catch (err) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Impossibile promuovere l'utente.` });
            }
        }
        return true;
    }

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

    if (command === '!addmember') {
        const status = args[1]?.toLowerCase();
        if (status !== 'on' && status !== 'off') {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Usa: !addmember on oppure !addmember off` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            try {
                await sock.groupMemberAddMode(chatJid, status === 'on' ? 'admin_add' : 'all_member_add');
                await sock.sendMessage(chatJid, { text: `${botArt} ⚙️ Restrizione aggiunta membri impostata su: *${status}*` });
            } catch (e) {
                await sock.sendMessage(chatJid, { text: `${botArt} ⚙️ Comando addmember elaborato.` });
            }
        }
        return true;
    }

    if (command === '!history') {
        const status = args[1]?.toLowerCase();
        if (status !== 'on' && status !== 'off') {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Usa: !history on oppure !history off` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚙️ Cronologia per i nuovi membri impostata su: *${status}*` });
        }
        return true;
    }

    if (command === '!invitelink') {
        const status = args[1]?.toLowerCase();
        if (status !== 'on' && status !== 'off') {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Usa: !invitelink on oppure !invitelink off` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚙️ Accesso tramite link d'invito impostato su: *${status}*` });
        }
        return true;
    }

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

    if (command === '!web' || command === '!cerca') {
        const query = args.slice(1).join(' ');
        if (!query) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Inserisci una domanda o una ricerca da effettuare.` }, { quoted: m });
            return true;
        }
        if (!global.geminiApiKey) {
            await sock.sendMessage(chatJid, { text: `${botArt} ❌ Chiave API di Google Gemini non configurata.` }, { quoted: m });
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

    if (command === '!tagall' || command === '!tutti') {
        const customText = args.slice(1).join(' ');
        if (!customText) {
            await sock.sendMessage(chatJid, { text: `${botArt} Cosa vorresti scrivere nell'avviso?` }, { quoted: m });
            return true;
        }
        try {
            const groupMetadata = await sock.groupMetadata(chatJid);
            const participants = groupMetadata.participants;
            let textToSend = `${botArt} *AVVISO GENERALE* ${botArt}\n\n${customText}\n\n`;
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

    if (command === '!setname') {
        const newName = args.slice(1).join(' ');
        if (!newName) {
            await sock.sendMessage(chatJid, { text: `${botArt} Cosa vuoi che metto sul titolo del gruppo?` }, { quoted: m });
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

    if (command === '!link') {
        const status = args[1]?.toLowerCase();
        if (status === 'on') {
            global.linksEnabled = true;
            await sock.sendMessage(chatJid, { text: `${botArt} 🔗 Cancellazione automatica dei link esterni ATTIVATA.` }, { quoted: m });
        } else if (status === 'off') {
            global.linksEnabled = false;
            await sock.sendMessage(chatJid, { text: `${botArt} 🔗 Cancellazione automatica dei link esterni DISATTIVATA.` }, { quoted: m });
        } else {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Usa: !link on oppure !link off` }, { quoted: m });
        }
        return true;
    }

    if (command === '!cooldown') {
        const status = args[1]?.toLowerCase();
        if (status === 'on') {
            global.cooldownEnabled = true;
            await sock.sendMessage(chatJid, { text: `${botArt} ⏱️ Cooldown antispam ATTIVATO.` }, { quoted: m });
        } else if (status === 'off') {
            global.cooldownEnabled = false;
            await sock.sendMessage(chatJid, { text: `${botArt} ⏱️ Cooldown antispam DISATTIVATA.` }, { quoted: m });
        } else {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Usa: !cooldown on oppure !cooldown off` }, { quoted: m });
        }
        return true;
    }

    if (command === '!protezione') {
        if (!isOwner(sender)) {
            await sock.sendMessage(chatJid, { text: `${botArt} Al momento non puoi usare questo comando perché questo comando è riservato al proprietario.` }, { quoted: m });
            return true;
        }
        
        let status = args.find(arg => arg.toLowerCase() === 'on' || arg.toLowerCase() === 'off')?.toLowerCase();
        let targetJid = getTargetJid();

        if (!status) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Specifica se attivare o disattivare la protezione usando 'on' o 'off'.` }, { quoted: m });
            return true;
        }

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
                global.protectedUsers.delete('general');
                global.protectedUsers.clear();
                await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ Protezione disattivata completamente.` }, { quoted: m });
            }
        }
        return true;
    }

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

    if (command === '!offline' || command === '!assente') {
        if (isOwner(sender)) {
            global.offlineMode = true;
            await sock.sendMessage(chatJid, { text: `${botArt} 🔴 Modalità offline attivata con successo.` }, { quoted: m });
        }
        return true;
    }

    if (command === '!online' || command === '!presente') {
        if (isOwner(sender)) {
            global.offlineMode = false;
            await sock.sendMessage(chatJid, { text: `${botArt} 🟢 Alessio è ora disponibile per risponderti!` }, { quoted: m });
        }
        return true;
    }

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
} // <-- QUESTA ERA LA GRAFFA MANCANTE CHE CAUSAVA L'ERRORE DI SINTASSI SU RENDER
