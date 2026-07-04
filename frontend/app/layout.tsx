import type { Metadata, Viewport } from 'next';
import {
  Cormorant_Garamond,
  IBM_Plex_Mono,
  Instrument_Sans,
  Noto_Serif_KR,
} from 'next/font/google';
import './globals.css';
import RegisterSW from '@/components/RegisterSW';

// Same faces as the marketing site (public/marketing.html), self-hosted at
// build time so the product pages share its editorial look.
const display = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
});
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});
const sans = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
});
const serifKr = Noto_Serif_KR({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-serif',
});

export const metadata: Metadata = {
  title: 'Shema — Live Korean Sermon Translation',
  description: 'Real-time Korean sermon to English translation',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: '/icon-192.png',
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Shema',
  },
};

export const viewport: Viewport = {
  themeColor: '#0A0E1A',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${mono.variable} ${sans.variable} ${serifKr.variable}`}>
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
