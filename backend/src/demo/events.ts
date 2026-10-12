/**
 * Funnel events.
 *
 * The two numbers that say whether this funnel works are the mic-grant rate
 * and the sign-in conversion, and neither is knowable without recording the
 * steps. Fire and forget: an analytics write must never fail a demo.
 */

import { isDbConfigured, query } from '../db';

export type DemoEvent =
  | 'page_view'
  | 'mic_granted'
  | 'mic_denied'
  | 'sample_played'
  | 'first_caption'
  | 'wall_hit'
  | 'demo_finished'
  | 'signed_in'
  | 'tts_started'
  | 'cap_reached'
  | 'listener_opened'
  | 'cta_clicked';

export const DEMO_EVENTS: DemoEvent[] = [
  'page_view', 'mic_granted', 'mic_denied', 'sample_played', 'first_caption',
  'wall_hit', 'demo_finished', 'signed_in', 'tts_started', 'cap_reached', 'listener_opened', 'cta_clicked',
];

export function isDemoEvent(v: unknown): v is DemoEvent {
  return typeof v === 'string' && (DEMO_EVENTS as string[]).includes(v);
}

export function recordEvent(input: {
  event: DemoEvent;
  sessionId?: string | null;
  clerkUserId?: string | null;
  meta?: Record<string, unknown>;
}): void {
  if (!isDbConfigured()) return;
  void query(
    'INSERT INTO demo_events (session_id, event, clerk_user_id, meta) VALUES ($1, $2, $3, $4::jsonb)',
    [
      input.sessionId ?? null,
      input.event,
      input.clerkUserId ?? null,
      JSON.stringify(input.meta ?? {}),
    ],
  ).catch((err) => console.warn('[Demo] Event not recorded:', (err as Error).message));
}
