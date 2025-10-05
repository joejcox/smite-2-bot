// commands/stats.js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import path from 'node:path';


// Lazy guard so we only load once
let diskLoaded = false;

const PERSIST_DIR = path.join(process.cwd(), 'data');
const PERSIST_FILE = path.join(PERSIST_DIR, 'tier_cache.json');

const TIER_URL = 'https://smitebrain.com/tier-list';
const GOD_BASE = 'https://smitebrain.com/gods';
const TIER_COLORS = { S: 0x8A2BE2, A: 0x00C49F, B: 0x2F9DE2, C: 0xF0AD4E, D: 0xFF6B6B, F: 0x9E9E9E };
const ROLES = ['all', 'jungle', 'solo', 'mid', 'support', 'carry'];

// ----- caching -----
const DATA_TTL_MS = 10 * 60 * 1000;   // 10 min for tier data
const ICON_TTL_MS = 30 * 60 * 1000;   // 30 min for thumbnails

// role -> { items: Array, expires: number }
const dataCache = new Map();
// role -> Promise<Array> (to dedupe in-flight fetches)
const dataInflight = new Map();

// slug -> { buf: Buffer, expires: number }
const iconCache = new Map();

function cachePrune(map) {
    const now = Date.now();
    for (const [k, v] of map) {
        if ((v?.expires ?? 0) <= now) map.delete(k);
    }
}

async function fetchWithTimeout(url, opts = {}, ms = 2500) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ac.signal }); }
    finally { clearTimeout(t); }
}

async function fetchTierItems(role = 'all') {
    cachePrune(dataCache);

    const now = Date.now();
    const cached = dataCache.get(role);
    if (cached && cached.expires > now) return cached.items;

    // de-dupe in-flight
    if (dataInflight.has(role)) return dataInflight.get(role);

    const url = role === 'all' ? TIER_URL : `${TIER_URL}?role=${encodeURIComponent(role)}`;
    const p = (async () => {
        const res = await fetchWithTimeout(url, { headers: { 'user-agent': 'smite2-bot/1.0' } }, 2500);
        if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
        const html = await res.text();

        if (/Just a moment/i.test(html) || /cf-browser-verification/i.test(html)) {
            throw new Error('Cloudflare challenge');
        }

        const arrLiteral = findEmbeddedArray(html);
        if (!arrLiteral) throw new Error('Embedded data block not found');

        let root;
        try {
            root = JSON.parse(jsLiteralToJson(arrLiteral));
        } catch (e) {
            throw new Error('Embedded data parse failed');
        }

        const items = Array.isArray(root) && Array.isArray(root[0]) ? root[0]
            : Array.isArray(root) ? root
                : [];

        dataCache.set(role, { items, expires: now + DATA_TTL_MS });
        return items;
    })();

    dataInflight.set(role, p);
    try {
        return await p;
    } finally {
        dataInflight.delete(role);
    }
}

// ----- tiny cache for god names per role -----
const nameCache = new Map(); // role -> { names: string[], expires: number }
const TTL_MS = 15 * 60 * 1000;


async function loadDiskCache() {
    if (diskLoaded) return;
    try {
        const raw = await readFile(PERSIST_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.roles && typeof parsed.roles === 'object') {
            const now = Date.now();
            for (const r of ROLES) {
                const names = Array.isArray(parsed.roles[r]) ? parsed.roles[r] : [];
                if (names.length) {
                    nameCache.set(r, { names, expires: now + TTL_MS }); // set a TTL so memory stays fresh
                }
            }
        }
    } catch (_) {
        // no file yet, ignore
    } finally {
        diskLoaded = true;
    }
}

async function saveDiskCache() {
    await mkdir(PERSIST_DIR, { recursive: true });
    const out = {
        updatedAt: Date.now(),
        roles: {},
    };
    for (const r of ROLES) {
        const entry = nameCache.get(r);
        out.roles[r] = entry?.names ?? [];
    }
    await writeFile(PERSIST_FILE, JSON.stringify(out, null, 2));
}

// Warm a single role (fetch, fill in-memory caches, persist afterward)
async function warmRole(role = 'all') {
    const items = await fetchTierItems(role);
    const names = [...new Set(items.map(it => it.god).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    nameCache.set(role, { names, expires: Date.now() + TTL_MS });
}

// Called once on startup
export async function prewarmCache() {
    await loadDiskCache(); // seed from disk immediately
    // Warm in parallel to avoid long boot
    await Promise.all(ROLES.map(r => warmRole(r).catch(() => { })));
    await saveDiskCache();
}

// Schedule a periodic refresh (default weekly)
export function scheduleCacheRefresh(intervalMs = 7 * 24 * 60 * 60 * 1000) {
    setInterval(async () => {
        try {
            for (const r of ROLES) await warmRole(r);
            await saveDiskCache();
            // prune icon cache too (nice-to-have)
            cachePrune(iconCache);
        } catch (e) {
            console.warn('weekly cache refresh failed:', e?.message || e);
        }
    }, intervalMs).unref?.();
}

function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}
function pct(x, digits = 2) {
    return typeof x === 'number' ? (x * 100).toFixed(digits) + '%' : String(x ?? '—');
}

// ---------- robust SvelteKit data extraction ----------
function findEmbeddedArray(html) {
    const marker = 'resolve(1, () =>';
    const idx = html.indexOf(marker);
    if (idx === -1) return null;

    // find the first '[' after the arrow
    let i = html.indexOf('[', idx);
    if (i === -1) return null;

    // balanced bracket parse
    let depth = 0;
    let start = i;
    for (; i < html.length; i++) {
        const ch = html[i];
        if (ch === '[') depth++;
        else if (ch === ']') {
            depth--;
            if (depth === 0) {
                // slice inclusive of closing bracket
                return html.slice(start, i + 1);
            }
        }
    }
    return null;
}

// Convert JS-literal → JSON: quote keys, fix leading decimals, true/false/null OK
function jsLiteralToJson(js) {
    let s = js;

    // Quote simple object keys
    s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');

    // Add leading zero to decimals like :.123 or [, .123 or , .123
    s = s.replace(/(:\s*)\.(\d+)/g, '$10.$2');
    s = s.replace(/(\[\s*)\.(\d+)/g, '$10.$2');
    s = s.replace(/(,\s*)\.(\d+)/g, '$10.$2');

    return s;
}


async function getGodNames(role = 'all') {
    const items = await fetchTierItems(role);
    return [...new Set(items.map(it => it.god).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function fetchIconBuffer(slug) {
    cachePrune(iconCache);
    const now = Date.now();
    const hit = iconCache.get(slug);
    if (hit && hit.expires > now) return hit.buf;

    const iconUrl = `https://smitebrain.com/cdn-cgi/image/width=80,height=80,f=png,fit=cover/https://images.smitebrain.com/images/gods/icons/${slug}`;
    try {
        const r = await fetch(iconUrl, { headers: { 'user-agent': 'smite2-bot/1.0' } });
        if (!r.ok) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        iconCache.set(slug, { buf, expires: now + ICON_TTL_MS });
        return buf;
    } catch {
        return null;
    }
}

export const data = new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show Smite 2 stats for a god (tier, win%, pick%, matches)')
    .addStringOption(o =>
        o.setName('god')
            .setDescription('God name, e.g. "Agni"')
            .setRequired(true)
            .setAutocomplete(true) // 👈 enable autocomplete
    )
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
    );

// 🔎 autocomplete handler
export async function autocomplete(interaction) {
    try {
        const focused = interaction.options.getFocused(true); // { name: 'god' | 'role', value: '...' }
        if (focused.name !== 'god') return;

        // consider current role selection to narrow suggestions
        const role = (interaction.options.getString('role') ?? 'all').toLowerCase();
        const entry = nameCache.get(ROLES.includes(role) ? role : 'all');
        const names = entry?.names ?? [];

        const q = String(focused.value || '').toLowerCase();

        const starts = [];
        const contains = [];
        for (const n of names) {
            const ln = n.toLowerCase();
            if (!q || ln.startsWith(q)) starts.push(n);
            else if (ln.includes(q)) contains.push(n);
            if (starts.length >= 25) break;
        }

        const suggestions = (starts.length < 25 ? starts.concat(contains) : starts).slice(0, 25);

        // Single attempt to respond; then return
        await interaction.respond(suggestions.map(n => ({ name: n, value: n })));

        // Warm in background if cache is stale (don’t await)
        if (!entry || entry.expires <= Date.now()) {
            warmRole(ROLES.includes(role) ? role : 'all').then(saveDiskCache).catch(() => { });
        }
    } catch (e) {
        // Swallow “already acknowledged” & “unknown interaction” so logs stay clean
        if (e?.code !== 40060 && e?.code !== 10062) {
            console.warn('autocomplete respond err:', e);
        }
    }
}

// 🧾 main execute (unchanged from your working role-aware stats)
export async function execute(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('god', true);
    const role = (interaction.options.getString('role') ?? 'all').toLowerCase();

    try {
        const url = role === 'all' ? TIER_URL : `${TIER_URL}?role=${encodeURIComponent(role)}`;
        const res = await fetch(url, { headers: { 'user-agent': 'smite2-bot/1.0' } });
        if (!res.ok) {
            await interaction.editReply(`Upstream returned ${res.status} for <${url}>`);
            return;
        }
        const html = await res.text();

        if (/Just a moment/i.test(html) || /cf-browser-verification/i.test(html)) {
            await interaction.editReply('The site is challenging our request (Cloudflare). Try again in a moment.');
            return;
        }
        if (!html || html.length < 1000) {
            await interaction.editReply('Page response was unexpectedly small. Try again.');
            return;
        }

        const arrLiteral = findEmbeddedArray(html);
        if (!arrLiteral) {
            await interaction.editReply(`Couldn't find embedded data in <${url}>`);
            return;
        }

        // const js = extractSvelteKitArray(html);
        // if (!js) return interaction.editReply(`Couldn't find embedded data.\n<${url}>`);

        // const root = JSON.parse(jsLiteralToJson(js));
        let root;

        try {
            root = JSON.parse(jsLiteralToJson(arrLiteral));
        } catch (e) {
            console.error('parse error:', e);
            // tiny debug tail helps without dumping secrets
            const tail = arrLiteral.slice(0, 120) + '...';
            await interaction.editReply(`Found data but failed to parse it (first 120 chars): \`${tail}\``);
            return;
        }

        // const items = Array.isArray(root) && Array.isArray(root[0]) ? root[0] : Array.isArray(root) ? root : [];
        // if (!items.length) return interaction.editReply('Embedded data was empty.');

        let items;
        try {
            items = await fetchTierItems(ROLES.includes(role) ? role : 'all');
        } catch (e) {
            await interaction.editReply(`Fetch/parse failed: ${e.message || e}`);
            return;
        }

        const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
        const wanted = norm(query);
        let hit = items.find(it => norm(it.god) === wanted) || items.find(it => slugify(it.god) === slugify(query));


        if (!hit) {
            const names = await getGodNames(role);
            const suggestions = names.filter(n => norm(n).includes(wanted.split(' ')[0] || '')).slice(0, 10);
            await interaction.editReply(
                suggestions.length
                    ? `Couldn't find **${query}**${role !== 'all' ? ` in **${role}**` : ''}. Did you mean: ${suggestions.join(', ')}`
                    : `Couldn't find **${query}**${role !== 'all' ? ` in **${role}**` : ''}.`
            );
            return;
        }

        const name = hit.god;
        const tier = String(hit.tier ?? '').toUpperCase();
        const win = pct(hit.win_rate);
        const pick = pct(hit.pick_rate);
        const matches = hit.matches_played ?? hit.matches ?? '—';

        const slug = slugify(name);
        const page = `${GOD_BASE}/${slug}${role !== 'all' ? `?role=${encodeURIComponent(role)}` : ''}`;
        const buildsUrl = `${GOD_BASE}/${slug}/builds${role !== 'all' ? `?role=${encodeURIComponent(role)}` : ''}`;

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('View Builds')
                .setStyle(ButtonStyle.Link)
                .setURL(buildsUrl)
        );

        const thumbBuffer = await fetchIconBuffer(slug);

        // build embed as before...
        const embed = new EmbedBuilder()
            .setTitle(`${name} — ${role === 'all' ? 'All Roles' : role}`)
            .setURL(page)
            .setColor(TIER_COLORS[tier] ?? 0x5865F2)
            .addFields(
                { name: 'Tier', value: tier || '—', inline: true },
                { name: 'Win Rate', value: String(win), inline: true },
                { name: 'Pick Rate', value: String(pick), inline: true },
                { name: 'Matches', value: String(matches), inline: true },
            )
            .setFooter({ text: 'Source: smitebrain.com/tier-list' })
            .setTimestamp(new Date());

        if (thumbBuffer) {
            await interaction.editReply({
                embeds: [embed.setThumbnail(`attachment://${slug}.png`)],
                files: [{ attachment: thumbBuffer, name: `${slug}.png` }],
                components: [row],
            });
        } else {
            embed.setThumbnail(`https://smitebrain.com/cdn-cgi/image/width=80,height=80,f=png,fit=cover/https://images.smitebrain.com/images/gods/icons/${slug}.png`);
            await interaction.editReply({ embeds: [embed], components: [row] });
        }

    } catch (err) {
        console.error(err);
        await interaction.editReply('Fetch/parse failed.');
    }
}
