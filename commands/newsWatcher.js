// newsWatcher.js
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { sortOldToNew } from '../helpers.js';

// const OFFICIAL_INDEX = 'https://www.smite2.com/news/';
const LIVE_INDEX = 'https://smite2.live/news/';
const ALLOWED_HOSTS = new Set(['smite2.live']); // only post from this site

// Use a browsery UA so we don't get a minimal/blocked variant
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const STATE_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(STATE_DIR, 'last_news.json');

const normUrl = (u = '') => {
    try {
        const url = new URL(u);
        url.hash = '';
        if (!url.pathname.endsWith('/')) url.pathname += '/';
        url.hostname = url.hostname.toLowerCase();
        return url.toString();
    } catch { return u; }
};

const decodeEntities = (s = '') =>
    s.replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

const stripTags = (s = '') => decodeEntities(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

// ---------- state ----------
async function ensureStateFile() {
    await mkdir(STATE_DIR, { recursive: true });
    try { await access(STATE_FILE); }
    catch { await writeFile(STATE_FILE, JSON.stringify({ posted: [], lastCheckedAt: 0 }, null, 2)); }
}
async function readState() {
    await ensureStateFile();
    try {
        const json = JSON.parse(await readFile(STATE_FILE, 'utf8'));
        json.posted = Array.isArray(json.posted) ? json.posted : [];
        return json;
    } catch {
        return { posted: [], lastCheckedAt: 0 };
    }
}
async function writeState(obj) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(obj, null, 2));
}
export async function setLastUrl(url) {
    const s = await readState();
    s.posted = Array.from(new Set([normUrl(url), ...s.posted]));
    await writeState(s);
}

// ---------- fetch helpers ----------
async function fetchText(url, { retries = 2 } = {}) {
    let err;
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url, {
                headers: {
                    'user-agent': UA,
                    'accept-language': 'en-GB,en;q=0.9',
                    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (e) {
            err = e;
            if (i < retries) {
                console.warn(`[newsWatcher] fetch ${url} failed: ${e?.message}; retrying… (${retries - i})`);
                await new Promise(r => setTimeout(r, 800));
            }
        }
    }
    throw err;
}

// ---------- parsers ----------
function parseJsonLdArticlesFromHtml(html, base) {
    const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    const items = [];

    for (const m of scripts) {
        const raw = m[1];
        try {
            const parsed = JSON.parse(raw);
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const node of arr) {
                const full = url ? new URL(url, base).toString() : '';
                const host = full ? new URL(full).hostname.toLowerCase() : '';
                if (!ALLOWED_HOSTS.has(host)) continue;   // ⬅️ filter here
                items.push({
                    url: normUrl(full),
                    title,
                    excerpt: desc,
                    image: img ? new URL(img, base).toString() : null,
                    timeISO: time || undefined,
                });
            }


        } catch {
            // ignore malformed JSON-LD
        }
    }

    // de-dupe
    const seen = new Set(); const out = [];
    for (const it of items) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        out.push(it);
    }
    return out;
}

// Fallback: from listing page, collect /news/<slug> links
function collectNewsLinksFromListing(html, base, allowedHost = 'smite2.live') {
    const links = new Set();
    const re = /<a[^>]+href=["']([^"']*\/news\/[^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
        try {
            const u = new URL(m[1], base);
            if (u.hostname.toLowerCase() !== allowedHost) continue; // 👈 host filter
            const path = u.pathname.endsWith('/') ? u.pathname : u.pathname + '/';
            if (/^\/news\/[^/]+\/$/.test(path)) links.add(u.toString());
        } catch { }
    }
    return [...links];
}

function safeImageUrl(u) {
    if (!u) return null;
    try {
        const url = new URL(u);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        const s = url.toString().trim();
        if (!s || s.length > 2000) return null; // Discord can be picky with very long URLs
        // Optional: basic “imagey” check (kept lenient since OG images can be extensionless)
        if (!/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(s)) return null;
        return s;
    } catch {
        return null;
    }
}


// Fetch each article page and read OG/meta
async function fetchArticleMeta(url) {
    const host = new URL(url).hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) return null;  // safety net

    const html = await fetchText(url);
    const pick = (re) => html.match(re)?.[1]?.trim();
    const og = {
        title: pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i),
        desc: pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i),
        img: pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i),
        time: pick(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i)
            || pick(/<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["'][^>]*>/i),
    };
    // fallback title from <title>
    if (!og.title) og.title = stripTags(pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || '');
    return {
        url: normUrl(url),
        title: og.title || 'Smite 2 News',
        excerpt: og.desc || '',
        image: og.img || undefined,
        timeISO: og.time || undefined,
    };
}

async function parseLiveIndex(html) {
    // 1) try JSON-LD first
    const viaJsonLd = parseJsonLdArticlesFromHtml(html, LIVE_INDEX);
    if (viaJsonLd.length) return viaJsonLd;

    // 2) fallback: collect links, then fetch OG/meta for top N (keep it small)
    const links = collectNewsLinksFromListing(html, LIVE_INDEX, 'smite2.live').slice(0, 12);
    const out = [];
    for (const u of links) {
        try {
            const meta = await fetchArticleMeta(u);
            if (meta) out.push(meta);      // ⬅️ ignore nulls
        } catch (e) {
            console.warn('[newsWatcher] article fetch failed:', u, e?.message || e);
        }
    }
    return out;
}

// ---------- embed ----------
function buildEmbed(item, source) {
    const e = new EmbedBuilder()
        .setTitle(item.title)
        .setURL(item.url)
        .setColor(source === 'official' ? 0x2F9DE2 : 0x00C49F)
        .setFooter({ text: 'smite2.live/news' });

    if (item.excerpt !== '') {
        e.setDescription(item.excerpt);
    }

    const img = safeImageUrl('https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2437170/header.jpg');
    if (img) e.setImage(img);
    // e.setThumbnail('https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2437170/header.jpg');
    if (item.timeISO) e.setTimestamp(new Date(item.timeISO));
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Read More').setStyle(ButtonStyle.Link).setURL(item.url)
    );
    return { embed: e, components: [row] };
}

// ---------- watcher ----------
export function startNewsWatcher(client, {
    channelId,
    intervalMs = 1 * 60 * 60 * 1000, // daily
    backfillMax = 10,
} = {}) {
    if (!channelId) {
        console.warn('newsWatcher: no PATCH_CHANNEL_ID provided; watcher disabled.');
        return;
    }
    // const OFFICIAL_ENABLED = '0';

    let timer = null;
    let running = false;

    const syncNow = async (boot = false) => {
        if (running) return;
        running = true;
        try {
            await ensureStateFile();
            const ch = await client.channels.fetch(channelId);
            if (!ch?.isTextBased()) {
                console.warn('[newsWatcher] target channel not text-based or not found');
                return;
            }

            // let official = [];
            // if (OFFICIAL_ENABLED) {
            //     try { official = parseOfficialIndex(await fetchText(OFFICIAL_INDEX)); }
            //     catch (e) { console.warn('[newsWatcher] official fetch failed:', e?.message || e); }
            // }

            let live = [];
            try { live = await parseLiveIndex(await fetchText(LIVE_INDEX)); }
            catch (e) { console.warn('[newsWatcher] live fetch failed:', e?.message || e); }

            function isAllowed(u) {
                try { return new URL(u).hostname.toLowerCase() === 'smite2.live'; }
                catch { return false; }
            }

            console.log(`[newsWatcher] found total ${live.length}`);
            const merged = live?.filter(x => isAllowed(x.url)).map(x => ({ ...x, _source: 'live' }));

            // de-dupe by URL, newest-first best-effort
            const seen = new Set(); const uniq = [];
            for (const it of merged) {
                if (seen.has(it.url)) continue;
                seen.add(it.url);
                uniq.push(it);
            }

            const state = await readState();
            const posted = new Set((state.posted || []).map(normUrl));

            // New items (limit to a small number on boot to avoid spam)
            let toPost = uniq.filter(it => !posted.has(normUrl(it.url)));

            if (boot) {
                // backfill a batch: post oldest → newest so newest ends up last
                toPost = sortOldToNew(toPost).slice(-backfillMax);
            } else {
                // even on regular ticks, if multiple new ones appeared, keep them in order
                toPost = sortOldToNew(toPost);
            }

            console.log(`[newsWatcher] unseen toPost: ${toPost.length}`);

            for (const item of toPost) {
                try {

                    const { embed, components } = buildEmbed(item, item._source);
                    await ch.send({ embeds: [embed], components });
                    posted.add(normUrl(item.url));
                    console.log('[newsWatcher] posted:', item.url);
                } catch (err) {
                    const msg = String(err?.message || err);
                    if (/embeds\[0\]\.image\.url/i.test(msg) || /Invalid Form Body/i.test(msg)) {
                        // retry without the image
                        try {
                            const { embed, components } = buildEmbed({ ...item, image: null }, item._source);
                            await ch.send({ embeds: [embed], components });
                            posted.add(normUrl(item.url));
                            console.log('[newsWatcher] posted (no image):', item.url);
                        } catch (err2) {
                            console.warn('[newsWatcher] failed to post even without image:', item.url, err2?.message || err2);
                        }
                    } else {
                        console.warn('[newsWatcher] failed to post:', item.url, msg);
                    }
                }

            }

            state.posted = Array.from(posted);
            state.lastCheckedAt = Date.now();
            await writeState(state);
        } catch (e) {
            console.warn('[newsWatcher] sync failed:', e?.message || e);
        } finally {
            running = false;
        }
    };

    console.log(`newsWatcher: polling ${LIVE_INDEX} every ${Math.round(intervalMs / 60000)}m (boot backfill ${backfillMax}) -> ${channelId}`);

    // run once now (backfill)
    syncNow(true);
    // then on interval
    timer = setInterval(() => syncNow(false), intervalMs);
    return () => clearInterval(timer);
}
