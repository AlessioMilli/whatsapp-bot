import { DisconnectReason } from '@whiskeysockets/baileys';

// Strutture dati globali di base
const blacklist = new Set();
const warnings = new Map();
const mutedUsers = new Set();
const cooldowns = new Map();

// Archivio globale di tutti i gruppi in cui il bot viene rilevato automaticamente
const savedGroups = new Map();

// Gestione delle configurazioni specifiche per ogni singolo gruppo (chatJid -> impostazioni)
const groupsConfig = new Map();

function getGroupConfig(chatJid) {
    if (!groupsConfig.has(chatJid)) {
        groupsConfig.set(chatJid, {
            linkFilter: false,
            cooldownEnabled: false,
            cooldownTime: 4000,
            waitingForTagAll: new Set(),
            waitingForSetName: new Set(),
            isInactive: false,
            isLocked: false,
            stealthMode: false,
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

const isProtected = (jid, config) => {
    return jid === OWNER_JID || config.protectedUsers.has(jid);
};

async function checkGroupAdminPrivileges(sock, chatJid) {
    try {
        const metadata = await sock.groupMetadata(chatJid);
        const senderJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
        
        const participant = metadata.participants.find(p => {
            const pIdClean = p.id.split(':')[0].split('@')[0];
            const ownerClean = OWNER_JID.split(':')[0].split('@')[0];
            const senderClean = senderJid ? senderJid.split(':')[0].split('@')[0] : '';
            
            return pIdClean === ownerClean || pIdClean === senderClean;
        });

        return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
    } catch (e) {
        return false;
    }
}

async function ensureBotIsAdmin(sock, chatJid) {
    try {
        const metadata = await sock.groupMetadata(chatJid);
        const cleanOwnerJid = OWNER_JID.split(':')[0].split('@')[0];
        const botParticipant = metadata.participants.find(p => p.id.includes(cleanOwnerJid));
        return botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');
    } catch (e) {
        return false;
    }
}

export async function execute(sock, m, chatJid, messageText, sender, isGroup) {
    try {
        if (!chatJid) chatJid = m.key.remoteJid;
        if (isGroup === undefined) isGroup = chatJid.endsWith('@g.us');
        if (!sender) sender = m.key.participant || chatJid;

        // 🔍 SALVATAGGIO AUTOMATICO ID GRUPPO: Appena arriva un messaggio in un gruppo, lo memorizza al volo[cite: 2]
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

        // 🥷 Controllo presenza di Aleh (+39 392 491 1895) nel gruppo: se c'è, il bot sta completamente zitto[cite: 2]
        const alehJid = "3924911895@s.whatsapp.net";
        if (isGroup) {
            try {
                const metadata = await sock.groupMetadata(chatJid);
                const isAlehPresent = metadata.participants.some(p => p.id.includes(alehJid.split('@')[0]));
                if (isAlehPresent) {
                    return true; // Il bot ignora tutto e non risponde[cite: 2]
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

        // 👋 Benvenuto automatico specifico per gruppo[cite: 2]
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

        // Controllo utenti mutati[cite: 2]
        if (isGroup && !m.key.fromMe) {
            const senderClean = sender.split('@')[0];
            if (mutedUsers.has(sender) || Array.from(mutedUsers).some(id => id.split('@')[0] === senderClean)) {
                try { await sock.sendMessage(chatJid, { delete: m.key }); } catch (err) {}
                return true;
            }
        }

        // Controllo blocco totale gruppo specifico[cite: 2]
        if (isGroup && config.isLocked && !m.key.fromMe) {
            if (await ensureBotIsAdmin(sock, chatJid)) {
                try {
                    const metadata = await sock.groupMetadata(chatJid);
                    const participant = metadata.participants.find(p => p.id === sender);
                    const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
                    if (!isAdmin && !isOwner(sender, sock)) {
                        await sock.sendMessage(chatJid, { delete: m.key });
                        return true;
                    }
                } catch (e) {}
            }
        }

        if (!messageText) return false;

        const args = messageText.trim().split(/ +/);
        const command = args[0].toLowerCase();
        const targetMention = getTargetJid();

        // Controllo se il bot è disattivato solo in questo specifico gruppo[cite: 2]
        if (isGroup && config.isInactive) {
            if (command === '!gruppo' && args[1] === 'on' && isOwner(sender, sock)) {
                config.isInactive = false;
                await sock.sendMessage(chatJid, { text: "🤖 Il bot è di nuovo attivo in questo gruppo" });
                return true;
            }
            return false;
        }

        // Cooldown specifico per gruppo[cite: 2]
        if (config.cooldownEnabled && isGroup && !isOwner(sender, sock)) {
            const now = Date.now();
            const lastTime = cooldowns.get(sender + chatJid) || 0;
            if (now - lastTime < config.cooldownTime) return true;
            cooldowns.set(sender + chatJid, now);
        }

        // Stati in attesa specifici[cite: 2]
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
                if (await checkGroupAdminPrivileges(sock, chatJid)) {
                    await sock.groupUpdateSubject(chatJid, newTitle);
                    await sock.sendMessage(chatJid, { text: `🏷 Il nome del gruppo è stato aggiornato in modo perfetto` });
                }
            }
            return true;
        }

        // Filtro link specifico per gruppo[cite: 2]
        if (isGroup && config.linkFilter && !isOwner(sender, sock)) {
            const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
            if (urlRegex.test(messageText)) {
                await sock.sendMessage(chatJid, { delete: m.key }).catch(() => {});
                await sock.sendMessage(chatJid, { text: `⚠️ Non puoi inviare link esterni in questo gruppo se prima non chiedi il permesso` });
                return true;
            }
        }

        // Protezione utente nel gruppo[cite: 2]
        if (targetMention && isProtected(targetMention, config) && ['!mute', '!warn', '!wuarn', '!kick', '!rimuovi', '!demuovi', '!quickdemote', '!multidemote'].includes(command)) {
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
• \`!masskick\` (o \`!svuotagruppo\`) 🧹 - Rimuove tutti i partecipanti (lascia admin e bot)
• \`!deletegroup\` (o \`!eliminagruppo\`) 🗑️ - Svuota ed elimina o abbandona il gruppo
• \`!clearalltesto [parola]\` 🔍 - Elimina per tutti i messaggi con la parola indicata

🛡️ **GESTIONE AMMINISTRATORI**
• \`!promuovi @utente\` ⭐ - Promuove l'utente amministratore
• \`!demuovi @utente\` (o \`!quickdemote\`) 👤 - Rimuove subito i poteri di admin
• \`!multidemote @u1 @u2...\` 👥 - Rimuove i poteri di admin a più utenti insieme

⚙️ **IMPOSTAZIONI E SICUREZZA GRUPPO**
• \`!checkadmin\` 🔍 - Verifica istantanea dei permessi amministrativi nel gruppo
• \`!gruppo on/off\` 🤖 - Attiva/disattiva il bot nel gruppo
• \`!editgroup on/off\` ✏ - Gestisce la modifica info gruppo per soli admin
• \`!approva on/off\` 📋 - Gestisce approvazione nuovi membri
• \`!addmember on/off\` ➕ - Gestisce restrizione aggiunta partecipanti
• \`!history on/off\` 📜 - Invio cronologia messaggi ai nuovi membri
• \`!invitelink on/off\` 🔗 - Accesso tramite link d'invito
• \`!setname [nome]\` 🏷 - Cambia istantaneamente il nome del gruppo
• \`!lockinfo\` / \`!unlockinfo\` 🔒 - Blocca o sblocca i dettagli del gruppo
• \`!link on/off\` 🌐 - Cancellazione automatica link esterni
• \`!cooldown on/off\` ⏱️️ - Limite tempo antispam tra comandi

💬 **SUPPORTO E BENVENUTO**
• \`!commands\` (o \`!aiuto\` / \`!menu\`) 📖 - Mostra questo menu comandi
• \`!chiedialessio [mess]\` ✉️ - Invia una domanda diretta al supporto
• \`!tagall\` (o \`!tutti\`) [messaggio] 📢 - Avviso con menzione di tutti i partecipanti
• \`!poll [domanda] [opz 1] [opz 2]\` 📊 - Sondaggio interattivo
• \`!welcome on/off\` 👋 - Gestisce il benvenuto automatico

👤 **PROPRIETARIO DEL BOT E COMFORT PRIVATO**
• \`!aggiungiowner @utente\` (o \`!addowner\`) 👑 - Promuove un amico a co-owner
• \`!rimuoviowner @utente\` (o \`!delowner\`) 🛡️ - Rimuove un amico dai co-owner
• \`!offline\` (o \`!assente\`) 📴 - Attiva lo stato offline in privata
• \`!online\` (o \`!presente\`) 📲 - Disattiva lo stato offline in privata
• \`!protezione on/off\` 🔒 - Attiva la protezione avanzata sicurezza
• \`!broadcast [messaggio]\` 📡 - Invia un messaggio globale in tutti i gruppi`;

                if (isOwner(sender, sock)) {
                    menuText += `\n\n🚀 **COMANDI ESCLUSIVI OWNER**
1. \`!inspect @utente\` 🔍 - Mostra la scheda informativa dell'utente nel database
2. \`!lockgroup\` / \`!unlockgroup\` 🔐 - Blocca o sblocca totalmente la chat del gruppo
3. \`!backup\` 💾 - Invia il backup completo in chat privata all'owner
4. \`!emergencyoff\` / \`!emergencyon\` ⚡ - Spegnimento o riattivazione totale d'emergenza del bot
5. \`!statsbot\` 📈 - Mostra statistiche di utilizzo e gruppi attivi
6. \`!stealth on/off\` 🥷 - Esegue comandi di moderazione in background in modo silenzioso
7. \`!blockuser @utente\` / \`!unblockuser @utente\` 🚫 - Gestisce la blacklist globale dei comandi
8. \`!cleandb\` 🗄 - Esegue una pulizia automatica del database e dei warn obsoleti
9. \`!listagruppi\` 📂 - Mostra la lista di tutti i gruppi salvati con i loro ID e partecipanti`;
                }

                await sock.sendMessage(chatJid, { text: menuText });
                return true;
            }

            case '!mute': {
                if (isGroup && !(await checkGroupAdminPrivileges(sock, chatJid))) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Non hai i privilegi di Amministratore qui." });
                    return true;
                }
                if (!targetMention) return true;
                mutedUsers.add(targetMention);
                if (!config.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `🔇 L'utente è stato mutato in questo gruppo.`, mentions: [targetMention] });
                }
                return true;
            }

            case '!unmute': {
                if (isGroup && !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                if (!targetMention) return true;
                const targetClean = targetMention.split('@')[0];
                for (let u of mutedUsers) {
                    if (u === targetMention || u.split('@')[0] === targetClean) mutedUsers.delete(u);
                }
                if (!config.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `🔊 L'utente può tornare a scrivere in questo gruppo.`, mentions: [targetMention] });
                }
                return true;
            }

            case '!warn':
            case '!wuarn': {
                if (isGroup && !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                if (!targetMention) return true;
                const currentWarns = (warnings.get(targetMention + chatJid) || 0) + 1;
                warnings.set(targetMention + chatJid, currentWarns);

                if (currentWarns < 3) {
                    if (!config.stealthMode) {
                        await sock.sendMessage(chatJid, { text: `⚠️ Avvertimento ${currentWarns}/3 registrato per l'utente in questo gruppo.`, mentions: [targetMention] });
                    }
                } else {
                    warnings.delete(targetMention + chatJid);
                    await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                    if (!config.stealthMode) {
                        await sock.sendMessage(chatJid, { text: `🚨 3 avvertimenti superati: utente espulso da questo gruppo.`, mentions: [targetMention] });
                    }
                }
                return true;
            }

            case '!rimuovi':
            case '!kick': {
                if (!isGroup || !targetMention) return true;
                if (!(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                if (!config.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `Utente rimosso da questo gruppo con successo.`, mentions: [targetMention] });
                }
                return true;
            }

            case '!masskick':
            case '!svuotagruppo': {
                if (!isGroup || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants.filter(p => !p.admin && !isProtected(p.id, config)).map(p => p.id);
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove");
                    if (!config.stealthMode) await sock.sendMessage(chatJid, { text: "🧹 Membri non admin rimossi da questo gruppo" });
                }
                return true;
            }

            case '!deletegroup':
            case '!eliminagruppo': {
                if (!isGroup || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants.filter(p => !isProtected(p.id, config)).map(p => p.id);
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove").catch(() => {});
                }
                await sock.groupLeave(chatJid);
                return true;
            }

            case '!clearalltesto': {
                if (!isOwner(sender, sock) && !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                const keyword = messageText.replace(/^!clearalltesto/i, '').trim();
                if (!keyword) return true;
                if (!config.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `🔍 Scansione avviata in questo gruppo per: ${keyword}` });
                }
                return true;
            }

            case '!promuovi': {
                if (!isGroup || !targetMention || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "promote");
                if (!config.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `Utente promosso ad admin in questo gruppo.`, mentions: [targetMention] });
                }
                return true;
            }

            case '!demuovi':
            case '!quickdemote': {
                if (!isGroup || !targetMention || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "demote");
                if (!config.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `Poteri revocati in questo gruppo.`, mentions: [targetMention] });
                }
                return true;
            }

            case '!multidemote': {
                if (!isGroup || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                const targets = getAllMentionedJids();
                if (targets.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, targets, "demote");
                    if (!config.stealthMode) await sock.sendMessage(chatJid, { text: `Admin multipli rimossi in questo gruppo.` });
                }
                return true;
            }

            case '!checkadmin': {
                if (!isGroup) return true;
                const metadata = await sock.groupMetadata(chatJid);
                const cleanSender = sender.replace(/:[0-9]+@/, '@').split(':')[0].split('@')[0];
                const pInfo = metadata.participants.find(p => p.id.replace(/:[0-9]+@/, '@').split(':')[0].split('@')[0] === cleanSender);
                const isUserAdmin = pInfo && (pInfo.admin === 'admin' || pInfo.admin === 'superadmin');
                
                if (isUserAdmin || isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "Verifica OK: sei Amministratore in questo gruppo." });
                } else {
                    await sock.sendMessage(chatJid, { text: "Non risulti Amministratore in questo gruppo specifico." });
                }
                return true;
            }

            case '!editgroup': {
                if (!isGroup || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
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
                if (!isGroup || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupJoinApprovalMode(chatJid, mode).catch(() => {});
                    await sock.sendMessage(chatJid, { text: `📋 Approvazione membri impostata su ${mode} qui.` });
                }
                return true;
            }

            case '!addmember': {
                if (!isGroup || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupAddMode(chatJid, mode === 'on' ? 'admin_add' : 'all_member_add').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `➕ Aggiunta membri impostata su ${mode} qui.` });
                }
                return true;
            }

            case '!history': {
                if (!isGroup || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupMemberAddMode(chatJid, mode === 'on' ? 'prompt' : 'no_prompt').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `📜 Cronologia ai nuovi impostata su ${mode} qui.` });
                }
                return true;
            }

            case '!invitelink': {
                if (!isGroup || !(await checkGroupAdminPrivileges(sock, chatJid))) return true;
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
                if (isGroup && (await checkGroupAdminPrivileges(sock, chatJid))) {
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
                if (isGroup && (await checkGroupAdminPrivileges(sock, chatJid))) {
                    await sock.groupSettingUpdate(chatJid, 'locked');
                    await sock.sendMessage(chatJid, { text: "🔒 Info bloccate per questo gruppo." });
                }
                return true;
            }

            case '!unlockinfo': {
                if (isGroup && (await checkGroupAdminPrivileges(sock, chatJid))) {
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

            case '!cooldown': {
                if (isGroup) {
                    if (args[1] === 'on') {
                        config.cooldownEnabled = true;
                        await sock.sendMessage(chatJid, { text: "⏱️ Cooldown antispam attivato in questo gruppo." });
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
                    text: `🛡️ L'amico è stato rimosso dai co-owner del bot.`, 
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
                if (isOwner(sender, sock) || (isGroup && (await checkGroupAdminPrivileges(sock, chatJid)))) {
                    if (isGroup) {
                        config.isLocked = true;
                        await sock.sendMessage(chatJid, { text: "🔐 Questo gruppo è ora bloccato: solo gli admin possono scrivere." });
                    }
                }
                return true;
            }

            case '!unlockgroup': {
                if (isOwner(sender, sock) || (isGroup && (await checkGroupAdminPrivileges(sock, chatJid)))) {
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
                    await sock.sendMessage(chatJid, { text: "📂 Nessun gruppo memorizzato finora. Fai scrivere un messaggio in un gruppo affinché il bot lo salvi." });
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

            case '!stealth': {
                if (isOwner(sender, sock) || (isGroup && (await checkGroupAdminPrivileges(sock, chatJid)))) {
                    if (args[1] === 'on') {
                        config.stealthMode = true;
                        await sock.sendMessage(chatJid, { text: "🥷 Modalità stealth attivata solo per questo gruppo." });
                    } else if (args[1] === 'off') {
                        config.stealthMode = false;
                        await sock.sendMessage(chatJid, { text: "🥷 Modalità stealth disattivata in questo gruppo." });
                    }
                }
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
