# Gorilla Tag 24/7 Catalog & Title Data Tracker Bot

A standalone Discord bot that tracks PlayFab Catalog changes, Title Data updates, and Upcoming Cosmetics 24/7 headlessly (no game client needed). Designed to run on a Raspberry Pi, VPS, or cloud host.

---

## Features

- **Multi-Channel Architecture**:
  1. 🆕 **New Items Channel** (`NEW_ITEMS_CHANNEL_ID`) — Alerts whenever new cosmetics or bundles are added.
  2. 💰 **Price & Content Changes Channel** (`PRICE_CHANGES_CHANNEL_ID`) — Alerts for price edits, name changes, or bundle item alterations.
  3. 📦 **Catalog Channel** (`CATALOG_CHANNEL_ID`) — General catalog events & removed item alerts (or fallback if channels 1 & 2 are left blank).
  4. 📜 **Title Data Channel** (`TITLE_DATA_CHANNEL_ID`) — Alerts whenever Title Data keys are added, removed, or changed, with syntax-highlighted JSON codeblocks.
  5. 📋 **Live Upcoming Cosmetics List Channel** (`LIST_CHANNEL_ID`) — A dedicated channel where the bot posts and automatically **edits a single live message** listing all accumulated upcoming cosmetics with prefix categorizations (`LH`, `LB`, `LM`, `LP`, `LS`, `LF`, `LE`, etc.).
- **Commands**:
  - `/buy` (or `?buy`) — Purchases an item directly in Gorilla Tag using a PlayFab session ticket, item ID, and price (replies privately with ephemeral embeds).
  - `/clearlist` (or `?clearlist`) — Resets the upcoming cosmetics list and clears the live list message.
  - `/upcoming` (or `?upcoming`) — Dumps the entire upcoming cosmetics list in batches of 20.
  - `/status` (or `?status`) — Displays bot uptime, polling interval, last check time, and item counts.
  - `/reset` (or `?reset`) — Clears all baseline files and re-scans PlayFab.
- **Headless Steam + PlayFab Authentication**:
  - Authenticates headlessly with Steam using `steam-user`.
  - Generates auth tickets to log into Gorilla Tag's PlayFab title (`63FDD`).
  - Automatically handles session ticket renewal and Discord 429 rate limits.

---

## Commands Guide

### `/buy` (Purchase Item)
Parameters:
- `sessionticket` *(Required)*: Your PlayFab Session Ticket
- `itemid` *(Required)*: The cosmetic ItemId (e.g. `LBAAA.`)
- `price` *(Required)*: Price in Shiny Rocks (enter `0` for free items)
- `currency` *(Optional)*: Virtual currency code (default: `SR` for Shiny Rocks)

> **Security Note**: `/buy` replies ephemerally (only you can see the response) so your session ticket is never leaked.

---

## Setup Instructions

### 1. Configure `.env`

Edit `.env` in the bot root directory:

```env
# Discord Bot Token
DISCORD_TOKEN=your_bot_token_here

# Channel IDs:
NEW_ITEMS_CHANNEL_ID=
PRICE_CHANGES_CHANNEL_ID=
CATALOG_CHANNEL_ID=your_catalog_channel_id
TITLE_DATA_CHANNEL_ID=your_titledata_channel_id
LIST_CHANNEL_ID=your_list_channel_id

# Steam Credentials
STEAM_USERNAME=your_steam_username
STEAM_PASSWORD=your_steam_password

# Gorilla Tag Steam AppID & PlayFab Title ID
STEAM_APPID=1533390
PLAYFAB_TITLE_ID=63FDD

# Polling Interval (in seconds or minutes)
POLL_INTERVAL_SECONDS=15
```

---

### 2. Running Locally

```cmd
npm start
```

---

### 3. Running 24/7 on a Raspberry Pi (PM2)

```bash
sudo npm install -g pm2
cd catalogtrackerbot
pm2 start src/index.js --name "catalog-tracker"
pm2 save
pm2 startup
```