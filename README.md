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
# In the backend directory, create .env from the example
cp .env.example backend/.env
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

For local development, no frontend `.env.local` is needed — `next.config.js` defaults to `ws://localhost:3001/ws`.

For production, create `frontend/.env.local`:

```env
NEXT_PUBLIC_BACKEND_WS_URL=wss://your-backend.railway.app/ws
NEXT_PUBLIC_BACKEND_HTTP_URL=https://your-backend.railway.app
```

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

1. Open **http://SERVER_IP:3000/broadcast**
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
> `http://localhost:3000/broadcast` and `http://localhost:3000/listen` in two
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

## Deployment

### Backend → Railway

1. Create a new project at https://railway.app
2. Connect your GitHub repo and select the `backend/` directory
3. Set environment variables in Railway dashboard:
   - `ANTHROPIC_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `ELEVENLABS_VOICE_ID`
   - `PORT=3001`
   - `FRONTEND_URL=https://your-vercel-app.vercel.app`
4. Railway auto-deploys on push

### Frontend → Vercel

1. Import your repo at https://vercel.com/new
2. Set **Root Directory** to `frontend`
3. Set environment variables:
   - `NEXT_PUBLIC_BACKEND_WS_URL=wss://your-backend.railway.app/ws`
   - `NEXT_PUBLIC_BACKEND_HTTP_URL=https://your-backend.railway.app`
4. Deploy

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
│   │   ├── broadcast/page.tsx # Broadcaster UI (/broadcast)
│   │   └── listen/page.tsx   # Listener UI (/listen)
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
