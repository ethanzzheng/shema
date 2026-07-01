'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { WsClient, ServerMessage, DebugMsg, TranslationMsg } from '@/lib/ws-client';
import { AudioCapture } from '@/lib/audio-capture';

function getWsUrl(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_WS_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_WS_URL;
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.hostname}:3001/ws`;
}

type Mode = 'fast' | 'smooth';
type ConnState = 'disconnected' | 'connecting' | 'connected';

interface DebugPanel {
  chunkSize: number;
  translationLatencyMs: number;
  ttsLatencyMs: number;
  e2eLatencyMs: number;
  sttConnected: boolean;
}

interface ScriptEntry {
  seq: number;
  korean: string;
  sermon: string;
}

const DEFAULT_DEBUG: DebugPanel = {
  chunkSize: 0,
  translationLatencyMs: 0,
  ttsLatencyMs: 0,
  e2eLatencyMs: 0,
  sttConnected: false,
};

export default function BroadcastPage() {
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [broadcasting, setBroadcasting] = useState(false);
  const [mode, setMode] = useState<Mode>('fast');
  const [script, setScript] = useState<ScriptEntry[]>([]);
  const [liveKorean, setLiveKorean] = useState('');
  const [debug, setDebug] = useState<DebugPanel>(DEFAULT_DEBUG);
  const [errors, setErrors] = useState<string[]>([]);

  const wsRef = useRef<WsClient | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Auto-scroll
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [script]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 60;
  };

  // ── WebSocket lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    const client = new WsClient({
      url: getWsUrl(),
      role: 'broadcaster',
      onOpen: () => setConnState('connected'),
      onClose: () => {
        setConnState('disconnected');
        setBroadcasting((prev) => {
          if (prev) stopCapture();
          return false;
        });
      },
      onError: () => setConnState('disconnected'),
      onMessage: handleMessage,
      reconnectDelayMs: 2000,
    });

    wsRef.current = client;
    setConnState('connecting');
    client.connect();

    return () => {
      client.disconnect();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'transcript':
        if ('korean' in msg) setLiveKorean(msg.korean as string);
        break;
      case 'translation': {
        const t = msg as TranslationMsg;
        setScript((prev) => {
          if (prev.some((e) => e.seq === t.seq)) return prev;
          return [...prev, { seq: t.seq, korean: t.korean ?? '', sermon: t.sermon }];
        });
        setLiveKorean(''); // clear interim korean after translation arrives
        break;
      }
      case 'debug': {
        const d = msg as DebugMsg;
        setDebug({
          chunkSize: d.chunkSize,
          translationLatencyMs: d.translationLatencyMs,
          ttsLatencyMs: d.ttsLatencyMs,
          e2eLatencyMs: d.e2eLatencyMs,
          sttConnected: d.sttConnected,
        });
        break;
      }
      case 'error':
        if ('message' in msg) {
          setErrors((prev) => [...prev.slice(-4), msg.message as string]);
        }
        break;
    }
  }, []);

  // ── Start / Stop broadcast ───────────────────────────────────────────────
  const startBroadcast = async () => {
    if (broadcasting || !wsRef.current?.isConnected) return;

    try {
      const capture = new AudioCapture({
        chunkIntervalMs: 200,
        onChunk: (pcm) => {
          wsRef.current?.sendBinary(pcm);
        },
      });

      await capture.start();
      captureRef.current = capture;

      wsRef.current.sendJSON({ type: 'start', mode });
      setBroadcasting(true);

      setScript([]);
      setLiveKorean('');
      setErrors([]);
    } catch (err) {
      setErrors((prev) => [
        ...prev.slice(-4),
        `Mic error: ${(err as Error).message}`,
      ]);
    }
  };

  const stopCapture = () => {
    captureRef.current?.stop();
    captureRef.current = null;
  };

  const stopBroadcast = () => {
    stopCapture();
    wsRef.current?.sendJSON({ type: 'stop' });
    setBroadcasting(false);
  };

  const handleModeChange = (m: Mode) => {
    setMode(m);
    if (broadcasting) {
      wsRef.current?.sendJSON({ type: 'mode', mode: m });
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const stateColor =
    connState === 'connected'
      ? 'var(--green)'
      : connState === 'connecting'
      ? 'var(--yellow)'
      : 'var(--red)';

  const stateLabel =
    connState === 'connected'
      ? 'Connected'
      : connState === 'connecting'
      ? 'Connecting…'
      : 'Disconnected';

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '1.5rem 1rem', display: 'flex', flexDirection: 'column', height: '100dvh', boxSizing: 'border-box', gap: '1rem' }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Link href="/" style={{ color: 'var(--text-muted)', fontSize: '1.3rem' }}>
            ←
          </Link>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 800 }}>Broadcaster</h1>
        </div>

        <div className="pill" style={{ background: 'var(--surface2)', color: stateColor }}>
          <span className={`dot${connState === 'connected' && broadcasting ? ' dot-pulse' : ''}`} />
          {stateLabel}
          {broadcasting && connState === 'connected' && (
            <span style={{ marginLeft: 4 }}>· LIVE</span>
          )}
        </div>
      </div>

      {/* ── Controls bar ───────────────────────────────────────────────── */}
      <div
        className="card"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        {!broadcasting ? (
          <button
            className="btn btn-primary"
            onClick={startBroadcast}
            disabled={connState !== 'connected'}
            style={{ opacity: connState !== 'connected' ? 0.5 : 1 }}
          >
            Start Broadcast
          </button>
        ) : (
          <button className="btn btn-danger" onClick={stopBroadcast}>
            Stop
          </button>
        )}

        {/* STT indicator */}
        {broadcasting && (
          <div
            className="pill"
            style={{
              background: debug.sttConnected
                ? 'rgba(34,197,94,.15)'
                : 'rgba(239,68,68,.15)',
              color: debug.sttConnected ? 'var(--green)' : 'var(--red)',
            }}
          >
            <span className={`dot${debug.sttConnected ? ' dot-pulse' : ''}`} />
            STT {debug.sttConnected ? 'Active' : 'Waiting'}
          </div>
        )}

        {/* Debug metrics inline */}
        {broadcasting && debug.e2eLatencyMs > 0 && (
          <div className="pill" style={{ background: 'var(--surface2)', color: 'var(--text-muted)' }}>
            {debug.e2eLatencyMs}ms e2e
          </div>
        )}

        <a
          href="/listen"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost"
          style={{ marginLeft: 'auto', fontSize: '0.85rem', padding: '0.5rem 1rem' }}
        >
          Open Listener
        </a>
      </div>

      {/* ── Rolling script ──────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="card"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '1.5rem',
          lineHeight: 1.8,
        }}
      >
        {script.length > 0 || liveKorean ? (
          <div>
            {/* Translated segments */}
            {script.map((entry, i) => (
              <p key={entry.seq} style={{ marginBottom: '0.8rem', fontSize: '1.05rem' }}>
                <span style={{ color: 'var(--text)' }}>{entry.sermon}</span>
                {entry.korean && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', display: 'block', marginTop: '0.2rem' }}>
                    {entry.korean}
                  </span>
                )}
              </p>
            ))}

            {/* Live Korean being transcribed (not yet translated) */}
            {liveKorean && (
              <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '0.95rem' }}>
                {liveKorean}…
              </p>
            )}
          </div>
        ) : (
          <p style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {broadcasting ? 'Listening…' : 'Start a broadcast to begin translating.'}
          </p>
        )}
      </div>

      {/* ── Errors ──────────────────────────────────────────────────────── */}
      {errors.length > 0 && (
        <div
          className="card"
          style={{
            borderColor: 'rgba(239,68,68,.4)',
            background: 'rgba(239,68,68,.05)',
            flexShrink: 0,
          }}
        >
          <div className="label" style={{ color: 'var(--red)' }}>Errors</div>
          {errors.map((e, i) => (
            <p key={i} style={{ color: 'var(--red)', fontSize: '0.85rem', marginTop: '0.35rem' }}>
              {e}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
