'use client';

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { WsClient, ServerMessage, AudioChunkMsg, TranslationMsg, TranscriptHistoryMsg } from '@/lib/ws-client';
import { AudioPlaybackQueue } from '@/lib/audio-playback';
import { AudioStreamPlayer, base64ToBytes } from '@/lib/audio-stream';
import { getBackendWsUrl } from '@/lib/backend-config';
import { churchDisplayName } from '@/lib/slug';
import { CaretDown, CaretRight, Pause, Play, SpeakerHigh } from '@phosphor-icons/react';
import { Seg } from '@/components/app/chrome';
import '@/components/app/listener.css';

/** Fastest automatic catch-up: Korean output plays near normal speed. */
function maxRateFor(direction: string): number {
  return direction === 'en-ko' ? 1.05 : 1.15;
}

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
  const [direction, setDirection] = useState<'ko-en' | 'en-ko' | 'zh-en' | 'yue-en'>('ko-en');
  // The player is built outside React state, so it reads the direction here.
  const directionRef = useRef(direction);
  useEffect(() => {
    directionRef.current = direction;
    if (streamRef.current) streamRef.current.maxCatchUpRate = maxRateFor(direction);
  }, [direction]);
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
  // Playback health, reported upstream a few times an hour.
  //
  // Stuttering was the loudest complaint from the live pilot and the hardest
  // thing to confirm fixed: it is provable headlessly, but in a real service
  // nothing counted it, so the only evidence was whether anyone in the pews
  // happened to mention it. These few bytes per minute turn that into a number
  // the desk can read while the service is still running.
  useEffect(() => {
    const report = () => {
      const s = streamRef.current?.stats();
      if (!s || !s.secondsPlayed) return;
      wsRef.current?.sendJSON({ type: 'playback_stats', ...s });
    };
    const t = setInterval(report, 60_000);
    // Also on the way out, so a listener who leaves early still counts.
    const onHide = () => { if (document.visibilityState === 'hidden') report(); };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  // How far the audio runs behind live (drives the Jump-to-live pill).
  const [behindSec, setBehindSec] = useState(0);
  // Auto catch-up speed (on by default; opt-out for anyone who finds the
  // brisk playback distracting). Persisted per device.
  const [autoCatchUp, setAutoCatchUp] = useState(true);
  const autoCatchUpRef = useRef(true);
  // The voice / catch-up controls are for troubleshooting; folded by default.
  const [optionsOpen, setOptionsOpen] = useState(false);

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

  const followLive = useCallback(() => {
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
  }, [spokenSeq]);

  // Keep the SPOKEN line in view (unless the user scrolled away to read).
  useEffect(followLive, [transcript, followLive]);

  // A new caption size reflows every line while scrollTop stays put, which
  // left the view drifting up the page mid-sermon. Re-anchor before paint,
  // if the reader was following the live line when they tapped.
  const followingAtResizeRef = useRef(false);
  useLayoutEffect(() => {
    if (!followingAtResizeRef.current) return;
    followingAtResizeRef.current = false;
    autoScrollRef.current = true;
    followLive();
    // followLive is read fresh on purpose; only a size change re-anchors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textSize]);

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
    followingAtResizeRef.current = autoScrollRef.current;
    setTextSize(size);
    try { window.localStorage.setItem('shema-caption-size', size); } catch {}
  };

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    pausedRef.current = next;
    // A real pause, not a mute. Muting kept the element running so a resume
    // could stay near live, but an inaudible page is a background-suspension
    // candidate on every platform — pausing and pocketing the phone was the
    // most reliable way to lose audio for good. Resume jumps to live, so the
    // listener misses exactly what they would have missed either way.
    if (next) streamRef.current?.pause();
    else streamRef.current?.resume();
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
  const pendingRebuildRef = useRef(false);
  const rebuildsRef = useRef<{ n: number; at: number }>({ n: 0, at: 0 });

  const buildStream = useCallback(function build(): void {
    const s = new AudioStreamPlayer();
    s.onSeqPlaying = onSeqPlaying;
    s.onStalled = () => {
      // The media pipeline died (observed on iOS: text flows, audio silent,
      // page still says live). Tear down and rebuild; if it keeps dying,
      // playback needs a fresh user gesture — show "Tap to listen" again.
      // Never rebuild while hidden: a fresh Audio() with no user gesture is
      // autoplay-blocked, which turns a recoverable stall into permanent
      // silence behind a UI that still says "live". Defer to the next time
      // the page is visible.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        console.warn('[Listener] stall while hidden — deferring rebuild until visible');
        pendingRebuildRef.current = true;
        return;
      }
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
    s.maxCatchUpRate = maxRateFor(directionRef.current);
    s.start();
    if (pausedRef.current) s.pause();
    streamRef.current = s;
  }, [onSeqPlaying]);

  // Returning to a visible page is when deferred recovery can safely happen:
  // rebuilding needs a document that is allowed to play audio, and a page that
  // was frozen may also be holding a zombie socket that never fired 'close'.
  useEffect(() => {
    if (!audioStarted) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (pendingRebuildRef.current) {
        pendingRebuildRef.current = false;
        console.warn('[Listener] page visible again — running deferred rebuild');
        streamRef.current?.stop();
        streamRef.current = null;
        buildStream();
        return;
      }
      // Not dead, just suspended: nudge playback if the OS paused us.
      if (!pausedRef.current) streamRef.current?.resume();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [audioStarted, buildStream]);

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
          if (s.direction === 'ko-en' || s.direction === 'en-ko' || s.direction === 'zh-en' || s.direction === 'yue-en') setDirection(s.direction);
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
            // The MSE path ignored clip boundaries, which let the silence fill
            // splice a pad into the middle of a word between two chunks of the
            // same sentence.
            else streamRef.current.noteClipStart();
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
          streamRef.current?.noteClipEnd();
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
  // The line being spoken NOW is the bright one. Full transcript preserved —
  // history dims above, upcoming lines wait faint below.
  const statusClass =
    connState === 'connected'
      ? broadcastActive ? ' live' : ' ls-status-wait'
      : connState === 'connecting' ? ' ls-status-wait' : ' ls-status-off';

  // What the listener is hearing — label it so nobody wonders which language.
  const outputLang = direction === 'en-ko' ? 'Korean' : 'English';
  // lang attributes so each script gets its own line breaking and glyph forms
  // (Korean wraps between words; Chinese must not get Korean glyph shapes).
  const outLangAttr = direction === 'en-ko' ? 'ko' : 'en';
  const srcLangAttr = direction === 'en-ko' ? 'en' : direction === 'zh-en' ? 'zh' : direction === 'yue-en' ? 'yue-Hant' : 'ko';

  const connLabel =
    connState === 'connected'
      ? broadcastActive ? 'Live' : 'Waiting'
      : connState === 'connecting' ? 'Connecting…' : 'Reconnecting…';

  const title = churchDisplayName(church) || church;

  return (
    <div className={`v2 ls-root ap-cap-${textSize}`}>
      <div className="ap-listen ls-listen">
        {/* Header — church name + status */}
        <header className="ap-listen-top ls-top">
          <h1>{title}</h1>
          <span className={`ap-status${statusClass}`} role="status">
            <span className="ap-dot" />
            {connLabel}
          </span>
        </header>

        {/* Audio init — one tap unlocks autoplay for the whole service */}
        {!audioStarted && (
          <section className="ls-tap">
            <button type="button" className="ap-tap-btn" onClick={initAudio}>
              <SpeakerHigh weight="fill" aria-hidden /> Tap to listen
            </button>
            <p className="ap-muted">
              One tap starts the {outputLang} audio. Get your headphones in first.
            </p>
          </section>
        )}

        {/* Behind-live indicator: catch-up handles small drift silently; deep
            drift gets a one-tap escape (captions keep every line). */}
        {audioStarted && ttsMode === 'elevenlabs' && behindSec > 30 && (
          <div className="ls-notice">
            <span>Audio is ~{behindSec}s behind live</span>
            <button type="button" className="v2-btn v2-btn-ink v2-btn-sm" onClick={() => streamRef.current?.jumpToLive()}>
              Jump to live
            </button>
          </div>
        )}

        {/* Full transcript; only the spoken line is bright */}
        <div ref={scrollRef} onScroll={handleScroll} className="ls-scroll">
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
                      <p key={entry.seq} data-seq={entry.seq} lang={outLangAttr} className="ap-cap-now ls-line">
                        {text}
                      </p>
                    );
                  }
                  const upcoming = entry.seq > highlightSeq;
                  return (
                    <p
                      key={entry.seq}
                      data-seq={entry.seq}
                      lang={outLangAttr}
                      className={`ap-cap-heard ls-line${upcoming ? ' ls-upcoming' : ''}`}
                    >
                      {text}
                    </p>
                  );
                });
              })()}
              {/* Tentative live line: raw source-language STT, clearly styled
                  as provisional; cleared when the confirmed translation lands. */}
              {partial && (
                <p className="ap-cap-next ls-line" lang={srcLangAttr}>
                  {partial}
                  <span className="ap-caret" aria-hidden />
                </p>
              )}
            </>
          ) : partial ? (
            <p className="ap-cap-next ls-line" lang={srcLangAttr}>
              {partial}
              <span className="ap-caret" aria-hidden />
            </p>
          ) : (
            <p className="ls-empty">
              {!broadcastActive ? 'Waiting for broadcast to start…' : 'Translating…'}
            </p>
          )}
        </div>

        {/* Errors */}
        {errors.length > 0 && (
          <div className="ls-errors" role="alert">
            {errors.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        )}

        {/* Footer — pause, output language, caption size, audio options.
            Every control ≥44px: the audience is older congregants on phones. */}
        {audioStarted && (
          <footer className="ap-player ls-player">
            <div className="ap-player-row">
              <button type="button" className="ap-play" onClick={togglePause} aria-label={paused ? 'Resume audio' : 'Pause audio'}>
                {paused ? <Play weight="fill" aria-hidden /> : <Pause weight="fill" aria-hidden />}
              </button>
              <div className="ap-player-label">
                <strong>{outputLang} audio</strong>
                <span className={paused ? 'ap-muted' : 'ap-ok'}>
                  {paused ? 'Paused' : behindSec > 3 ? `${behindSec}s behind` : 'Live'}
                </span>
              </div>
              <div className="ap-sizes" role="radiogroup" aria-label="Caption text size">
                {(['s', 'm', 'l'] as const).map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    role="radio"
                    aria-checked={textSize === sz}
                    aria-label={sz === 's' ? 'Small text' : sz === 'm' ? 'Medium text' : 'Large text'}
                    className={`ap-size-${sz}${textSize === sz ? ' on' : ''}`}
                    onClick={() => changeTextSize(sz)}
                  >
                    A
                  </button>
                ))}
              </div>
            </div>

            {/* Audio source + catch-up — tucked away; only for troubleshooting */}
            <button type="button" className="ap-opts-toggle" aria-expanded={optionsOpen} onClick={() => setOptionsOpen((o) => !o)}>
              {optionsOpen ? <CaretDown aria-hidden /> : <CaretRight aria-hidden />} Audio options
            </button>
            {optionsOpen && (
              <div className="ap-opts">
                <Seg<TtsMode>
                  label="Voice"
                  value={ttsMode}
                  onChange={(m) => { setTtsMode(m); browserTtsRef.current?.cancel(); }}
                  options={[
                    { v: 'browser', l: 'Basic voice', title: "Fallback — your browser's built-in speech" },
                    { v: 'elevenlabs', l: 'Studio voice', title: 'Studio voice (default)' },
                    { v: 'off', l: 'Captions only', title: 'Captions only' },
                  ]}
                />
                {/* Catch-up speed: on = quietly play brisk when behind live;
                    off = always normal speed (the Jump-to-live pill still works). */}
                <div className="ap-opts-row">
                  <span>Catch-up speed</span>
                  <Seg<'auto' | 'off'>
                    label="Catch-up speed"
                    value={autoCatchUp ? 'auto' : 'off'}
                    onChange={(v) => changeAutoCatchUp(v === 'auto')}
                    options={[
                      { v: 'auto', l: 'Auto', title: 'Plays slightly faster when behind live so you stay close (default)' },
                      { v: 'off', l: 'Off', title: 'Always normal speed — you may drift behind live' },
                    ]}
                  />
                </div>
              </div>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
