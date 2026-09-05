import fs from 'fs';
import path from 'path';

const filePath = path.resolve('commands/cyber_module/bestemmiometro_data.json');

// Carica i dati dal file JSON (o crea la struttura se non esiste)
function loadData() {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {
        console.log("Errore lettura dati bestemmiometro:", e);
    }
    return { enabledGroups: [], stats: {} };
}

// Salva i dati nel file JSON
function saveData(data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.log("Errore salvataggio dati bestemmiometro:", e);
    }
}

// Lista di parole chiave o bestemmie da monitorare (personalizzabile)
const badWords = [
    "dio cane", "madonna maiala", "porco dio", "porca madonna", 
    "dio porco", "madonna cane", "cristo infame", "gesù cristo"
];

// Funzione richiamata a ogni messaggio in background
export async function handleMessage(sock, m) {
    const chatJid = m.key.remoteJid;
    if (!chatJid || !chatJid.endsWith('@g.us')) return;

    const data = loadData();
    if (!data.enabledGroups.includes(chatJid)) return;

    const messageText = (m.message.conversation || m.message.extendedTextMessage?.text || '').toLowerCase();
    if (!messageText) return;

    const sender = m.key.participant || m.key.remoteJid;

    // Controlla se il messaggio contiene una parola vietata
    let found = false;
    for (const word of badWords) {
        if (messageText.includes(word)) {
            found = true;
            break;
        }
    }

    if (found) {
        if (!data.stats[chatJid]) data.stats[chatJid] = {};
        if (!data.stats[chatJid][sender]) data.stats[chatJid][sender] = 0;

        data.stats[chatJid][sender] += 1;
        saveData(data);

        const count = data.stats[chatJid][sender];
        await sock.sendMessage(chatJid, { 
            text: `⚠️ @${sender.split('@')[0]} beccato! Questo è il tuo bestemmiometro personale: ${count} infraction${count > 1 ? 's' : 'e'}.`, 
            mentions: [sender] 
        });
    }
}

// Gestione del comando !bestemmiometro on / off / stats
export async function execute(sock, m, args) {
    const chatJid = m.key.remoteJid;
    if (!chatJid || !chatJid.endsWith('@g.us')) {
        await sock.sendMessage(chatJid, { text: "⚠️ Questo comando può essere usato solo nei gruppi!" });
        return;
    }

    const action = args[0] ? args[0].toLowerCase() : '';
    const data = loadData();

    if (action === 'on') {
        if (!data.enabledGroups.includes(chatJid)) {
            data.enabledGroups.push(chatJid);
            saveData(data);
        }
        await sock.sendMessage(chatJid, { text: "✅ Bestemmiometro attivato con successo per questo gruppo!" });
    } else if (action === 'off') {
        data.enabledGroups = data.enabledGroups.filter(id => id !== chatJid);
        saveData(data);
        await sock.sendMessage(chatJid, { text: "❌ Bestemmiometro disattivato per questo gruppo." });
    } else if (action === 'stats' || action === 'classifica') {
        if (!data.stats[chatJid] || Object.keys(data.stats[chatJid]).length === 0) {
            await sock.sendMessage(chatJid, { text: "📊 Nessuna statistica registrata finora in questo gruppo." });
            return;
        }

        let text = "🏆 *Classifica Bestemmiometro* 🏆\n\n";
        const sorted = Object.entries(data.stats[chatJid]).sort((a, b) => b[1] - a[1]);

        let mentions = [];
        for (let [user, count] of sorted) {
            text += `• @${user.split('@')[0]}: ${count} bestemmie\n`;
            mentions.push(user);
        }

        await sock.sendMessage(chatJid, { text, mentions });
    } else {
        await sock.sendMessage(chatJid, { text: "ℹ️ Uso corretto del comando:\n• `!bestemmiometro on`\n• `!bestemmiometro off`\n• `!bestemmiometro stats`" });
    }
}