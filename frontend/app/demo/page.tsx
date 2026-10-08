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
import ShemaMark from '@/components/ShemaMark';
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
type Direction = 'ko-en' | 'en-ko';

interface Caption {
  seq: number;
  source: string;
  output: string;
}

const SAMPLE_URL = '/demo/sample-sermon.mp3';

export default function DemoPage() {
  const { isSignedIn, getToken } = useAuth();

  const [cfg, setCfg] = useState<DemoConfig | null>(null);
  const [session, setSession] = useState<DemoSession | null>(null);
  const [stage, setStage] = useState<Stage>('pick');
  const [direction, setDirection] = useState<Direction>('ko-en');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [ttsAllowed, setTtsAllowed] = useState(false);
  const [ttsNote, setTtsNote] = useState('');
  const [qr, setQr] = useState('');
  const [listenUrl, setListenUrl] = useState('');
  const [busy, setBusy] = useState(false);
  /** True while the bundled clip is the source, rather than a microphone. */
  const [usingSample, setUsingSample] = useState(false);
  /** Set when the browser refused to start the clip without a direct tap. */
  const [needsAudioTap, setNeedsAudioTap] = useState(false);

  const wsRef = useRef<WsClient | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const playerRef = useRef<AudioStreamPlayer | null>(null);
  const listenWsRef = useRef<WsClient | null>(null);
  const levelRef = useRef(0);
  const sampleStopRef = useRef<(() => void) | null>(null);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);
  const startedAtRef = useRef(0);
  const roomRef = useRef<string | null>(null);

  useEffect(() => {
    fetchDemoConfig().then(setCfg).catch(() => setError('The demo is unavailable right now.'));
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
    captureRef.current?.stop();
    captureRef.current = null;
    wsRef.current?.disconnect();
    wsRef.current = null;
    listenWsRef.current?.disconnect();
    listenWsRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  // Meter, so a prospect can see the microphone working before any words land.
  useEffect(() => {
    if (stage !== 'live' && stage !== 'full') return;
    const t = setInterval(() => setLevel(levelRef.current), 120);
    return () => clearInterval(t);
  }, [stage]);

  // The anonymous countdown. The server enforces the same cap; this only tells
  // the truth about it so the wall is not a surprise.
  useEffect(() => {
    if (stage !== 'live' || !cfg) return;
    const t = setInterval(() => {
      const elapsed = (Date.now() - startedAtRef.current) / 1000;
      setSecondsLeft(Math.max(0, Math.ceil(cfg.anonSeconds - elapsed)));
    }, 250);
    return () => clearInterval(t);
  }, [stage, cfg]);

  const hitWall = useCallback(() => {
    sampleStopRef.current?.();
    sampleStopRef.current = null;
    captureRef.current?.stop();
    captureRef.current = null;
    setStage('wall');
    reportDemoEvent('wall_hit', { room: roomRef.current });
  }, []);

  const handleMessage = useCallback(
    (raw: ServerMessage) => {
      const msg = raw as { type: string; [k: string]: unknown };
      if (msg.type === 'translation') {
        const caption: Caption = {
          seq: Number(msg.seq ?? 0),
          source: String(msg.korean ?? msg.source ?? ''),
          output: String(msg.sermon ?? ''),
        };
        setCaptions((prev) => {
          if (prev.length === 0) reportDemoEvent('first_caption', { room: roomRef.current });
          const next = [...prev, caption];
          // Anonymous runs end on segments or seconds, whichever lands first.
          if (cfg && next.length >= cfg.anonSegments && !ttsAllowed) setTimeout(hitWall, 400);
          return next.slice(-40);
        });
      } else if (msg.type === 'demo_tts_stopped') {
        setTtsAllowed(false);
        setTtsNote(String(msg.message ?? 'Voice preview finished.'));
      } else if (msg.type === 'error') {
        setError(String(msg.message ?? 'Something went wrong.'));
      }
    },
    [cfg, ttsAllowed, hitWall],
  );

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
    },
    [handleMessage],
  );

  const beginSession = useCallback(async (): Promise<DemoSession> => {
    const s = await startDemoSession();
    setSession(s);
    roomRef.current = s.room;
    return s;
  }, []);

  /** Microphone path. */
  const startWithMic = async () => {
    setBusy(true);
    setError('');
    try {
      const s = session ?? (await beginSession());
      const capture = new AudioCapture({
        chunkIntervalMs: 200,
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
      setError(
        e.name === 'NotAllowedError'
          ? 'Microphone blocked. Allow it in your browser, or try the sample instead.'
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
      const pcm = await decodeSampleToPcm(SAMPLE_URL);
      await connect(s.room, 'ko-en'); // the clip is Korean
      setDirection('ko-en');
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
      audio.src = SAMPLE_URL;
      audio.volume = 0.9;
      audio.setAttribute('data-demo-sample', 'true');
      audio.style.display = 'none';
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

  // Enforce the anonymous time cap client-side too, so the wall arrives when
  // the countdown says it will.
  useEffect(() => {
    if (stage !== 'live' || !cfg || ttsAllowed) return;
    const t = setTimeout(hitWall, cfg.anonSeconds * 1000);
    return () => clearTimeout(t);
  }, [stage, cfg, ttsAllowed, hitWall]);

  /** Signed in at the wall: unlock speech and the phone listener. */
  const unlock = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Sign-in did not complete.');
      const up = await upgradeDemoSession(session.room, token);
      setTtsAllowed(up.ttsAllowed);
      if (!up.ttsAllowed) setTtsNote("This account's voice preview is already used up.");

      const url = `${window.location.origin}${up.listenPath}`;
      setListenUrl(url);
      setQr(await QRCode.toDataURL(url, { width: 264, margin: 1 }));

      // Hear it here as well as on the phone: the page the prospect is already
      // looking at should not stay silent.
      const player = new AudioStreamPlayer();
      player.start();
      playerRef.current = player;
      const lws = new WsClient({
        url: getBackendWsUrl(),
        role: 'listener',
        room: session.room,
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

      // Resume capture, which stopped at the wall.
      if (!captureRef.current && !sampleStopRef.current) await startWithMic();
      setStage('full');
      reportDemoEvent('tts_started', { room: session.room, token });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [session, getToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clerk reports the sign-in asynchronously after the modal closes.
  useEffect(() => {
    if (isSignedIn && stage === 'wall') void unlock();
  }, [isSignedIn, stage, unlock]);

  const lit = Math.round(Math.min(1, level * 6) * 14);

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
              className="dm-btn"
              style={{ minHeight: 38, padding: '8px 14px', fontSize: '0.84rem' }}
              onClick={() => { teardown(); setStage('pick'); setCaptions([]); setSession(null); roomRef.current = null; }}
            >
              Start over
            </button>
          )}
        </span>
      </header>

      <main className="dm-main">
        {stage === 'pick' && (
          <>
            <h1 className="dm-lede">Hear your own words translated, live.</h1>
            <p className="dm-sub">
              Speak for a few seconds and watch the translation appear as it would for someone
              sitting in your congregation. No account, no install.
            </p>

            <div className="dm-step">
              <div className="dm-langs">
                <button className="dm-lang" onClick={() => setDirection('ko-en')} aria-pressed={direction === 'ko-en'}>
                  <span>한국어 to English</span>
                  <span className="dm-lang-sub">Korean preaching, English in the pews</span>
                </button>
                <button className="dm-lang" onClick={() => setDirection('en-ko')} aria-pressed={direction === 'en-ko'}>
                  <span>English to 한국어</span>
                  <span className="dm-lang-sub">English preaching, Korean in the pews</span>
                </button>
              </div>

              <div className="dm-actions">
                <button className="dm-btn dm-btn-primary" onClick={startWithMic} disabled={busy}>
                  {busy ? 'Starting…' : 'Use my microphone'}
                </button>
                <button className="dm-btn" onClick={startWithSample} disabled={busy}>
                  No mic? Play a sample
                </button>
              </div>
              <p className="dm-note">
                Currently set to <strong>{direction === 'ko-en' ? '한국어 to English' : 'English to 한국어'}</strong>.
                The sample is a Korean reading, so it always runs Korean to English.
              </p>
            </div>
          </>
        )}

        {(stage === 'live' || stage === 'full') && (
          <>
            <div className="dm-live-head">
              <span className="dm-listening">
                <span className="dm-dot" aria-hidden />
                {stage === 'full' ? 'Live with voice' : usingSample ? 'Playing sample' : 'Listening'}
              </span>
              {stage === 'live' && secondsLeft !== null && (
                <span className="dm-left">{secondsLeft}s left in the free preview</span>
              )}
            </div>

            <div className="dm-meter" aria-hidden>
              {Array.from({ length: 14 }, (_, i) => (
                <span key={i} className={i < lit ? 'on' : ''} style={{ height: `${40 + (i % 4) * 18}%` }} />
              ))}
            </div>

            <div className="dm-captions" aria-live="polite">
              {captions.length === 0 && (
                <p className="dm-waiting">
                  {usingSample
                    ? 'Playing a short clip of a Korean sermon. The translation will appear here.'
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

            {needsAudioTap && (
              <button
                className="dm-btn"
                style={{ marginTop: 14 }}
                onClick={() => {
                  void sampleAudioRef.current?.play();
                  setNeedsAudioTap(false);
                }}
              >
                Tap to hear the sermon audio
              </button>
            )}

            {ttsNote && <p className="dm-note">{ttsNote}</p>}

            {stage === 'full' && qr && (
              <div className="dm-wall">
                <h2>Now hear it the way your congregation would</h2>
                <div className="dm-qr">
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
                      style={{ display: 'inline-block', marginTop: 12, textDecoration: 'none' }}
                      onClick={() => reportDemoEvent('listener_opened', { room: session?.room })}
                    >
                      Open the listener view
                    </a>
                  </div>
                </div>
              </div>
            )}

            {stage === 'full' && (
              <div className="dm-actions">
                <Link
                  className="dm-btn dm-btn-primary"
                  href="/#contact"
                  style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => reportDemoEvent('cta_clicked', { room: session?.room })}
                >
                  Ready to run this on Sunday?
                </Link>
              </div>
            )}
          </>
        )}

        {stage === 'wall' && (
          <div className="dm-wall">
            <h2>That is the free preview.</h2>
            <p>
              Sign in and keep going with the natural voice your congregation would actually hear,
              plus a QR code to try it on your own phone. Free, and takes a moment.
            </p>
            <div className="dm-actions">
              <SignedOut>
                <SignInButton mode="modal">
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
                href="/#contact"
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
