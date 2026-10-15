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
import { ArrowSquareOut, CaretDown, Check, Copy, Headphones, X } from '@phosphor-icons/react';
import { AccountMenu, Brand, Seg } from '@/components/app/chrome';
import {
  addGlossaryTerm,
  deleteGlossaryTerm,
  describeTerm,
  fetchGlossary,
  parseTermEntry,
  type GlossaryTerm,
  glossaryExample,
} from '@/lib/glossary';
import QRCode from 'qrcode';
import { WsClient, ServerMessage, DebugMsg, TranslationMsg, AudioChunkMsg } from '@/lib/ws-client';
import { AudioCapture } from '@/lib/audio-capture';
import { AudioStreamPlayer, base64ToBytes } from '@/lib/audio-stream';
import { getBackendWsUrl } from '@/lib/backend-config';
import { normalizeChurchSlug } from '@/lib/slug';
import { fetchAllowedDirections, getToken, getUsername } from '@/lib/auth';
import { useRequireAuth } from '@/lib/use-require-auth';
import '@/components/app/desk.css';

const CHURCH_STORAGE_KEY = 'shema-church';
const DEVICE_STORAGE_KEY = 'shema-input-device';
const DIRECTION_STORAGE_KEY = 'shema-direction';
const OUTPUT_DEVICE_STORAGE_KEY = 'shema-output-device';
const LOCAL_VOLUME_STORAGE_KEY = 'shema-local-volume';

type Mode = 'fast' | 'smooth';
type Direction = 'ko-en' | 'en-ko' | 'zh-en';
type ConnState = 'disconnected' | 'connecting' | 'connected';

const DIRECTION_LABELS: Record<Direction, string> = {
  'ko-en': '한국어 → EN',
  'en-ko': 'EN → 한국어',
  'zh-en': '中文 → EN',
};

/** How each direction's source and translation columns are labelled and typeset. */
const DIRECTION_META: Record<
  Direction,
  { title: string; srcLabel: string; tgtLabel: string; srcClass: string; srcLang: string; tgtClass: string; tgtLang: string }
> = {
  'ko-en': {
    title: 'Korean sermon in, English audio out',
    srcLabel: '한국어 · Spoken', tgtLabel: 'English · Sent to the pews',
    srcClass: 'serif-kr', srcLang: 'ko', tgtClass: 'serif-en', tgtLang: 'en',
  },
  'en-ko': {
    title: 'English sermon in, Korean audio out',
    srcLabel: 'English · Spoken', tgtLabel: '한국어 · Sent to the pews',
    srcClass: 'serif-en', srcLang: 'en', tgtClass: 'serif-kr', tgtLang: 'ko',
  },
  'zh-en': {
    title: 'Mandarin sermon in, English audio out',
    srcLabel: '中文 · Spoken', tgtLabel: 'English · Sent to the pews',
    srcClass: 'serif-zh', srcLang: 'zh-Hans', tgtClass: 'serif-en', tgtLang: 'en',
  },
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

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Cheap RMS over every 8th sample — enough for a meter, not worth more. */
function pcmLevel(pcm: ArrayBuffer): number {
  const view = new Int16Array(pcm);
  let sum = 0;
  for (let i = 0; i < view.length; i += 8) sum += view[i] * view[i];
  return Math.sqrt(sum / Math.max(1, view.length / 8)) / 32768;
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
    <div className="ap-meter-row">
      <div className="ap-meter dk-meter" aria-hidden>
        {Array.from({ length: 15 }, (_, i) => (
          <span key={i} className={i < lit ? 'on' : ''} style={{ height: `${40 + (i % 4) * 18}%` }} />
        ))}
      </div>
      <span className={good ? 'ap-ok' : 'ap-muted'}>
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
  // The directions this church account is set up for; null until known (or
  // if the server can't say), which shows them all.
  const [allowedDirections, setAllowedDirections] = useState<Direction[] | null>(null);
  const [script, setScript] = useState<ScriptEntry[]>([]);
  const [liveKorean, setLiveKorean] = useState('');
  const [debug, setDebug] = useState<DebugPanel>(DEFAULT_DEBUG);

  // ── Glossary ("Terms") ──────────────────────────────────────────────────
  // Names and terms the pipeline must get right. Church-scope terms are
  // permanent; service-scope ones belong to this broadcast. Adding one takes
  // effect on the next translated sentence.
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [termDraft, setTermDraft] = useState('');
  const [termServiceOnly, setTermServiceOnly] = useState(true);
  const [termsOpen, setTermsOpen] = useState(false);
  const [termBusy, setTermBusy] = useState(false);
  const [termError, setTermError] = useState('');
  const [termsReadOnly, setTermsReadOnly] = useState(false);

  // Whether a transcript is actually being kept for this broadcast. Reported
  // by the backend rather than assumed: with no database reachable, nothing is
  // stored, and an indicator that said otherwise would be a lie about what the
  // church has a record of.
  const [recordingTranscript, setRecordingTranscript] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [listenerCount, setListenerCount] = useState(0);
  const [showDiag, setShowDiag] = useState(false);
  const [elapsed, setElapsed] = useState('00:00:00');
  // The seq the most-behind listener's audio is actually playing.
  const [pewsSeq, setPewsSeq] = useState(0);

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

  // ── Local output ("one laptop" mode for soundboard churches) ─────────────
  // Plays the translated audio stream — the same one listeners get — through
  // a chosen OUTPUT device via setSinkId, while capture stays on the chosen
  // input. The kiosk page remains for the two-device setup.
  const [localOutput, setLocalOutput] = useState(false);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState('');
  const [outVolume, setOutVolume] = useState(1);
  const [toneBusy, setToneBusy] = useState(false);
  const [sinkSupported, setSinkSupported] = useState(true);
  const outWsRef = useRef<WsClient | null>(null);
  const outStreamRef = useRef<AudioStreamPlayer | null>(null);
  const outVolumeRef = useRef(1);
  const outSinkRef = useRef('');
  const toneCtxRef = useRef<AudioContext | null>(null);
  const outReportRef = useRef<{ seq: number; at: number }>({ seq: 0, at: 0 });

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
  // A second, listen-only capture that runs while NOT broadcasting, purely to
  // drive the meter. Nothing it hears leaves the machine — it never touches
  // the socket. A meter that only lights up once you are on air cannot tell
  // you the soundboard is dead, which is exactly when you need to know.
  const monitorRef = useRef<AudioCapture | null>(null);
  const [monitoring, setMonitoring] = useState(false);
  const startedAtRef = useRef(0);

  // Restore the last-used direction (persists across services).
  useEffect(() => {
    const saved = window.localStorage.getItem(DIRECTION_STORAGE_KEY);
    if (saved === 'ko-en' || saved === 'en-ko' || saved === 'zh-en') {
      setDirection(saved);
      directionRef.current = saved;
    }
  }, []);

  // Show only the languages this account has. If the last-used direction
  // isn't one of them (another account used this browser), fall back to the
  // account's first without overwriting the saved choice.
  useEffect(() => {
    if (gate !== 'ok') return;
    let cancelled = false;
    fetchAllowedDirections().then((list) => {
      if (cancelled || !list) return;
      const allowed = (['ko-en', 'en-ko', 'zh-en'] as const).filter((d) => list.includes(d));
      setAllowedDirections(allowed);
      if (allowed.length > 0 && !allowed.includes(directionRef.current)) {
        setDirection(allowed[0]);
        directionRef.current = allowed[0];
      }
    });
    return () => {
      cancelled = true;
    };
  }, [gate]);

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
      const all = await navigator.mediaDevices.enumerateDevices();
      const list = all.filter((d) => d.kind === 'audioinput');
      setDevices(list);
      setOutputDevices(all.filter((d) => d.kind === 'audiooutput'));
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
    setOutputDeviceId(window.localStorage.getItem(OUTPUT_DEVICE_STORAGE_KEY) ?? '');
    outSinkRef.current = window.localStorage.getItem(OUTPUT_DEVICE_STORAGE_KEY) ?? '';
    const v = parseFloat(window.localStorage.getItem(LOCAL_VOLUME_STORAGE_KEY) ?? '');
    if (!Number.isNaN(v) && v >= 0 && v <= 1) {
      setOutVolume(v);
      outVolumeRef.current = v;
    }
    setSinkSupported('setSinkId' in HTMLMediaElement.prototype);
    refreshDevices();
    const onChange = () => refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, [refreshDevices]);

  // Runs the meter while off air. Deliberately gated on labels already being
  // populated: that only happens once mic permission has been granted, so
  // landing on this page never triggers a permission prompt just to draw a
  // meter. Granting via "List devices" starts it immediately after.
  useEffect(() => {
    if (gate !== 'ok' || broadcasting) return;
    if (needsPermission || devices.length === 0) return;

    let cancelled = false;
    let cap: AudioCapture | null = null;

    (async () => {
      try {
        const c = new AudioCapture({
          chunkIntervalMs: 200,
          deviceId: deviceId || undefined,
          onChunk: (pcm) => { levelRef.current = pcmLevel(pcm); },
          onDeviceEnded: () => { setMonitoring(false); refreshDevices(); },
        });
        await c.start();
        if (cancelled) { c.stop(); return; }
        cap = c;
        monitorRef.current = c;
        setMonitoring(true);
      } catch {
        /* Monitoring is a convenience. A failure here must never block or
           alarm the operator — Start broadcast still reports for real. */
      }
    })();

    return () => {
      cancelled = true;
      cap?.stop();
      if (monitorRef.current === cap) monitorRef.current = null;
      setMonitoring(false);
      levelRef.current = 0;
    };
  }, [gate, broadcasting, deviceId, needsPermission, devices.length, refreshDevices]);

  // Load this church's terms whenever the room changes. The backend pushes
  // updates over the broadcaster socket after that, so this runs once.
  useEffect(() => {
    if (!church || gate !== 'ok') return;
    let cancelled = false;
    fetchGlossary(church)
      .then((snap) => {
        if (cancelled) return;
        setTerms([...snap.church, ...snap.service]);
        setTermsReadOnly(snap.source === 'env');
      })
      .catch(() => {
        // A glossary that will not load must not look like a broken desk.
        if (!cancelled) setTerms([]);
      });
    return () => { cancelled = true; };
  }, [church, gate]);

  const submitTerm = async () => {
    const parsed = parseTermEntry(termDraft);
    // church is null until the URL/localStorage lookup resolves on mount.
    if (!parsed || termBusy || !church) return;
    setTermBusy(true);
    setTermError('');
    try {
      const term = await addGlossaryTerm({
        church,
        sourceTerm: parsed.sourceTerm,
        behavior: parsed.behavior,
        targets: parsed.targets,
        serviceOnly: termServiceOnly,
      });
      setTerms((prev) => [...prev.filter((t) => t.id !== term.id), term]);
      setTermDraft('');
      setTermsOpen(true);
    } catch (err) {
      setTermError((err as Error).message);
    } finally {
      setTermBusy(false);
    }
  };

  const removeTerm = async (id: string) => {
    const before = terms;
    setTerms((prev) => prev.filter((t) => t.id !== id)); // optimistic
    try {
      await deleteGlossaryTerm(id);
    } catch (err) {
      setTerms(before);
      setTermError((err as Error).message);
    }
  };

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

  // ── Local output machinery (reuses the listener stream + player) ─────────
  const outRebuildsRef = useRef<{ n: number; at: number }>({ n: 0, at: 0 });

  const buildOutStream = useCallback(function build(): void {
    const s = new AudioStreamPlayer();
    s.setVolume(outVolumeRef.current);
    if (outSinkRef.current) s.setSinkId(outSinkRef.current);
    // This output IS what the room hears in a one-laptop church — report
    // its playhead so the pews marker stays meaningful.
    s.onSeqPlaying = (seq) => {
      const now = Date.now();
      if (seq !== outReportRef.current.seq && now - outReportRef.current.at > 1500) {
        outReportRef.current = { seq, at: now };
        outWsRef.current?.sendJSON({ type: 'playing', seq });
      }
    };
    s.onStalled = () => {
      // Same self-heal as the listener/kiosk: rebuild in place — but capped,
      // so a player that can't start doesn't loop forever.
      outStreamRef.current?.stop();
      outStreamRef.current = null;
      const rc = outRebuildsRef.current;
      const now = Date.now();
      if (now - rc.at > 60_000) rc.n = 0;
      rc.at = now;
      rc.n++;
      if (rc.n > 2) {
        console.warn('[Speak] local output keeps dying — turning it off');
        outWsRef.current?.disconnect();
        outWsRef.current = null;
        setLocalOutput(false);
        setErrors((prev) => [...prev.slice(-4), 'Local output stopped — click On to start it again.']);
        return;
      }
      console.warn('[Speak] local output stalled — rebuilding player');
      build();
    };
    s.start();
    outStreamRef.current = s;
  }, []);

  const handleOutMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'status': {
        const st = msg as { type: 'status'; active?: boolean };
        if (st.active === true) outStreamRef.current?.reset();
        break;
      }
      case 'audio_chunk': {
        const a = msg as AudioChunkMsg;
        outStreamRef.current?.appendChunk(base64ToBytes(a.data), a.seq);
        break;
      }
    }
  }, []);

  const teardownLocalOutput = useCallback(() => {
    outWsRef.current?.disconnect();
    outWsRef.current = null;
    outStreamRef.current?.stop();
    outStreamRef.current = null;
  }, []);

  const toggleLocalOutput = () => {
    if (localOutput) {
      teardownLocalOutput();
      setLocalOutput(false);
      return;
    }
    if (!church) return;
    // A deliberate retry deserves a fresh rebuild allowance — the cap guards
    // against automatic loops, not the operator clicking On again.
    outRebuildsRef.current = { n: 0, at: 0 };
    // The click is the user gesture that unlocks audio — start the player now.
    buildOutStream();
    const client = new WsClient({
      url: getBackendWsUrl(),
      role: 'listener',
      room: church,
      onMessage: handleOutMessage,
      reconnectDelayMs: 2000,
    });
    outWsRef.current = client;
    client.connect();
    setLocalOutput(true);
  };

  const selectOutputDevice = (id: string) => {
    setOutputDeviceId(id);
    outSinkRef.current = id;
    outStreamRef.current?.setSinkId(id);
    try { window.localStorage.setItem(OUTPUT_DEVICE_STORAGE_KEY, id); } catch {}
  };

  const changeOutVolume = (v: number) => {
    setOutVolume(v);
    outVolumeRef.current = v;
    outStreamRef.current?.setVolume(v);
    try { window.localStorage.setItem(LOCAL_VOLUME_STORAGE_KEY, String(v)); } catch {}
  };

  // Test tone through the SELECTED output (AudioContext.setSinkId where
  // supported) so the operator can verify the church system hears it.
  const playTestTone = () => {
    if (toneBusy) return;
    try {
      if (!toneCtxRef.current || toneCtxRef.current.state === 'closed') {
        toneCtxRef.current = new AudioContext();
      }
      const ctx = toneCtxRef.current as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (outSinkRef.current) ctx.setSinkId?.(outSinkRef.current).catch(() => {});
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      const peak = 0.5 * outVolumeRef.current;
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

  // Local output follows the room: church change tears it down (re-toggle).
  useEffect(() => {
    return () => {
      teardownLocalOutput();
      setLocalOutput(false);
      toneCtxRef.current?.close().catch(() => {});
      toneCtxRef.current = null;
    };
  }, [church, teardownLocalOutput]);

  // Feedback guard: same physical device as input+output would loop the
  // translation back into STT.
  const feedbackRisk = (() => {
    if (!localOutput || !outputDeviceId || !deviceId) return false;
    const inDev = devices.find((d) => d.deviceId === deviceId);
    const outDev = outputDevices.find((d) => d.deviceId === outputDeviceId);
    return Boolean(inDev && outDev && inDev.groupId && inDev.groupId === outDev.groupId);
  })();

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

      case 'pews':
        if ('seq' in msg) setPewsSeq(msg.seq as number);
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
      case 'started':
        setRecordingTranscript((msg as { recordingTranscript?: boolean }).recordingTranscript === true);
        break;

      case 'glossary':
        // Pushed after any add/edit/delete, including ones made on the
        // management page, so two operators never disagree about the terms.
        if (Array.isArray(msg.terms)) setTerms(msg.terms as GlossaryTerm[]);
        break;

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

    // Release the monitor first: some inputs refuse a second simultaneous
    // open, and `broadcasting` does not flip until after capture.start().
    monitorRef.current?.stop();
    monitorRef.current = null;
    setMonitoring(false);

    try {
      const capture = new AudioCapture({
        chunkIntervalMs: 200,
        deviceId: deviceId || undefined,
        onChunk: (pcm) => {
          wsRef.current?.sendBinary(pcm);
          levelRef.current = pcmLevel(pcm);
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
    setRecordingTranscript(false);
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
  const meta = DIRECTION_META[direction];
  const termExample = glossaryExample(direction === 'zh-en' ? 'zh' : 'ko');
  const hearing = broadcasting && debug.sttConnected;
  const onAir = broadcasting && connState === 'connected';

  // Waiting on the auth check (or being redirected to /login) — render nothing.
  if (gate !== 'ok') return null;

  const statusClass = onAir ? ' live' : connState === 'connecting' ? ' dk-connecting' : connState === 'disconnected' ? ' dk-down' : '';
  const listening = Math.max(0, listenerCount - (localOutput ? 1 : 0));

  return (
    <div className="v2 ap-page ap-desk">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="ap-bar dk-bar">
        {/* Dashboard, not the marketing site. Everyone who reaches this page is
            signed in, and none of them came here to read the landing page. */}
        <Link href="/host" className="ap-bar-brand" title="Dashboard"><Brand /></Link>
        <span className="ap-bar-rule" aria-hidden />
        <span className="ap-bar-title">Broadcast desk</span>

        {/* Church slug: editable while off air, locked while live */}
        <input
          className="dk-church"
          value={churchDraft}
          onChange={(e) => setChurchDraft(e.target.value)}
          onBlur={commitChurch}
          onKeyDown={(e) => { if (e.key === 'Enter') commitChurch(); }}
          disabled={broadcasting}
          placeholder="church-slug"
          aria-label="Church room"
        />

        <span className="ap-bar-fill" />

        {/* Pacing echo — visible without looking down at the rail */}
        {broadcasting && <span className="ap-pill ap-hide-sm">{mode === 'smooth' ? 'Smooth' : 'Fast'} pacing</span>}

        {/* A record of the service is being kept. Quiet and outlined rather
            than filled: it must be visible to anyone glancing at the desk
            while a testimony is being given, without competing with the
            on-air state, which is the thing the operator is actually
            watching. Shown at every width for that reason. */}
        {broadcasting && recordingTranscript && (
          <span className="ap-pill dk-rec" title="Every service is saved. Remove one from the transcripts page.">
            <span className="ap-dot ap-dot-live" aria-hidden />
            <span className="dk-rec-long">Recording transcript</span>
            <span className="dk-rec-short">Recording</span>
          </span>
        )}

        {broadcasting && <span className="ap-timer">{elapsed}</span>}
        <span className={`ap-status${statusClass}`}>
          <span className="ap-dot" />
          {onAir ? 'On air' : connState === 'connected' ? 'Ready' : connState === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </span>
        {/* Account menu sits last, after the status: the operator's eye goes
            to on-air state first, and the one control they must never hit by
            accident is furthest from it. */}
        <AccountMenu />
      </header>

      {/* ── Desk grid ───────────────────────────────────────────────────── */}
      <div className="ap-desk-grid">
        {/* ── Left rail ── */}
        <aside className="ap-rail">
          {/* 1. Start / End broadcast */}
          {!broadcasting ? (
            <button type="button" className="ap-go" onClick={startBroadcast} disabled={connState !== 'connected'}>
              <span className="ap-go-dot" aria-hidden />Start broadcast
            </button>
          ) : (
            <button type="button" className="ap-go live" onClick={stopBroadcast}>
              <span className="ap-go-sq" aria-hidden />End broadcast
            </button>
          )}

          {/* 2. Direction */}
          <section className="ap-panel">
            <h3>Direction {broadcasting && <small>Locked while live</small>}</h3>
            <Seg<Direction>
              label="Direction"
              value={direction}
              onChange={handleDirectionChange}
              disabled={broadcasting}
              options={(allowedDirections ?? (['ko-en', 'en-ko', 'zh-en'] as const)).map((d) => ({
                v: d,
                l: DIRECTION_LABELS[d],
                title: DIRECTION_META[d].title,
              }))}
            />
          </section>

          {/* 3. Sound source */}
          <section className="ap-panel">
            <h3>Sound source</h3>
            <select
              className="v2-input"
              value={deviceId}
              onChange={(e) => selectDevice(e.target.value)}
              disabled={broadcasting}
              title={broadcasting && liveDeviceLabel ? `Live: ${liveDeviceLabel}` : undefined}
              aria-label="Input device"
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
                type="button"
                className="v2-btn v2-btn-ghost v2-btn-sm dk-start"
                onClick={unlockDeviceLabels}
                title="Grant mic access once so device names show up"
              >
                List devices
              </button>
            )}
            <InputMeter levelRef={levelRef} active={broadcasting || monitoring} />
          </section>

          {/* 4. Pacing */}
          <section className="ap-panel">
            <h3>Pacing <small className="ap-ok">Safe to change on air</small></h3>
            <Seg<Mode>
              label="Pacing"
              value={mode}
              onChange={handleModeChange}
              options={[
                { v: 'fast', l: 'Fast', title: 'Lower latency; rougher sentence edges' },
                { v: 'smooth', l: 'Smooth', title: 'Waits for natural pauses; cleanest sentences' },
              ]}
            />
          </section>

          {/* 5. Local output — one-laptop mode for soundboard churches */}
          <section className="ap-panel">
            <h3 title="Play translated audio from this device into the church system">Local output</h3>
            <Seg<'off' | 'on'>
              label="Local output"
              value={localOutput ? 'on' : 'off'}
              onChange={(v) => { if ((v === 'on') !== localOutput) toggleLocalOutput(); }}
              options={[{ v: 'off', l: 'Off' }, { v: 'on', l: 'On' }]}
            />
            {localOutput && (
              <div className="ap-out">
                {sinkSupported ? (
                  <select
                    className="v2-input"
                    value={outputDeviceId}
                    onChange={(e) => selectOutputDevice(e.target.value)}
                    aria-label="Output device"
                  >
                    <option value="">System default output</option>
                    {outputDevices
                      .filter((d) => d.deviceId && d.deviceId !== 'default')
                      .map((d, i) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Output ${i + 1}`}
                        </option>
                      ))}
                  </select>
                ) : (
                  <p className="ap-hint">
                    This browser can&apos;t pick an output device — audio plays on the system default output.
                  </p>
                )}
                <label className="ap-range">
                  <span>Volume</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={outVolume}
                    onChange={(e) => changeOutVolume(parseFloat(e.target.value))}
                    aria-label="Local output volume"
                  />
                  <span>{Math.round(outVolume * 100)}%</span>
                </label>
                <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm" onClick={playTestTone} disabled={toneBusy}>
                  {toneBusy ? 'Playing…' : 'Test tone'}
                </button>
                {feedbackRisk && (
                  <p className="dk-alert" role="alert">
                    Output and input are the same device — the translation would feed back into the microphone. Pick a different output.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* 6. Glossary. The input stays visible because adding a term is the
              live action; the list collapses because it is the bulky part and
              is only consulted after the fact. Same name as the management
              page, so the two are obviously the same thing. */}
          <section className="ap-panel">
            <h3>
              Glossary
              <button
                type="button"
                className="dk-expander"
                onClick={() => setTermsOpen((v) => !v)}
                aria-expanded={termsOpen}
                aria-label={`${terms.length} ${terms.length === 1 ? 'term' : 'terms'}, ${termsOpen ? 'hide' : 'show'} list`}
              >
                {terms.length} {terms.length === 1 ? 'term' : 'terms'}
                <CaretDown weight="bold" aria-hidden className={termsOpen ? 'dk-flip' : undefined} />
              </button>
            </h3>
            <input
              className="v2-input"
              value={termDraft}
              onChange={(e) => setTermDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitTerm(); }}
              disabled={termsReadOnly || termBusy}
              placeholder={`${termExample.term}=${termExample.rendering}`}
              aria-label="Add a term"
            />
            <p className="ap-hint">
              {termsReadOnly
                ? 'Read-only — this server has no glossary database.'
                : `Enter to add. Type a name on its own to keep it unchanged, or ${termExample.term}=${termExample.rendering} to set how it comes out.`}
            </p>
            <Seg<'service' | 'church'>
              label="Glossary scope"
              value={termServiceOnly ? 'service' : 'church'}
              onChange={(v) => setTermServiceOnly(v === 'service')}
              options={[{ v: 'service', l: 'This service' }, { v: 'church', l: 'Church' }]}
            />
            {termError && <p className="dk-alert" role="alert">{termError}</p>}
            {termsOpen && (
              terms.length === 0 ? (
                <p className="ap-hint">No terms yet.</p>
              ) : (
                <ul className="ap-terms dk-terms">
                  {terms.map((t) => (
                    <li key={t.id}>
                      <span className="dk-term-k">{t.sourceTerm}</span>
                      <span className="ap-terms-to">{describeTerm(t)}</span>
                      {/* Church terms outlive the service, so they are marked. */}
                      {t.sessionId === null && <span className="ap-tag">Church</span>}
                      <button
                        type="button"
                        onClick={() => removeTerm(t.id)}
                        disabled={termsReadOnly}
                        aria-label={`Remove ${t.sourceTerm}`}
                      >
                        <X aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </section>

          {/* 7. Congregation link — pinned to the rail's bottom */}
          {church && (
            <section className="ap-panel ap-link-panel">
              <h3>Congregation link</h3>
              <div className="ap-link">
                {qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrDataUrl} alt={`QR code for ${listenUrl}`} width={88} height={88} />
                ) : (
                  <span className="ap-qr-ph" aria-hidden />
                )}
                <div>
                  <code>{listenUrl.replace(/^https?:\/\//, '')}</code>
                  <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm" onClick={copyLink}>
                    {copied ? <Check weight="bold" aria-hidden /> : <Copy aria-hidden />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </section>
          )}
        </aside>

        {/* ── Right pane ── */}
        <main className="ap-desk-main">
          {/* Health strip */}
          <div className="ap-health">
            <div>
              <span className="ap-health-k">Hearing the pastor</span>
              <span className={`ap-health-v${hearing ? ' ap-ok' : ''}`}>
                {hearing ? <><span className="ap-dot ap-dot-live" />Yes</> : broadcasting ? 'Waiting' : '—'}
              </span>
            </div>
            <div>
              <span className="ap-health-k">Delay to the pews</span>
              <span className="ap-health-v">
                {debug.e2eLatencyMs > 0 ? `${(debug.e2eLatencyMs / 1000).toFixed(1)} seconds` : '—'}
              </span>
            </div>
            <div>
              <span className="ap-health-k">Listening now</span>
              <span className="ap-health-v" title={localOutput ? "Excludes this device's own local output" : undefined}>
                {`${listening} ${listening === 1 ? 'person' : 'people'}`}
              </span>
            </div>
            <div className="ap-health-actions">
              <button type="button" className="ap-link-btn" aria-pressed={showDiag} onClick={() => setShowDiag((v) => !v)}>
                Diagnostics
              </button>
              <a
                className="ap-link-btn"
                href={church ? `/listen/${church}` : '/listen'}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open listener <ArrowSquareOut aria-hidden />
              </a>
            </div>
          </div>

          {/* Diagnostics disclosure — the raw figures */}
          {showDiag && (
            <dl className="ap-diag">
              {[
                ['Last chunk', `${debug.chunkSize} chars`],
                ['Chunker wait', `${debug.chunkerWaitMs}ms`],
                ['Translation', `${debug.translationLatencyMs}ms`],
                ['TTS first byte', `${debug.ttsFirstByteMs}ms`],
                ['TTS total', `${debug.ttsLatencyMs}ms`],
                ['End-to-end', `${debug.e2eLatencyMs}ms`],
                ['STT connected', debug.sttConnected ? 'yes' : 'no'],
                ['Listeners', `${listenerCount}`],
              ].map(([key, val]) => (
                <div key={key}><dt>{key}</dt><dd>{val}</dd></div>
              ))}
            </dl>
          )}

          {/* Transcript */}
          <div className="ap-feed" ref={scrollRef} onScroll={handleScroll}>
            <div className="ap-feed-head">
              <span>{meta.srcLabel}</span>
              <span className="dk-feed-out">{meta.tgtLabel}</span>
            </div>

            {script.length > 0 || liveKorean ? (
              <>
                {script.map((entry, i) => {
                  const fromEnd = script.length - 1 - i;
                  const inPews = entry.seq === pewsSeq && listenerCount > 0;
                  const opacity = inPews ? 1 : fromEnd === 0 ? 1 : fromEnd === 1 ? 0.6 : 0.45;
                  return (
                    <div key={entry.seq} className={`ap-feed-row${inPews ? ' playing' : ''}`} style={{ opacity }}>
                      <p className={meta.srcClass} lang={meta.srcLang}>{entry.korean}</p>
                      <p className={meta.tgtClass} lang={meta.tgtLang}>
                        {entry.sermon}
                        {inPews && <span className="ap-inpews"><Headphones weight="bold" aria-hidden /> In the pews</span>}
                      </p>
                    </div>
                  );
                })}

                {/* In-progress source line */}
                {liveKorean && (
                  <div className="ap-feed-row holding">
                    <p className={meta.srcClass} lang={meta.srcLang}>
                      {liveKorean}
                      <span className="ap-caret" aria-hidden />
                    </p>
                    <p className="ap-muted">Holding for the sentence…</p>
                  </div>
                )}
              </>
            ) : (
              <p className="ap-empty">{broadcasting ? 'Listening…' : 'Start a broadcast to begin translating.'}</p>
            )}
          </div>

          {/* Errors */}
          {errors.length > 0 && (
            <div className="dk-errors" role="alert">
              <strong>Errors</strong>
              {errors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
