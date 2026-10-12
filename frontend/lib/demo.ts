/**
 * Demo funnel client.
 *
 * The demo runs through the real pipeline: it opens a broadcaster socket to a
 * room in the `demo-` namespace, exactly as the church desk does, so a
 * prospect hears the actual product rather than a simulation of it.
 */

import { getBackendHttpUrl } from './backend-config';

export interface DemoConfig {
  /** When false the demo runs end to end with no sign-in wall. */
  requireSignIn: boolean;
  anonSeconds: number;
  anonSegments: number;
  ttsSecondsPerAccount: number;
  sessionTtlSeconds: number;
  clerkEnabled: boolean;
}

export interface DemoSession {
  room: string;
  ttsAllowed: boolean;
  /** Present when the demo needs no sign-in: the phone listener, up front. */
  listenPath?: string | null;
  anonSeconds: number;
  anonSegments: number;
  expiresAt: number;
}

export interface DemoUpgrade {
  ttsAllowed: boolean;
  remainingChars: number;
  totalChars: number;
  listenPath: string;
}

/** Every event the funnel reports. Names match the server's allowlist. */
export type DemoEventName =
  | 'page_view' | 'mic_granted' | 'mic_denied' | 'sample_played' | 'first_caption'
  | 'wall_hit' | 'demo_finished' | 'signed_in' | 'tts_started' | 'cap_reached' | 'listener_opened' | 'cta_clicked';

export async function fetchDemoConfig(): Promise<DemoConfig> {
  const res = await fetch(`${getBackendHttpUrl()}/demo/config`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not reach the demo service.');
  return res.json();
}

export async function startDemoSession(): Promise<DemoSession> {
  const res = await fetch(`${getBackendHttpUrl()}/demo/session`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? 'Could not start the demo.');
  return body;
}

export async function upgradeDemoSession(room: string, token: string): Promise<DemoUpgrade> {
  const res = await fetch(`${getBackendHttpUrl()}/demo/session/${room}/upgrade`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? 'Could not unlock the full demo.');
  return body;
}

/**
 * Report a funnel step. Deliberately fire-and-forget and never thrown from:
 * analytics must not be able to break the thing it is measuring.
 */
export function reportDemoEvent(
  event: DemoEventName,
  opts: { room?: string | null; token?: string | null; meta?: Record<string, unknown> } = {},
): void {
  try {
    void fetch(`${getBackendHttpUrl()}/demo/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify({ event, room: opts.room ?? null, meta: opts.meta ?? {} }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let instrumentation break the demo */
  }
}

/**
 * Decode a bundled mp3 into the 16kHz mono PCM the pipeline expects, for the
 * "no mic?" path — someone opening a cold email in an open-plan office cannot
 * speak into their laptop, and that is a large share of the audience.
 */
export async function decodeSampleToPcm(url: string): Promise<Int16Array> {
  const res = await fetch(url);
  const encoded = await res.arrayBuffer();
  // OfflineAudioContext resamples for us; Safari needs the webkit prefix.
  const Ctx: typeof OfflineAudioContext =
    (window as unknown as { OfflineAudioContext: typeof OfflineAudioContext }).OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;

  const probe = new (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const decoded = await probe.decodeAudioData(encoded.slice(0));
  await probe.close();

  const targetRate = 16000;
  const frames = Math.ceil((decoded.duration * targetRate));
  const offline = new Ctx(1, frames, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();

  const float = rendered.getChannelData(0);
  const pcm = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float[i]));
    pcm[i] = clamped * 0x7fff;
  }
  return pcm;
}
