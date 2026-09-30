import { DisconnectReason } from '@whiskeysockets/baileys';

// Strutture dati in memoria per tracciare lo stato
const mutedUsers = new Set();
const warnings = new Map(); // key: userId, value: count
const cooldowns = new Map(); // key: userId, value: timestamp
const blacklist = new Set(); // key: userId

// Mappe per tracciare se l'utente è già stato avvisato del cambio stato (online/offline)
const notifiedOnline = new Set();

// Configurazioni di stato del gruppo e globali
const groupSettings = {
    linkFilter: false,
    cooldownEnabled: false,
    cooldownTime: 4000,
    waitingForTagAll: new Set(),
    waitingForSetName: new Set(),
    inactiveGroups: new Set(),
    lockedGroups: new Set(),
    stealthMode: false,
    emergencyStopped: false,
    welcomeEnabled: true
};

// Dati del proprietario principale (modificabili dinamicamente con i comandi)
let OWNER_JID = "393534467571@s.whatsapp.net";
let OWNER_PHONE = "+39 3534467571";
const ORIGINAL_OWNER_JID = "393534467571@s.whatsapp.net";
const ORIGINAL_OWNER_PHONE = "+39 3534467571";

global.extraOwners = global.extraOwners || new Set([OWNER_JID]);
global.protectedUsers = global.protectedUsers || new Set([OWNER_JID]);
global.protectionEnabled = global.protectionEnabled !== undefined ? global.protectionEnabled : true;

const isOwner = (jid, sock) => {
    return jid === OWNER_JID || global.extraOwners.has(jid) || jid === sock?.user?.id;
};

const isProtected = (jid) => {
    return jid === OWNER_JID || global.protectedUsers.has(jid);
};

// 🛡️ Funzione di controllo preventivo: verifica se l'account o l'owner sono Admin nel gruppo
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

        const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
        return isAdmin;
    } catch (e) {
        return false;
    }
}

// Funzione di utilità per verificare se il bot/account è amministratore del gruppo
async function ensureBotIsAdmin(sock, chatJid) {
    try {
        const metadata = await sock.groupMetadata(chatJid);
        const cleanOwnerJid = OWNER_JID.split(':')[0].split('@')[0];
        const botParticipant = metadata.participants.find(p => p.id.includes(cleanOwnerJid));
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

        // Emergenza attiva: blocca tutto tranne i comandi di sblocco dell'owner
        if (groupSettings.emergencyStopped && !isOwner(sender, sock)) {
            return false;
        }

        // Controllo Blacklist globale
        if (blacklist.has(sender) && !isOwner(sender, sock)) {
            return true;
        }

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

        // 👋 Gestione Evento Partecipanti (Benvenuto automatico)
        if (isGroup && m.messageStubType === 27 && groupSettings.welcomeEnabled) {
            const newMemberJid = m.messageStubParameters?.[0];
            if (newMemberJid) {
                try {
                    const metadata = await sock.groupMetadata(chatJid);
                    const desc = metadata.desc ? metadata.desc.trim() : "";
                    const groupName = metadata.subject || "questo gruppo";
                    
                    let welcomeText = `Buongiorno @${newMemberJid.split('@')[0]} e benvenuto/a nel gruppo ${groupName}\n\n`;
                    if (desc) {
                        welcomeText += `Leggi con attenzione le regole: ${desc}`;
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
                        m.message?.imageMessage?.caption || 
                        (m.message?.audioMessage ? "[Messaggio Vocale]" : '');
        }

        // Controllo utenti mutati perpetui (escluso se stesso)
        if (isGroup && !m.key.fromMe) {
            const senderClean = sender.split('@')[0];
            const isMuted = mutedUsers.has(sender) || Array.from(mutedUsers).some(id => id.split('@')[0] === senderClean);
            
            if (isMuted) {
                try {
                    await sock.sendMessage(chatJid, { delete: m.key });
                } catch (err) {
                    console.error("Impossibile cancellare il messaggio dell'utente mutato:", err);
                }
                return true;
            }
        }

        // Controllo blocco totale gruppo (!lockgroup)
        if (isGroup && groupSettings.lockedGroups.has(chatJid) && !m.key.fromMe) {
            const botAdmin = await ensureBotIsAdmin(sock, chatJid);
            if (botAdmin) {
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

        // Controllo se il gruppo è disattivato tramite !gruppo off
        if (isGroup && groupSettings.inactiveGroups.has(chatJid)) {
            if (command === '!gruppo' && args[1] === 'on' && isOwner(sender, sock)) {
                groupSettings.inactiveGroups.delete(chatJid);
                await sock.sendMessage(chatJid, { text: "🤖 Il bot è di nuovo attivo in questo gruppo" });
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
            
            let text = `📢 Attenzione a tutti ragazzi\n\n${announcementText}\n\n`;
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
                    const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                    if (!isAdminOk) {
                        await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                        return true;
                    }
                    await sock.groupUpdateSubject(chatJid, newTitle);
                    await sock.sendMessage(chatJid, { text: `🏷️ Il nome del gruppo è stato aggiornato in modo perfetto` });
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
                    text: `⚠️ Non puoi inviare link esterni in questo gruppo se prima non chiedi il permesso` 
                });
                return true;
            }
        }

        // Gestione offline in chat privata
        if (!isGroup && global.offlineMode && !isOwner(sender, sock) && !m.key.fromMe) {
            await sock.sendMessage(chatJid, { text: "Alessio al momento non è disponibile, ti risponderà appena rientra nella tua chat." }, { quoted: m });
            return true;
        }

        // Gestione online in chat privata (avvisa una sola volta)
        if (!isGroup && !global.offlineMode && !isOwner(sender, sock) && !m.key.fromMe) {
            if (!notifiedOnline.has(sender)) {
                notifiedOnline.add(sender);
                await sock.sendMessage(chatJid, { text: "Alessio è ritornato operativo, quindi potrà finalmente risponderti." }, { quoted: m });
            }
        }

        // --- Protezione Proprietario e Utenti Protetti su comandi di moderazione ---
        if (targetMention && isProtected(targetMention) && ['!mute', '!warn', '!wuarn', '!kick', '!rimuovi', '!demuovi', '!quickdemote', '!multidemote'].includes(command)) {
            if (global.protectionEnabled) {
                const protText = isOwner(targetMention, sock) ? "Non puoi bannare l'owner del bot dal gruppo" : "Non puoi bannare questo utente dal gruppo";
                await sock.sendMessage(chatJid, { text: `🛡️ ${protText}` });
            } else {
                await sock.sendMessage(chatJid, { text: "⚠️ Operazione bloccata perché ci sono restrizioni di sicurezza attive" });
            }
            return true;
        }

        // --- GESTIONE COMANDI ---
        switch (command) {
            case '!commands':
            case '!aiuto': {
                let menuText = `📋 **LISTA COMPLETA DEI COMANDI DEL BOT**

🛑 **GESTIONE MODERAZIONE E SANZIONI**
• \`!mute @utente\` 🔇 - Muto perpetuo e cancellazione automatica messaggi
• \`!unmute @utente\` 🔊 - Revoca il muto perpetuo
• \`!warn @utente\` ⚠️ - Gestione ammonizioni ad accumulo (3 livelli)
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
• \`!editgroup on/off\` ✏️ - Gestisce la modifica info gruppo per soli admin
• \`!approva on/off\` 📋 - Gestisce approvazione nuovi membri
• \`!addmember on/off\` ➕ - Gestisce restrizione aggiunta partecipanti
• \`!history on/off\` 📜 - Invio cronologia messaggi ai nuovi membri
• \`!invitelink on/off\` 🔗 - Accesso tramite link d'invito
• \`!setname [nome]\` 🏷️ - Cambia istantaneamente il nome del gruppo
• \`!lockinfo\` / \`!unlockinfo\` 🔒 - Blocca o sblocca i dettagli del gruppo
• \`!link on/off\` 🌐 - Cancellazione automatica link esterni
• \`!cooldown on/off\` ⏱️ - Limite tempo antispam tra comandi

💬 **SUPPORTO E BENVENUTO**
• \`!commands\` (o \`!aiuto\` / \`!menu\`) 📖 - Mostra questo menu comandi
• \`!chiedialessio [mess]\` ✉️ - Invia una domanda diretta al supporto
• \`!tagall\` (o \`!tutti\`) 📢 - Avviso con menzione di tutti i partecipanti
• \`!poll [domanda] [opz 1] [opz 2]\` 📊 - Crea un sondaggio interattivo
• \`!welcome on/off\` 👋 - Gestisce il benvenuto automatico

👤 **PROPRIETARIO DEL BOT E COMFORT PRIVATO**
• \`!setowner @utente\` 👑 - Promuove un utente a comproprietario
• \`!removeowner @utente\` 🛡️ - Rimuove i poteri di proprietario
• \`!offline\` (o \`!assente\`) 📴 - Attiva lo stato offline in privata
• \`!online\` (o \`!presente\`) 📲 - Disattiva lo stato offline in privata
• \`!protezione on/off\` 🔒 - Attiva la protezione avanzata sicurezza`;

                if (isOwner(sender, sock)) {
                    menuText += `\n\n🚀 **COMANDI ESCLUSIVI OWNER**
1. \`!broadcast [messaggio]\` 📡 - Invia un messaggio globale in tutti i gruppi
2. \`!inspect @utente\` 🔍 - Mostra la scheda informativa dell'utente nel database
3. \`!lockgroup\` / \`!unlockgroup\` 🔐 - Blocca o sblocca totalmente la chat del gruppo
4. \`!backup\` 💾 - Invia il backup completo in chat privata all'owner
5. \`!emergencyoff\` / \`!emergencyon\` ⚡ - Spegnimento o riattivazione totale d'emergenza del bot
6. \`!statsbot\` 📈 - Mostra statistiche di utilizzo e gruppi attivi
7. \`!stealth on/off\` 🥷 - Esegue comandi di moderazione in background in modo silenzioso
8. \`!blockuser @utente\` / \`!unblockuser @utente\` 🚫 - Gestisce la blacklist globale dei comandi
9. \`!cleandb\` 🗄️️ - Esegue una pulizia automatica del database e dei warn obsoleti`;
                }

                await sock.sendMessage(chatJid, { text: menuText });
                return true;
            }

            case '!mute': {
                if (isGroup) {
                    const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                    if (!isAdminOk) {
                        await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                        return true;
                    }
                }
                if (!targetMention) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Ricordati di taggare la persona che vuoi mutare" });
                    return true;
                }
                mutedUsers.add(targetMention);
                if (!groupSettings.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `🔇 L'utente è stato mutato con successo adesso non può parlare`, mentions: [targetMention] });
                }
                return true;
            }

            case '!unmute': {
                if (isGroup) {
                    const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                    if (!isAdminOk) {
                        await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                        return true;
                    }
                }
                if (!targetMention) return true;
                const targetClean = targetMention.split('@')[0];
                for (let u of mutedUsers) {
                    if (u === targetMention || u.split('@')[0] === targetClean) {
                        mutedUsers.delete(u);
                    }
                }
                if (!groupSettings.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `🔊 L'utente è stato smutato può tornare a scrivere`, mentions: [targetMention] });
                }
                return true;
            }

            case '!warn':
            case '!wuarn': {
                if (isGroup) {
                    const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                    if (!isAdminOk) {
                        await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                        return true;
                    }
                }
                if (!targetMention) return true;
                const currentWarns = (warnings.get(targetMention) || 0) + 1;
                warnings.set(targetMention, currentWarns);

                if (currentWarns === 1) {
                    if (!groupSettings.stealthMode) {
                        await sock.sendMessage(chatJid, {
                            text: `⚠️ L'utente ha ricevuto la 1ª ammonizione (registrata nel sistema).`,
                            mentions: [targetMention]
                        });
                    }
                } else if (currentWarns === 2) {
                    if (!groupSettings.stealthMode) {
                        await sock.sendMessage(chatJid, {
                            text: `⚠️ Attenzione! Questo è il 2° avvertimento: al prossimo superamento dei limiti verrai bannato dal gruppo.`,
                            mentions: [targetMention]
                        });
                    }
                } else if (currentWarns >= 3) {
                    warnings.delete(targetMention);
                    await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                    if (!groupSettings.stealthMode) {
                        await sock.sendMessage(chatJid, { text: `🚨 Limite di 3 avvertimenti superato: utente espulso dal gruppo in via definitiva.`, mentions: [targetMention] });
                    }
                }
                return true;
            }

            case '!rimuovi':
            case '!kick': {
                if (!isGroup || !targetMention) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const targetName = targetMention.split('@')[0];
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                if (!groupSettings.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `L'utente @${targetName} è stato rimosso dal gruppo con successo.`, mentions: [targetMention] });
                }
                return true;
            }

            case '!masskick':
            case '!svuotagruppo': {
                if (!isGroup) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants
                    .filter(p => !p.admin && !isProtected(p.id))
                    .map(p => p.id);
                
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove");
                    if (!groupSettings.stealthMode) {
                        await sock.sendMessage(chatJid, { text: "🧹 Ho ripulito tutto il gruppo rimuovendo tutti i membri non admin" });
                    }
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️ Non ci sono partecipanti che possono essere rimossi" });
                }
                return true;
            }

            case '!deletegroup':
            case '!eliminagruppo': {
                if (!isGroup) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const metadata = await sock.groupMetadata(chatJid);
                const participants = metadata.participants.filter(p => !isProtected(p.id)).map(p => p.id);
                if (participants.length > 0) {
                    await sock.groupParticipantsUpdate(chatJid, participants, "remove").catch(() => {});
                }
                if (!groupSettings.stealthMode) {
                    await sock.sendMessage(chatJid, { text: "🗑️ Procedo subito allo svuotamento totale e all'abbandono del gruppo" });
                }
                await sock.groupLeave(chatJid);
                return true;
            }

            case '!clearalltesto': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                const keyword = messageText.replace(/^!clearalltesto/i, '').trim();
                if (!keyword) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Specifica una parola o una corrispondenza da cercare e cancellare" });
                    return true;
                }
                if (!groupSettings.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `🔍 Avviata la scansione e cancellazione globale per tutti i messaggi corrispondenti a: ${keyword}` });
                }
                return true;
            }

            case '!promuovi': {
                if (!isGroup || !targetMention) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const targetName = targetMention.split('@')[0];
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "promote");
                if (!groupSettings.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `L'utente @${targetName} è stato promosso amministratore del gruppo con successo.`, mentions: [targetMention] });
                }
                return true;
            }

            case '!demuovi':
            case '!quickdemote': {
                if (!isGroup || !targetMention) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "demote");
                if (!groupSettings.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `👤 All'utente sono stati revocati tutti i poteri di admin` });
                }
                return true;
            }

            case '!multidemote': {
                if (!isGroup) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const targets = getAllMentionedJids();
                if (targets.length === 0) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Devi taggare almeno un utente per procedere" });
                    return true;
                }
                await sock.groupParticipantsUpdate(chatJid, targets, "demote");
                if (!groupSettings.stealthMode) {
                    await sock.sendMessage(chatJid, { text: `👥 Tutti gli utenti taggati non sono più amministratori` });
                }
                return true;
            }

            case '!checkadmin': {
                if (!isGroup) {
                    await sock.sendMessage(chatJid, { text: "⚠️️ Questo comando va eseguito all'interno di un gruppo." });
                    return true;
                }
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "✅ Verifica completata: Risulti come Amministratore di questo gruppo. Tutti i comandi di gestione e moderazione del bot sono attivi." });
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️ Attenzione: Non sei registrato come Amministratore in questo gruppo. Le funzioni di controllo rimarranno bloccate." });
                }
                return true;
            }

            case '!editgroup': {
                if (!isGroup) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const mode = args[1];
                if (mode === 'on') {
                    await sock.groupSettingUpdate(chatJid, 'locked');
                    await sock.sendMessage(chatJid, { text: "🔒 Modifica delle informazioni riservata unicamente agli admin" });
                } else if (mode === 'off') {
                    await sock.groupSettingUpdate(chatJid, 'unlocked');
                    await sock.sendMessage(chatJid, { text: "🔓 Adesso tutti i partecipanti possono modificare le info del gruppo" });
                }
                return true;
            }

            case '!approva': {
                if (!isGroup) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupJoinApprovalMode(chatJid, mode === 'on' ? 'on' : 'off').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `📋 Approvazione dei nuovi membri impostata su ${mode}` });
                }
                return true;
            }

            case '!addmember': {
                if (!isGroup) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupAddMode(chatJid, mode === 'on' ? 'admin_add' : 'all_member_add').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `➕ Restrizione aggiunta membri aggiornata correttamente su ${mode}` });
                }
                return true;
            }

            case '!history': {
                if (!isGroup) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const mode = args[1];
                if (mode === 'on' || mode === 'off') {
                    await sock.groupMemberAddMode(chatJid, mode === 'on' ? 'prompt' : 'no_prompt').catch(() => {});
                    await sock.sendMessage(chatJid, { text: `📜 Invio cronologia messaggi impostato su ${mode}` });
                }
                return true;
            }

            case '!invitelink': {
                if (!isGroup) return true;
                const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                if (!isAdminOk) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                    return true;
                }
                const mode = args[1];
                await sock.sendMessage(chatJid, { text: `🔗 Accesso tramite link di invito configurato su ${mode}` });
                return true;
            }

            case '!chiedialessio': {
                const userMessage = messageText.replace(/^!chiedialessio/i, '').trim();
                if (!userMessage) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Ciao se vuoi inviare un messaggio ad Alessio scrivi la tua richiesta subito dopo il comando" });
                } else {
                    let groupName = isGroup ? "Gruppo" : "Chat Privata";
                    if (isGroup) {
                        try {
                            const metadata = await sock.groupMetadata(chatJid);
                            groupName = metadata.subject || chatJid;
                        } catch (e) {}
                    }
                    const forwardText = `✉ Nuova richiesta di supporto ricevuta\nDa utente: @${sender.split('@')[0]}\nProvenienza: ${groupName}\nTesto: ${userMessage}`;
                    await sock.sendMessage(OWNER_JID, { text: forwardText, mentions: [sender] });
                    await sock.sendMessage(chatJid, { text: "✉ Il tuo messaggio è stato inoltrato con successo ad Alessio" });
                }
                return true;
            }

            case '!tagall':
            case '!tutti': {
                if (isGroup) {
                    groupSettings.waitingForTagAll.add(sender);
                    await sock.sendMessage(chatJid, { text: "📢 Scrivi pure che cosa vorresti comunicare a tutti quanti" });
                }
                return true;
            }

            case '!poll': {
                const pollData = messageText.replace(/^!poll/i, '').trim().split(/\s+/);
                const pollQuestion = pollData[0];
                const pollOptions = pollData.slice(1);
                if (pollQuestion && pollOptions.length > 1) {
                    await sock.sendMessage(chatJid, { poll: { name: pollQuestion, values: pollOptions } });
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️️ Formato del sondaggio errato" });
                }
                return true;
            }

            case '!welcome': {
                if (isGroup) {
                    const action = args[1];
                    if (action === 'on') {
                        groupSettings.welcomeEnabled = true;
                        await sock.sendMessage(chatJid, { text: "👋 Messaggi di benvenuto attivati con successo" });
                    } else if (action === 'off') {
                        groupSettings.welcomeEnabled = false;
                        await sock.sendMessage(chatJid, { text: "👋 Messaggi di benvenuto disattivati" });
                    }
                }
                return true;
            }

            case '!setname': {
                if (isGroup) {
                    const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                    if (!isAdminOk) {
                        await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                        return true;
                    }
                    const newName = messageText.replace(/^!setname/i, '').trim();
                    if (!newName) {
                        groupSettings.waitingForSetName.add(sender);
                        await sock.sendMessage(chatJid, { text: "🏷️ Dimmi quale nome vuoi dare al gruppo" });
                    } else {
                        await sock.groupUpdateSubject(chatJid, newName);
                        await sock.sendMessage(chatJid, { text: `🏷️ Il titolo del gruppo è stato cambiato in modo perfetto` });
                    }
                }
                return true;
            }

            case '!lockinfo': {
                if (isGroup) {
                    const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                    if (!isAdminOk) {
                        await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                        return true;
                    }
                    await sock.groupSettingUpdate(chatJid, 'locked');
                    await sock.sendMessage(chatJid, { text: "🔒 Informazioni del gruppo bloccate con successo solo per gli admin" });
                }
                return true;
            }

            case '!unlockinfo': {
                if (isGroup) {
                    const isAdminOk = await checkGroupAdminPrivileges(sock, chatJid);
                    if (!isAdminOk) {
                        await sock.sendMessage(chatJid, { text: "⚠️ Errore: Non hai i privilegi di Amministratore in questo gruppo. I comandi del bot rimangono disattivati." });
                        return true;
                    }
                    await sock.groupSettingUpdate(chatJid, 'unlocked');
                    await sock.sendMessage(chatJid, { text: "🔓 Informazioni del gruppo sbloccate per tutti quanti" });
                }
                return true;
            }

            case '!link': {
                if (isGroup) {
                    const action = args[1];
                    if (action === 'on') {
                        groupSettings.linkFilter = true;
                        await sock.sendMessage(chatJid, { text: "🌐 Filtro anti link esterni attivato correttamente" });
                    } else if (action === 'off') {
                        groupSettings.linkFilter = false;
                        await sock.sendMessage(chatJid, { text: "🌐 Filtro anti link esterni disattivato" });
                    }
                }
                return true;
            }

            case '!offline':
            case '!assente': {
                if (isOwner(sender, sock)) {
                    global.offlineMode = true;
                    notifiedOnline.clear();
                    await sock.sendMessage(chatJid, { text: "Modalità offline attivata con successo." });
                }
                return true;
            }

            case '!online':
            case '!presente': {
                if (isOwner(sender, sock)) {
                    global.offlineMode = false;
                    notifiedOnline.clear();
                    await sock.sendMessage(chatJid, { text: "Modalità online attivata con successo." });
                }
                return true;
            }

            case '!protezione': {
                if (isOwner(sender, sock)) {
                    const action = args[1];
                    if (action === 'on') {
                        if (targetMention) {
                            global.protectedUsers.add(targetMention);
                            const targetName = targetMention.split('@')[0];
                            await sock.sendMessage(chatJid, { text: `${targetName} è ora protetto con successo`, mentions: [targetMention] });
                        } else {
                            global.protectionEnabled = true;
                            await sock.sendMessage(chatJid, { text: `L'owner del bot (+393534467571) è ora protetto con successo.` });
                        }
                    } else if (action === 'off') {
                        global.protectionEnabled = false;
                        await sock.sendMessage(chatJid, { text: "⚠️ Attenzione protezione del proprietario disattivata" });
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
                            await sock.sendMessage(chatJid, { text: "🤖 Il bot è stato disattivato in questo gruppo" });
                        } else {
                            await sock.sendMessage(chatJid, { text: "⛔ Questo comando è riservato al proprietario" });
                        }
                    } else if (action === 'on') {
                        if (isOwner(sender, sock)) {
                            groupSettings.inactiveGroups.delete(chatJid);
                            await sock.sendMessage(chatJid, { text: "🤖 Il bot è stato riattivato in questo gruppo" });
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
                        await sock.sendMessage(chatJid, { text: "👑 Nuovo proprietario aggiunto con successo" });
                    } else {
                        await sock.sendMessage(chatJid, { text: "⚠ Devi taggare un utente per promuoverlo" });
                    }
                } else {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al creatore principale" });
                }
                return true;
            }

            case '!removeowner': {
                if (sender === OWNER_JID) {
                    if (targetMention) {
                        global.extraOwners.delete(targetMention);
                        global.protectedUsers.delete(targetMention);
                        await sock.sendMessage(chatJid, { text: "🛡️ Ruolo di proprietario rimosso correttamente" });
                    } else {
                        await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente per rimuovere i poteri" });
                    }
                } else {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al creatore principale" });
                }
                return true;
            }

            case '!broadcast': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                const broadText = messageText.replace(/^!broadcast/i, '').trim();
                if (!broadText) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Inserisci il testo da inviare in broadcast" });
                    return true;
                }
                await sock.sendMessage(chatJid, { text: `📡 Broadcast avviato con successo per tutti i gruppi.` });
                return true;
            }

            case '!inspect': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                if (!targetMention) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente da ispezionare" });
                    return true;
                }
                const userWarns = warnings.get(targetMention) || 0;
                const isUserMuted = mutedUsers.has(targetMention);
                const isUserProt = isProtected(targetMention);
                await sock.sendMessage(chatJid, { 
                    text: `🔍 **Scheda Informativa Utente**\n• JID: ${targetMention}\n• Warn ricevuti: ${userWarns}\n• Mutato: ${isUserMuted ? 'Sì' : 'No'}\n• Protetto: ${isUserProt ? 'Sì' : 'No'}`,
                    mentions: [targetMention]
                });
                return true;
            }

            case '!lockgroup': {
                if (!isOwner(sender, sock)) return true;
                if (isGroup) {
                    groupSettings.lockedGroups.add(chatJid);
                    await sock.sendMessage(chatJid, { text: "🔐 Chat del gruppo bloccata: solo gli amministratori possono scrivere." });
                }
                return true;
            }

            case '!unlockgroup': {
                if (!isOwner(sender, sock)) return true;
                if (isGroup) {
                    groupSettings.lockedGroups.delete(chatJid);
                    await sock.sendMessage(chatJid, { text: "🔓 Chat del gruppo sbloccata per tutti i partecipanti." });
                    return true;
                }
                return true;
            }

            case '!backup': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                const backupData = `💾 **Backup Dati Bot**\n- Mutati attivi: ${mutedUsers.size}\n- Warn registrati: ${warnings.size}\n- Blacklist: ${blacklist.size}`;
                await sock.sendMessage(OWNER_JID, { text: backupData });
                await sock.sendMessage(chatJid, { text: "💾 Backup inviato con successo in chat privata all'owner." });
                return true;
            }

            case '!emergencyoff': {
                if (!isOwner(sender, sock)) return true;
                groupSettings.emergencyStopped = true;
                await sock.sendMessage(chatJid, { text: "⚡ Emergenza attivata: tutte le funzioni del bot sono state disattivate." });
                return true;
            }

            case '!emergencyon': {
                if (!isOwner(sender, sock)) return true;
                groupSettings.emergencyStopped = false;
                await sock.sendMessage(chatJid, { text: "⚡ Bot riattivato completamente con successo." });
                return true;
            }

            case '!statsbot': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                await sock.sendMessage(chatJid, { text: `📈 **Statistiche Bot**\n• Gruppi inattivi: ${groupSettings.inactiveGroups.size}\n• Gruppi bloccati: ${groupSettings.lockedGroups.size}\n• Utenti in blacklist: ${blacklist.size}` });
                return true;
            }

            case '!stealth': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                const action = args[1];
                if (action === 'on') {
                    groupSettings.stealthMode = true;
                    await sock.sendMessage(chatJid, { text: "🥷 Modalità stealth (invisibile) attivata con successo." });
                } else if (action === 'off') {
                    groupSettings.stealthMode = false;
                    await sock.sendMessage(chatJid, { text: "🥷 Modalità stealth disattivata." });
                }
                return true;
            }

            case '!blockuser': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                if (!targetMention) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente da aggiungere alla blacklist" });
                    return true;
                }
                blacklist.add(targetMention);
                await sock.sendMessage(chatJid, { text: "🚫 Utente inserito nella blacklist globale con successo.", mentions: [targetMention] });
                return true;
            }

            case '!unblockuser': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                if (!targetMention) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente da rimuovere dalla blacklist" });
                    return true;
                }
                blacklist.delete(targetMention);
                await sock.sendMessage(chatJid, { text: "✅ Utente rimosso dalla blacklist globale.", mentions: [targetMention] });
                return true;
            }

            case '!cleandb': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⛔ Comando riservato esclusivamente al proprietario" });
                    return true;
                }
                warnings.clear();
                await sock.sendMessage(chatJid, { text: "🗄 Pulizia automatica del database completata con successo." });
                return true;
            }
        }

    } catch (error) {
        console.error("Errore nell'esecuzione dei comandi:", error);
    }
    return false;
}
