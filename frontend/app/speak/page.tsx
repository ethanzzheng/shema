'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import QRCode from 'qrcode';
import { WsClient, ServerMessage, DebugMsg, TranslationMsg } from '@/lib/ws-client';
import { AudioCapture } from '@/lib/audio-capture';
import { getBackendWsUrl } from '@/lib/backend-config';
import { normalizeChurchSlug } from '@/lib/slug';
import { getToken, getUsername } from '@/lib/auth';
import { useRequireAuth } from '@/lib/use-require-auth';

const CHURCH_STORAGE_KEY = 'shema-church';
const DEVICE_STORAGE_KEY = 'shema-input-device';

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

export default function SpeakPage() {
  // Staff page: redirects to /login when the backend enforces auth.
  const gate = useRequireAuth();
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [broadcasting, setBroadcasting] = useState(false);
  const [mode, setMode] = useState<Mode>('smooth');
  const [script, setScript] = useState<ScriptEntry[]>([]);
  const [liveKorean, setLiveKorean] = useState('');
  const [debug, setDebug] = useState<DebugPanel>(DEFAULT_DEBUG);
  const [errors, setErrors] = useState<string[]>([]);
  const [listenerCount, setListenerCount] = useState(0);

  // Committed church room (drives the WS connection); null until read from
  // the URL/localStorage on mount. churchDraft is the input's live text.
  const [church, setChurch] = useState<string | null>(null);
  const [churchDraft, setChurchDraft] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [listenUrl, setListenUrl] = useState('');

  // Input device picker: '' = system default. Labels only populate once the
  // origin has mic permission; until then we offer a one-click unlock.
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [needsPermission, setNeedsPermission] = useState(false);
  const [liveDeviceLabel, setLiveDeviceLabel] = useState('');

  const wsRef = useRef<WsClient | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  // True from Start until a deliberate Stop — drives auto-resume after a
  // connection drop (the reconnect handler re-sends start while this is set).
  const wantBroadcastRef = useRef(false);
  const modeRef = useRef<Mode>('smooth');
  const lastPongRef = useRef(0);

  // ── Church room init: ?church= / legacy ?room= → last used → "default" ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('church') ?? params.get('room');
    // Signed-in staff default to their own church (username = church slug in
    // Phase A), beating any stale last-used room from testing.
    const slug = normalizeChurchSlug(
      fromUrl ?? getUsername() ?? window.localStorage.getItem(CHURCH_STORAGE_KEY) ?? 'default',
    );
    setChurch(slug);
    setChurchDraft(slug);
  }, []);

  const commitChurch = () => {
    const slug = normalizeChurchSlug(churchDraft);
    setChurchDraft(slug);
    if (slug !== church) setChurch(slug); // triggers a reconnect to the new room
    try { window.localStorage.setItem(CHURCH_STORAGE_KEY, slug); } catch {}
  };

  // ── Input devices: enumerate, persist choice, react to (un)plugs ────────
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === 'audioinput',
      );
      setDevices(list);
      const hasLabels = list.some((d) => d.label);
      setNeedsPermission(list.length > 0 && !hasLabels);
      // Drop a saved selection whose device is gone — but only once labels are
      // populated (before permission, enumerateDevices hides real deviceIds).
      if (hasLabels) {
        setDeviceId((prev) => (prev && !list.some((d) => d.deviceId === prev) ? '' : prev));
      }
    } catch {
      /* enumeration is best-effort */
    }
  }, []);

  useEffect(() => {
    setDeviceId(window.localStorage.getItem(DEVICE_STORAGE_KEY) ?? '');
    refreshDevices();
    const onChange = () => refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, [refreshDevices]);

  const selectDevice = (id: string) => {
    setDeviceId(id);
    try { window.localStorage.setItem(DEVICE_STORAGE_KEY, id); } catch {}
  };

  // One-off permission grab so device labels populate in the dropdown.
  const unlockDeviceLabels = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await refreshDevices();
    } catch (err) {
      setErrors((prev) => [...prev.slice(-4), `Mic permission error: ${(err as Error).message}`]);
    }
  };

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

  // ── WebSocket lifecycle (reconnects when the church room changes) ───────
  useEffect(() => {
    if (!church || gate !== 'ok') return;

    const client = new WsClient({
      url: getBackendWsUrl(),
      role: 'broadcaster',
      room: church,
      onOpen: () => {
        setConnState('connected');
        lastPongRef.current = Date.now();
        // Auto-resume: if a broadcast was live when the connection dropped,
        // restart it the instant we're back — the mic never stopped, so a
        // network blip costs seconds of silence instead of dead air until an
        // operator notices.
        if (wantBroadcastRef.current) {
          client.sendJSON({ type: 'start', mode: modeRef.current, token: getToken() ?? undefined });
          setBroadcasting(true);
        }
      },
      onClose: () => {
        setConnState('disconnected');
        // Keep the capture running while we intend to broadcast; onOpen
        // re-starts the session. Only a deliberate Stop tears the mic down.
        if (!wantBroadcastRef.current) {
          setBroadcasting(false);
        }
      },
      onError: () => setConnState('disconnected'),
      onMessage: handleMessage,
      reconnectDelayMs: 2000,
    });

    wsRef.current = client;
    setConnState('connecting');
    client.connect();

    // Heartbeat: flaky networks (hotspots, church Wi-Fi) can kill the path
    // without a close event — the socket says OPEN while nothing flows. Ping
    // the backend and force a reconnect when replies stop.
    lastPongRef.current = Date.now();
    const heartbeat = setInterval(() => {
      if (!client.isConnected) return;
      client.sendJSON({ type: 'ping' });
      if (Date.now() - lastPongRef.current > 45_000) {
        console.warn('[Speak] No heartbeat reply for 45s — connection is half-dead, forcing reconnect');
        lastPongRef.current = Date.now(); // avoid immediate re-trigger
        client.forceReconnect();
      }
    }, 15_000);

    return () => {
      clearInterval(heartbeat);
      client.disconnect();
      wsRef.current = null;
      stopCapture();
      wantBroadcastRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [church, gate]);

  // ── Shareable listener link + QR for the current room ───────────────────
  useEffect(() => {
    if (!church) return;
    const url = `${window.location.origin}/listen/${church}`;
    setListenUrl(url);
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [church]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(listenUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErrors((prev) => [...prev.slice(-4), 'Copy failed — copy the link manually.']);
    }
  };

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'status':
        // Deepgram connect/disconnect — the debug message also carries this,
        // but only after a full pipeline round-trip; this is the live signal.
        if ('sttConnected' in msg) {
          setDebug((prev) => ({ ...prev, sttConnected: msg.sttConnected as boolean }));
        }
        break;

      case 'transcript':
        if ('korean' in msg) setLiveKorean(msg.korean as string);
        break;

      case 'listeners':
        if ('count' in msg) setListenerCount(msg.count as number);
        break;

      case 'pong':
        lastPongRef.current = Date.now();
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
        deviceId: deviceId || undefined,
        onChunk: (pcm) => {
          wsRef.current?.sendBinary(pcm);
        },
        onDeviceEnded: () => {
          setErrors((prev) => [
            ...prev.slice(-4),
            'Input device disconnected — pick a device and start again.',
          ]);
          stopBroadcast();
          refreshDevices();
        },
      });

      await capture.start();
      captureRef.current = capture;
      setLiveDeviceLabel(capture.trackLabel);
      refreshDevices(); // permission just granted → labels populate

      // The login session token authorizes the start (backend-verified).
      wsRef.current.sendJSON({ type: 'start', mode, token: getToken() ?? undefined });
      wantBroadcastRef.current = true;
      setBroadcasting(true);

      setScript([]);
      setLiveKorean('');
      setErrors([]);
    } catch (err) {
      const e = err as Error;
      if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
        // Saved device no longer exists — fall back to default and re-list.
        selectDevice('');
        refreshDevices();
        setErrors((prev) => [
          ...prev.slice(-4),
          'Selected input device is unavailable — switched to System default. Start again.',
        ]);
      } else {
        setErrors((prev) => [...prev.slice(-4), `Mic error: ${e.message}`]);
      }
    }
  };

  const stopCapture = () => {
    captureRef.current?.stop();
    captureRef.current = null;
  };

  const stopBroadcast = () => {
    wantBroadcastRef.current = false;
    stopCapture();
    wsRef.current?.sendJSON({ type: 'stop' });
    setBroadcasting(false);
    setLiveDeviceLabel('');
  };

  const handleModeChange = (m: Mode) => {
    setMode(m);
    modeRef.current = m;
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

  // Waiting on the auth check (or being redirected to /login) — render nothing.
  if (gate !== 'ok') return null;

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
          <h1 style={{ fontSize: '1.65rem', fontWeight: 600 }}>Broadcaster</h1>
        </div>

        <div className="pill" style={{ background: 'var(--surface2)', color: stateColor }}>
          <span className={`dot${connState === 'connected' && broadcasting ? ' dot-pulse' : ''}`} />
          {stateLabel}
          {broadcasting && connState === 'connected' && (
            <span style={{ marginLeft: 4 }}>· LIVE</span>
          )}
        </div>
      </div>

      {/* ── Control panel ──────────────────────────────────────────────── */}
      <div
        className="card"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
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
            style={{ opacity: connState !== 'connected' ? 0.5 : 1, padding: '0.8rem 2rem', fontSize: '1rem' }}
          >
            ● Start Broadcast
          </button>
        ) : (
          <button className="btn btn-danger" onClick={stopBroadcast} style={{ padding: '0.8rem 2rem', fontSize: '1rem' }}>
            ■ Stop
          </button>
        )}

        {/* Church room */}
        <div>
          <div className="label" style={{ marginBottom: '0.3rem' }}>Church</div>
          <input
            className="field"
            value={churchDraft}
            onChange={(e) => setChurchDraft(e.target.value)}
            onBlur={commitChurch}
            onKeyDown={(e) => { if (e.key === 'Enter') commitChurch(); }}
            disabled={broadcasting}
            placeholder="e.g. grace-church"
            style={{ width: 150 }}
          />
        </div>

        {/* Input device */}
        <div>
          <div className="label" style={{ marginBottom: '0.3rem' }}>Input</div>
          <select
            className="field"
            value={deviceId}
            onChange={(e) => selectDevice(e.target.value)}
            disabled={broadcasting}
            title={broadcasting && liveDeviceLabel ? `Live: ${liveDeviceLabel}` : undefined}
            style={{ maxWidth: 210 }}
          >
            <option value="">System default</option>
            {devices
              .filter((d) => d.deviceId && d.deviceId !== 'default')
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
          {needsPermission && !broadcasting && (
            <button
              className="btn btn-ghost"
              onClick={unlockDeviceLabels}
              style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', marginLeft: 6 }}
              title="Grant mic access once so device names show up"
            >
              List devices
            </button>
          )}
        </div>

        {/* Pacing */}
        <div>
          <div className="label" style={{ marginBottom: '0.3rem' }}>Pacing</div>
          <div className="toggle-group">
            <button
              className={`toggle-opt${mode === 'fast' ? ' active' : ''}`}
              onClick={() => handleModeChange('fast')}
              title="Lower latency; rougher sentence edges"
            >
              Fast
            </button>
            <button
              className={`toggle-opt${mode === 'smooth' ? ' active' : ''}`}
              onClick={() => handleModeChange('smooth')}
              title="Waits for natural pauses; cleanest sentences"
            >
              Smooth
            </button>
          </div>
        </div>

        <a
          href={church ? `/listen/${church}` : '/listen'}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost"
          style={{ marginLeft: 'auto', fontSize: '0.85rem', padding: '0.5rem 1rem' }}
        >
          Open Listener
        </a>
      </div>

      {/* ── Status row (live) ──────────────────────────────────────────── */}
      {broadcasting && (
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', flexShrink: 0 }}>
          <div className={`pill ${debug.sttConnected ? 'pill-green' : 'pill-red'}`}>
            <span className={`dot${debug.sttConnected ? ' dot-pulse' : ''}`} />
            STT {debug.sttConnected ? 'Active' : 'Waiting'}
          </div>
          <div className="pill pill-yellow">
            <span className="dot" />
            {listenerCount} listening
          </div>
          {debug.e2eLatencyMs > 0 && (
            <div className="pill pill-muted">{(debug.e2eLatencyMs / 1000).toFixed(1)}s delay</div>
          )}
          {liveDeviceLabel && (
            <div className="pill pill-muted" style={{ maxWidth: 260 }} title={liveDeviceLabel}>
              🎙 <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{liveDeviceLabel}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Share card (QR + link for congregants) ─────────────────────── */}
      {church && (
        <div
          className="card"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1.25rem',
            flexWrap: 'wrap',
            flexShrink: 0,
            borderColor: 'rgba(201,169,97,.45)',
            background: 'rgba(201,169,97,.05)',
          }}
        >
          {qrDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrDataUrl}
              alt={`QR code for ${listenUrl}`}
              width={120}
              height={120}
              style={{ borderRadius: 2, background: '#fff', padding: 4 }}
            />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 220, flex: 1 }}>
            <div className="label">Congregation link — scan or share</div>
            <code style={{ fontSize: '0.95rem', wordBreak: 'break-all', color: 'var(--text)' }}>{listenUrl}</code>
            <div>
              <button className="btn btn-ghost" onClick={copyLink} style={{ fontSize: '0.85rem', padding: '0.45rem 0.9rem' }}>
                {copied ? 'Copied ✓' : 'Copy link'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rolling script ──────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="card prose-serif"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '1.5rem',
          lineHeight: 1.85,
        }}
      >
        {script.length > 0 || liveKorean ? (
          <div>
            {/* Translated segments */}
            {script.map((entry) => (
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

      {/* ── Debug (collapsed by default — out of a volunteer's way) ────── */}
      <details className="card" style={{ flexShrink: 0, padding: '0.8rem 1.25rem' }}>
        <summary className="label" style={{ cursor: 'pointer', marginBottom: 0, userSelect: 'none' }}>
          Debug
        </summary>
        <div className="debug-grid" style={{ marginTop: '0.9rem', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <div className="debug-item">
            <div className="debug-val">{debug.chunkSize}</div>
            <div className="debug-key">last chunk (chars)</div>
          </div>
          <div className="debug-item">
            <div className="debug-val">{debug.translationLatencyMs}ms</div>
            <div className="debug-key">translation</div>
          </div>
          <div className="debug-item">
            <div className="debug-val">{debug.ttsLatencyMs}ms</div>
            <div className="debug-key">tts</div>
          </div>
          <div className="debug-item">
            <div className="debug-val">{debug.e2eLatencyMs}ms</div>
            <div className="debug-key">end-to-end</div>
          </div>
          <div className="debug-item">
            <div className="debug-val">{debug.sttConnected ? 'yes' : 'no'}</div>
            <div className="debug-key">stt connected</div>
          </div>
          <div className="debug-item">
            <div className="debug-val">{listenerCount}</div>
            <div className="debug-key">listeners</div>
          </div>
        </div>
      </details>

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
