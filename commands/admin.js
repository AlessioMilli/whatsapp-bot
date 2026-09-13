export async function execute(sock, m, chatJid, messageText, sender, isGroup) {
    global.linksEnabled = global.linksEnabled !== undefined ? global.linksEnabled : false;
    global.cooldownEnabled = global.cooldownEnabled !== undefined ? global.cooldownEnabled : false;
    global.offlineMode = global.offlineMode !== undefined ? global.offlineMode : false;
    global.groupActive = global.groupActive !== undefined ? global.groupActive : true;
    global.botOwner = global.botOwner || "393534467571@s.whatsapp.net";
    
    global.protectedUsers = global.protectedUsers || new Set();
    global.extraOwners = global.extraOwners || new Set([global.botOwner]);

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

    const isOwner = (jid) => jid === global.botOwner || global.extraOwners.has(jid) || m.key.fromMe;

    // Gestione automatica della modalità offline in chat privata
    if (!isGroup && global.offlineMode && !isOwner(sender) && !m.key.fromMe) {
        await sock.sendMessage(chatJid, { text: "Al momento Alessio non è disponibile. Ti risponderà appena possibile..." }, { quoted: m });
        return true;
    }

    if (messageText === '!commands' || messageText === '!menu') {
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

        await sock.sendMessage(chatJid, { text: menuText }, { quoted: m });
        return true;
    }

    if (messageText.startsWith('!protezione')) {
        let parts = messageText.split(' ');
        let status = parts[1];
        let targetJid = getTargetJid();

        if (status === 'on') {
            if (targetJid) {
                global.protectedUsers.add(targetJid);
                await sock.sendMessage(chatJid, { text: `🛡️ L'utente @${targetJid.split('@')[0]} ora è protetto ed è intoccabile come il proprietario!`, mentions: [targetJid] }, { quoted: m });
            } else {
                global.protectedUsers.add('general');
                await sock.sendMessage(chatJid, { text: "🛡️ Protezione generale del gruppo ATTIVATA." }, { quoted: m });
            }
        } else if (status === 'off') {
            if (targetJid) {
                global.protectedUsers.delete(targetJid);
                await sock.sendMessage(chatJid, { text: `🛡️ Protezione rimossa per l'utente @${targetJid.split('@')[0]}`, mentions: [targetJid] }, { quoted: m });
            } else {
                global.protectedUsers.clear();
                await sock.sendMessage(chatJid, { text: "🛡️ Protezione disattivata completamente." }, { quoted: m });
            }
        }
        return true;
    }

    if (messageText.startsWith('!setowner')) {
        if (isOwner(sender)) {
            let targetJid = getTargetJid();
            if (targetJid) {
                global.extraOwners.add(targetJid);
                global.protectedUsers.add(targetJid);
                await sock.sendMessage(chatJid, { text: `👑 L'utente @${targetJid.split('@')[0]} è ora ufficialmente un proprietario del bot!`, mentions: [targetJid] }, { quoted: m });
            } else {
                await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente per renderlo proprietario." }, { quoted: m });
            }
        } else {
            await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al creatore principale del bot." }, { quoted: m });
        }
        return true;
    }

    if (messageText.startsWith('!removeowner')) {
        if (isOwner(sender)) {
            let targetJid = getTargetJid();
            if (targetJid) {
                global.extraOwners.delete(targetJid);
                await sock.sendMessage(chatJid, { text: `🛡️ Rimossi i poteri di proprietario all'utente @${targetJid.split('@')[0]}`, mentions: [targetJid] }, { quoted: m });
            } else {
                await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente per rimuovere i poteri di proprietario." }, { quoted: m });
            }
        } else {
            await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al creatore principale del bot." }, { quoted: m });
        }
        return true;
    }

    if (messageText === '!offline' || messageText === '!assente') {
        if (isOwner(sender)) {
            global.offlineMode = true;
            await sock.sendMessage(chatJid, { text: "🔴 Modalità offline attivata con successo." }, { quoted: m });
        }
        return true;
    }

    if (messageText === '!online' || messageText === '!presente') {
        if (isOwner(sender)) {
            global.offlineMode = false;
            await sock.sendMessage(chatJid, { text: "🟢 Alessio è ora disponibile per risponderti!" }, { quoted: m });
        }
        return true;
    }

    if (messageText.startsWith('!gruppo ')) {
        let status = messageText.split(' ')[1];
        if (isOwner(sender)) {
            if (status === 'on' || status === 'off') {
                global.groupActive = (status === 'on');
                await sock.sendMessage(chatJid, { text: `🤖 Risposta del bot in questo gruppo impostata su: ${status}` }, { quoted: m });
            }
        } else {
            await sock.sendMessage(chatJid, { text: "Al momento non puoi usare questo comando perché questo comando è riservato al proprietario." }, { quoted: m });
        }
        return true;
    }

    return false;
}