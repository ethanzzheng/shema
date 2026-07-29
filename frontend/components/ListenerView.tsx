'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { WsClient, ServerMessage, AudioChunkMsg, TranslationMsg, TranscriptHistoryMsg } from '@/lib/ws-client';
import { AudioPlaybackQueue } from '@/lib/audio-playback';
import { AudioStreamPlayer, base64ToBytes } from '@/lib/audio-stream';
import { getBackendWsUrl } from '@/lib/backend-config';

type ConnState = 'disconnected' | 'connecting' | 'connected';
type TtsMode = 'elevenlabs' | 'browser' | 'off';

interface TranscriptEntry {
  seq: number;
  sermon: string;
  direct: string;
}

// ── Browser TTS helper ─────────────────────────────────────────────────────
class BrowserTTS {
  private queue: (string | { text: string; seq: number })[] = [];
  private speaking = false;

  speak(text: string): void {
    if (!('speechSynthesis' in window)) return;
    this.queue.push(text);
    this.drain();
  }

  /** Fires when an utterance actually starts speaking (the spoken seq). */
  onSeqStart: ((seq: number) => void) | null = null;

  speakSeq(text: string, seq: number): void {
    if (!('speechSynthesis' in window)) return;
    this.queue.push({ text, seq });
    this.drain();
  }

  private drain(): void {
    if (this.speaking || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    if (this.queue.length > 3) {
      this.queue = this.queue.slice(-1);
    }
    const text = typeof item === 'string' ? item : item.text;
    const seq = typeof item === 'string' ? null : item.seq;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'en-US';
    utter.rate = 1.25;
    utter.pitch = 1.0;
    if (seq !== null) {
      utter.onstart = () => this.onSeqStart?.(seq);
    }
    utter.onend = () => {
      this.speaking = false;
      this.drain();
    };
    utter.onerror = () => {
      this.speaking = false;
      this.drain();
    };
    this.speaking = true;
    window.speechSynthesis.speak(utter);
  }

  cancel(): void {
    this.queue = [];
    this.speaking = false;
    window.speechSynthesis?.cancel();
  }
}

// ── Component ──────────────────────────────────────────────────────────────
// The congregation listener for ONE church room. Routes decide the slug
// (/listen/[church] or /listen?church=) and render this.
export default function ListenerView({ church }: { church: string }) {
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [broadcastActive, setBroadcastActive] = useState(false);
  // Output language of the broadcast (from status messages); ko-en = English.
  const [direction, setDirection] = useState<'ko-en' | 'en-ko'>('ko-en');
  const [ttsMode, setTtsMode] = useState<TtsMode>('elevenlabs');
  // Captions default to the polished sermon rendering; "direct" is the more
  // literal pass for anyone who wants to track the Korean phrasing closely.
  const [captionMode, setCaptionMode] = useState<'sermon' | 'direct'>('sermon');
  // Caption size — accessibility for older members. Persisted per device.
  const [textSize, setTextSize] = useState<'s' | 'm' | 'l'>('m');
  // Pause = output muted; the stream keeps flowing so resuming stays near-live.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [audioStarted, setAudioStarted] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  // The seq whose AUDIO is playing right now — drives the highlight.
  // Translations arrive ahead of their audio; highlighting the latest
  // translation runs ahead of what the ear hears.
  const [spokenSeq, setSpokenSeq] = useState(0);

  const wsRef = useRef<WsClient | null>(null);
  const streamRef = useRef<AudioStreamPlayer | null>(null); // MSE progressive player (primary)
  const playbackRef = useRef<AudioPlaybackQueue | null>(null); // per-clip queue (fallback)
  const fallbackAccumRef = useRef<{ seq: number; parts: Uint8Array[] } | null>(null);
  const browserTtsRef = useRef<BrowserTTS | null>(null);
  const lastSpokenSeqRef = useRef(0);
  const handleMessageRef = useRef<(msg: ServerMessage) => void>(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const programmaticScrollRef = useRef(false);

  // Keep the SPOKEN line in view (unless the user scrolled away to read).
  useEffect(() => {
    if (!autoScrollRef.current || !scrollRef.current) return;
    const container = scrollRef.current;
    programmaticScrollRef.current = true;
    const el = spokenSeq > 0 ? container.querySelector(`[data-seq="${spokenSeq}"]`) : null;
    if (el) {
      (el as HTMLElement).scrollIntoView({ block: 'center' });
    } else {
      container.scrollTop = container.scrollHeight;
    }
    // scrollIntoView fires the scroll handler asynchronously
    setTimeout(() => { programmaticScrollRef.current = false; }, 50);
  }, [transcript, spokenSeq]);

  const handleScroll = () => {
    if (!scrollRef.current || programmaticScrollRef.current) return;
    const container = scrollRef.current;
    // Re-latch auto-scroll when the user brings the live line back into view
    // (or reaches the bottom); manual scrolling away releases it.
    const el = container.querySelector(`[data-seq="${spokenSeq}"]`) as HTMLElement | null;
    if (el) {
      const c = container.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      autoScrollRef.current = r.top < c.bottom && r.bottom > c.top;
    } else {
      const { scrollTop, scrollHeight, clientHeight } = container;
      autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 60;
    }
  };

  useEffect(() => {
    const saved = window.localStorage.getItem('shema-caption-size');
    if (saved === 's' || saved === 'm' || saved === 'l') setTextSize(saved);
  }, []);

  const changeTextSize = (size: 's' | 'm' | 'l') => {
    setTextSize(size);
    try { window.localStorage.setItem('shema-caption-size', size); } catch {}
  };

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    pausedRef.current = next;
    streamRef.current?.setVolume(next ? 0 : 1);
    playbackRef.current?.setVolume(next ? 0 : 1);
    if (next) browserTtsRef.current?.cancel();
  };
  const togglePauseRef = useRef<() => void>(() => {});
  togglePauseRef.current = togglePause;

  // ── Media Session: lock-screen metadata + controls ───────────────────────
  // With playback on a real <audio> element, the OS treats the stream like a
  // podcast: it keeps playing with the screen off / app switched, and these
  // handlers put working play/pause controls on the lock screen.
  useEffect(() => {
    if (!audioStarted || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Live English Translation',
        artist: church,
        album: 'Shema',
        artwork: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
      navigator.mediaSession.setActionHandler('play', () => {
        if (pausedRef.current) togglePauseRef.current();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (!pausedRef.current) togglePauseRef.current();
      });
    } catch {
      /* media session is progressive enhancement */
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.metadata = null;
      } catch {}
    };
  }, [audioStarted, church]);

  useEffect(() => {
    if (!audioStarted || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
    } catch {}
  }, [audioStarted, paused]);

  // ── Init audio (requires user gesture) ────────────────────────────────
  const initAudio = () => {
    if (audioStarted) return;

    // Prefer progressive MediaSource streaming; fall back to per-clip playback.
    if (AudioStreamPlayer.isSupported()) {
      const s = new AudioStreamPlayer();
      s.onSeqPlaying = (seq) => setSpokenSeq(seq);
      s.start();
      streamRef.current = s;
    } else {
      const q = new AudioPlaybackQueue();
      q.onSeqStart = (seq) => setSpokenSeq(seq);
      q.start();
      playbackRef.current = q;
    }

    browserTtsRef.current = new BrowserTTS();
    browserTtsRef.current.onSeqStart = (seq) => setSpokenSeq(seq);

    setAudioStarted(true);
  };

  // ── WebSocket lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    const client = new WsClient({
      url: getBackendWsUrl(),
      role: 'listener',
      room: church,
      onOpen: () => setConnState('connected'),
      onClose: () => setConnState('disconnected'),
      onError: () => {
        setConnState('disconnected');
      },
      onMessage: (msg: ServerMessage) => handleMessageRef.current(msg),
      reconnectDelayMs: 2500,
    });

    wsRef.current = client;
    setConnState('connecting');
    client.connect();

    return () => {
      client.disconnect();
      streamRef.current?.stop();
      playbackRef.current?.stop();
      browserTtsRef.current?.cancel();
      wsRef.current = null;
      streamRef.current = null;
      playbackRef.current = null;
      browserTtsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [church]);

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'status': {
          const s = msg as { type: 'status'; active?: boolean; direction?: string };
          if (s.direction === 'ko-en' || s.direction === 'en-ko') setDirection(s.direction);
          if (typeof s.active === 'boolean') {
            setBroadcastActive(s.active);
            if (s.active) {
              // New broadcast — reset playback state.
              streamRef.current?.reset();
              playbackRef.current?.reset();
              fallbackAccumRef.current = null;
            } else {
              browserTtsRef.current?.cancel();
            }
          }
          break;
        }

        case 'transcript_history': {
          // Authoritative transcript of the current broadcast: sent on
          // connect (late join / refresh restores the whole sermon so far)
          // and as empty chunks when a new sermon starts (screen resets).
          const h = msg as TranscriptHistoryMsg;
          const seen = new Set<number>();
          const entries: TranscriptEntry[] = [];
          for (const c of h.chunks ?? []) {
            if (seen.has(c.seq)) continue;
            seen.add(c.seq);
            entries.push({ seq: c.seq, sermon: c.sermon, direct: c.direct ?? c.sermon });
          }
          entries.sort((a, b) => a.seq - b.seq);
          setTranscript(entries);
          break;
        }

        case 'translation': {
          const t = msg as TranslationMsg;

          // Append to rolling transcript
          setTranscript((prev) => {
            // Skip if we already have this seq
            if (prev.some((e) => e.seq === t.seq)) return prev;
            return [...prev, { seq: t.seq, sermon: t.sermon, direct: t.direct ?? t.sermon }];
          });

          // Browser TTS
          if (
            ttsMode === 'browser' &&
            audioStarted &&
            !pausedRef.current &&
            browserTtsRef.current &&
            t.seq > lastSpokenSeqRef.current
          ) {
            lastSpokenSeqRef.current = t.seq;
            browserTtsRef.current.speakSeq(t.sermon, t.seq);
          }
          break;
        }

        case 'audio_start': {
          const a = msg as { seq: number };
          if (ttsMode === 'elevenlabs') {
            // Fallback path accumulates chunks per clip; MSE path streams directly.
            if (!streamRef.current) fallbackAccumRef.current = { seq: a.seq, parts: [] };
          }
          break;
        }

        case 'audio_chunk': {
          if (ttsMode !== 'elevenlabs') break;
          const a = msg as AudioChunkMsg;
          const bytes = base64ToBytes(a.data);
          if (streamRef.current) {
            streamRef.current.appendChunk(bytes, a.seq);
          } else if (fallbackAccumRef.current) {
            fallbackAccumRef.current.parts.push(bytes);
          }
          break;
        }

        case 'audio_end': {
          if (ttsMode !== 'elevenlabs') break;
          const a = msg as { seq: number };
          // Fallback: reassemble the whole clip and hand it to the per-clip queue.
          const accum = fallbackAccumRef.current;
          if (!streamRef.current && playbackRef.current && accum && accum.seq === a.seq) {
            fallbackAccumRef.current = null;
            const total = accum.parts.reduce((n, p) => n + p.length, 0);
            const merged = new Uint8Array(total);
            let off = 0;
            for (const p of accum.parts) {
              merged.set(p, off);
              off += p.length;
            }
            let bin = '';
            for (let i = 0; i < merged.length; i++) bin += String.fromCharCode(merged[i]);
            playbackRef.current.enqueue(a.seq, btoa(bin)).catch(console.error);
          }
          break;
        }

        case 'error': {
          if ('message' in msg) {
            setErrors((prev) => [...prev.slice(-4), msg.message as string]);
          }
          break;
        }
      }
    },
    [ttsMode, audioStarted],
  );

  // Keep ref in sync so the WebSocket always calls the latest handler
  handleMessageRef.current = handleMessage;

  // ── Render ─────────────────────────────────────────────────────────────
  const connColor =
    connState === 'connected'
      ? broadcastActive ? 'var(--green)' : 'var(--yellow)'
      : connState === 'connecting' ? 'var(--yellow)' : 'var(--red)';

  // What the listener is hearing — label it so nobody wonders which language.
  const outputLang = direction === 'en-ko' ? 'Korean' : 'English';

  const connLabel =
    connState === 'connected'
      ? broadcastActive ? `Live ${outputLang} Translation` : 'Connected — waiting for broadcast'
      : connState === 'connecting' ? 'Connecting…' : 'Disconnected — reconnecting…';

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', padding: '1.5rem 1rem', display: 'flex', flexDirection: 'column', gap: '1rem', height: '100dvh', boxSizing: 'border-box' }}>

      {/* Header — church name + subtle status, nothing else */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', flexShrink: 0 }}>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 600 }}>{church}</h1>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.68rem',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: connColor,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
          }}
        >
          <span className={`dot${broadcastActive ? ' dot-pulse' : ''}`} style={{ background: 'currentColor' }} />
          {connLabel}
        </span>
      </div>

      {/* Audio init — one tap unlocks autoplay for the whole service */}
      {!audioStarted && (
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1.5rem', borderColor: 'rgba(201,169,97,.45)', background: 'rgba(201,169,97,.05)', flexShrink: 0 }}>
          <button
            className="btn btn-primary"
            onClick={initAudio}
            style={{ width: '100%', maxWidth: 380, padding: '1.1rem 1.5rem', fontSize: '1.2rem', fontWeight: 600 }}
          >
            🔊 Tap to listen
          </button>
          <p style={{ marginTop: '0.9rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            One tap starts the {outputLang} audio — your browser blocks sound until you do.
          </p>
        </div>
      )}

      {/* Controls row — pause, text size, caption source */}
      {audioStarted && (
        <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
          <button
            className={paused ? 'btn btn-primary' : 'btn btn-ghost'}
            onClick={togglePause}
            style={{ padding: '0.55rem 1.3rem', fontSize: '0.95rem' }}
          >
            {paused ? (
              <svg width="11" height="12" viewBox="0 0 11 12" fill="currentColor" aria-hidden>
                <path d="M0 0 L11 6 L0 12 Z" />
              </svg>
            ) : (
              <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden>
                <rect x="0" y="0" width="3.5" height="12" />
                <rect x="6.5" y="0" width="3.5" height="12" />
              </svg>
            )}
            {paused ? 'Listen' : 'Pause'}
          </button>

          {/* Caption size */}
          <div className="toggle-group" aria-label="Caption text size">
            <button className={`toggle-opt${textSize === 's' ? ' active' : ''}`} onClick={() => changeTextSize('s')} style={{ fontSize: '0.62rem' }}>A</button>
            <button className={`toggle-opt${textSize === 'm' ? ' active' : ''}`} onClick={() => changeTextSize('m')} style={{ fontSize: '0.74rem' }}>A</button>
            <button className={`toggle-opt${textSize === 'l' ? ' active' : ''}`} onClick={() => changeTextSize('l')} style={{ fontSize: '0.88rem' }}>A</button>
          </div>

          {/* Caption source */}
          <div className="toggle-group" style={{ marginLeft: 'auto' }}>
            <button
              className={`toggle-opt${captionMode === 'sermon' ? ' active' : ''}`}
              onClick={() => setCaptionMode('sermon')}
              title="Natural spoken-English rendering (matches the audio)"
            >
              Sermon
            </button>
            <button
              className={`toggle-opt${captionMode === 'direct' ? ' active' : ''}`}
              onClick={() => setCaptionMode('direct')}
              title="More literal translation of the Korean"
            >
              Direct
            </button>
          </div>
        </div>
      )}

      {/* Rolling captions — history faded, current sentence emphasized */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="card prose-serif"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          fontSize: textSize === 's' ? '0.95rem' : textSize === 'l' ? '1.45rem' : '1.15rem',
          lineHeight: 1.85,
          padding: '1.5rem',
        }}
      >
        {transcript.length > 0 ? (
          <>
            {/* Spotify-lyrics style, synced to the EAR: lines already heard
                are faded above, the line whose audio is playing NOW glows,
                and translated-but-not-yet-spoken lines wait dimmed below
                (read ahead if you like). When audio isn't the driver
                (captions-only), the newest line is the live one. */}
            {(() => {
              const lastSeq = transcript[transcript.length - 1].seq;
              const audioDriven = audioStarted && ttsMode !== 'off' && spokenSeq > 0;
              const highlightSeq = audioDriven ? Math.min(spokenSeq, lastSeq) : lastSeq;
              return transcript.map((entry) => {
                const text = captionMode === 'direct' ? entry.direct : entry.sermon;
                if (entry.seq === highlightSeq) {
                  return (
                    <p key={entry.seq} data-seq={entry.seq} style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', fontSize: '1.35em', lineHeight: 1.6, marginBottom: '0.7em' }}>
                      {text}
                    </p>
                  );
                }
                const upcoming = entry.seq > highlightSeq;
                return (
                  <p
                    key={entry.seq}
                    data-seq={entry.seq}
                    style={{
                      color: 'var(--text-muted)',
                      opacity: upcoming ? 0.5 : 1,
                      whiteSpace: 'pre-wrap',
                      marginBottom: '0.9em',
                    }}
                  >
                    {text}
                  </p>
                );
              });
            })()}
          </>
        ) : (
          <p style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {!broadcastActive ? 'Waiting for broadcast to start…' : 'Translating…'}
          </p>
        )}
      </div>

      {/* Audio source — tucked away; only needed for troubleshooting */}
      {audioStarted && (
        <details style={{ flexShrink: 0 }}>
          <summary className="label" style={{ cursor: 'pointer', marginBottom: 0, userSelect: 'none' }}>
            Audio options
          </summary>
          <div className="toggle-group" style={{ marginTop: '0.5rem', maxWidth: 320 }}>
            <button
              className={`toggle-opt${ttsMode === 'browser' ? ' active' : ''}`}
              onClick={() => { setTtsMode('browser'); browserTtsRef.current?.cancel(); }}
              title="Fallback — your browser's built-in speech"
            >
              Basic voice
            </button>
            <button
              className={`toggle-opt${ttsMode === 'elevenlabs' ? ' active' : ''}`}
              onClick={() => { setTtsMode('elevenlabs'); browserTtsRef.current?.cancel(); }}
              title="Studio voice (default)"
            >
              Studio voice
            </button>
            <button
              className={`toggle-opt${ttsMode === 'off' ? ' active' : ''}`}
              onClick={() => { setTtsMode('off'); browserTtsRef.current?.cancel(); }}
              title="Captions only"
            >
              Captions only
            </button>
          </div>
        </details>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div className="card" style={{ borderColor: 'rgba(239,68,68,.4)', background: 'rgba(239,68,68,.05)', flexShrink: 0 }}>
          <div className="label" style={{ color: 'var(--red)' }}>Errors</div>
          {errors.map((e, i) => (
            <p key={i} style={{ color: 'var(--red)', fontSize: '0.85rem', marginTop: '0.35rem' }}>{e}</p>
          ))}
        </div>
      )}
    </div>
  );
}
