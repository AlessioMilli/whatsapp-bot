/**
 * Modulo di moderazione avanzata e gestione gruppi per Baileys
 * Proprietario: Alessio (@Alessio)
 */

import { DisconnectReason } from '@whiskeysockets/baileys';

// Strutture dati in memoria per tracciare lo stato
const mutedUsers = new Set();
const warnings = new Map(); // key: userId, value: count
const cooldowns = new Map(); // key: userId, value: timestamp

// Configurazioni di stato del gruppo (chiave: groupId o globale)
const groupSettings = {
    linkFilter: false,
    cooldownEnabled: false,
    cooldownTime: 4000, // 4 secondi
    waitingForTagAll: new Set(), // utenti che devono scrivere il messaggio per !tutti
    waitingForSetName: new Set(), // utenti che devono scrivere il nome del gruppo
    inactiveGroups: new Set() // Gruppi in cui il bot è disattivato via !gruppo off
};

// Dati del proprietario protetto
const OWNER_JID = "3935344667571@s.whatsapp.net"; // Numero di Alessio
const OWNER_PHONE = "+39 35344667571";
const OWNER_NAME = "@Alessio";

global.extraOwners = global.extraOwners || new Set([OWNER_JID]);

const isOwner = (jid, sock) => {
    return jid === OWNER_JID || global.extraOwners.has(jid) || jid === sock?.user?.id;
};

/**
 * Funzione principale che gestisce i comandi di moderazione e admin
 */
async function handleModeration(sock, m, remoteJid, messageText, sender, isGroup, externalMutedUsers, externalWarnings) {
    try {
        if (!remoteJid) {
            remoteJid = m.key.remoteJid;
        }
        if (isGroup === undefined) {
            isGroup = remoteJid.endsWith('@g.us');
        }
        if (!sender) {
            sender = m.key.participant || remoteJid;
        }

        // 1. Gestione Evento Partecipanti (Benvenuto automatico)
        if (isGroup && m.messageStubType === 27) {
            const newMemberJid = m.messageStubParameters?.[0];
            if (newMemberJid) {
                try {
                    const metadata = await sock.groupMetadata(remoteJid);
                    const desc = metadata.desc ? metadata.desc.trim() : "";
                    
                    let welcomeText = `👋 Benvenuto/a @${newMemberJid.split('@')[0]}!\n\n`;
                    if (desc) {
                        welcomeText += `📌 Leggi attentamente le regole del gruppo: ${desc}`;
                    } else {
                        welcomeText += `⚠️ Nota: In questo specifico gruppo al momento non sono presenti regole.`;
                    }

                    await sock.sendMessage(remoteJid, {
                        text: welcomeText,
                        mentions: [newMemberJid]
                    });
                } catch (err) {
                    console.error("Errore nell'invio del messaggio di benvenuto:", err);
                }
            }
            return;
        }

        if (!messageText) {
            messageText = m.message?.conversation || 
                          m.message?.extendedTextMessage?.text || 
                          m.message?.imageMessage?.caption || '';
        }
        
        if (!messageText) return;

        const args = messageText.trim().split(/ +/);
        const command = args[0].toLowerCase();
        const targetMention = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                            m.message?.extendedTextMessage?.contextInfo?.participant;

        // Gestione comando !gruppo on / !gruppo off
        if (command === '!gruppo') {
            const status = args[1];
            if (status === 'off' || status === 'on') {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(remoteJid, { text: "Al momento non puoi usare questo comando perché questo comando è riservato al proprietario." });
                    return;
                }
                if (status === 'off') {
                    groupSettings.inactiveGroups.add(remoteJid);
                    await sock.sendMessage(remoteJid, { text: "⚠️ Il bot è stato disattivato in questo gruppo e non risponderà più a nessun comando finché non verrà riattivato." });
                } else {
                    groupSettings.inactiveGroups.delete(remoteJid);
                    await sock.sendMessage(remoteJid, { text: "✅ Il bot è ora nuovamente attivo in questo gruppo!" });
                }
                return;
            }
        }

        // Se il gruppo è disattivato tramite !gruppo off, ignora completamente qualsiasi altro input/comando
        if (isGroup && groupSettings.inactiveGroups.has(remoteJid)) {
            return;
        }

        // 2. Controllo Intercettazione Messaggi Utenti Mutati
        const activeMuted = externalMutedUsers || mutedUsers;
        if (isGroup && activeMuted.has(sender)) {
            await sock.sendMessage(remoteJid, { delete: m.key });
            return;
        }

        // 3. Gestione Stati in attesa (es. !tutti / !setname prompt)
        if (groupSettings.waitingForTagAll && groupSettings.waitingForTagAll.has(sender)) {
            if (command === '!tutti' || command === '!tagall') {
                groupSettings.waitingForTagAll.delete(sender);
                const announcementText = messageText.replace(/^(!tutti|!tagall)/i, '').trim();
                const metadata = await sock.groupMetadata(remoteJid);
                const participants = metadata.participants.map(p => p.id);
                
                await sock.sendMessage(remoteJid, {
                    text: `📢 *Avviso Generale*\n\n${announcementText}`,
                    mentions: participants
                });
                return;
            }
        }

        if (groupSettings.waitingForSetName && groupSettings.waitingForSetName.has(sender)) {
            if (command === '!setname') {
                groupSettings.waitingForSetName.delete(sender);
                const newTitle = messageText.replace(/^!setname/i, '').trim();
                if (newTitle) {
                    await sock.groupUpdateSubject(remoteJid, newTitle);
                    await sock.sendMessage(remoteJid, { text: `✅ Titolo del gruppo aggiornato con successo in: *${newTitle}*` });
                }
                return;
            }
        }

        // 4. Filtro Link Esterni (se !link on)
        if (isGroup && groupSettings.linkFilter && !isOwner(sender, sock)) {
            const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
            if (urlRegex.test(messageText)) {
                await sock.sendMessage(remoteJid, { delete: m.key });
                await sock.sendMessage(remoteJid, { 
                    text: `Ragazzi, sono il chatbot di moderazione di ${OWNER_NAME} (${OWNER_PHONE}). Se volete inviare link esterni dovete prima contattare il proprietario` 
                });
                return;
            }
        }

        // Se non è un comando valido, interrompi
        if (!command.startsWith('!')) return;

        // 5. Controllo Cooldown Antispam
        if (groupSettings.cooldownEnabled && !isOwner(sender, sock)) {
            const now = Date.now();
            const lastTime = cooldowns.get(sender) || 0;
            if (now - lastTime < groupSettings.cooldownTime) {
                return; // Ignora silenziosamente
            }
            cooldowns.set(sender, now);
        }

        // --- COMANDI DI MODERAZIONE E ADMIN ---
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
!history on/off* - Attiva/disattiva l'invio della cronologia dei messaggi ai novos membri (solo admin)
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

                await sock.sendMessage(remoteJid, { text: menuText }, { quoted: m });
                break;
            }

            case '!setowner': {
                if (sender !== OWNER_JID && !m.key.fromMe) {
                    await sock.sendMessage(remoteJid, { text: "⚠️ Comando riservato al creatore principale del bot." });
                    return;
                }
                if (targetMention) {
                    global.extraOwners.add(targetMention);
                    await sock.sendMessage(remoteJid, { text: `👑 L'utente @${targetMention.split('@')[0]} è ora ufficialmente un proprietario del bot!`, mentions: [targetMention] });
                } else {
                    await sock.sendMessage(remoteJid, { text: "⚠️ Tagga un utente per renderlo proprietario." });
                }
                break;
            }

            case '!removeowner': {
                if (sender !== OWNER_JID && !m.key.fromMe) {
                    await sock.sendMessage(remoteJid, { text: "⚠️ Comando riservato al creatore principale del bot." });
                    return;
                }
                if (targetMention) {
                    global.extraOwners.delete(targetMention);
                    await sock.sendMessage(remoteJid, { text: `🛡️ Rimossi i poteri di proprietario all'utente @${targetMention.split('@')[0]}`, mentions: [targetMention] });
                } else {
                    await sock.sendMessage(remoteJid, { text: "⚠️ Tagga un utente per rimuovere i poteri di proprietario." });
                }
                break;
            }
            
            case '!mute': {
                if (!targetMention) return;
                if (targetMention === OWNER_JID) {
                    await sock.sendMessage(remoteJid, { text: "Impossibile eseguire questa operazione per motivi tecnici messi dal proprietario" });
                    return;
                }
                const activeMutedSet = externalMutedUsers || mutedUsers;
                activeMutedSet.add(targetMention);
                await sock.sendMessage(remoteJid, { text: `🔇 L'utente è stato mutato con successo.` });
                break;
            }

            case '!unmute': {
                if (!targetMention) return;
                const activeMutedSet = externalMutedUsers || mutedUsers;
                activeMutedSet.delete(targetMention);
                await sock.sendMessage(remoteJid, { text: `🔊 L'utente è stato rimosso dal blocco in modo definitivo.` });
                break;
            }

            case '!warn': {
                if (!targetMention) return;
                const activeWarnings = externalWarnings || warnings;
                const currentWarns = (activeWarnings.get(targetMention) || 0) + 1;
                activeWarnings.set(targetMention, currentWarns);

                if (currentWarns === 2) {
                    await sock.sendMessage(remoteJid, { 
                        text: `⚠️ @${targetMention.split('@')[0]}, questo è il tuo secondo avvertimento (2/3). Al terzo verrai bannato!`,
                        mentions: [targetMention]
                    });
                } else if (currentWarns >= 3) {
                    activeWarnings.set(targetMention, 0);
                    await sock.groupParticipantsUpdate(remoteJid, [targetMention], "remove");
                    await sock.sendMessage(remoteJid, { text: `🚫 Utente bannato automaticamente dopo il terzo avvertimento.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: `⚠️ Avvertimento registrato (${currentWarns}/3) per l'utente.` });
                }
                break;
            }

            case '!rimuovi':
            case '!kick': {
                if (!targetMention) return;
                if (targetMention === OWNER_JID) {
                    await sock.sendMessage(remoteJid, { text: "Non puoi espellere il proprietario." });
                    return;
                }
                await sock.groupParticipantsUpdate(remoteJid, [targetMention], "remove");
                await sock.sendMessage(remoteJid, { text: `👢 Utente espulso dal gruppo.` });
                break;
            }

            case '!promuovi': {
                if (!targetMention) return;
                await sock.groupParticipantsUpdate(remoteJid, [targetMention], "promote");
                await sock.sendMessage(remoteJid, { text: `🎉 L'utente è stato nominato amministratore.` });
                break;
            }

            case '!demuovi': {
                if (!targetMention) return;
                await sock.groupParticipantsUpdate(remoteJid, [targetMention], "demote");
                await sock.sendMessage(remoteJid, { text: `📉 All'utente sono stati rimossi i poteri da amministratore.` });
                break;
            }

            case '!multidemote': {
                const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                if (mentions.length === 0) return;
                await sock.groupParticipantsUpdate(remoteJid, mentions, "demote");
                await sock.sendMessage(remoteJid, { text: `📉 Poteri rimossi a tutti gli utenti taggati.` });
                break;
            }

            case '!quickdemote': {
                if (!targetMention) return;
                await sock.groupParticipantsUpdate(remoteJid, [targetMention], "demote");
                await sock.sendMessage(remoteJid, { text: `⚡ Rimozione rapida admin eseguita.` });
                break;
            }

            case '!editgroup': {
                const mode = args[1];
                if (mode === 'on') {
                    await sock.groupSettingUpdate(remoteJid, 'announcement');
                    await sock.sendMessage(remoteJid, { text: `🔒 Modifica info gruppo ristretta ai soli admin.` });
                } else if (mode === 'off') {
                    await sock.groupSettingUpdate(remoteJid, 'not_announcement');
                    await sock.sendMessage(remoteJid, { text: `🔓 Modifica info gruppo aperta a tutti i partecipanti.` });
                }
                break;
            }

            case '!approva': {
                const mode = args[1];
                if (mode === 'on') {
                    await sock.groupJoinApprovalMode(remoteJid, 'on');
                    await sock.sendMessage(remoteJid, { text: `🚪 Sala d'attesa (approvazione nuovi membri) attivata.` });
                } else if (mode === 'off') {
                    await sock.groupJoinApprovalMode(remoteJid, 'off');
                    await sock.sendMessage(remoteJid, { text: `🚪 Sala d'attesa disattivata.` });
                }
                break;
            }

            case '!addmember': {
                const mode = args[1];
                await sock.sendMessage(remoteJid, { text: `⚙️ Impostazione addmember impostata su: ${mode}` });
                break;
            }

            case '!history': {
                const mode = args[1];
                await sock.groupToggleEphemeral(remoteJid, mode === 'on' ? 86400 : 0);
                await sock.sendMessage(remoteJid, { text: `📜 Cronologia/Messaggi temporanei impostati su: ${mode}` });
                break;
            }

            case '!invitelink': {
                const mode = args[1];
                if (mode === 'off') {
                    await sock.groupRevokeInvite(remoteJid);
                    await sock.sendMessage(remoteJid, { text: `🔗 Link d'invito revocato e disattivato.` });
                } else {
                    const code = await sock.groupInviteCode(remoteJid);
                    await sock.sendMessage(remoteJid, { text: `🔗 Link d'invito attivo: https://chat.whatsapp.com/${code}` });
                }
                break;
            }

            case '!masskick':
            case '!svuotagruppo': {
                const metadata = await sock.groupMetadata(remoteJid);
                const participantsToKick = metadata.participants
                    .filter(p => !p.admin && p.id !== OWNER_JID)
                    .map(p => p.id);
                
                if (participantsToKick.length > 0) {
                    await sock.groupParticipantsUpdate(remoteJid, participantsToKick, "remove");
                    await sock.sendMessage(remoteJid, { text: `🧹 Gruppo svuotato da tutti i membri non amministratori.` });
                }
                break;
            }

            case '!deletegroup':
            case '!eliminagruppo': {
                const metadata = await sock.groupMetadata(remoteJid);
                const participantsToKick = metadata.participants
                    .filter(p => p.id !== sock.user.id)
                    .map(p => p.id);
                
                if (participantsToKick.length > 0) {
                    await sock.groupParticipantsUpdate(remoteJid, participantsToKick, "remove");
                }
                await sock.sendMessage(remoteJid, { text: `⚠️ Eliminazione del gruppo in corso...` });
                await sock.groupLeave(remoteJid);
                break;
            }

            case '!tagall':
            case '!tutti': {
                groupSettings.waitingForTagAll.add(sender);
                await sock.sendMessage(remoteJid, { text: "Cosa vorresti scrivere nell'avviso?" });
                break;
            }

            case '!poll': {
                const pollContent = messageText.replace(/^!poll/i, '').trim();
                const parts = pollContent.split('|').map(p => p.trim());
                const question = parts[0];
                const options = parts.slice(1);

                if (question && options.length > 0) {
                    await sock.sendMessage(remoteJid, {
                        poll: {
                            name: question,
                            values: options
                        }
                    });
                }
                break;
            }

            case '!setname': {
                groupSettings.waitingForSetName.add(sender);
                await sock.sendMessage(remoteJid, { text: "Cosa vuoi che metto sul titolo del gruppo?" });
                break;
            }

            case '!lockinfo': {
                await sock.groupSettingUpdate(remoteJid, 'announcement');
                await sock.sendMessage(remoteJid, { text: "🔒 Informazioni del gruppo bloccate." });
                break;
            }

            case '!unlockinfo': {
                await sock.groupSettingUpdate(remoteJid, 'not_announcement');
                await sock.sendMessage(remoteJid, { text: "🔓 Informazioni del gruppo sbloccate." });
                break;
            }

            case '!link': {
                const mode = args[1];
                if (mode === 'on') {
                    groupSettings.linkFilter = true;
                    await sock.sendMessage(remoteJid, { text: "🛡️ Filtro link esterni attivato." });
                } else if (mode === 'off') {
                    groupSettings.linkFilter = false;
                    await sock.sendMessage(remoteJid, { text: "🛡️ Filtro link esterni disattivato." });
                }
                break;
            }

            case '!cooldown': {
                const mode = args[1];
                if (mode === 'on') {
                    groupSettings.cooldownEnabled = true;
                    await sock.sendMessage(remoteJid, { text: "⏱️ Sistema antispam cooldown attivato." });
                } else if (mode === 'off') {
                    groupSettings.cooldownEnabled = false;
                    await sock.sendMessage(remoteJid, { text: "⏱️ Sistema antispam cooldown disattivato." });
                }
                break;
            }
        }

    } catch (error) {
        console.error("Errore nel modulo di moderazione:", error);
    }
}

export { handleModeration };