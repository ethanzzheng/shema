/**
 * Clerk is scoped to the demo route rather than the whole app.
 *
 * The staff pages have their own Phase A auth and do not need Clerk; wrapping
 * the root layout would put a second identity system in front of /speak and
 * /host for no reason, and would load Clerk's bundle on the listener page that
 * congregants open on a phone in a pew.
 */

import { ClerkProvider } from '@clerk/nextjs';

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  // Without a key Clerk's provider throws at render, which would take the
  // anonymous demo down with it — and the anonymous demo is the part that
  // needs no sign-in at all. Degrade to stage one instead.
  if (!publishableKey) return <>{children}</>;

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      // Clerk defaults to "/" after a sign-in that leaves the page — a Google
      // round trip, or its development-instance handoff. Landing a prospect on
      // the marketing homepage abandons the demo they were in the middle of.
      signInFallbackRedirectUrl="/demo"
      signUpFallbackRedirectUrl="/demo"
      afterSignOutUrl="/demo"
      appearance={{
        variables: {
          colorPrimary: '#C8A25E',
          colorBackground: '#17171A',
          colorText: '#F4F1EA',
          colorInputBackground: 'rgba(244,241,234,0.04)',
          borderRadius: '8px',
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
