import 'dotenv/config';
import { Client, GatewayIntentBits, Events, Collection } from 'discord.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLastUrl, startNewsWatcher } from './commands/newsWatcher.js';

import http from 'node:http';
const PORT = process.env.PORT || 8080;
http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
}).listen(PORT, () => console.log(`health server on :${PORT}`));


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.commands = new Collection();

// Load all commands that export { data, execute }
const commandsPath = path.join(__dirname, 'commands');
for (const file of await readdir(commandsPath)) {
    if (!file.endsWith('.js')) continue;
    const mod = await import(path.join(commandsPath, file));
    if (!mod.data || !mod.execute) continue;
    client.commands.set(mod.data.name, mod);
}

client.once(Events.ClientReady, async (c) => {
    console.log(`🤖 Logged in as ${c.user.tag}`);
    console.log('Loaded commands:', [...client.commands.keys()]);

    const patchChannelId = process.env.PATCH_CHANNEL_ID;
    if (!patchChannelId) {
        console.log('PATCH_CHANNEL_ID not set; news watcher disabled');
        return;
    }

    // Seed last posted URL from channel history (best-effort)
    try {
        const ch = await client.channels.fetch(patchChannelId);
        if (ch?.isTextBased()) {
            const msgs = await ch.messages.fetch({ limit: 50 });
            const mine = msgs.find(m => m.author.id === client.user.id && m.embeds?.[0]?.url);
            if (mine?.embeds?.[0]?.url) {
                await setLastUrl(mine.embeds[0].url);
                console.log('[newsWatcher] seeded lastUrl from channel history');
            }
        }
    } catch (_) { }

    startNewsWatcher(client, {
        channelId: patchChannelId,
        intervalMs: 24 * 60 * 60 * 1000, // daily
        backfillDays: 90,
        backfillMax: 0,
    });
});



client.on(Events.InteractionCreate, async (interaction) => {
    try {
        // handle autocomplete first
        if (interaction.isAutocomplete()) {
            const cmd = client.commands.get(interaction.commandName);
            if (cmd?.autocomplete) await cmd.autocomplete(interaction);
            return;
        }

        // then handle slash commands
        if (!interaction.isChatInputCommand()) return;

        const cmd = client.commands.get(interaction.commandName);
        if (!cmd) {
            await interaction.reply({ content: 'Command not found.', ephemeral: true });
            return;
        }

        await cmd.execute(interaction);
    } catch (err) {
        console.error(err);
        if (interaction.isAutocomplete()) {
            try { await interaction.respond([]); } catch { }
            return;
        }
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply('There was an error executing that action.');
        } else {
            await interaction.reply({ content: 'There was an error executing that action.', ephemeral: true });
        }
    }
});


client.login(process.env.BOT_TOKEN);
