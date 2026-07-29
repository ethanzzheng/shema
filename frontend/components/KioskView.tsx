'use client';

/**
 * Single-device kiosk output (/play/[church]).
 *
 * Runs on ONE laptop whose headphone/line-out feeds the church's receiver
 * system (e.g. the translator-mic input). One click starts continuous
 * playback; the screen stays awake (Wake Lock); big status readouts mean the
 * operator can glance at it from across the room. Same WS protocol and audio
 * pipeline as the listener — different UI over the same stream.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { WsClient, ServerMessage, AudioChunkMsg, TranslationMsg } from '@/lib/ws-client';
import { AudioPlaybackQueue } from '@/lib/audio-playback';
import { AudioStreamPlayer, base64ToBytes } from '@/lib/audio-stream';
import { getBackendWsUrl } from '@/lib/backend-config';
import { useRequireAuth } from '@/lib/use-require-auth';

const VOLUME_STORAGE_KEY = 'shema-kiosk-volume';

type ConnState = 'disconnected' | 'connecting' | 'connected';

export default function KioskView({ church }: { church: string }) {
  // Staff page: redirects to /login when the backend enforces auth.
  const gate = useRequireAuth();
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [broadcastActive, setBroadcastActive] = useState(false);
  const [direction, setDirection] = useState<'ko-en' | 'en-ko'>('ko-en');
  const [started, setStarted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [wakeLockState, setWakeLockState] = useState<'active' | 'unavailable' | 'off'>('off');
  const [toneBusy, setToneBusy] = useState(false);
  const [caption, setCaption] = useState('');
  const [prevCaption, setPrevCaption] = useState('');
  const [segments, setSegments] = useState(0);
  const [error, setError] = useState('');

  const wsRef = useRef<WsClient | null>(null);
  const streamRef = useRef<AudioStreamPlayer | null>(null);
  const playbackRef = useRef<AudioPlaybackQueue | null>(null);
  const fallbackAccumRef = useRef<{ seq: number; parts: Uint8Array[] } | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const toneCtxRef = useRef<AudioContext | null>(null);
  const handleMessageRef = useRef<(msg: ServerMessage) => void>(() => {});
  const volumeRef = useRef(1);

  // ── Saved volume ─────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = parseFloat(window.localStorage.getItem(VOLUME_STORAGE_KEY) ?? '');
    if (!Number.isNaN(saved) && saved >= 0 && saved <= 1) {
      setVolume(saved);
      volumeRef.current = saved;
    }
  }, []);

  const changeVolume = (v: number) => {
    setVolume(v);
    volumeRef.current = v;
    streamRef.current?.setVolume(v);
    playbackRef.current?.setVolume(v);
    try { window.localStorage.setItem(VOLUME_STORAGE_KEY, String(v)); } catch {}
  };

  // ── Wake lock: hold during output, re-acquire when the tab foregrounds ──
  const acquireWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) {
      setWakeLockState('unavailable');
      return;
    }
    try {
      const lock = await navigator.wakeLock.request('screen');
      wakeLockRef.current = lock;
      setWakeLockState('active');
      lock.addEventListener('release', () => setWakeLockState((s) => (s === 'active' ? 'off' : s)));
    } catch {
      setWakeLockState('unavailable');
    }
  }, []);

  useEffect(() => {
    if (!started) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !wakeLockRef.current) acquireWakeLock();
      if (document.visibilityState === 'visible' && wakeLockState === 'off') acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [started, wakeLockState, acquireWakeLock]);

  // ── Start output (single user gesture unlocks audio + wake lock) ────────
  const startOutput = () => {
    if (started) return;

    if (AudioStreamPlayer.isSupported()) {
      const s = new AudioStreamPlayer();
      s.setVolume(volumeRef.current);
      s.start();
      streamRef.current = s;
    } else {
      const q = new AudioPlaybackQueue();
      q.setVolume(volumeRef.current);
      q.start();
      playbackRef.current = q;
    }

    acquireWakeLock();
    setStarted(true);
  };

  // ── Test tone: verify the line-out feeds the house system ───────────────
  const playTestTone = () => {
    if (toneBusy) return;
    try {
      if (!toneCtxRef.current || toneCtxRef.current.state === 'closed') {
        toneCtxRef.current = new AudioContext();
      }
      const ctx = toneCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      // Follow the output volume, with headroom + soft edges (no click).
      const peak = 0.5 * volumeRef.current;
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.05);
      gain.gain.setValueAtTime(peak, t + 1.4);
      gain.gain.linearRampToValueAtTime(0, t + 1.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 1.55);
      setToneBusy(true);
      osc.onended = () => setToneBusy(false);
    } catch {
      setToneBusy(false);
    }
  };

  // ── WebSocket (same protocol as the listener) ────────────────────────────
  useEffect(() => {
    if (gate !== 'ok') return;
    const client = new WsClient({
      url: getBackendWsUrl(),
      role: 'listener',
      room: church,
      onOpen: () => setConnState('connected'),
      onClose: () => setConnState('disconnected'),
      onError: () => setConnState('disconnected'),
      onMessage: (msg: ServerMessage) => handleMessageRef.current(msg),
      reconnectDelayMs: 2000,
    });

    wsRef.current = client;
    setConnState('connecting');
    client.connect();

    return () => {
      client.disconnect();
      streamRef.current?.stop();
      playbackRef.current?.stop();
      toneCtxRef.current?.close().catch(() => {});
      wakeLockRef.current?.release().catch(() => {});
      wsRef.current = null;
      streamRef.current = null;
      playbackRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [church, gate]);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'status': {
        const s = msg as { type: 'status'; active?: boolean; direction?: string };
        if (s.direction === 'ko-en' || s.direction === 'en-ko') setDirection(s.direction);
        if (typeof s.active === 'boolean') {
          setBroadcastActive(s.active);
          if (s.active) {
            streamRef.current?.reset();
            playbackRef.current?.reset();
            fallbackAccumRef.current = null;
            setCaption('');
            setPrevCaption('');
            setSegments(0);
          }
        }
        break;
      }

      case 'translation': {
        const t = msg as TranslationMsg;
        setCaption((cur) => {
          setPrevCaption(cur);
          return t.sermon;
        });
        setSegments((n) => n + 1);
        break;
      }

      case 'audio_start': {
        const a = msg as { seq: number };
        if (!streamRef.current) fallbackAccumRef.current = { seq: a.seq, parts: [] };
        break;
      }

      case 'audio_chunk': {
        const a = msg as AudioChunkMsg;
        const bytes = base64ToBytes(a.data);
        if (streamRef.current) {
          streamRef.current.appendChunk(bytes);
        } else if (fallbackAccumRef.current) {
          fallbackAccumRef.current.parts.push(bytes);
        }
        break;
      }

      case 'audio_end': {
        const a = msg as { seq: number };
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

      case 'error':
        if ('message' in msg) setError(msg.message as string);
        break;
    }
  }, []);
  handleMessageRef.current = handleMessage;

  // ── Render ───────────────────────────────────────────────────────────────
  const statusColor =
    connState !== 'connected' ? 'var(--red)' : broadcastActive ? 'var(--green)' : 'var(--yellow)';
  const statusLabel =
    connState === 'connecting'
      ? 'Connecting…'
      : connState === 'disconnected'
      ? 'Disconnected — reconnecting…'
      : broadcastActive
      ? 'Live'
      : 'Waiting for broadcast';

  // Waiting on the auth check (or being redirected to /login) — render nothing.
  if (gate !== 'ok') return null;

  return (
    <div
      style={{
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        padding: 'clamp(1.25rem, 3vw, 2.5rem)',
        gap: '1.25rem',
        boxSizing: 'border-box',
      }}
    >
      {/* ── Top bar: church + status ─────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
          <h1 style={{ fontSize: 'clamp(1.6rem, 3.4vw, 2.6rem)', fontWeight: 600 }}>{church}</h1>
          <span className="label" style={{ marginBottom: 0 }}>
            Kiosk output · {direction === 'en-ko' ? 'Korean' : 'English'}
          </span>
        </div>
        <div className="pill" style={{ color: statusColor, borderColor: 'currentColor', fontSize: '0.8rem', padding: '0.45rem 1rem' }}>
          <span className={`dot${broadcastActive && connState === 'connected' ? ' dot-pulse' : ''}`} />
          {statusLabel}
        </div>
      </div>

      {/* ── Main area ────────────────────────────────────────────────── */}
      {!started ? (
        <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem', borderColor: 'rgba(201,169,97,.45)', background: 'rgba(201,169,97,.04)' }}>
          <button
            className="btn btn-primary"
            onClick={startOutput}
            style={{ fontSize: '1.5rem', padding: '1.4rem 3.5rem', fontWeight: 600 }}
          >
            ▶ Start output
          </button>
          <p style={{ color: 'var(--text-muted)', maxWidth: '46ch', textAlign: 'center', fontSize: '0.95rem' }}>
            One click unlocks continuous audio out of this laptop&apos;s headphone / line-out.
            Use the test tone below to verify the church system hears it, then leave this
            screen open for the whole service.
          </p>
        </div>
      ) : (
        <div className="card prose-serif" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 'clamp(1.5rem, 4vw, 3rem)', gap: '1.5rem', overflow: 'hidden' }}>
          {caption ? (
            <>
              <p style={{ color: 'var(--text-muted)', fontSize: 'clamp(1rem, 1.8vw, 1.4rem)', lineHeight: 1.6 }}>{prevCaption}</p>
              <p style={{ fontSize: 'clamp(1.4rem, 3vw, 2.3rem)', lineHeight: 1.55 }}>{caption}</p>
            </>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 'clamp(1.2rem, 2.2vw, 1.8rem)', textAlign: 'center' }}>
              {broadcastActive ? 'Translating…' : 'Output armed — waiting for the broadcast to start.'}
            </p>
          )}
        </div>
      )}

      {/* ── Operator bar: volume, test tone, wake lock ───────────────── */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap', padding: '1rem 1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1, minWidth: 240 }}>
          <span className="label" style={{ marginBottom: 0 }}>Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => changeVolume(parseFloat(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--accent)' }}
            aria-label="Output volume"
          />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)', width: 42, textAlign: 'right' }}>
            {Math.round(volume * 100)}%
          </span>
        </div>

        <button className="btn btn-ghost" onClick={playTestTone} disabled={toneBusy} style={{ opacity: toneBusy ? 0.5 : 1 }}>
          {toneBusy ? 'Playing…' : 'Test tone'}
        </button>

        <div className="pill" style={{ color: wakeLockState === 'active' ? 'var(--green)' : 'var(--text-muted)' }}>
          <span className="dot" />
          {wakeLockState === 'active'
            ? 'Screen stays awake'
            : wakeLockState === 'unavailable'
            ? 'Wake lock unavailable — disable sleep in OS settings'
            : 'Screen may sleep'}
        </div>

        {started && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-muted)', letterSpacing: '0.08em' }}>
            {segments} SEGMENTS
          </span>
        )}
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'rgba(255,138,128,.4)', background: 'rgba(255,138,128,.05)', padding: '0.75rem 1.25rem' }}>
          <span style={{ color: 'var(--red)', fontSize: '0.9rem' }}>{error}</span>
        </div>
      )}
    </div>
  );
}
