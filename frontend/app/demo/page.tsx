'use client';

/**
 * Public demo: try the product before trusting it.
 *
 * Runs on the real pipeline — the page opens a broadcaster socket to a room in
 * the `demo-` namespace and sends microphone PCM exactly as the church desk
 * does. A prospect therefore hears what a congregation would, not a mock.
 *
 * Stage one is captions only, which is what makes anonymous traffic nearly
 * free: speech is the cost. Signing in unlocks the voice and the phone
 * listener, which is the part that actually sells.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import QRCode from 'qrcode';
import { SignInButton, SignedIn, SignedOut, useAuth } from '@clerk/nextjs';

import DeskPreview from './DeskPreview';
import AudioSettings from './AudioSettings';
import ShemaMark from '@/components/ShemaMark';
import { ArrowRight, ArrowCounterClockwise, Check, Desktop, Info, Microphone, Pause, Play, SpeakerHigh, SpeakerSlash, Timer } from '@phosphor-icons/react';
import { WsClient, type ServerMessage } from '@/lib/ws-client';
import { AudioCapture } from '@/lib/audio-capture';
import { AudioStreamPlayer } from '@/lib/audio-stream';
import {
  decodeSampleToPcm,
  fetchDemoConfig,
  reportDemoEvent,
  startDemoSession,
  upgradeDemoSession,
  type DemoConfig,
  type DemoSession,
} from '@/lib/demo';
import { getBackendWsUrl } from '@/lib/backend-config';
import './demo.css';

type Stage = 'pick' | 'live' | 'wall' | 'full' | 'done';
type Direction = 'ko-en' | 'en-ko' | 'zh-en';

interface Caption {
  seq: number;
  source: string;
  output: string;
}

/**
 * A short scripted passage per source language. English → Korean has none of
 * its own: its sample is the Korean one, as before.
 */
const SAMPLES = {
  ko: { url: '/demo/sample-sermon.mp3', direction: 'ko-en', label: '한국어', name: 'Korean' },
  zh: { url: '/demo/sample-sermon-zh.mp3', direction: 'zh-en', label: '中文', name: 'Mandarin' },
} as const;

/** "3 minutes", "90 seconds", "1 minute": whole minutes when it divides evenly. */
function formatLength(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

const sampleFor = (d: Direction) => (d === 'zh-en' ? SAMPLES.zh : SAMPLES.ko);

/** The direction cards on the first screen, and the labels the live screen uses. */
const DIRECTIONS: { id: Direction; from: string; to: string; fromLang: string; toLang: string; sub: string; voice: string }[] = [
  { id: 'ko-en', from: '한국어', to: 'English', fromLang: 'ko', toLang: 'en', sub: 'Korean preaching, English in the pews', voice: 'English' },
  { id: 'zh-en', from: '中文', to: 'English', fromLang: 'zh', toLang: 'en', sub: 'Mandarin preaching, English in the pews', voice: 'English' },
  { id: 'en-ko', from: 'English', to: '한국어', fromLang: 'en', toLang: 'ko', sub: 'English preaching, Korean in the pews', voice: 'Korean' },
];

/**
 * Signing in can navigate away from the page entirely — a Google round trip,
 * or Clerk's development handoff, both of which reload /demo from scratch and
 * wipe React state. The room itself is still alive on the server, so remember
 * enough to pick it back up; otherwise a prospect returns from signing in to
 * an empty picker, with the demo they just committed to orphaned.
 */
const RESUME_KEY = 'shema.demo.resume';

/** The visitor's microphone and speaker choice, kept for their next visit. */
const MIC_KEY = 'shema.demo.mic';
const OUT_KEY = 'shema.demo.out';

function readPref(key: string): string {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function writePref(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
}

type SinkElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

interface Resume {
  room: string;
  expiresAt: number;
  mode: 'mic' | 'sample';
  direction: Direction;
}

function rememberDemo(r: Resume): void {
  try { window.sessionStorage.setItem(RESUME_KEY, JSON.stringify(r)); } catch { /* private mode */ }
}

function forgetDemo(): void {
  try { window.sessionStorage.removeItem(RESUME_KEY); } catch { /* private mode */ }
}

/** Returns the saved demo only while the server would still honour it. */
function recallDemo(): Resume | null {
  try {
    const raw = window.sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Resume;
    if (!r?.room || typeof r.expiresAt !== 'number' || r.expiresAt <= Date.now()) {
      forgetDemo();
      return null;
    }
    return r;
  } catch {
    return null;
  }
}

/**
 * Whether Clerk is configured for this build. Inlined by Next at build time.
 *
 * The demo must work with no Clerk configuration at all — with the sign-in
 * wall off, which is the default, nothing on this page needs an identity.
 * useAuth() throws outside a ClerkProvider, and a hook cannot be called
 * conditionally, so the branch is made at the component boundary instead.
 */
const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

type DemoAuth = {
  isSignedIn: boolean;
  clerkLoaded: boolean;
  getToken: () => Promise<string | null>;
};

/** Stands in for Clerk when it is not configured. Nobody is ever signed in. */
const NO_AUTH: DemoAuth = {
  isSignedIn: false,
  clerkLoaded: true,
  getToken: async () => null,
};

export default function DemoPage() {
  return CLERK_ENABLED ? <DemoWithClerk /> : <Demo auth={NO_AUTH} />;
}

/** Only ever mounted inside a ClerkProvider, so useAuth() is safe here. */
function DemoWithClerk() {
  const { isSignedIn, getToken, isLoaded } = useAuth();
  return (
    <Demo
      auth={{
        isSignedIn: Boolean(isSignedIn),
        clerkLoaded: isLoaded,
        getToken: () => getToken(),
      }}
    />
  );
}

function Demo({ auth }: { auth: DemoAuth }) {
  const { isSignedIn, getToken, clerkLoaded } = auth;

  const [cfg, setCfg] = useState<DemoConfig | null>(null);
  const [session, setSession] = useState<DemoSession | null>(null);
  const [stage, setStage] = useState<Stage>('pick');
  /** For callbacks that must not end a demo that has already moved on. */
  const stageRef = useRef<Stage>('pick');
  stageRef.current = stage;
  const [direction, setDirection] = useState<Direction>('ko-en');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [ttsNote, setTtsNote] = useState('');
  const [qr, setQr] = useState('');
  const [listenUrl, setListenUrl] = useState('');
  const [busy, setBusy] = useState(false);
  /** True while the bundled clip is the source, rather than a microphone. */
  const [usingSample, setUsingSample] = useState(false);
  /** Set when the browser refused to start the clip without a direct tap. */
  const [needsAudioTap, setNeedsAudioTap] = useState(false);
  /** Browser voice for the anonymous stage. Free, and audibly not ElevenLabs. */
  const [voiceOn, setVoiceOn] = useState(true);
  const [samplePaused, setSamplePaused] = useState(false);
  /** Time ran out with no wall: capture has stopped and this is the closing screen. */
  const [finished, setFinished] = useState(false);
  /** The source clip. Muting it leaves only the translation, which is how a
   *  congregant with an earbud actually experiences a service. */
  const [sourceOn, setSourceOn] = useState(true);
  /** Chosen devices; '' means the system default. */
  const [micId, setMicId] = useState('');
  const [outId, setOutId] = useState('');
  const outIdRef = useRef('');

  const wsRef = useRef<WsClient | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const playerRef = useRef<AudioStreamPlayer | null>(null);
  const listenWsRef = useRef<WsClient | null>(null);
  const levelRef = useRef(0);
  const sampleStopRef = useRef<(() => void) | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);
  /** Read by the sample pump, which must stop sending audio when paused. */
  const samplePausedRef = useRef(false);
  /** Milliseconds spent paused, excluded from the free-preview countdown. */
  const pausedMsRef = useRef(0);
  const pausedAtRef = useRef(0);
  const startedAtRef = useRef(0);
  const roomRef = useRef<string | null>(null);

  useEffect(() => {
    setMicId(readPref(MIC_KEY));
    const out = readPref(OUT_KEY);
    setOutId(out);
    outIdRef.current = out;
  }, []);

  const chooseMic = useCallback((id: string) => {
    setMicId(id);
    writePref(MIC_KEY, id);
  }, []);

  /** Takes effect at once: the translated voice and the sample both move. */
  const chooseOut = useCallback((id: string) => {
    setOutId(id);
    outIdRef.current = id;
    writePref(OUT_KEY, id);
    playerRef.current?.setSinkId(id);
    (sampleAudioRef.current as SinkElement | null)?.setSinkId?.(id).catch(() => {});
  }, []);

  useEffect(() => {
    fetchDemoConfig()
      .then((c) => {
        cfgRef.current = c;
        setCfg(c);
      })
      .catch(() => setError('The demo is unavailable right now.'));
    reportDemoEvent('page_view');
  }, []);

  /** Everything this page owns, released in one place. */
  const teardown = useCallback(() => {
    sampleStopRef.current?.();
    sampleStopRef.current = null;
    if (sampleAudioRef.current) {
      sampleAudioRef.current.pause();
      sampleAudioRef.current.remove();
      sampleAudioRef.current = null;
    }
    setUsingSample(false);
    setSamplePaused(false);
    setSourceOn(true);
    samplePausedRef.current = false;
    pausedMsRef.current = 0;
    captureRef.current?.stop();
    captureRef.current = null;
    wsRef.current?.disconnect();
    wsRef.current = null;
    listenWsRef.current?.disconnect();
    listenWsRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
  }, []);

  /** Deliberately not part of teardown: unmounting to sign in must not forget. */
  const endDemo = useCallback(() => {
    forgetDemo();
    teardown();
  }, [teardown]);

  /** Back to the first screen with nothing carried over from the last session. */
  const startOver = useCallback(() => {
    endDemo();
    setStage('pick');
    setCaptions([]);
    setSession(null);
    roomRef.current = null;
    setNeedsAudioTap(false);
    setFinished(false);
    setSecondsLeft(null);
    setError('');
    setQr('');
    setListenUrl('');
    setTtsNote('');
    levelRef.current = 0;
  }, [endDemo]);

  useEffect(() => teardown, [teardown]);

  // Meter, so a prospect can see the microphone working before any words land.
  useEffect(() => {
    if (stage !== 'live' && stage !== 'full') return;
    const t = setInterval(() => setLevel(levelRef.current), 120);
    return () => clearInterval(t);
  }, [stage]);

  /**
   * Pause or resume the sample. Everything stops together: the clip the
   * listener hears, the stream feeding the pipeline, the free-preview
   * countdown, and any sentence the browser voice is part-way through. Pausing
   * only the audio would leave the pipeline translating ahead of what is being
   * heard, and the visitor would return to captions for audio that never
   * played.
   */
  /** The translated voice. */
  const toggleTranslationAudio = useCallback(() => {
    const next = !voiceOn;
    setVoiceOn(next);
    playerRef.current?.setVolume(next ? 1 : 0);
  }, [voiceOn]);

  /** The source clip. */
  const toggleSourceAudio = useCallback(() => {
    const next = !sourceOn;
    setSourceOn(next);
    if (sampleAudioRef.current) sampleAudioRef.current.muted = !next;
  }, [sourceOn]);

  const toggleSamplePause = useCallback(() => {
    const next = !samplePausedRef.current;
    samplePausedRef.current = next;
    setSamplePaused(next);
    if (next) {
      pausedAtRef.current = Date.now();
      sampleAudioRef.current?.pause();
    } else {
      pausedMsRef.current += Date.now() - pausedAtRef.current;
      if (sampleAudioRef.current) sampleAudioRef.current.muted = !sourceOn;
      void sampleAudioRef.current?.play().catch(() => setNeedsAudioTap(true));
    }
  }, [sourceOn]);

  const hitWall = useCallback(() => {
    sampleStopRef.current?.();
    sampleStopRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    // With no sign-in required the clock is simply the end of the demo, not a
    // gate: stop cleanly on the closing screen instead of asking for an
    // account the visitor was never told they would need.
    const gated = cfgRef.current?.requireSignIn ?? false;
    setStage(gated ? 'wall' : 'full');
    setFinished(!gated);
    reportDemoEvent(gated ? 'wall_hit' : 'demo_finished', { room: roomRef.current });
  }, []);

  // The anonymous countdown. The server enforces the same cap; this only tells
  // the truth about it so the wall is not a surprise.
  useEffect(() => {
    if (stage !== 'live' || !cfg) return;
    const t = setInterval(() => {
      const pausedNow = samplePausedRef.current ? Date.now() - pausedAtRef.current : 0;
      const elapsed = (Date.now() - startedAtRef.current - pausedMsRef.current - pausedNow) / 1000;
      const left = Math.max(0, Math.ceil(cfg.anonSeconds - elapsed));
      setSecondsLeft(left);
      // The countdown owns the wall. A separate timeout would fire while the
      // demo sat paused, ending a preview the visitor had stopped. It ends the
      // demo whether or not the voice is still allowed: it used to wait for the
      // voice to stop first, so a quiet visitor who never used up the voice
      // sat at "0:00 left" with the microphone still streaming.
      if (left <= 0) hitWall();
    }, 250);
    return () => clearInterval(t);
  }, [stage, cfg, hitWall]);

  const handleMessage = useCallback(
    (raw: ServerMessage) => {
      const msg = raw as { type: string; [k: string]: unknown };
      if (msg.type === 'translation') {
        const caption: Caption = {
          seq: Number(msg.seq ?? 0),
          source: String(msg.korean ?? msg.source ?? ''),
          output: String(msg.sermon ?? ''),
        };
        // The voice arrives separately, over the listener socket, while the
        // server allows it. Past that the demo goes on as captions only: a
        // robotic browser voice undersold the product at the moment that
        // mattered, so there is no fallback voice.

        setCaptions((prev) => {
          if (prev.length === 0) reportDemoEvent('first_caption', { room: roomRef.current });
          const next = [...prev, caption];
          // Anonymous runs end on segments or seconds, whichever lands first.
          if (cfg && next.length >= cfg.anonSegments && stageRef.current === 'live') setTimeout(hitWall, 400);
          return next.slice(-40);
        });
      } else if (msg.type === 'demo_tts_stopped') {
        setTtsNote(String(msg.message ?? 'Voice preview finished.'));
      } else if (msg.type === 'error') {
        setError(String(msg.message ?? 'Something went wrong.'));
      }
    },
    [cfg, hitWall],
  );

  /**
   * Join the room as a listener so the real translated voice is audible on
   * this page. Opened for anonymous demos too, now that they get a genuine
   * taste of the voice rather than only captions.
   */
  const openListener = useCallback((room: string) => {
    if (listenWsRef.current) return;
    const player = new AudioStreamPlayer();
    player.start();
    if (outIdRef.current) player.setSinkId(outIdRef.current);
    playerRef.current = player;
    const lws = new WsClient({
      url: getBackendWsUrl(),
      role: 'listener',
      room,
      onMessage: (m) => {
        const msg = m as { type: string; data?: string; seq?: number };
        if (msg.type === 'audio_start') player.noteClipStart();
        else if (msg.type === 'audio_end') player.noteClipEnd();
        else if (msg.type === 'audio_chunk' && msg.data) {
          const bin = atob(msg.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          player.appendChunk(bytes, msg.seq);
        }
      },
      reconnectDelayMs: 0,
    });
    listenWsRef.current = lws;
    lws.connect();
  }, []);

  /** Open the demo room and start the pipeline. */
  const connect = useCallback(
    async (room: string, dir: Direction): Promise<void> => {
      const ws = new WsClient({
        url: getBackendWsUrl(),
        role: 'broadcaster',
        room,
        onMessage: handleMessage,
        onError: () => setError('Lost the connection. Start the demo again.'),
        reconnectDelayMs: 0,
      });
      wsRef.current = ws;

      ws.connect();
      await new Promise<void>((resolve) => {
        const started = Date.now();
        const tick = setInterval(() => {
          if (ws.isConnected || Date.now() - started > 8000) {
            clearInterval(tick);
            resolve();
          }
        }, 80);
      });
      ws.sendJSON({ type: 'start', mode: 'fast', direction: dir });
      startedAtRef.current = Date.now();
      // Signed in already? Skip the countdown to the wall — but only when
      // there is a wall. With sign-in switched off, unlocking means jumping to
      // the closing screen seconds into a demo that has not happened yet.
      if (isSignedIn && cfgRef.current?.requireSignIn) {
        setTimeout(() => void unlockRef.current?.(), 300);
      }
      // The real voice starts immediately; the server decides when it stops.
      openListener(room);
    },
    [handleMessage, voiceOn, openListener, isSignedIn],
  );

  /** Set once unlock() exists; connect() runs before it is declared. */
  const unlockRef = useRef<(() => Promise<void>) | null>(null);
  /** hitWall is memoised with no deps; reach config through a ref. */
  const cfgRef = useRef<DemoConfig | null>(null);

  const beginSession = useCallback(async (): Promise<DemoSession> => {
    const s = await startDemoSession();
    setSession(s);
    roomRef.current = s.room;
    // No wall means nothing to trade the listener link for, so put it up
    // straight away — hearing it on your own phone is the whole pitch, and
    // making someone finish the demo first only delays it.
    if (s.listenPath) {
      const url = `${window.location.origin}${s.listenPath}`;
      setListenUrl(url);
      void QRCode.toDataURL(url, { width: 264, margin: 1 }).then(setQr).catch(() => {});
      openListener(s.room);
    }
    return s;
  }, [openListener]);

  /** Microphone path. */
  const startWithMic = async () => {
    setBusy(true);
    setError('');
    try {
      const s = session ?? (await beginSession());
      rememberDemo({ room: s.room, expiresAt: s.expiresAt, mode: 'mic', direction });
      const capture = new AudioCapture({
        chunkIntervalMs: 200,
        deviceId: micId || undefined,
        onChunk: (pcm) => {
          wsRef.current?.sendBinary(pcm);
          const view = new Int16Array(pcm);
          let sum = 0;
          for (let i = 0; i < view.length; i += 8) sum += view[i] * view[i];
          levelRef.current = Math.sqrt(sum / Math.max(1, view.length / 8)) / 32768;
        },
      });
      await capture.start(); // throws if permission is refused
      captureRef.current = capture;
      reportDemoEvent('mic_granted', { room: s.room });
      await connect(s.room, direction);
      setStage('live');
    } catch (err) {
      const e = err as Error;
      reportDemoEvent('mic_denied', { room: roomRef.current, meta: { name: e.name } });
      // Browsers only expose mediaDevices in a secure context, so over plain
      // http on a LAN address the API is simply absent and the raw error is
      // "Cannot read properties of undefined". Name the actual cause.
      const insecure = typeof window !== 'undefined' && !window.isSecureContext;
      setError(
        e.name === 'NotAllowedError'
          ? 'Microphone blocked. Allow it in your browser, or try the sample instead.'
          : insecure
            ? 'Your browser only allows microphone access over https. Use the sample instead — it shows the same thing.'
            : `Could not start the microphone: ${e.message}`,
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Sample path, for anyone in an open-plan office who cannot talk to their
   * laptop. Streams the bundled clip through the same socket at real time.
   */
  const startWithSample = async () => {
    setBusy(true);
    setError('');
    try {
      const s = session ?? (await beginSession());
      const sample = sampleFor(direction);
      rememberDemo({ room: s.room, expiresAt: s.expiresAt, mode: 'sample', direction: sample.direction });
      const pcm = await decodeSampleToPcm(sample.url);
      await connect(s.room, sample.direction); // the clip's own language
      setDirection(sample.direction);
      setUsingSample(true);
      setStage('live');
      reportDemoEvent('sample_played', { room: s.room });

      // Play it aloud as well as sending it. "Play a sample" plainly means
      // the listener should hear the sermon being translated; without this the
      // page translates in silence and looks broken.
      // Attached to the document rather than left detached. A bare `new Audio`
      // held only by a ref has been seen collected mid-playback, which is the
      // same fragility the listener player had to fix; attaching it also lets
      // the element be inspected when something sounds wrong.
      const audio = document.createElement('audio');
      audio.src = sample.url;
      audio.volume = 0.9;
      audio.setAttribute('data-demo-sample', 'true');
      audio.style.display = 'none';
      if (outIdRef.current) (audio as SinkElement).setSinkId?.(outIdRef.current).catch(() => {});
      document.body.appendChild(audio);
      sampleAudioRef.current = audio;
      // Autoplay is refused unless the browser counts this as a user gesture.
      // It normally does, since a button was pressed, but when it does not the
      // page would translate in silence with no explanation — so check whether
      // playback really began and offer a tap if it did not.
      void audio.play().catch(() => {});
      setTimeout(() => {
        if (sampleAudioRef.current === audio && (audio.paused || audio.currentTime === 0)) {
          setNeedsAudioTap(true);
        }
      }, 1500);

      // Paced to wall clock: the pipeline chunks on silence, so faster than
      // real time would arrive as one unreadable block.
      const samplesPerChunk = 16000 * 0.2;
      let offset = 0;
      let cancelled = false;
      sampleStopRef.current = () => {
        cancelled = true;
        audio.pause();
        audio.remove();
      };
      const pump = () => {
        if (cancelled || offset >= pcm.length) return;
        // Paused means paused for the pipeline too. Letting the pump run on
        // would translate ahead of what the listener is hearing, and they
        // would come back to captions for audio that never played.
        if (samplePausedRef.current) {
          setTimeout(pump, 200);
          return;
        }
        const slice = pcm.subarray(offset, offset + samplesPerChunk);
        offset += samplesPerChunk;
        // Copy rather than view: sendBinary wants a plain ArrayBuffer, and the
        // underlying buffer is shared with the rest of the clip.
        const chunk = new Int16Array(slice);
        wsRef.current?.sendBinary(chunk.buffer as ArrayBuffer);
        let sum = 0;
        for (let i = 0; i < slice.length; i += 8) sum += slice[i] * slice[i];
        levelRef.current = Math.sqrt(sum / Math.max(1, slice.length / 8)) / 32768;
        setTimeout(pump, 200);
      };
      pump();
    } catch (err) {
      setError(`Could not play the sample: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** Signed in at the wall: unlock speech and the phone listener. */
  const unlock = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Sign-in did not complete.');
      const up = await upgradeDemoSession(session.room, token);
      openListener(session.room);
      if (!up.ttsAllowed) setTtsNote("This account's voice preview is already used up.");

      const url = `${window.location.origin}${up.listenPath}`;
      setListenUrl(url);
      setQr(await QRCode.toDataURL(url, { width: 264, margin: 1 }));

      // Resume capture, which stopped at the wall.
      if (!captureRef.current && !sampleStopRef.current) await startWithMic();
      setStage('full');
      reportDemoEvent('tts_started', { room: session.room, token });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [session, getToken, openListener]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    unlockRef.current = unlock;
  }, [unlock]);

  /**
   * Returning from a sign-in that reloaded the page. The room outlives the
   * socket server-side, so reattach to it and go straight through the wall —
   * the alternative is making someone who just signed in start over, which is
   * the worst possible moment to ask for patience.
   */
  const resumedRef = useRef(false);
  useEffect(() => {
    // Only meaningful when signing in can navigate away mid-demo. With the
    // wall off there is no redirect to come back from, and resuming would
    // drop a returning visitor on the closing screen of an old session.
    if (!cfg?.requireSignIn) return;
    if (!clerkLoaded || !isSignedIn || resumedRef.current || stage !== 'pick') return;
    const saved = recallDemo();
    if (!saved) return;
    resumedRef.current = true;

    void (async () => {
      setBusy(true);
      try {
        const revived: DemoSession = {
          room: saved.room,
          expiresAt: saved.expiresAt,
          ttsAllowed: false,
          anonSeconds: cfg?.anonSeconds ?? 90,
          anonSegments: cfg?.anonSegments ?? 12,
        };
        setSession(revived);
        roomRef.current = saved.room;
        setDirection(saved.direction);
        await connect(saved.room, saved.direction);
        startedAtRef.current = Date.now();
        await unlockRef.current?.();
      } catch {
        // The room went while they were away. Say so plainly and let them
        // start again rather than leaving a page that looks stuck.
        forgetDemo();
        setError('That demo timed out while you were signing in. Start another — you are signed in now, so it runs in full.');
        setStage('pick');
      } finally {
        setBusy(false);
      }
    })();
  }, [clerkLoaded, isSignedIn, stage, cfg, connect]);

  // Clerk reports the sign-in asynchronously after the modal closes.
  useEffect(() => {
    if (isSignedIn && stage === 'wall') void unlock();
  }, [isSignedIn, stage, unlock]);

  const lit = Math.round(Math.min(1, level * 6) * 24);
  const dirMeta = DIRECTIONS.find((d) => d.id === direction) ?? DIRECTIONS[0];

  return (
    <div className="dm-root">
      <header className="dm-bar">
        <Link href="/" className="dm-brand">
          <ShemaMark />
          <span className="dm-brand-name">Shema</span>
        </Link>
        <span className="dm-bar-end">
          {stage !== 'pick' && (
            <button
              className="dm-btn dm-btn-sm"
              onClick={startOver}
            >
              <ArrowCounterClockwise weight="bold" aria-hidden /> Start over
            </button>
          )}
        </span>
      </header>

      <main className="dm-main">
        {stage === 'pick' && (
          <>
            <div className="dm-hero">
              <span className="dm-kicker"><span className="dm-dot" aria-hidden /> Live demo</span>
              <h1 className="dm-lede">Hear your own words translated, live.</h1>
              <p className="dm-intro">
                Speak for a few seconds and watch the translation appear as it would for someone
                sitting in your congregation. No account, no install.
              </p>
              <p className="dm-desktop">
                <Desktop weight="duotone" aria-hidden />
                <span>
                  <strong>Best on a desktop or laptop.</strong> Speak into your computer, then scan
                  the QR code with your phone to hear it the way your congregation would.
                </span>
              </p>
            </div>

            <div className="dm-card">
              <div className="dm-card-sec">
                <div className="dm-step-head"><span className="dm-num">1</span> Choose a direction</div>
                <div className="dm-langs">
                  {DIRECTIONS.map((d) => (
                    <button key={d.id} className="dm-lang" onClick={() => setDirection(d.id)} aria-pressed={direction === d.id}>
                      <span className="dm-lang-pair">
                        <span lang={d.fromLang}>{d.from}</span>
                        <ArrowRight weight="bold" aria-hidden />
                        <span lang={d.toLang}>{d.to}</span>
                      </span>
                      <span className="dm-lang-sub">{d.sub}</span>
                      <span className="dm-lang-check" aria-hidden><Check weight="bold" /></span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="dm-card-sec">
                <div className="dm-step-head"><span className="dm-num">2</span> Start the demo</div>
                <div className="dm-actions">
                  <button className="dm-btn dm-btn-primary" onClick={startWithMic} disabled={busy}>
                    {busy ? <><span className="dm-spin" aria-hidden /> Starting…</> : <><Microphone weight="fill" aria-hidden /> Use my microphone</>}
                  </button>
                  <button className="dm-btn" onClick={startWithSample} disabled={busy}>
                    <Play weight="fill" aria-hidden /> No mic? Play a sample
                  </button>
                </div>

              {/* With no wall, say what the visitor gets rather than what
                  they must do to get it. */}
              {cfg && !cfg.requireSignIn && (
                <p className="dm-note dm-note-icon">
                  <Info weight="bold" aria-hidden />
                  Runs for {formatLength(cfg.anonSeconds ?? 180)} with the real voice,
                  and gives you a QR code to hear it on your own phone. No account, no install.
                </p>
              )}

              {/* The preview is capped; signing in first skips the cap rather
                  than making someone hit it before they are offered the way
                  past it. */}
              {cfg?.requireSignIn && CLERK_ENABLED && (
              <>
              <SignedOut>
                <p className="dm-note">
                  The preview runs for {cfg?.anonSeconds ?? 90} seconds.{' '}
                  <SignInButton mode="modal" forceRedirectUrl="/demo" signUpForceRedirectUrl="/demo">
                    <button className="dm-link">Sign in free</button>
                  </SignInButton>{' '}
                  first for the full demo, with the voice and a QR code to hear it on your phone.
                </p>
              </SignedOut>
              <SignedIn>
                <p className="dm-note">
                  Signed in. The full demo starts as soon as you pick an option above.
                </p>
              </SignedIn>
              </>
              )}

              </div>

              <div className="dm-card-foot">
                <AudioSettings micId={micId} outId={outId} onMic={chooseMic} onOut={chooseOut} micLocked={false} />
              </div>
            </div>
          </>
        )}

        {(stage === 'live' || stage === 'full') && (
          <>
            <div className="dm-card dm-session">
            <div className="dm-live-head">
              <span className={`dm-listening${samplePaused || finished ? ' paused' : ''}`}>
                <span className="dm-dot" aria-hidden />
                {finished
                  ? 'Demo finished'
                  : stage === 'full'
                  ? 'Live with voice'
                  : usingSample
                    ? samplePaused
                      ? 'Paused'
                      : 'Playing sample'
                    : 'Listening'}
              </span>
              <span className="dm-dir">{dirMeta.from} <ArrowRight weight="bold" aria-hidden /> {dirMeta.to}</span>
              {stage === 'live' && secondsLeft !== null && (
                <span className="dm-left" title={cfg?.requireSignIn ? 'Left in the free preview' : 'Left in this demo'}>
                  <Timer weight="bold" aria-hidden />
                  {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')} left
                </span>
              )}
            </div>

            <div className="dm-tools">
              <div className="dm-meter" aria-hidden>
                {Array.from({ length: 24 }, (_, i) => (
                  <span key={i} className={i < lit ? 'on' : ''} style={{ height: `${30 + Math.abs(Math.sin(i * 1.3)) * 70}%` }} />
                ))}
              </div>
              <div className="dm-toggles">
                {usingSample && stage === 'live' && (
                  <button className="dm-voice" onClick={toggleSamplePause}>
                    {samplePaused ? <Play weight="fill" aria-hidden /> : <Pause weight="fill" aria-hidden />}
                    {samplePaused ? 'Resume' : 'Pause'}
                  </button>
                )}
                {usingSample && stage === 'live' && (
                  <button className="dm-voice" aria-pressed={sourceOn} onClick={toggleSourceAudio}>
                    {sourceOn ? <SpeakerHigh weight="bold" aria-hidden /> : <SpeakerSlash weight="bold" aria-hidden />}
                    {sampleFor(direction).label}
                  </button>
                )}
                <button className="dm-voice" aria-pressed={voiceOn} onClick={toggleTranslationAudio}>
                  {voiceOn ? <SpeakerHigh weight="bold" aria-hidden /> : <SpeakerSlash weight="bold" aria-hidden />}
                  {dirMeta.voice}<span className="dm-hide-sm">&nbsp;voice</span>
                </button>
              </div>
            </div>

            {needsAudioTap && (
              <button
                className="dm-tap"
                onClick={() => {
                  void sampleAudioRef.current?.play();
                  setNeedsAudioTap(false);
                }}
              >
                <SpeakerHigh weight="fill" aria-hidden />
                <span>Your browser paused the sermon audio. <strong>Tap to hear it.</strong></span>
              </button>
            )}

            <div className="dm-captions" aria-live="polite">
              {captions.length === 0 && (
                <p className="dm-waiting">
                  {usingSample
                    ? `Playing a short ${sampleFor(direction).name} passage. The translation will appear here, and you will hear it spoken.`
                    : 'Say something, and the translation will appear here.'}
                </p>
              )}
              {captions.map((c) => (
                <div className="dm-cap" key={`${c.seq}-${c.output.slice(0, 12)}`}>
                  <p className="dm-cap-src">{c.source}</p>
                  <p className="dm-cap-out">{c.output}</p>
                </div>
              ))}
            </div>

            <div className="dm-card-foot">
              <AudioSettings
                micId={micId}
                outId={outId}
                onMic={chooseMic}
                onOut={chooseOut}
                micLocked={!usingSample}
              />
            </div>
            </div>


            {ttsNote && <p className="dm-note">{ttsNote}</p>}

            {(stage === 'full' || stage === 'live') && qr && (
              <div className="dm-wall dm-wall-qr">
                <h2>Now hear it the way your congregation would</h2>
                <div className="dm-qr">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt={`QR code to open the listener view at ${listenUrl}`} />
                  <div className="dm-qr-copy">
                    <p>
                      Scan this with your phone, put an earbud in, and keep speaking. That is exactly
                      what someone in the pews gets, with no app to install.
                    </p>
                    <a
                      className="dm-btn"
                      href={listenUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ marginTop: 14, textDecoration: 'none' }}
                      onClick={() => reportDemoEvent('listener_opened', { room: session?.room })}
                    >
                      Open the listener view <ArrowRight weight="bold" aria-hidden />
                    </a>
                  </div>
                </div>
              </div>
            )}

            {/* The demo has shown the pews' half. The half being bought is the
                operator's, so show that before asking for the meeting. */}
            {stage === 'full' && (
              <>
                <h2 className="dm-closing">And this is the other side of it.</h2>
                <DeskPreview />
              </>
            )}

            {stage === 'full' && (
              <div className="dm-actions">
                <Link
                  className="dm-btn dm-btn-primary"
                  href="/#demo"
                  style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => reportDemoEvent('cta_clicked', { room: session?.room })}
                >
                  Ready to run this on Sunday?
                </Link>
              </div>
            )}
          </>
        )}

        {stage === 'wall' && CLERK_ENABLED && (
          <div className="dm-wall">
            <h2>That is the free preview.</h2>
            <p>
              Sign in to keep the natural voice going, and get a QR code so you can hear it on
              your own phone the way someone in the pews would. Free, and takes a moment.
            </p>
            <div className="dm-actions">
              <SignedOut>
                <SignInButton mode="modal" forceRedirectUrl="/demo" signUpForceRedirectUrl="/demo">
                  <button className="dm-btn dm-btn-primary">Sign in free to continue</button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <button className="dm-btn dm-btn-primary" onClick={unlock} disabled={busy}>
                  {busy ? 'Unlocking…' : 'Continue'}
                </button>
              </SignedIn>
              <Link
                className="dm-btn"
                href="/#demo"
                style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                onClick={() => reportDemoEvent('cta_clicked', { room: session?.room })}
              >
                Just talk to someone
              </Link>
            </div>
            {captions.length > 0 && (
              <p className="dm-note">
                {captions.length} {captions.length === 1 ? 'line' : 'lines'} translated just now.
              </p>
            )}
          </div>
        )}

        {error && <p className="dm-error">{error}</p>}
      </main>
    </div>
  );
}
