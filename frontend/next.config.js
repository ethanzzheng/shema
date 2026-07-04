/** @type {import('next').NextConfig} */

// The marketing landing page (frontend/public/marketing.html) is a self-contained
// static export from the site builder. It is served at "/" as its own document, so
// its styles/scripts are fully isolated from the product routes (/broadcast, /listen).
//
// CONTACT_WORKER_ORIGIN: origin of the Cloudflare Worker that backs the contact form
// (see ../marketing-worker). When set (e.g. on Vercel), same-origin POSTs to
// /api/contact are proxied to the Worker — no CORS, and the marketing bundle stays
// unedited. Leave unset in local dev; the form simply won't send.
const CONTACT_WORKER_ORIGIN = process.env.CONTACT_WORKER_ORIGIN;

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const beforeFiles = [
      // Marketing homepage at the site root.
      { source: '/', destination: '/marketing.html' },
    ];
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
