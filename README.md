# Smite 2 Discord Bot

A lightweight Discord bot that pulls live **tier lists** and **god stats** from smitebrain.com and posts **Smite 2 patch notes** to a dedicated channel. Built with `discord.js` and designed to run locally or on Fly.io.

## Features

- **/tierlist** — Show the Smite 2 tier list as a color-coded embed  
  - Filters:
    - `role`: `all` | `jungle` | `solo` | `mid` | `support` | `carry`
    - `tier`: `S` | `A` | `B` | `C` | `D` | `F` (optional “just this tier”)
  - Output is grouped by tier with per-tier colors.

- **/stats <god> [role]** — Show a god’s **tier**, **win rate**, **pick rate**, and **matches**  
  - Autocomplete for `god` (resolves names using the tier list data)
  - Optional `role` filter (same roles as above)
  - Embed includes a thumbnail icon and “View Builds” button to the god’s builds page.

- **Patch Notes Watcher** — Automatically posts new patch notes in a separate channel  
  - Sources: `smite2.live/news` (with robust fallbacks)
  - Daily poll by default (configurable)
  - Backfills the latest few posts on first run (no duplicates)
  - Persists posted URLs in a local `data/last_news.json` file (or a Fly.io volume)

- **/patch** — Manual “force a check now” command for patch notes (optional).

---

## Commands (slash)

- `/tierlist [role] [tier]`
- `/stats god:<name> [role]`
- `/patch` (optional admin utility)

> You must register your slash commands in your server (guild) before first use. If you already have a deploy script, run it; otherwise register via the Discord Developer Portal or a simple REST deploy script.

---

## Environment Variables

Create a `.env` file (never commit this):

```env
BOT_TOKEN=your_discord_bot_token
APP_ID=your_application_id
GUILD_ID=your_guild_id
PATCH_CHANNEL_ID=channel_id_for_patch_notes
PORT=8080
```

- `PATCH_CHANNEL_ID` is the text channel where patch notes should be posted.
- `PORT` is used for a tiny health server (useful for Fly.io health checks).

Make sure `.env` and `data/` are in `.gitignore`.

---

## Local Development

```bash
# install
npm install

# run the bot
node index.js
```

You should see logs like:
```
health server on :8080
🤖 Logged in as Smite 2 Bot#1234
Loaded commands: [ 'patch', 'ping', 'stats', 'tierlist' ]
newsWatcher: polling https://smite2.live/news/ every 1440m (boot backfill 10) -> <channel_id>
```

### Notes
- The bot uses a browsery User-Agent and retries to avoid basic blocks.
- Icon thumbnails are fetched and attached; if that fails, it falls back to a URL.
- The news watcher writes state to `data/last_news.json` to avoid duplicates.

---

## Deployment (Fly.io)

1. **Secrets**
   ```bash
   fly secrets set      BOT_TOKEN=...      APP_ID=...      GUILD_ID=...      PATCH_CHANNEL_ID=...
   ```

2. **(Optional) Persistent volume for news history**
   ```bash
   fly volumes create data --size 1 --region lhr
   ```
   Then mount it in your `fly.toml`:
   ```toml
   [[mounts]]
     source="data"
     destination="/app/data"
   ```

3. **Deploy**
   ```bash
   fly deploy
   ```

The included health server listens on `PORT` (default `8080`) and is already wired up for Fly health checks.

---

## Configuration

You can tweak the news watcher in `commands/newsWatcher.js`:

- `intervalMs`: how often to poll (default daily).
- `backfillMax`: how many recent posts to seed on first run.
- The embed style (title, description, image, button) is customizable in `buildEmbed`.

---

## Troubleshooting

- **No images or missing embeds?**  
  The source may lazy-load images or block bots. The watcher falls back to Open Graph meta from each article page. If a specific post breaks, you can override with your own image.

- **“Fetch/parse failed.” in chat**  
  This is usually a transient upstream block. Try again; the bot retries, and `/stats` also uses a small cache to be gentle on the site.

- **Patch notes posted in the wrong order**  
  Backfill posts are sent oldest → newest to keep chronological order in the channel.

- **Running locally AND in the cloud**  
  Discord only allows one active gateway session per bot token. Stop the local process when testing the hosted one (and vice versa) to avoid disconnects.

---

## Project Structure

```
.
├─ commands/
│  ├─ tierlist.js      # /tierlist with role+tier filters
│  ├─ stats.js         # /stats with autocomplete and role filter
│  ├─ newsWatcher.js   # patch notes polling + embeds
│  └─ patch.js         # /patch (manual trigger)
├─ data/               # (created at runtime) posted-news state
├─ index.js            # bot bootstrap + health server
├─ Dockerfile
├─ fly.toml
├─ .env                # (local only, not committed)
└─ .gitignore
```

---

## Security

- **Never** commit `.env` or tokens. If a token ever leaks, **rotate it** immediately in the Discord Developer Portal and update Fly.io secrets.
- Keep the repo private if it includes deployment config tied to your bot.

---

## License

MIT
