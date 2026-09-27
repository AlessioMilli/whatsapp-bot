                await sock.sendMessage(chatJid, { 
                    text: "Al momento Alessio non è disponibile. Ti risponderà appena rientra nella chat." 
                }, { quoted: m });
                return; 
            }

            // Controllo Antispam / Cooldown
            if (global.cooldownEnabled && !m.key.fromMe) {
                const now = Date.now();
                const lastMessageTime = userCooldowns.get(sender) || 0;

                if (now - lastMessageTime < COOLDOWN_TIME) {
                    await sock.sendMessage(chatJid, { 
                        text: `⚠️ Piano con i messaggi! Attendi qualche secondo prima di scrivere di nuovo.` 
                    }, { quoted: m });
                    return; 
                }

                userCooldowns.set(sender, now);
            }

            // Esecuzione centralizzata tramite admin.js
            await adminExecute(sock, m, chatJid, messageText, sender, isGroup);
            
        } catch (err) {
            console.error('Errore durante la gestione del messaggio:', err);
        }
    });
}

startBot();
