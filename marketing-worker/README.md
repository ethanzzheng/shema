# marketing-worker

Cloudflare Worker that backs the marketing site's **contact form** (the "Request a
pilot" / "language request" forms on the landing page). It receives `POST /api/contact`
and sends the submission as email via Cloudflare Email Routing.

This is the **email backend** for the contact form — it was preserved here when the
marketing site was merged into this repo. Do not delete it.

## How the form reaches it

The landing page (`frontend/public/marketing.html`) POSTs to a same-origin
`/api/contact`. In production (e.g. Vercel), set the env var `CONTACT_WORKER_ORIGIN`
to this Worker's deployed origin; `frontend/next.config.js` then proxies
`/api/contact` → `${CONTACT_WORKER_ORIGIN}/api/contact` (no CORS needed).

If instead you deploy the whole site on Cloudflare with this Worker in front of the
static assets, `/api/contact` is already same-origin and no proxy is required.

## Deploy

```bash
cd marketing-worker
npx wrangler deploy
```

The Worker deploys to its own `tryshema.<account>.workers.dev` origin and claims no
custom domain — the site itself lives on Vercel (`tryshema.app` points there via
DNS-only records). Point `CONTACT_WORKER_ORIGIN` on Vercel at the `*.workers.dev` URL.

- Destination inbox: `shematranslate@gmail.com`
- From: `noreply@tryshema.app`
