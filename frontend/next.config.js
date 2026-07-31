/** @type {import('next').NextConfig} */

// The marketing homepage is a real Next.js page (app/page.tsx) as of the 2026
// redesign — the old static marketing.html rewrite is gone.
//
// CONTACT_WORKER_ORIGIN: origin of the Cloudflare Worker that backs the contact
// forms (see ../marketing-worker). When set (e.g. on Vercel), same-origin POSTs
// to /api/contact are proxied to the Worker — no CORS. Leave unset in local
// dev; the forms fall back to a mailto:.
const CONTACT_WORKER_ORIGIN = process.env.CONTACT_WORKER_ORIGIN;

const nextConfig = {
  // Overridable so CI/verification builds can't clobber a running dev
  // server's .next cache (they share the folder otherwise).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  async rewrites() {
    const beforeFiles = [];
    if (CONTACT_WORKER_ORIGIN) {
      beforeFiles.push({
        source: '/api/contact',
        destination: `${CONTACT_WORKER_ORIGIN}/api/contact`,
      });
    }
    return { beforeFiles };
  },
};

module.exports = nextConfig;
