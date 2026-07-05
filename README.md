# Shema — Live Korean Sermon → English Translation

Real-time pipeline: **Korean mic** → Deepgram STT → Claude translation → ElevenLabs TTS → **English audio on listener device**.

Target end-to-end latency: **2–5 seconds**.

---

## Architecture

```
Laptop A (Broadcaster)            Backend (Node.js)              Laptop B (Listener)
─────────────────────             ─────────────────              ───────────────────
Mic → PCM chunks
      │
      ▼ WebSocket (binary)
              ──────────►  Deepgram STT WebSocket
                           ↓ Korean transcript
                           KoreanChunker
                           ↓ semantic chunks
                           Claude API
                           ↓ { direct, sermon }
                           ElevenLabs TTS HTTP
                           ↓ MP3 audio
              ◄────────── WebSocket (base64 audio + text) ──►

Korean transcript ◄──────                          Audio queue → playback
Direct EN ◄──────                                  Sermon text display
Sermon EN ◄──────
Debug panel ◄────
```

---

## Quick Start — Local Development

### Prerequisites

- Node.js 18+
- npm 9+
- API keys for Anthropic, Deepgram (STT), and ElevenLabs (TTS)
- Two laptops on the **same Wi-Fi network**

### 1. Clone and install

```bash
git clone <repo-url>
cd shema

# Install backend dependencies
cd backend && npm install && cd ..

# Install frontend dependencies
cd frontend && npm install && cd ..
```

### 2. Configure API keys

```bash
# Create backend/.env from the example
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```env
ANTHROPIC_API_KEY=sk-ant-your-key-here
DEEPGRAM_API_KEY=your-deepgram-key-here
ELEVENLABS_API_KEY=your-elevenlabs-key-here
ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB   # or your preferred voice ID
PORT=3001
```

### 3. Configure frontend (optional for local dev)

For local development, no frontend `.env.local` is needed — backend URLs are
derived from the page's hostname (`ws://<host>:3001/ws`, see
`frontend/lib/backend-config.ts`), which also keeps the two-laptop LAN setup
working with zero config.

In production these come from `NEXT_PUBLIC_BACKEND_WS_URL` /
`NEXT_PUBLIC_BACKEND_HTTP_URL` (see `frontend/.env.example` and the
[Deploy](#deploy-tryshemaapp) section).

### 4. Run backend

```bash
cd backend
npm run dev
```

You should see:
```
🎙️  Shema backend running on port 3001
   WebSocket: ws://localhost:3001/ws?role=broadcaster|listener
   Health:    http://localhost:3001/health
```

### 5. Run frontend

In a separate terminal:

```bash
cd frontend
npm run dev
```

Open **http://localhost:3000** in your browser.

### 6. Run the two-laptop setup

The **server laptop** runs the backend + frontend and also plays the English
audio (Listener). The **broadcaster laptop** only needs a browser — it captures
the Korean mic. Both laptops must be on the **same Wi-Fi network**.

First, find the server laptop's local IP:

```bash
# macOS
ipconfig getifaddr en0     # e.g. 192.168.1.242
# Linux
hostname -I | awk '{print $1}'
```

Substitute that address for `SERVER_IP` below.

---

#### 💻 Server laptop (Listener — hears the English)

**Terminal 1 — backend:**
```bash
cd backend
npm run dev
# → 🎙️  Shema backend running on port 3001
```

**Terminal 2 — frontend:**
```bash
cd frontend
npm run dev
# → ready on http://localhost:3000
```

**Browser (this laptop):**
1. Open **http://localhost:3000/listen**
2. Click **Enable Audio** (browsers block autoplay until you click)
3. Turn the volume up — English audio plays here

---

#### 🎤 Broadcaster laptop (mic — speaks Korean)

Browsers block microphone access on a plain-`http://` address unless it's
`localhost`. Since this laptop loads the page over the network, allow the mic
**once** in Chrome:

1. Open **`chrome://flags/#unsafely-treat-insecure-origin-as-secure`**
2. Add **`http://SERVER_IP:3000`** to the box, set to **Enabled**, click **Relaunch**

Then start broadcasting:

1. Open **http://SERVER_IP:3000/speak**
2. Click **Start Broadcast**
3. **Allow** microphone access when prompted
4. Speak Korean — transcripts + translations appear here, and English audio
   plays on the **server laptop** a few seconds later

---

#### ✅ Sanity checks

- **Backend reachable from broadcaster?** Visit `http://SERVER_IP:3001/health`
- **Nothing happens after speaking?** Check the backend terminal for errors
  (usually a missing/invalid API key)
- **No mic prompt?** Re-check the Chrome flag URL is exactly `http://SERVER_IP:3000`
  and that you relaunched
- **No sound?** Make sure you clicked **Enable Audio** on the Listener page

> Single-laptop test: run both roles on the server laptop using
> `http://localhost:3000/speak` and `http://localhost:3000/listen` in two
> tabs — `localhost` needs no Chrome flag.

---

## Translation Modes

| Mode | Latency | Quality |
|------|---------|---------|
| **Fast** | ~2–3 s | Flushes on any final STT segment; rougher at sentence edges |
| **Smooth** | ~3–5 s | Waits for natural pauses; cleaner sentences |

Toggle during a live broadcast — the change takes effect immediately.

---

## API Keys Setup

### Anthropic (Claude)

1. Go to https://console.anthropic.com/
2. Create an API key under **API Keys**
3. Paste into `ANTHROPIC_API_KEY` in `backend/.env`

Model used: `claude-3-5-haiku-20241022` (fastest, lowest cost).
Swap to `claude-3-5-sonnet-20241022` in `backend/src/translation.ts` for higher quality.

### Deepgram (STT)

1. Go to https://console.deepgram.com/
2. Create an API key → `DEEPGRAM_API_KEY`

### ElevenLabs (TTS)

1. Go to https://elevenlabs.io/app/settings/api-keys
2. Create an API key → `ELEVENLABS_API_KEY`
3. Pick a voice from https://elevenlabs.io/app/voice-library → copy the voice ID → `ELEVENLABS_VOICE_ID`

Recommended voices for sermon delivery:
- **Adam** (`pNInz6obpgDQGcFmaJgB`) — deep, authoritative
- **Daniel** (`onwK4e9ZLuTAKqWW03F9`) — clear, natural

---

## Deploy (tryshema.app)

One Next.js app (marketing + product) on **Vercel**, the WebSocket backend on
**Railway**, and **Cloudflare** as registrar/DNS + host of the small
contact-form Worker. Follow the steps in order; the app stays runnable locally
throughout (local dev needs none of these env vars).

```
tryshema.app                → DNS at Cloudflare (points at everything below)
  ├─ /                      → marketing bundle   ┐
  ├─ /speak /listen/[church] → product routes    ├─ ONE Next.js app on VERCEL
  ├─ /api/contact           → Next rewrite → contact Worker on CLOUDFLARE
  └─ api.tryshema.app       → Node WebSocket backend on RAILWAY (all API keys live here)
```

**Secrets rule:** API keys live ONLY on Railway. The frontend carries nothing
but public `NEXT_PUBLIC_*` URLs.

### 1. Push the repo to GitHub

Vercel and Railway both deploy straight from the GitHub repo — make sure the
branch you want live is pushed.

### 2. Backend → Railway

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo** →
   pick this repo (authorize GitHub access if asked).
2. Click the created service → **Settings** → **Source** → set
   **Root Directory** to `backend`. Railway then auto-detects Node and runs
   `npm install` → `npm run build` → `npm start` (already wired: `build`
   compiles to `dist/`, `start` runs `node dist/index.js`).
3. **Variables** tab → add:
   - `ANTHROPIC_API_KEY`
   - `DEEPGRAM_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `ELEVENLABS_VOICE_ID`
   - `FRONTEND_URL=https://tryshema.app,https://www.tryshema.app`
   - `BROADCAST_HOST_KEY=<a long random string>` — locks broadcasting (see
     [Host keys](#host-keys-broadcast-protection) below)
   - `NODE_ENV=production` (usually set automatically; setting it explicitly
     is what arms the CORS/WebSocket origin allowlist)
   - Do **NOT** set `PORT` — Railway injects its own and the server reads it.
4. **Settings** → **Networking** → **Generate Domain**. Note the
   `something.up.railway.app` URL and check `https://<it>/health` returns JSON.
5. Same Networking panel → **Custom Domain** → add `api.tryshema.app`.
   Railway shows you a CNAME target — you'll create that record in
   Cloudflare in step 4.

### 3. Frontend → Vercel

1. Go to https://vercel.com/new → **Import** this repo.
2. Set **Root Directory** to `frontend` (framework auto-detects as Next.js).
3. **Environment Variables** → add:
   - `NEXT_PUBLIC_BACKEND_WS_URL=wss://api.tryshema.app/ws`
   - `NEXT_PUBLIC_BACKEND_HTTP_URL=https://api.tryshema.app`
   - `CONTACT_WORKER_ORIGIN=<the contact Worker's own origin>` — its
     `https://….workers.dev` URL from step 4. ⚠️ This must be the Worker's OWN
     origin: **not** `https://tryshema.app` (that's Vercel itself — the
     rewrite would loop forever) and **not** `api.tryshema.app` (that's the
     Railway backend, which has no contact endpoint). If you don't have the
     Worker URL yet, deploy without it and add it after step 4 (then
     **Redeploy** — env vars only take effect on a fresh build).
4. **Deploy**. Check the generated `*.vercel.app` URL: `/` shows the marketing
   page, `/speak` and `/listen` load (they'll connect once DNS is live).
5. Project → **Settings** → **Domains** → add `tryshema.app` and
   `www.tryshema.app`. Vercel will display the exact DNS records it wants —
   keep that page open for step 4.

### 4. Cloudflare — contact Worker + DNS

**Deploy the contact-form Worker:**

The Worker deploys as-is to its own `*.workers.dev` origin — it claims no
custom domain (`tryshema.app` belongs to Vercel via DNS):

```bash
cd marketing-worker
npx wrangler deploy   # log in with your Cloudflare account when prompted
```

Note the printed `https://tryshema.<your-account>.workers.dev` URL → that is
`CONTACT_WORKER_ORIGIN` for Vercel (step 3.3; set it and redeploy).
Email delivery uses Cloudflare **Email Routing** on the `tryshema.app` zone —
it was already configured for the old site; verify the destination address is
still verified under Cloudflare → Email → Email Routing.

**DNS records** (Cloudflare dashboard → tryshema.app → DNS):

1. First remove any old records/Worker routes pointing `tryshema.app` at the
   old Cloudflare-hosted site.
2. Add what Vercel's Domains page told you — typically:
   - `A` record, name `@` (tryshema.app) → Vercel's IP (e.g. `76.76.21.21`)
   - `CNAME`, name `www` → `cname.vercel-dns.com`
3. Add the backend record from Railway (step 2.5):
   - `CNAME`, name `api` → the target Railway displayed
4. Set ALL THREE records to **DNS only** (click the orange cloud so it turns
   **grey**). Cloudflare's proxy must stay out of the way: Vercel manages its
   own TLS, and proxied WebSocket connections to Railway add an unnecessary
   failure point.

### 5. Verify

- `https://tryshema.app` → marketing page; `https://api.tryshema.app/health` → JSON
- `https://tryshema.app/listen/<church>` on a phone on **cellular** (not your
  Wi-Fi) — it should connect and, during a broadcast from `/speak` in the same
  church, play audio
- Contact form on the marketing page sends (check shematranslate@gmail.com)
- DNS propagation can take minutes to a few hours — `dig tryshema.app` /
  `dig api.tryshema.app` to watch it flip

---

## Host keys (broadcast protection)

Phase A auth: starting a broadcast requires a **host key**; listening never
does. No accounts, no database — keys live in backend env vars:

```env
# One shared key for every room (simplest for the pilot):
BROADCAST_HOST_KEY=pick-a-long-random-string

# Or per-room keys (win over the shared key for the rooms they name):
ROOM_HOST_KEYS=grace-church:abc123,hanmaeum:xyz789
```

- With **neither** set (typical local dev), rooms are open and /speak works
  with the Host key field left blank.
- With a key set, the staff member enters it in the **Host key** field on
  `/speak` before hitting Start Broadcast. A wrong or missing key gets a clear
  error and the connection is closed. The browser remembers the key for the
  current tab session only (sessionStorage) — it is never persisted.
- To rotate a key: change the env var and restart/redeploy the backend
  (Railway → Variables → edit → redeploy).
- Generate a decent key: `openssl rand -hex 16`

Real accounts + billing (Phase B) replace this once a second church signs on.

---

## Operator runbook (Sunday morning)

Three URLs run the whole service. `<church>` is your church's slug
(e.g. `grace-church`) — same one everywhere.

### 1. Staff — start the broadcast

1. On the staff laptop, open **https://tryshema.app/speak**
2. **Church**: enter your slug · **Host key**: enter your church's key
   (kept for this tab until you close it) · **Input**: pick the soundboard /
   USB interface (falls back to the laptop mic — works, but line feed sounds
   far better)
3. Click **Start Broadcast** when the preacher begins
4. Confirm within ~15 seconds: the **STT Active** pill is green and Korean
   text is scrolling. If both are true, you're live — leave the tab open and
   don't close the laptop lid.

### 2. Congregation — share the listen link

- The share card on /speak shows a **QR code + link** for
  `https://tryshema.app/listen/<church>` — put the QR in the bulletin, on a
  slide, or on a sign by the door. It's the same every week; print it once.
- Congregants: scan → **Tap to listen** (one tap, required by phone browsers)
  → English audio + captions. Earbuds recommended.
- No app install needed; "Add to Home Screen" works for regulars.

### 3. Receiver system — run the kiosk

For churches feeding translation into an existing transmitter/receiver system:

1. On the output laptop (plugged into the system via headphone/line-out),
   open **https://tryshema.app/play/<church>**
2. Click **▶ Start output** once
3. Click **Test tone** and confirm the beep comes out of the church receivers;
   set the on-screen volume to taste
4. Leave it. The screen stays awake and playback is continuous; the big pill
   shows Live / Waiting at a glance.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Phone: no sound | They skipped the tap — reload and press **Tap to listen**; check the phone's silent switch + volume |
| Phone: iPhone stops when locked | Known iOS limitation — keep the screen on, or use the kiosk + receivers |
| /speak: "Invalid host key" | Wrong or missing key — re-enter it (keys are per-church; rotate in Railway → Variables) |
| /speak: no Korean appearing | Wrong **Input** device — re-pick the board/interface; check the STT pill; make sure the board channel is unmuted |
| /speak: Korean appears, no English ever | Translation API issue — check Anthropic credits (console.anthropic.com → Plans & Billing) |
| Kiosk: test tone silent | Laptop output routed wrong — macOS System Settings → Sound → Output; then test tone again |
| Nothing connects at church | Check https://api.tryshema.app/health in a browser. If it loads but the app won't connect, church Wi-Fi may block WebSockets — hotspot the staff laptop or ask IT to allow wss to api.tryshema.app |
| Mid-service page weirdness | Reload the page — broadcast state recovers by itself; listeners auto-reconnect |

**Weekly pre-service check (2 min):** open /speak, start a 10-second test
broadcast in a test room (e.g. `<church>-test`), confirm English audio on your
phone, stop. Confirms keys, credits, and audio path in one go.

---

## Latency Breakdown

| Stage | Typical Duration | Notes |
|-------|-----------------|-------|
| Audio capture → backend | < 50 ms | 200ms chunks via WebSocket |
| ElevenLabs STT | 300–800 ms | WebSocket streaming, near real-time |
| Korean chunking | 200–500 ms | Waits for natural pause or max length |
| Claude translation | 400–900 ms | Haiku model, ~512 output tokens |
| ElevenLabs TTS | 600–1500 ms | Streaming HTTP, depends on text length |
| Audio delivery → listener | < 100 ms | WebSocket + browser decode |
| **Total** | **~2–5 s** | Varies with network and text length |

### How to reduce latency further

1. **Use Fast mode** — reduces chunking delay by ~1 second
2. **Shorter sentences** — speaking in shorter phrases helps STT flush faster
3. **Collocate backend** — run the backend in AWS/Railway region closest to you
4. **Use eleven_turbo_v2_5** — faster TTS model (change `modelId` in `tts.ts`)
5. **Reduce chunk interval** — lower `chunkIntervalMs` in `AudioCapture` (already 200ms)

---

## Connecting to Church Audio Hardware (Future)

Instead of the browser mic, you can feed the backend a direct audio line:

1. Use a USB audio interface (e.g., Focusrite Scarlett) connected to the church mixing board
2. Replace the browser `AudioCapture` with a Node.js audio input library (e.g., `node-audiorecord` or `sox`) that streams PCM to the backend STT module directly
3. The backend pipeline (`stt.ts` → `chunker.ts` → `translation.ts` → `tts.ts`) remains unchanged

This eliminates laptop-microphone background noise entirely.

---

## npm Scripts

```bash
# Backend
cd backend
npm run dev      # Development (ts-node-dev, hot reload)
npm run build    # Compile TypeScript → dist/
npm start        # Run compiled output
npm test         # Tier A: deterministic unit tests (no API key, no network)
npm run eval     # Tier B: scored translation evals (needs ANTHROPIC_API_KEY)
                 #   add -- --judge for LLM-graded faithfulness/fluency

# Frontend
cd frontend
npm run dev      # Next.js dev server on :3000
npm run build    # Production build
npm start        # Serve production build
```

---

## Project Structure

```
shema/
├── backend/
│   ├── src/
│   │   ├── index.ts          # Express + WebSocket server
│   │   ├── session.ts        # In-memory session state
│   │   ├── broadcaster.ts    # Broadcaster WS handler (audio in → pipeline)
│   │   ├── listener.ts       # Listener WS handler (audio/text out)
│   │   ├── stt.ts            # ElevenLabs STT WebSocket client
│   │   ├── translation.ts    # Claude translation (returns JSON)
│   │   ├── tts.ts            # ElevenLabs TTS (HTTP streaming → Buffer)
│   │   └── chunker.ts        # Korean text chunking logic
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   ├── page.tsx          # Landing page (/)
│   │   ├── speak/page.tsx    # Broadcaster UI (/speak) + QR share
│   │   ├── listen/page.tsx   # Church-code entry (/listen, /listen?church=)
│   │   ├── listen/[church]/  # Listener UI (/listen/<church>, the QR link)
│   │   └── play/[church]/    # Kiosk output (placeholder until Step 6)
│   ├── lib/
│   │   ├── ws-client.ts      # Typed WebSocket client
│   │   ├── audio-capture.ts  # Mic → PCM 16kHz chunks
│   │   └── audio-playback.ts # MP3 queue → Web Audio API
│   ├── next.config.js
│   ├── package.json
│   └── tsconfig.json
├── .env.example
└── README.md
```
