import { GoogleGenAI } from "@google/genai";

export async function execute(sock, m, chatJid, messageText, sender, isGroup) {
    // Rimosso il blocco m.key.fromMe per permettere l'uso anche da parte tua (es. in chat privata)

    global.geminiApiKey = global.geminiApiKey || process.env.GEMINI_API_KEY;

    if (messageText.startsWith('!setgeminiak ')) {
        const key = messageText.slice(13).trim();
        if (key) {
            global.geminiApiKey = key;
            await sock.sendMessage(chatJid, { text: "✅ Chiave API di Google Gemini aggiornata con successo." }, { quoted: m });
        } else {
            await sock.sendMessage(chatJid, { text: "⚠️ Inserisci una chiave valida dopo il comando." }, { quoted: m });
        }
        return true;
    }

    if (messageText.startsWith('!web') || messageText.startsWith('!cerca')) {
        const query = messageText.replace(/^!(web|cerca)/i, '').trim();
        if (!query) {
            await sock.sendMessage(chatJid, { text: "Cosa desideri cercare sul web?" }, { quoted: m });
            return true;
        }
        try {
            const ai = new GoogleGenAI({ apiKey: global.geminiApiKey });
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: query,
            });
            await sock.sendMessage(chatJid, { text: `🌍 *Risultato Web*:\n${response.text}` }, { quoted: m });
        } catch (error) {
            await sock.sendMessage(chatJid, { text: "❌ Errore durante la richiesta all'API di Gemini." }, { quoted: m });
        }
        return true;
    }

    if (messageText.startsWith('!chiedialessio') || messageText.startsWith('!aiutoalessio')) {
        const query = messageText.replace(/^!(chiedialessio|aiutoalessio)/i, '').trim();
        if (!query) {
            await sock.sendMessage(chatJid, { text: "Ciao! Che tipo di funzione vorresti che Alessio aggiungesse al bot? Scrivi la tua idea iniziando con !chiedialessio o !aiutoalessio seguito dalla proposta." }, { quoted: m });
            return true;
        }

        try {
            const ai = new GoogleGenAI({ apiKey: global.geminiApiKey });
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `Agisci come l'assistente ufficiale di Alessio. Rispondi a questa richiesta di supporto o suggerimento in modo utile e amichevole: ${query}`,
            });
            await sock.sendMessage(chatJid, { text: `🤖 *Assistente IA (Alessio)*:\n${response.text}` }, { quoted: m });
        } catch (error) {
            await sock.sendMessage(chatJid, { text: `🤖 *Assistente IA (Alessio)*:\nHo ricevuto la tua richiesta: "${query}".` }, { quoted: m });
        }

        // Invia la notifica ad Alessio SOLO se il messaggio è stato mandato da un utente esterno
        if (!m.key.fromMe) {
            const tuoNumeroAdmin = '393534467571@s.whatsapp.net'; 
            const nomeUtente = m.pushName || sender.split('@')[0];
            const notificaTesto = `🚨 *Nuova richiesta funzione!*\n\n👤 Utente: ${nomeUtente} (${sender.split('@')[0]})\n💬 Proposta: "${query}"`;
            await sock.sendMessage(tuoNumeroAdmin, { text: notificaTesto });
        }

        return true;
    }

    return false;
}