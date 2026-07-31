'use client';

/**
 * /speak — the broadcast desk (redesign screen 1c).
 *
 * Everything a volunteer needs lives in the left rail and never moves:
 * End broadcast → Direction → Sound source (with a live input meter) →
 * Pacing → Congregation link. The old debug panel becomes three
 * plain-language health readings, with the raw figures behind DIAGNOSTICS.
 *
 * All wire behavior is unchanged: same WsClient lifecycle, heartbeat,
 * auto-resume, start/stop/mode/direction messages, church + device
 * persistence, QR share, and error surfacing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
const DIRECTION_STORAGE_KEY = 'shema-direction';

type Mode = 'fast' | 'smooth';
type Direction = 'ko-en' | 'en-ko';
type ConnState = 'disconnected' | 'connecting' | 'connected';

const DIRECTION_LABELS: Record<Direction, string> = {
  'ko-en': '한국어 → EN',
  'en-ko': 'EN → 한국어',
};

interface DebugPanel {
  chunkSize: number;
  chunkerWaitMs: number;
  translationLatencyMs: number;
  ttsFirstByteMs: number;
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
  chunkerWaitMs: 0,
  translationLatencyMs: 0,
  ttsFirstByteMs: 0,
  ttsLatencyMs: 0,
  e2eLatencyMs: 0,
  sttConnected: false,
};

const MONO: React.CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)',
  textTransform: 'uppercase',
  letterSpacing: '0.18em',
};

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** 15-bar live input meter fed by the capture's PCM RMS (via a ref). */
function InputMeter({ levelRef, active }: { levelRef: React.MutableRefObject<number>; active: boolean }) {
  const [level, setLevel] = useState(0);
  const lastSignalRef = useRef(0);
  useEffect(() => {
    if (!active) { setLevel(0); return; }
    const t = setInterval(() => {
      const v = levelRef.current;
      if (v > 0.02) lastSignalRef.current = Date.now();
      setLevel(v);
    }, 150);
    return () => clearInterval(t);
  }, [active, levelRef]);

  const lit = Math.round(Math.min(1, level * 6) * 15);
  const good = active && Date.now() - lastSignalRef.current < 2000;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 18, flex: 1 }} aria-hidden>
        {Array.from({ length: 15 }, (_, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: `${40 + (i % 4) * 18}%`,
              borderRadius: 1,
              background: i < lit ? 'var(--sage)' : 'rgba(244,241,234,0.14)',
              opacity: i >= 11 ? 0.35 : 1,
              transition: 'background 0.15s linear',
            }}
          />
        ))}
      </div>
      <span style={{ ...MONO, fontSize: 9, color: good ? 'var(--sage)' : 'rgba(244,241,234,0.35)' }}>
        {active ? (good ? 'Signal good' : 'No signal') : 'Idle'}
      </span>
    </div>
  );
}

export default function SpeakPage() {
  // Staff page: redirects to /login when the backend enforces auth.
  const gate = useRequireAuth();
  const [connState, setConnState] = useState<ConnState>('disconnected');
  const [broadcasting, setBroadcasting] = useState(false);
  const [mode, setMode] = useState<Mode>('smooth');
  const [direction, setDirection] = useState<Direction>('ko-en');
  const [script, setScript] = useState<ScriptEntry[]>([]);
  const [liveKorean, setLiveKorean] = useState('');
  const [debug, setDebug] = useState<DebugPanel>(DEFAULT_DEBUG);
  const [errors, setErrors] = useState<string[]>([]);
  const [listenerCount, setListenerCount] = useState(0);
  const [showDiag, setShowDiag] = useState(false);
  const [elapsed, setElapsed] = useState('00:00:00');

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
  const directionRef = useRef<Direction>('ko-en');
  const lastPongRef = useRef(0);
  const lastBeatRef = useRef(0);
  const missedBeatsRef = useRef(0);
  // Live input level (RMS of the last PCM chunk), fed by the capture callback.
  const levelRef = useRef(0);
  const startedAtRef = useRef(0);

  // Restore the last-used direction (persists across services).
  useEffect(() => {
    const saved = window.localStorage.getItem(DIRECTION_STORAGE_KEY);
    if (saved === 'ko-en' || saved === 'en-ko') {
      setDirection(saved);
      directionRef.current = saved;
    }
  }, []);

  const handleDirectionChange = (d: Direction) => {
    setDirection(d);
    directionRef.current = d;
    try { window.localStorage.setItem(DIRECTION_STORAGE_KEY, d); } catch {}
  };

  // Elapsed on-air clock.
  useEffect(() => {
    if (!broadcasting) return;
    if (!startedAtRef.current) startedAtRef.current = Date.now();
    const t = setInterval(() => setElapsed(formatElapsed(Date.now() - startedAtRef.current)), 1000);
    return () => clearInterval(t);
  }, [broadcasting]);

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
  }, [script, liveKorean]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 60;
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
          chunkerWaitMs: d.chunkerWaitMs ?? 0,
          translationLatencyMs: d.translationLatencyMs,
          ttsFirstByteMs: d.ttsFirstByteMs ?? 0,
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
          client.sendJSON({
            type: 'start',
            mode: modeRef.current,
            direction: directionRef.current,
            token: getToken() ?? undefined,
          });
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
    //
    // IMPORTANT: judged by MISSED REPLIES to pings we actually sent, never by
    // wall-clock. Chrome throttles background-tab timers to ~1/min (operator
    // watches the sermon/video in another tab!) — a wall-clock check woke up
    // after the throttled stretch, saw "no pong in 45s" for pings it never
    // sent, and tore down its own healthy connection, ending the broadcast.
    lastPongRef.current = Date.now();
    lastBeatRef.current = 0;
    missedBeatsRef.current = 0;
    const heartbeat = setInterval(() => {
      if (!client.isConnected) return;
      // Did the PREVIOUS beat's ping get a reply (however long ago that was)?
      if (lastBeatRef.current > 0) {
        if (lastPongRef.current >= lastBeatRef.current) {
          missedBeatsRef.current = 0;
        } else {
          missedBeatsRef.current++;
        }
      }
      if (missedBeatsRef.current >= 3) {
        console.warn('[Speak] 3 pings unanswered — connection is half-dead, forcing reconnect');
        missedBeatsRef.current = 0;
        lastPongRef.current = Date.now(); // avoid immediate re-trigger
        client.forceReconnect();
        return;
      }
      lastBeatRef.current = Date.now();
      client.sendJSON({ type: 'ping' });
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

  // ── Start / Stop broadcast ───────────────────────────────────────────────
  const startBroadcast = async () => {
    if (broadcasting || !wsRef.current?.isConnected) return;

    try {
      const capture = new AudioCapture({
        chunkIntervalMs: 200,
        deviceId: deviceId || undefined,
        onChunk: (pcm) => {
          wsRef.current?.sendBinary(pcm);
          // Cheap RMS for the rail's input meter.
          const view = new Int16Array(pcm);
          let sum = 0;
          for (let i = 0; i < view.length; i += 8) sum += view[i] * view[i];
          levelRef.current = Math.sqrt(sum / Math.max(1, view.length / 8)) / 32768;
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
      wsRef.current.sendJSON({ type: 'start', mode, direction, token: getToken() ?? undefined });
      wantBroadcastRef.current = true;
      startedAtRef.current = Date.now();
      setElapsed('00:00:00');
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
    levelRef.current = 0;
  };

  const stopBroadcast = () => {
    wantBroadcastRef.current = false;
    stopCapture();
    wsRef.current?.sendJSON({ type: 'stop' });
    setBroadcasting(false);
    setLiveDeviceLabel('');
    startedAtRef.current = 0;
  };

  const handleModeChange = (m: Mode) => {
    setMode(m);
    modeRef.current = m;
    if (broadcasting) {
      wsRef.current?.sendJSON({ type: 'mode', mode: m });
    }
  };

  // ── Derived ──────────────────────────────────────────────────────────────
  const srcIsKorean = direction === 'ko-en';
  const hearing = broadcasting && debug.sttConnected;
  const onAir = broadcasting && connState === 'connected';

  // Waiting on the auth check (or being redirected to /login) — render nothing.
  if (gate !== 'ok') return null;

  const railCard: React.CSSProperties = {
    border: '1px solid rgba(244,241,234,0.12)',
    borderRadius: 10,
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  };
  const railLabel: React.CSSProperties = { ...MONO, fontSize: 9.5, color: 'rgba(244,241,234,0.45)' };

  return (
    <div className="sp-root">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          padding: '12px clamp(14px, 2vw, 24px)',
          borderBottom: '1px solid rgba(244,241,234,0.08)',
        }}
      >
        <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--gold)' }} title="Home">
          <svg width="12" height="16" viewBox="0 0 24 32" fill="none" aria-hidden>
            <line x1="12" y1="1" x2="12" y2="31" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <span style={{ ...MONO, fontSize: 11, letterSpacing: '0.24em' }}>Shema</span>
        </Link>
        <span style={{ width: 1, height: 18, background: 'rgba(244,241,234,0.12)' }} aria-hidden />
        <span className="serif-en" style={{ fontSize: 19, color: 'rgba(244,241,234,0.9)' }}>Broadcast desk</span>

        {/* Church slug: chip while live, editable field otherwise */}
        <input
          className="field"
          value={churchDraft}
          onChange={(e) => setChurchDraft(e.target.value)}
          onBlur={commitChurch}
          onKeyDown={(e) => { if (e.key === 'Enter') commitChurch(); }}
          disabled={broadcasting}
          placeholder="church-slug"
          aria-label="Church room"
          style={{ width: 130, padding: '5px 10px', fontSize: 12.5, fontFamily: 'var(--font-mono, monospace)', borderRadius: 999 }}
        />

        {/* Pacing echo — visible without looking down at the rail */}
        {broadcasting && (
          <span
            style={{
              ...MONO,
              fontSize: 9,
              color: 'var(--night)',
              background: 'var(--gold)',
              borderRadius: 999,
              padding: '4px 10px',
            }}
          >
            {mode} pacing
          </span>
        )}

        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          {broadcasting && (
            <span style={{ ...MONO, fontSize: 11, color: 'rgba(244,241,234,0.6)' }}>{elapsed}</span>
          )}
          <span
            className="pill"
            style={{
              color: onAir ? 'var(--sage)' : connState === 'connecting' ? 'var(--gold-hover)' : connState === 'disconnected' ? 'var(--alert)' : 'rgba(244,241,234,0.5)',
              borderColor: 'currentColor',
            }}
          >
            <span className={`dot${onAir ? ' dot-pulse' : ''}`} />
            {onAir ? 'On air' : connState === 'connected' ? 'Ready' : connState === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
        </span>
      </div>

      {/* ── Desk grid ───────────────────────────────────────────────────── */}
      <div className="sp-grid" style={{ flex: 1, minHeight: 0, padding: 'clamp(12px, 1.6vw, 20px)', gap: 14 }}>
        {/* ── Left rail ── */}
        <aside className="sp-rail" style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {/* 1. Start / End broadcast */}
          {!broadcasting ? (
            <button
              onClick={startBroadcast}
              disabled={connState !== 'connected'}
              style={{
                width: '100%',
                padding: '15px 16px',
                borderRadius: 10,
                fontSize: 16,
                fontWeight: 600,
                background: 'var(--gold)',
                color: 'var(--night)',
                opacity: connState !== 'connected' ? 0.5 : 1,
                transition: 'background 0.3s var(--ease)',
              }}
            >
              ● Start broadcast
            </button>
          ) : (
            <button
              onClick={stopBroadcast}
              style={{
                width: '100%',
                padding: '15px 16px',
                borderRadius: 10,
                fontSize: 16,
                fontWeight: 600,
                background: 'rgba(255,138,128,0.09)',
                color: 'var(--alert)',
                border: '1px solid rgba(255,138,128,0.4)',
              }}
            >
              ■ End broadcast
            </button>
          )}

          {/* 2. Direction */}
          <div style={railCard}>
            <span style={railLabel}>Direction</span>
            <div className="toggle-group">
              {(['ko-en', 'en-ko'] as const).map((d) => (
                <button
                  key={d}
                  className={`toggle-opt${direction === d ? ' active' : ''}`}
                  onClick={() => handleDirectionChange(d)}
                  disabled={broadcasting}
                  title={d === 'ko-en' ? 'Korean sermon in, English audio out' : 'English sermon in, Korean audio out'}
                  style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, textTransform: 'none', letterSpacing: 0 }}
                >
                  {DIRECTION_LABELS[d]}
                </button>
              ))}
            </div>
          </div>

          {/* 3. Sound source */}
          <div style={railCard}>
            <span style={railLabel}>Sound source</span>
            <select
              className="field"
              value={deviceId}
              onChange={(e) => selectDevice(e.target.value)}
              disabled={broadcasting}
              title={broadcasting && liveDeviceLabel ? `Live: ${liveDeviceLabel}` : undefined}
              style={{ width: '100%', fontSize: 13 }}
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
                style={{ fontSize: '0.72rem', padding: '0.35rem 0.6rem', alignSelf: 'flex-start' }}
                title="Grant mic access once so device names show up"
              >
                List devices
              </button>
            )}
            <InputMeter levelRef={levelRef} active={broadcasting} />
          </div>

          {/* 4. Pacing */}
          <div style={railCard}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <span style={railLabel}>Pacing</span>
              <span style={{ ...MONO, fontSize: 8.5, color: 'var(--sage)' }}>Safe to change on air</span>
            </div>
            <div className="toggle-group">
              <button
                className={`toggle-opt${mode === 'fast' ? ' active-cream' : ''}`}
                onClick={() => handleModeChange('fast')}
                title="Lower latency; rougher sentence edges"
              >
                Fast
              </button>
              <button
                className={`toggle-opt${mode === 'smooth' ? ' active-cream' : ''}`}
                onClick={() => handleModeChange('smooth')}
                title="Waits for natural pauses; cleanest sentences"
              >
                Smooth
              </button>
            </div>
          </div>

          {/* 5. Congregation link — pinned to the rail's bottom */}
          {church && (
            <div style={{ ...railCard, marginTop: 'auto', borderColor: 'rgba(200,162,94,0.45)', background: 'rgba(200,162,94,0.05)' }}>
              <span style={{ ...railLabel, color: 'var(--gold)' }}>Congregation link</span>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                {qrDataUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={qrDataUrl}
                    alt={`QR code for ${listenUrl}`}
                    width={78}
                    height={78}
                    style={{ borderRadius: 4, background: '#fff', padding: 3, flexShrink: 0 }}
                  />
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                  <code style={{ fontSize: 11.5, wordBreak: 'break-all', color: 'rgba(244,241,234,0.75)' }}>
                    {listenUrl.replace(/^https?:\/\//, '')}
                  </code>
                  <button
                    onClick={copyLink}
                    style={{
                      ...MONO,
                      fontSize: 9,
                      alignSelf: 'flex-start',
                      padding: '5px 12px',
                      borderRadius: 6,
                      border: '1px solid rgba(244,241,234,0.16)',
                      color: 'rgba(244,241,234,0.75)',
                    }}
                  >
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </aside>

        {/* ── Right pane ── */}
        <main style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, minWidth: 0 }}>
          {/* Health strip */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'clamp(14px, 2.4vw, 34px)',
              flexWrap: 'wrap',
              border: '1px solid rgba(244,241,234,0.12)',
              borderRadius: 10,
              padding: '12px 18px',
            }}
          >
            <div>
              <div style={railLabel}>Hearing the pastor</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span className={`dot${hearing ? ' dot-pulse' : ''}`} style={{ color: hearing ? 'var(--sage)' : 'rgba(244,241,234,0.3)' }} />
                <span style={{ fontSize: 15, fontWeight: 600, color: hearing ? 'var(--sage)' : 'rgba(244,241,234,0.5)' }}>
                  {hearing ? 'Yes' : broadcasting ? 'Waiting' : '—'}
                </span>
              </div>
            </div>
            <div>
              <div style={railLabel}>Delay to the pews</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'rgba(244,241,234,0.9)', marginTop: 4 }}>
                {debug.e2eLatencyMs > 0 ? `${(debug.e2eLatencyMs / 1000).toFixed(1)} seconds` : '—'}
              </div>
            </div>
            <div>
              <div style={railLabel}>Listening now</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'rgba(244,241,234,0.9)', marginTop: 4 }}>
                {listenerCount} {listenerCount === 1 ? 'person' : 'people'}
              </div>
            </div>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                onClick={() => setShowDiag((v) => !v)}
                style={{
                  ...MONO,
                  fontSize: 9,
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: '1px solid rgba(244,241,234,0.16)',
                  color: showDiag ? 'var(--night)' : 'rgba(244,241,234,0.6)',
                  background: showDiag ? 'rgba(244,241,234,0.9)' : 'transparent',
                }}
              >
                Diagnostics
              </button>
              <a
                href={church ? `/listen/${church}` : '/listen'}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...MONO, fontSize: 9, padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(244,241,234,0.16)', color: 'rgba(244,241,234,0.6)' }}
              >
                Open listener ↗
              </a>
            </span>
          </div>

          {/* Diagnostics disclosure — the old raw figures */}
          {showDiag && (
            <div className="debug-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
              {[
                [`${debug.chunkSize}`, 'last chunk (chars)'],
                [`${debug.chunkerWaitMs}ms`, 'chunker wait'],
                [`${debug.translationLatencyMs}ms`, 'translation'],
                [`${debug.ttsFirstByteMs}ms`, 'tts first byte'],
                [`${debug.ttsLatencyMs}ms`, 'tts total'],
                [`${debug.e2eLatencyMs}ms`, 'end-to-end'],
                [debug.sttConnected ? 'yes' : 'no', 'stt connected'],
                [`${listenerCount}`, 'listeners'],
              ].map(([val, key]) => (
                <div key={key} className="debug-item">
                  <div className="debug-val" style={{ fontSize: '1rem' }}>{val}</div>
                  <div className="debug-key">{key}</div>
                </div>
              ))}
            </div>
          )}

          {/* Transcript */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            style={{
              flex: 1,
              minHeight: 200,
              overflowY: 'auto',
              border: '1px solid rgba(244,241,234,0.12)',
              borderRadius: 10,
              padding: 'clamp(14px, 1.8vw, 22px)',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)',
                gap: '0 clamp(14px, 2vw, 28px)',
                paddingBottom: 8,
                borderBottom: '1px solid rgba(244,241,234,0.12)',
                marginBottom: 4,
              }}
            >
              <span style={{ ...MONO, fontSize: 9, color: 'rgba(244,241,234,0.42)' }}>
                {srcIsKorean ? '한국어 · Spoken' : 'English · Spoken'}
              </span>
              <span style={{ ...MONO, fontSize: 9, color: 'var(--gold)' }}>
                {srcIsKorean ? 'English · Sent to the pews' : '한국어 · Sent to the pews'}
              </span>
            </div>

            {script.length > 0 || liveKorean ? (
              <>
                {script.map((entry, i) => {
                  const fromEnd = script.length - 1 - i;
                  const opacity = liveKorean ? (fromEnd === 0 ? 1 : fromEnd === 1 ? 0.42 : 0.32) : fromEnd === 0 ? 1 : fromEnd === 1 ? 0.42 : 0.32;
                  return (
                    <div
                      key={entry.seq}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)',
                        gap: '0 clamp(14px, 2vw, 28px)',
                        padding: '12px 0',
                        borderTop: i === 0 ? 'none' : '1px solid rgba(244,241,234,0.08)',
                        opacity,
                        transition: 'opacity 0.5s var(--ease)',
                      }}
                    >
                      <span
                        className={srcIsKorean ? 'serif-kr' : 'serif-en'}
                        lang={srcIsKorean ? 'ko' : 'en'}
                        style={{ fontSize: 15, lineHeight: 1.65, color: 'rgba(244,241,234,0.75)' }}
                      >
                        {entry.korean}
                      </span>
                      <span
                        className={srcIsKorean ? 'serif-en' : 'serif-kr'}
                        lang={srcIsKorean ? 'en' : 'ko'}
                        style={{ fontSize: 19, lineHeight: 1.55, color: 'var(--cream)' }}
                      >
                        {entry.sermon}
                      </span>
                    </div>
                  );
                })}

                {/* In-progress source line */}
                {liveKorean && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)',
                      gap: '0 clamp(14px, 2vw, 28px)',
                      padding: '12px 0',
                      borderTop: '1px solid rgba(244,241,234,0.08)',
                    }}
                  >
                    <span
                      className={srcIsKorean ? 'serif-kr' : 'serif-en'}
                      lang={srcIsKorean ? 'ko' : 'en'}
                      style={{ fontSize: 15, lineHeight: 1.65, fontStyle: 'italic', color: 'rgba(244,241,234,0.6)' }}
                    >
                      {liveKorean}
                      <span className="caret" aria-hidden>▍</span>
                    </span>
                    <span style={{ ...MONO, fontSize: 9, color: 'rgba(244,241,234,0.35)', alignSelf: 'center' }}>
                      Holding for the sentence…
                    </span>
                  </div>
                )}
              </>
            ) : (
              <p className="serif-en" style={{ color: 'rgba(244,241,234,0.4)', fontStyle: 'italic', padding: '18px 0' }}>
                {broadcasting ? 'Listening…' : 'Start a broadcast to begin translating.'}
              </p>
            )}
          </div>

          {/* Errors */}
          {errors.length > 0 && (
            <div
              style={{
                border: '1px solid rgba(255,138,128,0.4)',
                background: 'rgba(255,138,128,0.05)',
                borderRadius: 10,
                padding: '10px 16px',
              }}
            >
              <div style={{ ...MONO, fontSize: 9, color: 'var(--alert)', marginBottom: 4 }}>Errors</div>
              {errors.map((e, i) => (
                <p key={i} style={{ color: 'var(--alert)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                  {e}
                </p>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
