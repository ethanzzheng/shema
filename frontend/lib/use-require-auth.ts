'use client';

/**
 * Gate for staff pages (/host, /speak, /play/*): redirects to /login unless
 * there's a valid session OR the backend runs in open dev mode (no auth
 * configured). Render nothing while 'checking' to avoid a flash of gated UI.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { hasValidSession, backendRequiresAuth } from './auth';

export type AuthGateState = 'checking' | 'ok';

export function useRequireAuth(): AuthGateState {
  const router = useRouter();
  const [state, setState] = useState<AuthGateState>('checking');

  useEffect(() => {
    let cancelled = false;
    if (hasValidSession()) {
      setState('ok');
      return;
    }
    backendRequiresAuth().then((required) => {
      if (cancelled) return;
      if (required) {
        router.replace('/login');
      } else {
        setState('ok'); // open dev mode — no login exists to redirect to
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return state;
}
