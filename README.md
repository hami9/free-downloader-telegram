# Free Downloader Telegram Bot

A high-concurrency, serverless Telegram media downloader bot supporting **YouTube**, **Instagram**, **TikTok**, **X (Twitter)**, and **Pinterest** — built primarily for **Telegram Cloud (`tgcloud` V8 isolate + SQLite)** with zero external FFmpeg binaries required at runtime, alongside a legacy Docker/Python worker option.

---

## Key Features

### Multi-Platform Extraction & Lossless Media
- **YouTube (`tgcloud/lib/extractors/youtube.js`)**
  - Native InnerTube extraction with quality selector (`1080p`, `720p`, `480p`, `360p`, and `.m4a` Audio).
  - Pure-JS progressive MP4 & fMP4 muxing (`tgcloud/lib/mp4.js`) and **GOP-aligned automatic part splitting** (`< 44 MB` parts) for long/large videos, plus direct AAC audio track extraction from long videos.
- **Instagram (`tgcloud/lib/extractors/instagram.js`)**
  - Supports Reels, Posts, TV, and multi-slide Carousels.
  - Multi-tier extraction waterfall: `FB_UA` / `BOT_UA` `/embed/captioned/` & GraphQL -> `eeinstagram` (with automatic unwrapping of `?audio=1` photo slides to raw uncompressed CDN JPEGs) -> pure-JS `SnapSave` decoder -> `vxinstagram` fallback -> optional authenticated 19+ session fallback (`/igcookie`) for `MIN_AGE_ACCOUNT` / region-restricted posts.
  - Separates photo+music posts so images are delivered crisp & lossless with optional **Original (Lossless)** document download and **Post Audio** extraction.
- **TikTok (`tgcloud/lib/extractors/tiktok.js`)**
  - Watermark-free HD video & photo slideshow extraction with separate `.mp3` audio button and 429 circuit breaker.
- **X / Twitter (`tgcloud/lib/extractors/twitter.js`)**
  - Multi-provider extraction (`FxTwitter`, `VxTwitter`, Syndication), concurrent MP4 variant probing, pure-JS HLS (`.m3u8`) to MP4 remuxing (`tgcloud/lib/hls.js`), and `:orig` photo resolution upgrades.
- **Pinterest (`tgcloud/lib/extractors/pinterest.js`)**
  - Pin-scoped extraction for 720p MP4 videos, HLS remuxing, and multi-slide / original-resolution images.

### High-Load & Burst Resilience (`tgcloud-project/`)
- **Indexed SQLite Caching & TTL Sweeps (`tgcloud/schema.js`)**: Unique composite indexes (`uq_cached_url_fmt`, `uq_active_chat_token`), 30-day media cache TTL, 6-hour callback ref TTL, 10-minute YouTube stream info cache, and automatic LRU trimming (`MAX_CACHE_ROWS = 25000`).
- **URL Canonicalization & Singleflight**: Strips tracking parameters and unifies mirror domains so duplicate concurrent requests coalesce into a single upstream fetch (`runWithSingleflight` + `hotMemo`).
- **Telegram Flood / 429 Protection**: `tgCall` tracks rate limits per chat and suppresses temporary `"Fetching..."` status chatter during rapid bursts (`shouldSendStatusMessage`).
- **Bounded Memory & Concurrency**: `mapWithConcurrency`, stream timeouts, and cumulative carousel buffer caps (`96 MB`) prevent V8 isolate OOMs.
- **Pure English UI**: Clean, minimal English messages and inline buttons across all handlers and callbacks.

---

## Repository Structure

```text
├── tgcloud-project/               # Primary production serverless bot (Telegram Cloud / V8 + SQLite)
│   ├── tgcloud/
│   │   ├── schema.js              # Drizzle SQLite tables & indexes (cached_media, active_downloads)
│   │   ├── handlers/
│   │   │   ├── message.js         # Commands, link routing, cache & singleflight dispatch
│   │   │   └── callback_query.js  # YouTube quality/parts, lossless originals, audio & cancel
│   │   └── lib/
│   │       ├── media.js           # Unified exports
│   │       ├── delivery.js        # Chunked upload, album batching, magic-byte photo guard
│   │       ├── http.js            # Bounded concurrency, range slicing, stream timeouts
│   │       ├── mp4.js             # Pure-JS fMP4 muxer, MOOV parser, GOP video/audio splitter
│   │       ├── hls.js             # Pure-JS HLS (.m3u8 / MPEG-TS) to MP4 remuxer
│   │       └── extractors/        # common.js, instagram.js, youtube.js, tiktok.js, twitter.js, pinterest.js
│   ├── docs/tgcloud-sdk.md        # Platform SDK reference
│   ├── AGENTS.md                  # Runtime constraints & workflow rules
│   ├── tgcloud.jsonc              # tgcloud project configuration
│   └── package.json
├── astier-publisher/              # Optional standalone daily media publisher utility (Telegram / IG Graph API)
├── app/                           # Legacy Python Telegram bot (Redis queue + yt-dlp + ffmpeg)
├── backend-cluster/               # Legacy cluster configs
├── serverless/                    # Legacy serverless experiments
├── docker-compose.yml & Dockerfile
└── .env.example
```

---

## Deploying the Production Bot (`tgcloud-project/`)

### Prerequisites
- Node.js 20+
- A Telegram bot token linked via `@tgcloud/cli`

### Setup & Deploy
```bash
cd tgcloud-project
npm install
npx tgcloud login
npx tgcloud migrate    # Apply SQLite schema & indexes (cached_media, active_downloads)
npx tgcloud push       # Deploy handlers & libs to Telegram Cloud
npx tgcloud webhook    # Verify webhook is in sync
```

### Bot Commands
| Command | Scope | Description |
|---|---|---|
| `/start`, `/help` | All chats | Show supported platforms and usage |
| `/fun`, `/funon`, `/funoff` | Groups & DMs | Toggle playful replies when replying directly to the bot |
| `/claimadmin <token>` | Private DM | One-time admin binding using the provisioned setup token |
| `/igcookie <sessionid_or_cookie>` | Admin DM | Configure an adult Instagram session cookie for `MIN_AGE_ACCOUNT` / restricted posts (`/igcookie status`, `/igcookie clear`) |

---

## Legacy Python / Docker Worker (`app/`)

If you prefer self-hosting with Docker + Redis + `yt-dlp` + `ffmpeg`:

```bash
cp .env.example .env
# Set BOT_TOKEN in .env
docker compose up -d --build
```
