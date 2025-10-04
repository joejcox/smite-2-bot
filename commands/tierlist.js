import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

const BASE_URL = 'https://smitebrain.com/tier-list';
const TIER_ORDER = ['S', 'A', 'B', 'C', 'D', 'F'];
const TIER_COLORS = { S: 0x8A2BE2, A: 0x00C49F, B: 0x2F9DE2, C: 0xF0AD4E, D: 0xFF6B6B, F: 0x9E9E9E };

export const data = new SlashCommandBuilder()
    .setName('tierlist')
    .setDescription('Smite 2 tier list')
    .addSubcommand(sc =>
        sc.setName('show')
            .setDescription('Show the Smite 2 tier list')
            .addStringOption(o =>
                o.setName('role')
                    .setDescription('Filter by role')
                    .addChoices(
                        { name: 'All', value: 'all' },
                        { name: 'Jungle', value: 'jungle' },
                        { name: 'Solo', value: 'solo' },
                        { name: 'Mid', value: 'mid' },
                        { name: 'Support', value: 'support' },
                        { name: 'Carry', value: 'carry' },
                    )
            )
            .addStringOption(o =>
                o.setName('tier')
                    .setDescription('Filter by tier')
                    .addChoices(
                        { name: 'S', value: 'S' },
                        { name: 'A', value: 'A' },
                        { name: 'B', value: 'B' },
                        { name: 'C', value: 'C' },
                        { name: 'D', value: 'D' },
                        { name: 'F', value: 'F' },
                    )
            )
    )
    .addSubcommand(sc =>
        sc.setName('help').setDescription('Show command usage')
    );

// ---------- helpers ----------
function chunkText(str, max = 4000) {
    const parts = [];
    let cur = '';
    for (const token of str.split(', ')) {
        const piece = cur ? `, ${token}` : token;
        if ((cur + piece).length > max) { parts.push(cur); cur = token; }
        else { cur += piece; }
    }
    if (cur) parts.push(cur);
    return parts;
}

function extractSvelteKitArray(html) {
    const startIdx = html.indexOf('resolve(1, () =>');
    if (startIdx === -1) return null;
    const firstBracket = html.indexOf('[', startIdx);
    if (firstBracket === -1) return null;
    const endToken = ']])';
    const endIdx = html.indexOf(endToken, firstBracket);
    if (endIdx === -1) return null;
    return html.slice(firstBracket, endIdx + endToken.length - 1);
}

function jsLiteralToJson(js) {
    let s = js;
    s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    s = s.replace(/(:\s*)\.(\d+)/g, '$10.$2');
    s = s.replace(/(\[\s*)\.(\d+)/g, '$10.$2');
    s = s.replace(/(,\s*)\.(\d+)/g, '$10.$2');
    return s;
}

// ---------- handler ----------
export async function execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'help') {
        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Tier List — Help')
                    .setColor(0x5865F2)
                    .setDescription(
                        [
                            '**Usage**',
                            '• `/tierlist show` — all roles, all tiers',
                            '• `/tierlist show role:jungle`',
                            '• `/tierlist show role:mid tier:A`',
                            '• `/tierlist show tier:S`',
                            '',
                            '**Roles:** all, jungle, solo, mid, support, carry',
                            '**Tiers:** S, A, B, C, D, F',
                        ].join('\n')
                    )
            ]
        });
        return;
    }

    // sub === 'show'
    await interaction.deferReply();

    try {
        const role = (interaction.options.getString('role') ?? 'all').toLowerCase();
        const tierFilter = (interaction.options.getString('tier') ?? '').toUpperCase();
        const url = role === 'all' ? BASE_URL : `${BASE_URL}?role=${encodeURIComponent(role)}`;

        const res = await fetch(url, { headers: { 'user-agent': 'smite2-bot/1.0' } });
        if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
        const html = await res.text();

        const jsArrayLiteral = extractSvelteKitArray(html);
        if (!jsArrayLiteral) {
            await interaction.editReply(`Couldn't find embedded data on the page.\n<${url}>`);
            return;
        }

        const jsonText = jsLiteralToJson(jsArrayLiteral);
        let root;
        try { root = JSON.parse(jsonText); }
        catch (e) {
            console.error('JSON parse failed:', e);
            await interaction.editReply('Found embedded data but failed to parse it.');
            return;
        }

        const items = Array.isArray(root) && Array.isArray(root[0]) ? root[0] : Array.isArray(root) ? root : [];
        if (!items.length) {
            await interaction.editReply('Embedded data was empty.');
            return;
        }

        // bucket by tier
        const tiers = new Map(TIER_ORDER.map(t => [t, []]));
        for (const it of items) {
            const name = it.god || it.name || it.godName || it.title;
            const t = String(it.tier ?? it.letter ?? it.rank ?? '').toUpperCase();
            if (name && TIER_ORDER.includes(t)) tiers.get(t).push(name);
        }
        for (const t of TIER_ORDER) {
            const unique = [...new Set(tiers.get(t))];
            unique.sort((a, b) => a.localeCompare(b));
            tiers.set(t, unique);
        }

        // optional tier filter
        const tiersToShow = TIER_ORDER.filter(t => !tierFilter || t === tierFilter);

        // build embeds (one per tier)
        const embeds = [];
        for (const t of tiersToShow) {
            const names = tiers.get(t);
            if (!names?.length) continue;

            const joined = names.join(', ');
            const chunks = chunkText(joined, 4000);

            chunks.forEach((desc, i) => {
                embeds.push(
                    new EmbedBuilder()
                        .setTitle(
                            `${t} Tier${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}`
                            + (role !== 'all' ? ` — ${role}` : '')
                        )
                        .setURL(url)
                        .setColor(TIER_COLORS[t] ?? 0x5865F2)
                        .setDescription(desc)
                        .setFooter({ text: 'Source: smitebrain.com/tier-list' })
                        .setTimestamp(new Date())
                );
            });
        }

        if (!embeds.length) {
            await interaction.editReply(
                tierFilter
                    ? `No entries for **${tierFilter}** tier${role !== 'all' ? ` in **${role}**` : ''}.`
                    : 'No {name,tier} items found in embedded data.'
            );
            return;
        }

        // send one embed per message to avoid 6k cap
        await interaction.editReply({ embeds: [embeds[0]] });
        for (let i = 1; i < embeds.length; i++) {
            await interaction.followUp({ embeds: [embeds[i]] });
        }
    } catch (err) {
        console.error(err);
        await interaction.editReply('Fetch/parse failed.');
    }
}
