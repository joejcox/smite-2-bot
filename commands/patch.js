// commands/patch.js
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('patch')
    .setDescription('Admin tools for the patch-notes channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s =>
        s.setName('purge')
            .setDescription('Delete my recent patch-note posts')
            .addIntegerOption(o => o.setName('limit').setDescription('Max messages to search (default 200)').setMinValue(1))
            .addStringOption(o => o.setName('domain').setDescription('Only delete if embed URL contains this (e.g., smite2.live)'))
    );

export async function execute(interaction) {
    if (interaction.options.getSubcommand() !== 'purge') return;
    await interaction.deferReply({ ephemeral: true });

    const channelId = process.env.PATCH_CHANNEL_ID;
    const limit = interaction.options.getInteger('limit') ?? 200;
    const domain = interaction.options.getString('domain')?.toLowerCase();

    const ch = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased()) return interaction.editReply('Patch channel not found.');

    let lastId, scanned = 0, deleted = 0;
    while (scanned < limit) {
        const batch = await ch.messages.fetch({ limit: Math.min(100, limit - scanned), before: lastId }).catch(() => null);
        if (!batch?.size) break;

        for (const msg of batch.values()) {
            scanned++;
            if (msg.author.id !== interaction.client.user.id) continue;
            const url = msg.embeds?.[0]?.url || '';
            if (domain && !url.toLowerCase().includes(domain)) continue;
            await msg.delete().catch(() => { });
            deleted++;
        }
        lastId = batch.last()?.id;
        if (!lastId) break;
    }
    await interaction.editReply(`Deleted ${deleted} message(s) I posted${domain ? ` from ${domain}` : ''}.`);
}
