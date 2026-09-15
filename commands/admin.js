import { GoogleGenAI } from '@google/genai';

// Mappa globale per memorizzare quali gruppi hanno il cooldown attivo e chi ha ricevuto l'avviso di ritorno
global.groupCooldowns = global.groupCooldowns || new Map();
global.notifiedUsers = global.notifiedUsers || new Set();
const userCooldowns = new Map();
const COOLDOWN_TIME = 5000; // 5 secondi di attesa

export async function execute(sock, m, chatJid, messageText, sender, isGroup, mutedUsers, warnings) {
    global.linksEnabled = global.linksEnabled !== undefined ? global.linksEnabled : false;
    global.offlineMode = global.offlineMode !== undefined ? global.offlineMode : false;
    global.groupActive = global.groupActive !== undefined ? global.groupActive : true;
    global.botOwner = global.botOwner || "393534467571@s.whatsapp.net";
    global.geminiApiKey = global.geminiApiKey || "AQ.Ab8RN6KGF2fL0hUJelCsfC0nSSA-LWXs5UYs0K3SffjQRIjBtA";
    
    global.protectedUsers = global.protectedUsers || new Set();
    global.extraOwners = global.extraOwners || new Set([global.botOwner]);
    global.chatHistory = global.chatHistory || new Map();

    const botArt = "🤖";
    const args = messageText.trim().split(/ +/);
    const command = args[0] ? args[0].toLowerCase() : '';

    const isPrivateChatWithSelf = !isGroup && (sender.includes("393534467571") || chatJid.includes("393534467571") || m.key.fromMe);

    const isOwner = (jid) => {
        if (!jid && m.key.fromMe) return true;
        if (!jid) return false;
        const cleanJid = jid.split('@')[0].replace(/[^0-9]/g, '');
        const cleanOwner = global.botOwner.split('@')[0].replace(/[^0-9]/g, '');
        if (cleanJid === cleanOwner || cleanJid === "393534467571") return true;
        for (const owner of global.extraOwners) {
            if (owner.split('@')[0].replace(/[^0-9]/g, '') === cleanJid) return true;
        }
        return m.key.fromMe;
    };

    // Gestione esclusiva di !offline e !online nella tua chat privata con te stesso
    if (!isGroup && isOwner(sender)) {
        if (command === '!offline' || command === '!assente') {
            global.offlineMode = true;
            global.notifiedUsers.clear(); // Resetta la lista così al prossimo online riceveranno l'avviso
            await sock.sendMessage(chatJid, { text: `${botArt} 🔴 Modalità offline attivata per tutte le chat private.` }, { quoted: m });
            return true;
        }
        if (command === '!online' || command === '!presente') {
            global.offlineMode = false;
            await sock.sendMessage(chatJid, { text: `${botArt} 🟢 Bot online e disponibile in tutte le chat private!` }, { quoted: m });
            return true;
        }
    }

    // Filtro rigoroso: nei gruppi, se il messaggio non inizia con '!', il bot lo ignora completamente
    if (isGroup && !messageText.startsWith('!')) {
        return true;
    }

    const isTargetSpecificNumber = (jid) => {
        if (!jid) return false;
        const cleanJid = jid.split('@')[0].replace(/[^0-9]/g, '');
        return cleanJid === "393534467571";
    };

    if (isGroup && messageText) {
        if (!global.chatHistory.has(chatJid)) {
            global.chatHistory.set(chatJid, []);
        }
        let history = global.chatHistory.get(chatJid);
        history.push({ sender: sender.split('@')[0], text: messageText, time: Date.now() });
        if (history.length > 20) history.shift();
    }

    const getTargetJid = () => {
        let mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        if (mentioned && mentioned.length > 0) {
            return mentioned[0];
        }
        let participant = m.message?.extendedTextMessage?.contextInfo?.participant;
        if (participant) {
            return participant;
        }
        for (let i = 1; i < args.length; i++) {
            let arg = args[i];
            if (arg.startsWith('@')) {
                let clean = arg.slice(1).replace(/[^0-9]/g, '');
                if (clean.length > 5) return clean + '@s.whatsapp.net';
            } else if (/^\d{8,15}$/.test(arg)) {
                return arg + '@s.whatsapp.net';
            }
        }
        return null;
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

    // Gestione risposte automatiche nelle chat private con gli altri utenti
    if (!isGroup && !isOwner(sender) && !isPrivateChatWithSelf) {
        if (global.offlineMode) {
            await sock.sendMessage(chatJid, { text: `${botArt} Alessio al momento non è disponibile. Ti risponderà appena rientra nella chat.` }, { quoted: m });
            return true;
        } else {
            if (!global.notifiedUsers.has(sender)) {
                global.notifiedUsers.add(sender);
                await sock.sendMessage(chatJid, { text: `${botArt} Alessio è ora disponibile per risponderti.` }, { quoted: m });
            }
        }
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

    // Controllo del Cooldown specifico per questo gruppo
    if (isGroup && global.groupCooldowns.get(chatJid) === true && !isOwner(sender)) {
        const cooldownKey = `${chatJid}_${sender}`;
        const now = Date.now();
        const lastMessageTime = userCooldowns.get(cooldownKey) || 0;

        if (now - lastMessageTime < COOLDOWN_TIME) {
            await sock.sendMessage(chatJid, { 
                text: `${botArt} ⚠️ Piano con i messaggi! Attendi qualche secondo prima di scrivere di nuovo.` 
            }, { quoted: m });
            return true; 
        }

        userCooldowns.set(cooldownKey, now);
    }

    if (isGroup && global.linksEnabled && !isOwner(sender)) {
        const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\/.+)/gi;
        if (urlRegex.test(messageText)) {
            try {
                await sock.sendMessage(chatJid, { delete: m.key });
                await sock.sendMessage(chatJid, { text: `${botArt} Ragazzi, sono il chatbot di moderazione di @Alessio (+39 3534467571). Se volete inviare link esterni dovete prima contattare il proprietario`, mentions: ["393534467571@s.whatsapp.net"] });
            } catch (err) {
                console.error("Errore gestione link:", err);
            }
            return true;
        }
    }

    if (command === '!commands' || command === '!menu') {
        const menuText = `${botArt} LISTA COMANDI BOT ${botArt}

!mute @utente* - Silenzia un utente localmente
!unmute @utente* - Rimuove il muto all'utente
!warn @utente* - Dà un avvertimento (3 = analisi intelligente del contesto e provvedimento)
!rimuovi / !kick @utente* - Espelle dal gruppo
!promuovi @utente* - Rende amministratore
!demuovi @utente* - Toglie i poteri di admin
!multidemote @utente1 @utente2* - Rimuove i poteri di admin a più utenti taggati
!cooldown on/off* - Attiva o disattiva il cooldown/rallentamento antispam solo in questo gruppo specifico
!editgroup on/off* - Attiva/disattiva modifica info gruppo per i soli admin
!approva on/off* - Attiva/disattiva l'approvazione dei nuovi membri
!addmember on/off* - Attiva/disattiva la restrizione per aggiungere altri membri (solo admin)
!history on/off* - Attiva/disattiva l'invio della cronologia dei messaggi ai nuovi membri (solo admin)
!invitelink on/off* - Attiva/disattiva l'accesso tramite link d'invito al gruppo (solo admin)
!quickdemote @utente* - Comando rapido per rimuovere i poteri di admin taggando l'utente
!masskick / !svuotagruppo* - Rimuove istantaneamente tutti i partecipanti dal gruppo (Solo admin)
!deletegroup / !eliminagruppo* - Svuota ed elimina/abbandona il gruppo (Solo admin)
!chiedialessio [testo]* - Chiede supporto diretto ad Alessio inviandogli una richiesta aperta a tutti gli utenti
!aiutoalessio* - Mostra le istruzioni e le modalità di contatto rapido per Alessio disponibili a chiunque

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
!offline / !assente* - Attiva la modalità offline in tutte le chat private (usabile solo da te nella tua chat)
!online / !presente* - Disattiva la modalità offline in tutte le chat private
!protezione on/off* - Attiva/disattiva la protezione generale o su uno specifico utente (@utente)
!gruppo on/off* - Attiva/disattiva la risposta del bot in questo specifico gruppo (Solo Proprietario)
!setowner @utente* - Promuove un utente a proprietario del bot (Solo Creatore Principale)
!removeowner @utente* - Rimuove i poteri di proprietario a un utente (Solo Creatore Principale)`;

        await sock.sendMessage(chatJid, { text: menuText }, { quoted: m });
        return true;
    }

    if (command === '!cooldown') {
        const status = args[1]?.toLowerCase();
        if (status !== 'on' && status !== 'off') {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Usa: !cooldown on oppure !cooldown off` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            const isActive = (status === 'on');
            global.groupCooldowns.set(chatJid, isActive);
            await sock.sendMessage(chatJid, { text: `${botArt} ⏱️ Il cooldown antispam in questo gruppo è stato impostato su: *${status}*` }, { quoted: m });
        }
        return true;
    }

    if (command === '!chiedialessio') {
        const userQuery = args.slice(1).join(' ');
        if (!userQuery) {
            await sock.sendMessage(chatJid, { text: `${botArt} Ciao! Per chiedere supporto o inviare un messaggio ad Alessio, scrivi la richiesta subito dopo il comando, es: !chiedialessio [tua richiesta]` }, { quoted: m });
            return true;
        }
        await sock.sendMessage(chatJid, { text: `${botArt} 📩 Richiesta registrata con successo! Il messaggio "${userQuery}" è stato inoltrato ad Alessio. Ti risponderà appena possibile.` }, { quoted: m });
        return true;
    }

    if (command === '!aiutoalessio') {
        await sock.sendMessage(chatJid, { text: `${botArt} ℹ️ Centro Assistenza & Contatto Alessio:\n\nBenvenuto! Se hai bisogno di metterti in contatto con Alessio o richiedere supporto, puoi digitare il comando '!chiedialessio [il tuo messaggio]' oppure scrivergli direttamente. Il bot è qui per aiutarti a inoltrare qualsiasi segnalazione in modo semplice e veloce!` }, { quoted: m });
        return true;
    }

    if (command === '!mute') {
        let targetJid = getTargetJid();
        if (!targetJid) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Per favore, tagga o rispondi a un utente da mutare.` }, { quoted: m });
            return true;
        }
        const isTargetAlessio = isTargetSpecificNumber(targetJid);
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
        const isTargetAlessio = isTargetSpecificNumber(targetJid);
        if (isTargetAlessio || global.protectedUsers.has(targetJid)) {
            const protMsg = isTargetAlessio
                ? `${botArt} Impossibile eseguire questa azione perché sono stato programmato per proteggere il mio capo, essendo lui stesso ad avermi creato`
                : `${botArt} ⚠️ Non puoi dare un avvertimento a un utente protetto o al proprietario!`;
            await sock.sendMessage(chatJid, { text: protMsg }, { quoted: m });
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
        const isTargetAlessio = isTargetSpecificNumber(targetJid);
        if (isTargetAlessio || global.protectedUsers.has(targetJid)) {
            const protMsg = isTargetAlessio
                ? `${botArt} Impossibile eseguire questa azione perché sono stato programmato per proteggere il mio capo, essendo lui stesso ad avermi creato`
                : `${botArt} ⚠️ Non puoi rimuovere un utente protetto o il proprietario!`;
            await sock.sendMessage(chatJid, { text: protMsg }, { quoted: m });
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
            await sock.sendMessage(chatJid, { text: `${botArt} 🛡️ Approvazione membri impostata su: *${status}*` });
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
            try {
                if (status === 'off') {
                    await sock.groupRevokeInvite(chatJid);
                    await sock.sendMessage(chatJid, { text: `${botArt} 🔗 Il link d'invito del gruppo è stato disattivato/revocato.` });
                } else {
                    const code = await sock.groupInviteCode(chatJid);
                    await sock.sendMessage(chatJid, { text: `${botArt} 🔗 Link d'invito attivo. Link: https://chat.whatsapp.com/${code}` });
                }
            } catch (err) {
                console.error("Errore gestione link d'invito:", err);
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Impossibile modificare lo stato del link d'invito.` });
            }
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
                await sock.groupUpdateRestrict(chatJid, status === 'on');
                await sock.sendMessage(chatJid, { text: `${botArt} ⚙️ Restrizione per aggiungere membri impostata su: *${status}*` });
            } catch (err) {
                console.error("Errore addmember:", err);
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante la modifica dell'impostazione addmember.` });
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
            try {
                await sock.groupToggleAddRecentHistory(chatJid, status === 'on');
                await sock.sendMessage(chatJid, { text: `${botArt} 🕒 Cronologia messaggi per i nuovi membri impostata su: *${status}*` });
            } catch (err) {
                console.error("Errore history:", err);
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante la modifica della cronologia per i nuovi membri.` });
            }
        }
        return true;
    }

    if (command === '!web' || command === '!cerca') {
        const query = args.slice(1).join(' ');
        if (!query) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Inserisci una ricerca da effettuare.` }, { quoted: m });
            return true;
        }
        if (!global.geminiApiKey) {
            await sock.sendMessage(chatJid, { text: `${botArt} ❌ API Key di Gemini non configurata.` }, { quoted: m });
            return true;
        }
        try {
            const ai = new GoogleGenAI({ apiKey: global.geminiApiKey });
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: query,
                config: { tools: [{ googleSearch: {} }] }
            });
            await sock.sendMessage(chatJid, { text: `${botArt} ${response.text || "Nessun risultato."}` }, { quoted: m });
        } catch (err) {
            await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore durante la ricerca web.` }, { quoted: m });
        }
        return true;
    }

    if (command === '!tagall' || command === '!tutti') {
        const customText = args.slice(1).join(' ');
        if (!customText) {
            await sock.sendMessage(chatJid, { text: `${botArt} Scrivi il testo dell'avviso dopo il comando.` }, { quoted: m });
            return true;
        }
        try {
            const groupMetadata = await sock.groupMetadata(chatJid);
            let textToSend = `${botArt} *AVVISO* ${botArt}\n\n${customText}\n\n`;
            let mentions = [];
            for (const p of groupMetadata.participants) {
                textToSend += `@${p.id.split('@')[0]} `;
                mentions.push(p.id);
            }
            await sock.sendMessage(chatJid, { text: textToSend, mentions: mentions }, { quoted: m });
        } catch (err) {
            console.error(err);
        }
        return true;
    }

    if (command === '!poll') {
        const pollInput = args.slice(1).join(' ');
        if (!pollInput) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Usa: !poll Domanda? | Opz 1 | Opz 2` }, { quoted: m });
            return true;
        }
        const parts = pollInput.split('|').map(p => p.trim());
        if (parts.length < 3) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Inserire domanda e almeno due opzioni separate da |.` }, { quoted: m });
            return true;
        }
        await sock.sendMessage(chatJid, { poll: { name: parts[0], values: parts.slice(1) } });
        return true;
    }

    if (command === '!setname') {
        const newName = args.slice(1).join(' ');
        if (!newName) {
            await sock.sendMessage(chatJid, { text: `${botArt} ⚠️ Inserisci il nuovo nome del gruppo.` }, { quoted: m });
            return true;
        }
        if (await ensureBotIsAdmin()) {
            try {
                await sock.groupUpdateSubject(chatJid, newName);
                await sock.sendMessage(chatJid, { text: `${botArt} ✅ Nome aggiornato in: *${newName}*` });
            } catch (err) {
                await sock.sendMessage(chatJid, { text: `${botArt} ❌ Errore aggiornamento nome.` });
            }
        }
        return true;
    }

    return false;
}
