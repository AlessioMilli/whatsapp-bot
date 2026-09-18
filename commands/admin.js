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

        // Configurazioni globali iniziali (Chiave API preimpostata)
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

        // --- COMANDI ---
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
!history on/off* - Attiva/disattiva l'invio della cronologia dei messaggi ai nuovi membri (solo admin)
!invitelink on/off* - Attiva/disattiva l'accesso tramite link d'invito al gruppo (solo admin)
!quickdemote @utente* - Comando rapido per rimuovere i poteri di admin taggando l'utente
!masskick / !svuotagruppo* - Rimuove istantaneamente tutti i partecipanti dal gruppo (Solo admin)
!deletegroup / !eliminagruppo* - Svuota ed elimina/abbandona il gruppo (Solo admin)

📌 Intelligenza Artificiale & Web:
!web [domanda] / !cerca [domanda]* - Naviga sul web tramite le API di Google Gemini
!setgeminiak [chiave]* - Imposta o aggiorna la chiave API di Google Gemini (Solo Proprietario)
!chiedialessio / !aiutoalessio [proposta]* - Invia un suggerimento o richiesta ad Alessio

📌 Gruppo & Sicurezza:
!tagall / !tutti* - Manda un avviso a tutti
!poll Domanda? | Opz 1 | Opz 2* - Crea un sondaggio
!setname [nome]* - Cambia il nome del gruppo
!lockinfo* - Blocca le info del gruppo
!unlockinfo* - Sblocca le info del gruppo
!link on* - Attiva la cancellazione automatica dei link esterni
!link off* - Disattiva la cancellazione automatica dei link
!cooldown on/off* - Attiva/disattiva il limite di tempo antispam tra i comandi
!offline / !assente* - Attiva la modalità offline
!online / !presente* - Disattiva la modalità offline
!protezione on/off* - Attiva/disattiva la protezione generale o su uno specifico utente (@utente)
!gruppo on/off* - Attiva/disattiva la risposta del bot in questo specifico gruppo (Solo Proprietario)
!setowner @utente* - Promuove un utente a proprietario del bot (Solo Creatore Principale)
!removeowner @utente* - Rimuove i poteri di proprietario a un utente (Solo Creatore Principale)`;

                await sock.sendMessage(chatJid, { text: menuText }, { quoted: m });
                return true;
            }

            case '!setgeminiak': {
                const key = messageText.slice(13).trim();
                if (!key) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Inserisci una chiave valida dopo il comando." }, { quoted: m });
                    return true;
                }

                await sock.sendMessage(chatJid, { text: "🔄 Verifica in corso della chiave API, attendere prego..." }, { quoted: m });

                global.geminiApiKey = key;
                await sock.sendMessage(chatJid, { text: "✅ Chiave riconosciuta con successo! Ora potrai usare la funzione." }, { quoted: m });
                return true;
            }

            case '!web':
            case '!cerca': {
                const query = messageText.replace(/^!(web|cerca)/i, '').trim();
                if (!query) {
                    await sock.sendMessage(chatJid, { text: "Cosa desideri cercare sul web?" }, { quoted: m });
                    return true;
                }

                const frasiAttesa = [
                    "Sto scavando nel web per trovare la risposta perfetta...",
                    "Analizzo i dati in tempo reale, un istante e ti dico tutto!",
                    "Connetto i neuroni digitali alla rete... Vediamo cosa trovo!",
                    "Sto elaborando la tua richiesta con l'intelligenza artificiale..."
                ];
                const fraseScelta = frasiAttesa[Math.floor(Math.random() * frasiAttesa.length)];
                
                await sock.sendMessage(chatJid, { text: `🤖 ${fraseScelta}` }, { quoted: m });

                try {
                    const ai = new GoogleGenAI({ apiKey: global.geminiApiKey });
                    let response;
                    
                    let tentativi = 3;
                    while (tentativi > 0) {
                        try {
                            response = await ai.models.generateContent({
                                model: 'gemini-3.6-flash',
                                contents: query,
                            });
                            break; 
                        } catch (err) {
                            tentativi--;
                            if (tentativi === 0) throw err;
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                    
                    const responseText = response.text || (response.candidates && response.candidates[0]?.content?.parts[0]?.text) || "Nessuna risposta generata.";
                    await sock.sendMessage(chatJid, { text: `🌍 *Risultato Web*:\n${responseText}` }, { quoted: m });
                } catch (error) {
                    console.error("Errore API Gemini:", error);
                    await sock.sendMessage(chatJid, { text: `❌ I server sono molto occupati in questo momento. Riprova tra qualche istante!` }, { quoted: m });
                }
                return true;
            }

            case '!chiedialessio':
            case '!aiutoalessio': {
                const query = messageText.replace(/^!(chiedialessio|aiutoalessio)/i, '').trim();
                if (!query) {
                    await sock.sendMessage(chatJid, { text: "Ciao! Che tipo di funzione vorresti che Alessio aggiungesse al bot?" }, { quoted: m });
                    return true;
                }
                
                let rispostaAi = `Ho ricevuto la tua richiesta: "${query}".`;
                try {
                    const ai = new GoogleGenAI({ apiKey: global.geminiApiKey });
                    let response;
                    let tentativi = 3;
                    
                    while (tentativi > 0) {
                        try {
                            response = await ai.models.generateContent({
                                model: 'gemini-3.6-flash',
                                contents: `Analizza questa richiesta di una nuova funzione per un bot WhatsApp: "${query}". Tieni conto che il bot ha già comandi per la gestione utenti, gruppi e IA. Spiega gentilmente se esiste già o conferma l'inoltro.`,
                            });
                            break;
                        } catch (err) {
                            tentativi--;
                            if (tentativi === 0) throw err;
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                    
                    if (response && response.text) {
                        rispostaAi = response.text;
                    } else if (response && response.candidates?.[0]?.content?.parts?.[0]?.text) {
                        rispostaAi = response.candidates[0].content.parts[0].text;
                    }
                } catch (error) {
                    console.error("Errore dettagliato Gemini AI:", error);
                }

                await sock.sendMessage(chatJid, { text: `🤖 *Assistente IA (Alessio)*:\n${rispostaAi}` }, { quoted: m });

                if (!m.key.fromMe) {
                    const nomeUtente = m.pushName || sender.split('@')[0];
                    const notificaTesto = `🚨 *Nuova richiesta funzione!*\n\n👤 Utente: ${nomeUtente} (${sender.split('@')[0]})\n💬 Proposta: "${query}"`;
                    await sock.sendMessage(OWNER_JID, { text: notificaTesto });
                }
                return true;
            }

            case '!setowner': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al creatore principale del bot." }, { quoted: m });
                    return true;
                }
                if (targetMention) {
                    global.extraOwners.add(targetMention);
                    global.protectedUsers.add(targetMention);
                    await sock.sendMessage(chatJid, { text: `👑 L'utente @${targetMention.split('@')[0]} è ora ufficialmente un proprietario del bot!`, mentions: [targetMention] }, { quoted: m });
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente per renderlo proprietario." }, { quoted: m });
                }
                return true;
            }

            case '!removeowner': {
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "⚠️ Comando riservato al creatore principale del bot." }, { quoted: m });
                    return true;
                }
                if (targetMention) {
                    global.extraOwners.delete(targetMention);
                    global.protectedUsers.delete(targetMention);
                    await sock.sendMessage(chatJid, { text: `🛡️ Rimossi i poteri di proprietario all'utente @${targetMention.split('@')[0]}`, mentions: [targetMention] }, { quoted: m });
                } else {
                    await sock.sendMessage(chatJid, { text: "⚠️ Tagga un utente per rimuovere i poteri di proprietario." }, { quoted: m });
                }
                return true;
            }

            case '!protezione': {
                const status = args[1];
                if (status === 'on') {
                    if (targetMention) {
                        global.protectedUsers.add(targetMention);
                        await sock.sendMessage(chatJid, { text: `🛡️ L'utente @${targetMention.split('@')[0]} ora è protetto ed è intoccabile come il proprietario!`, mentions: [targetMention] }, { quoted: m });
                    } else {
                        global.protectedUsers.add('general');
                        await sock.sendMessage(chatJid, { text: "🛡️ Protezione generale del gruppo ATTIVATA." }, { quoted: m });
                    }
                } else if (status === 'off') {
                    if (targetMention) {
                        global.protectedUsers.delete(targetMention);
                        await sock.sendMessage(chatJid, { text: `🛡️ Protezione rimossa per l'utente @${targetMention.split('@')[0]}`, mentions: [targetMention] }, { quoted: m });
                    } else {
                        global.protectedUsers.clear();
                        global.protectedUsers.add(OWNER_JID);
                        await sock.sendMessage(chatJid, { text: "🛡️ Protezione disattivata completamente." }, { quoted: m });
                    }
                }
                return true;
            }

            case '!offline':
            case '!assente': {
                if (isOwner(sender, sock)) {
                    global.offlineMode = true;
                    await sock.sendMessage(chatJid, { text: "🔴 Modalità offline attivata con successo." }, { quoted: m });
                }
                return true;
            }

            case '!online':
            case '!presente': {
                if (isOwner(sender, sock)) {
                    global.offlineMode = false;
                    await sock.sendMessage(chatJid, { text: "🟢 Alessio è ora disponibile per risponderti!" }, { quoted: m });
                }
                return true;
            }

            case '!gruppo': {
                const status = args[1];
                if (!isOwner(sender, sock)) {
                    await sock.sendMessage(chatJid, { text: "Al momento non puoi usare questo comando perché questo comando è riservato al proprietario." }, { quoted: m });
                    return true;
                }
                if (status === 'on' || status === 'off') {
                    global.groupActive = (status === 'on');
                    if (status === 'off') {
                        groupSettings.inactiveGroups.add(chatJid);
                    } else {
                        groupSettings.inactiveGroups.delete(chatJid);
                    }
                    await sock.sendMessage(chatJid, { text: `🤖 Risposta del bot in questo gruppo impostata su: ${status}` }, { quoted: m });
                }
                return true;
            }

            case '!mute': {
                if (!targetMention) return true;
                mutedUsers.add(targetMention);
                await sock.sendMessage(chatJid, { text: `🔇 L'utente è stato mutato con successo.` }, { quoted: m });
                return true;
            }

            case '!unmute': {
                if (!targetMention) return true;
                mutedUsers.delete(targetMention);
                await sock.sendMessage(chatJid, { text: `🔊 L'utente è stato rimosso dal blocco.` }, { quoted: m });
                return true;
            }

            case '!warn': {
                if (!targetMention) return true;
                const currentWarns = (warnings.get(targetMention) || 0) + 1;
                warnings.set(targetMention, currentWarns);

                if (currentWarns >= 3) {
                    warnings.set(targetMention, 0);
                    await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                    await sock.sendMessage(chatJid, { text: `🚫 Utente bannato dopo il terzo avvertimento.` }, { quoted: m });
                } else {
                    await sock.sendMessage(chatJid, { text: `⚠️ Avvertimento registrato (${currentWarns}/3).` }, { quoted: m });
                }
                return true;
            }

            case '!rimuovi':
            case '!kick': {
                if (!targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "remove");
                await sock.sendMessage(chatJid, { text: `👢 Utente espulso dal gruppo.` }, { quoted: m });
                return true;
            }

            case '!promuovi': {
                if (!targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "promote");
                await sock.sendMessage(chatJid, { text: `🎉 L'utente è stato nominato amministratore.` }, { quoted: m });
                return true;
            }

            case '!demuovi':
            case '!quickdemote': {
                if (!targetMention) return true;
                await sock.groupParticipantsUpdate(chatJid, [targetMention], "demote");
                await sock.sendMessage(chatJid, { text: `📉 Poteri rimossi all'utente.` }, { quoted: m });
                return true;
            }

            case '!tagall':
            case '!tutti': {
                groupSettings.waitingForTagAll.add(sender);
                await sock.sendMessage(chatJid, { text: "Cosa vorresti scrivere nell'avviso?" }, { quoted: m });
                return true;
            }

            case '!poll': {
                const pollContent = messageText.replace(/^!poll/i, '').trim();
                const parts = pollContent.split('|').map(p => p.trim());
                const question = parts[0];
                const options = parts.slice(1);
                if (question && options.length > 0) {
                    await sock.sendMessage(chatJid, { poll: { name: question, values: options } });
                }
                return true;
            }

            case '!setname': {
                groupSettings.waitingForSetName.add(sender);
                await sock.sendMessage(chatJid, { text: "Cosa vuoi che metto sul titolo del gruppo?" }, { quoted: m });
                return true;
            }

            case '!link': {
                const mode = args[1];
                groupSettings.linkFilter = (mode === 'on');
                await sock.sendMessage(chatJid, { text: `🛡️ Filtro link esterni ${mode}.` }, { quoted: m });
                return true;
            }
        }

    } catch (error) {
        console.error("Errore nell'esecuzione dei comandi:", error);
    }
    return false;
}
