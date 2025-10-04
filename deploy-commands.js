import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

for (const file of await readdir(commandsPath)) {
    if (!file.endsWith('.js')) continue;
    const mod = await import(path.join(commandsPath, file));
    if (mod.data) commands.push(mod.data.toJSON());
}

const rest = new (await import('discord.js')).REST({ version: '10' })
    .setToken(process.env.BOT_TOKEN);

await rest.put(
    Routes.applicationGuildCommands(process.env.APP_ID, process.env.GUILD_ID),
    { body: commands }
);

console.log('✅ Guild commands deployed:', commands.map(c => c.name));
