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
  // Caption size — accessibility for older members. Persisted per device.
  const [textSize, setTextSize] = useState<'s' | 'm' | 'l'>('m');
  // Pause = output muted; the stream keeps flowing so resuming stays near-live.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  // Tentative interim STT text (source language) — the "hearing now" line.
  const [partial, setPartial] = useState('');
  const [audioStarted, setAudioStarted] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  // The seq whose AUDIO is playing right now — drives the highlight.
  // Translations arrive ahead of their audio; highlighting the latest
  // translation runs ahead of what the ear hears.
  const [spokenSeq, setSpokenSeq] = useState(0);
  // Report the playing seq upstream (throttled) so the broadcaster desk can
  // mark where the pews are.
  const lastReportRef = useRef<{ seq: number; at: number }>({ seq: 0, at: 0 });
  const onSeqPlaying = useCallback((seq: number) => {
    setSpokenSeq(seq);
    const now = Date.now();
    if (seq !== lastReportRef.current.seq && now - lastReportRef.current.at > 1500) {
      lastReportRef.current = { seq, at: now };
      wsRef.current?.sendJSON({ type: 'playing', seq });
    }
  }, []);
  // How far the audio runs behind live (drives the Jump-to-live pill).
  const [behindSec, setBehindSec] = useState(0);
  // Auto catch-up speed (on by default; opt-out for anyone who finds the
  // brisk playback distracting). Persisted per device.
  const [autoCatchUp, setAutoCatchUp] = useState(true);
  const autoCatchUpRef = useRef(true);

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
    const catchUp = window.localStorage.getItem('shema-auto-catchup') !== 'off';
    setAutoCatchUp(catchUp);
    autoCatchUpRef.current = catchUp;
  }, []);

  const changeAutoCatchUp = (on: boolean) => {
    setAutoCatchUp(on);
    autoCatchUpRef.current = on;
    if (streamRef.current) streamRef.current.catchUpEnabled = on;
    try { window.localStorage.setItem('shema-auto-catchup', on ? 'on' : 'off'); } catch {}
  };

  // Track the audio backlog for the Jump-to-live control.
  useEffect(() => {
    if (!audioStarted) return;
    const t = setInterval(() => {
      setBehindSec(Math.round(streamRef.current?.backlogSeconds ?? 0));
    }, 2000);
    return () => clearInterval(t);
  }, [audioStarted]);

  const changeTextSize = (size: 's' | 'm' | 'l') => {
    setTextSize(size);
    try { window.localStorage.setItem('shema-caption-size', size); } catch {}
  };

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    pausedRef.current = next;
    // muted, not volume: iOS ignores the volume property on media elements.
    streamRef.current?.setMuted(next);
    playbackRef.current?.setVolume(next ? 0 : 1); // WebAudio gain — works everywhere
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
  // Rebuilds within this window count toward the self-heal cap; past the cap
  // we assume the OS revoked autoplay and surface the tap gate again.
  const rebuildsRef = useRef<{ n: number; at: number }>({ n: 0, at: 0 });

  const buildStream = useCallback(function build(): void {
    const s = new AudioStreamPlayer();
    s.onSeqPlaying = onSeqPlaying;
    s.onStalled = () => {
      // The media pipeline died (observed on iOS: text flows, audio silent,
      // page still says live). Tear down and rebuild; if it keeps dying,
      // playback needs a fresh user gesture — show "Tap to listen" again.
      streamRef.current?.stop();
      streamRef.current = null;
      const rc = rebuildsRef.current;
      const now = Date.now();
      if (now - rc.at > 60_000) rc.n = 0;
      rc.at = now;
      rc.n++;
      if (rc.n > 2) {
        console.warn('[Listener] audio pipeline keeps dying — asking for a fresh tap');
        setAudioStarted(false);
        return;
      }
      console.warn('[Listener] audio pipeline stalled — rebuilding player');
      build();
    };
    s.catchUpEnabled = autoCatchUpRef.current;
    s.setMuted(pausedRef.current);
    s.start();
    streamRef.current = s;
  }, [onSeqPlaying]);

  const initAudio = () => {
    if (audioStarted) return;

    // Prefer progressive MediaSource streaming; fall back to per-clip playback.
    if (AudioStreamPlayer.isSupported()) {
      buildStream();
    } else {
      const q = new AudioPlaybackQueue();
      q.onSeqStart = onSeqPlaying;
      q.start();
      playbackRef.current = q;
    }

    browserTtsRef.current = new BrowserTTS();
    browserTtsRef.current.onSeqStart = onSeqPlaying;

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
            setPartial('');
          }
          break;
        }

        case 'partial_transcript': {
          if ('text' in msg && typeof msg.text === 'string') setPartial(msg.text);
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

          // Append to rolling transcript; the confirmed line supersedes the
          // tentative live line.
          setPartial('');
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
  // "Vigil" (redesign screen 1a): a dimmed sanctuary screen where the line
  // being spoken NOW is the only bright thing. Full transcript preserved —
  // history dims above, upcoming lines wait faint below.
  const connColor =
    connState === 'connected'
      ? broadcastActive ? 'var(--sage)' : 'var(--gold-hover)'
      : connState === 'connecting' ? 'var(--gold-hover)' : 'var(--alert)';

  // What the listener is hearing — label it so nobody wonders which language.
  const outputLang = direction === 'en-ko' ? 'Korean' : 'English';

  const connLabel =
    connState === 'connected'
      ? broadcastActive ? 'Live' : 'Waiting'
      : connState === 'connecting' ? 'Connecting…' : 'Reconnecting…';

  const mono: React.CSSProperties = {
    fontFamily: 'var(--font-mono, monospace)',
    textTransform: 'uppercase',
    letterSpacing: '0.2em',
  };
  const baseSize = textSize === 's' ? '0.95rem' : textSize === 'l' ? '1.45rem' : '1.15rem';
  const sizeBtn: React.CSSProperties = { minWidth: 44, minHeight: 44 };

  return (
    <div style={{ maxWidth: 700, margin: '0 auto', display: 'flex', flexDirection: 'column', height: '100dvh', boxSizing: 'border-box', background: 'var(--night)' }}>

      {/* Header — church name + breathing status */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', flexShrink: 0, padding: '1.1rem 1.25rem 0.6rem' }}>
        <h1 className="serif-en" style={{ fontSize: '1.55rem', color: 'rgba(244,241,234,0.92)' }}>{church}</h1>
        <span
          style={{
            ...mono,
            fontSize: '0.62rem',
            color: connColor,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.45rem',
          }}
        >
          <span className={`dot${broadcastActive ? ' dot-pulse' : ''}`} style={{ background: 'currentColor', width: 7, height: 7 }} />
          {connLabel}
        </span>
      </div>

      {/* Audio init — one tap unlocks autoplay for the whole service */}
      {!audioStarted && (
        <div style={{ textAlign: 'center', padding: '2rem 1.25rem', flexShrink: 0 }}>
          <button
            onClick={initAudio}
            style={{
              width: '100%',
              maxWidth: 380,
              padding: '1.15rem 1.5rem',
              fontSize: '1.2rem',
              fontWeight: 600,
              borderRadius: 12,
              background: 'var(--gold)',
              color: 'var(--night)',
            }}
          >
            🔊 Tap to listen
          </button>
          <p style={{ marginTop: '0.9rem', color: 'rgba(244,241,234,0.5)', fontSize: '0.85rem' }}>
            One tap starts the {outputLang} audio — your browser blocks sound until you do.
          </p>
        </div>
      )}

      {/* Behind-live indicator: catch-up handles small drift silently; deep
          drift gets a one-tap escape (captions keep every line). */}
      {audioStarted && ttsMode === 'elevenlabs' && behindSec > 45 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            padding: '0.6rem 1rem',
            margin: '0 1.25rem 0.5rem',
            border: '1px solid rgba(200,162,94,0.45)',
            background: 'rgba(200,162,94,0.07)',
            borderRadius: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: '0.85rem', color: 'rgba(244,241,234,0.6)' }}>
            Audio is ~{behindSec}s behind live
          </span>
          <button
            onClick={() => streamRef.current?.jumpToLive()}
            style={{ padding: '0.6rem 1rem', fontSize: '0.85rem', fontWeight: 600, minHeight: 44, borderRadius: 8, background: 'var(--gold)', color: 'var(--night)' }}
          >
            Jump to live
          </button>
        </div>
      )}

      {/* The vigil: full transcript, only the spoken line burns bright */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="serif-en"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          fontSize: baseSize,
          lineHeight: 1.7,
          padding: '1rem 1.5rem 2.5rem',
        }}
      >
        {transcript.length > 0 ? (
          <>
            {/* Synced to the EAR: lines already heard fade above, the line
                whose audio is playing NOW is the bright one, and
                translated-but-not-yet-spoken lines wait faint below. When
                audio isn't the driver (captions-only), the newest line is
                the live one. */}
            {(() => {
              const lastSeq = transcript[transcript.length - 1].seq;
              const audioDriven = audioStarted && ttsMode !== 'off' && spokenSeq > 0;
              const highlightSeq = audioDriven ? Math.min(spokenSeq, lastSeq) : lastSeq;
              return transcript.map((entry) => {
                const text = entry.sermon;
                if (entry.seq === highlightSeq) {
                  return (
                    <div key={entry.seq} data-seq={entry.seq} style={{ margin: '1.1em 0' }}>
                      <span aria-hidden style={{ display: 'block', width: 26, height: 2, background: 'var(--gold)', marginBottom: '0.55em' }} />
                      <p style={{ color: 'rgba(244,241,234,0.96)', whiteSpace: 'pre-wrap', fontSize: '1.5em', lineHeight: 1.42 }}>
                        {text}
                      </p>
                    </div>
                  );
                }
                const upcoming = entry.seq > highlightSeq;
                return (
                  <p
                    key={entry.seq}
                    data-seq={entry.seq}
                    style={{
                      color: 'var(--cream)',
                      opacity: upcoming ? 0.2 : 0.28,
                      whiteSpace: 'pre-wrap',
                      marginBottom: '0.85em',
                      transition: 'opacity 0.5s var(--ease)',
                    }}
                  >
                    {text}
                  </p>
                );
              });
            })()}
            {/* Tentative live line: raw source-language STT, clearly styled
                as provisional; cleared when the confirmed translation lands. */}
            {partial && (
              <p style={{ color: 'var(--cream)', opacity: 0.16, fontStyle: 'italic', whiteSpace: 'pre-wrap', fontSize: '0.85em' }}>
                {partial}
                <span className="caret" aria-hidden>▍</span>
              </p>
            )}
          </>
        ) : partial ? (
          <p style={{ color: 'var(--cream)', opacity: 0.2, fontStyle: 'italic', fontSize: '0.85em' }}>
            {partial}
            <span className="caret" aria-hidden>▍</span>
          </p>
        ) : (
          <p style={{ color: 'rgba(244,241,234,0.4)', fontStyle: 'italic', paddingTop: '1rem' }}>
            {!broadcastActive ? 'Waiting for broadcast to start…' : 'Translating…'}
          </p>
        )}
      </div>

      {/* Errors */}
      {errors.length > 0 && (
        <div style={{ border: '1px solid rgba(255,138,128,.4)', background: 'rgba(255,138,128,.05)', borderRadius: 10, flexShrink: 0, margin: '0 1.25rem 0.5rem', padding: '0.6rem 1rem' }}>
          {errors.map((e, i) => (
            <p key={i} style={{ color: 'var(--alert)', fontSize: '0.85rem', marginTop: i === 0 ? 0 : '0.35rem' }}>{e}</p>
          ))}
        </div>
      )}

      {/* Footer — pause, output language, caption source, text size.
          Every control ≥44px: the audience is older congregants on phones. */}
      {audioStarted && (
        <div
          style={{
            flexShrink: 0,
            padding: '0.9rem 1.25rem calc(0.9rem + env(safe-area-inset-bottom))',
            background: 'linear-gradient(to top, var(--night) 78%, rgba(19,19,24,0))',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.7rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', flexWrap: 'wrap' }}>
            <button
              onClick={togglePause}
              aria-label={paused ? 'Resume audio' : 'Pause audio'}
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'var(--gold)',
                color: 'var(--night)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {paused ? (
                <svg width="15" height="16" viewBox="0 0 11 12" fill="currentColor" aria-hidden>
                  <path d="M0 0 L11 6 L0 12 Z" />
                </svg>
              ) : (
                <svg width="13" height="16" viewBox="0 0 10 12" fill="currentColor" aria-hidden>
                  <rect x="0" y="0" width="3.5" height="12" />
                  <rect x="6.5" y="0" width="3.5" height="12" />
                </svg>
              )}
            </button>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 90 }}>
              <span style={{ ...mono, fontSize: '0.6rem', color: 'rgba(244,241,234,0.75)' }}>{outputLang} audio</span>
              <span style={{ ...mono, fontSize: '0.55rem', color: 'rgba(244,241,234,0.4)' }}>
                {paused ? 'Paused' : behindSec > 3 ? `${behindSec}s behind` : 'Live'}
              </span>
            </div>

            {/* Caption size */}
            <div className="toggle-group" aria-label="Caption text size" style={{ marginLeft: 'auto' }}>
              <button className={`toggle-opt${textSize === 's' ? ' active' : ''}`} onClick={() => changeTextSize('s')} style={{ ...sizeBtn, fontSize: '0.62rem' }}>A</button>
              <button className={`toggle-opt${textSize === 'm' ? ' active' : ''}`} onClick={() => changeTextSize('m')} style={{ ...sizeBtn, fontSize: '0.74rem' }}>A</button>
              <button className={`toggle-opt${textSize === 'l' ? ' active' : ''}`} onClick={() => changeTextSize('l')} style={{ ...sizeBtn, fontSize: '0.88rem' }}>A</button>
            </div>
          </div>

          {/* Audio source + catch-up — tucked away; only for troubleshooting */}
          <details>
            <summary style={{ ...mono, fontSize: '0.58rem', color: 'rgba(244,241,234,0.42)', cursor: 'pointer', userSelect: 'none', listStyle: 'none' }}>
              ▸ Audio options
            </summary>
            <div className="toggle-group" style={{ marginTop: '0.6rem', maxWidth: 340 }}>
              <button
                className={`toggle-opt${ttsMode === 'browser' ? ' active' : ''}`}
                onClick={() => { setTtsMode('browser'); browserTtsRef.current?.cancel(); }}
                title="Fallback — your browser's built-in speech"
                style={{ minHeight: 44 }}
              >
                Basic voice
              </button>
              <button
                className={`toggle-opt${ttsMode === 'elevenlabs' ? ' active' : ''}`}
                onClick={() => { setTtsMode('elevenlabs'); browserTtsRef.current?.cancel(); }}
                title="Studio voice (default)"
                style={{ minHeight: 44 }}
              >
                Studio voice
              </button>
              <button
                className={`toggle-opt${ttsMode === 'off' ? ' active' : ''}`}
                onClick={() => { setTtsMode('off'); browserTtsRef.current?.cancel(); }}
                title="Captions only"
                style={{ minHeight: 44 }}
              >
                Captions only
              </button>
            </div>
            {/* Catch-up speed: on = quietly play brisk when behind live;
                off = always normal speed (the Jump-to-live pill still works). */}
            <div style={{ ...mono, fontSize: '0.55rem', color: 'rgba(244,241,234,0.42)', margin: '0.7rem 0 0.35rem' }}>
              Catch-up speed
            </div>
            <div className="toggle-group" style={{ maxWidth: 340 }}>
              <button
                className={`toggle-opt${autoCatchUp ? ' active' : ''}`}
                onClick={() => changeAutoCatchUp(true)}
                title="Plays slightly faster when behind live so you stay close (default)"
                style={{ minHeight: 44 }}
              >
                Auto
              </button>
              <button
                className={`toggle-opt${!autoCatchUp ? ' active' : ''}`}
                onClick={() => changeAutoCatchUp(false)}
                title="Always normal speed — you may drift behind live"
                style={{ minHeight: 44 }}
              >
                Off
              </button>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
