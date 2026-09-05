export async function execute(sock, m, chatJid, messageText, sender, isGroup, mutedUsers, warnings) {
    global.linksEnabled = global.linksEnabled !== undefined ? global.linksEnabled : false;

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

    if (messageText === '!help' || messageText === '!menu') {
        const helpText = 
`🤖 *LISTA COMANDI BOT* 🤖

📌 *Moderazione:*
• *!mute @utente* - Silenzia un utente localmente
• *!unmute @utente* - Rimuove il muto all'utente
• *!warn @utente* - Dà un avvertimento (3 = ban)
• *!rimuovi / !kick @utente* - Espelle dal gruppo
• *!promuovi @utente* - Rende amministratore
• *!demuovi @utente* - Toglie i poteri di admin

📌 *Gruppo & Sicurezza:*
• *!tagall / !tutti* - Manda un avviso a tutti
• *!poll Domanda? | Opz 1 | Opz 2* - Crea un sondaggio
• *!setname [nome]* - Cambia il nome del gruppo
• *!lockinfo* - Blocca le info del gruppo
• *!unlockinfo* - Sblocca le info del gruppo
• *!link on* - Attiva il blocco link manuale
• *!link off* - Disattiva il blocco link manuale`;

        await sock.sendMessage(chatJid, { text: helpText }, { quoted: m });
        return true;
    }

    if (messageText.startsWith('!mute')) {
        let targetJid = getTargetJid();
        if (targetJid) {
            mutedUsers.add(targetJid);
            await sock.sendMessage(chatJid, { text: `🔇 *UTENTE MUTATO*\n@${targetJid.split('@')[0]} è stato imbavagliato.`, mentions: [targetJid] });
        } else {
            await sock.sendMessage(chatJid, { text: "Tagga o specifica un utente con la chiocciola (es. @utente)." });
        }
        return true;
    }

    if (messageText.startsWith('!unmute')) {
        let targetJid = getTargetJid();
        if (targetJid) {
            mutedUsers.delete(targetJid);
            await sock.sendMessage(chatJid, { text: `🔊 *UTENTE SMUTATO*\n@${targetJid.split('@')[0]} è stato liberato.`, mentions: [targetJid] });
        } else {
            await sock.sendMessage(chatJid, { text: "Tagga o specifica un utente con la chiocciola (es. @utente)." });
        }
        return true;
    }

    if (messageText.startsWith('!warn')) {
        let targetJid = getTargetJid();
        if (targetJid) {
            let currentWarns = warnings.get(targetJid) || 0;
            currentWarns++;
            warnings.set(targetJid, currentWarns);

            if (currentWarns >= 3) {
                warnings.set(targetJid, 0);
                await sock.groupParticipantsUpdate(chatJid, [targetJid], 'remove');
                await sock.sendMessage(chatJid, { text: `🚨 @${targetJid.split('@')[0]} è stato espulso per aver raggiunto 3 avvertimenti.`, mentions: [targetJid] });
            } else {
                await sock.sendMessage(chatJid, { text: `⚠️ @${targetJid.split('@')[0]} ha ricevuto un avvertimento (${currentWarns}/3).`, mentions: [targetJid] });
            }
        } else {
            await sock.sendMessage(chatJid, { text: "Tagga un utente per dare un avvertimento (es. !warn @utente)." });
        }
        return true;
    }

    if (messageText === '!tagall' || messageText === '!tutti') {
        if (isGroup) {
            const metadata = await sock.groupMetadata(chatJid);
            const participants = metadata.participants.map(p => p.id);
            let textTag = "📢 *AVVISO A TUTTI I MEMBRI* 📢\n\n";
            for (let p of participants) {
                textTag += `@${p.split('@')[0]} `;
            }
            await sock.sendMessage(chatJid, { text: textTag, mentions: participants });
        }
        return true;
    }

    if (messageText.startsWith('!poll ')) {
        let pollArgs = messageText.slice(6).split('|');
        let pollTitle = pollArgs[0]?.trim() || "Sondaggio";
        let pollOptions = pollArgs.slice(1).map(opt => opt.trim()).filter(opt => opt.length > 0);
        
        if (pollOptions.length >= 2) {
            await sock.sendMessage(chatJid, {
                poll: { name: pollTitle, values: pollOptions, selectableCount: 1 }
            });
        } else {
            await sock.sendMessage(chatJid, { text: "Usa il formato corretto: !poll Domanda? | Opzione 1 | Opzione 2" });
        }
        return true;
    }

    if (messageText.startsWith('!setname ')) {
        let newName = messageText.slice(9).trim();
        if (newName && isGroup) {
            await sock.groupUpdateSubject(chatJid, newName);
            await sock.sendMessage(chatJid, { text: `✅ Nome del gruppo aggiornato in: ${newName}` });
        }
        return true;
    }

    if (messageText.startsWith('!rimuovi') || messageText.startsWith('!kick')) {
        let targetJid = getTargetJid();
        if (targetJid) {
            await sock.groupParticipantsUpdate(chatJid, [targetJid], 'remove');
            await sock.sendMessage(chatJid, { text: "Utente rimosso con successo." });
        }
        return true;
    }

    if (messageText.startsWith('!promuovi')) {
        let targetJid = getTargetJid();
        if (targetJid) {
            await sock.groupParticipantsUpdate(chatJid, [targetJid], 'promote');
            await sock.sendMessage(chatJid, { text: "Utente promosso ad amministratore." });
        }
        return true;
    }

    if (messageText.startsWith('!demuovi')) {
        let targetJid = getTargetJid();
        if (targetJid) {
            await sock.groupParticipantsUpdate(chatJid, [targetJid], 'demote');
            await sock.sendMessage(chatJid, { text: "Utente rimosso dai privilegi." });
        }
        return true;
    }

    if (messageText === '!lockinfo' || messageText === '!chiudigruppo') {
        await sock.groupSettingUpdate(chatJid, 'announcement');
        await sock.sendMessage(chatJid, { text: "Impostazioni gruppo bloccate." });
        return true;
    }

    if (messageText === '!unlockinfo' || messageText === '!aprigruppo') {
        await sock.groupSettingUpdate(chatJid, 'not_announcement');
        await sock.sendMessage(chatJid, { text: "Impostazioni gruppo sbloccate." });
        return true;
    }

    if (messageText === '!link on') {
        global.linksEnabled = true;
        await sock.sendMessage(chatJid, { text: "🔗 Blocco link ATTIVATO manualmente." });
        return true;
    }

    if (messageText === '!link off') {
        global.linksEnabled = false;
        await sock.sendMessage(chatJid, { text: "🔗 Blocco link DISATTIVATO manualmente." });
        return true;
    }

    return false;
}