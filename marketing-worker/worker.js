import { EmailMessage } from "cloudflare:email";

const DESTINATION = "shematranslate@gmail.com";
const FROM = "noreply@tryshema.app";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/contact") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }

    // honeypot: bots fill every field; report success but send nothing
    if (data._gotcha) return json({ success: true });

    const email = typeof data.email === "string" ? data.email.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "invalid email" }, 400);

    const subject =
      typeof data._subject === "string" && data._subject.trim()
        ? data._subject.trim().slice(0, 120)
        : "New request — Shema";

    const lines = Object.entries(data)
      .filter(([k, v]) => !k.startsWith("_") && typeof v === "string" && v.trim())
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v.trim().slice(0, 500)}`);
    if (lines.length === 0) return json({ error: "empty submission" }, 400);
    const body = lines.join("\n");
    if (body.length > 5000) return json({ error: "submission too large" }, 400);

    const raw = [
      `From: Shema Website <${FROM}>`,
      `To: ${DESTINATION}`,
      `Reply-To: ${email}`,
      `Subject: =?utf-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@tryshema.app>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      b64(body).replace(/(.{76})/g, "$1\r\n"),
    ].join("\r\n");

    try {
      await env.CONTACT_EMAIL.send(new EmailMessage(FROM, DESTINATION, raw));
      return json({ success: true });
    } catch (e) {
      return json({ error: "send failed: " + (e && e.message) }, 502);
    }
  },
};
