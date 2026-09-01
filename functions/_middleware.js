export async function onRequest(context) {
  const { request, env, next } = context;
  const path = new URL(request.url).pathname;

  if (/\.(css|js|ico|png|jpg|jpeg|gif|svg|webp|woff2?)$/i.test(path)) {
    return next();
  }

  try {
    const ip = request.headers.get("cf-connecting-ip") || "";
    if (!ip || !env.STORE) return next();

    const hash = await sha256hex("freetictac-ip:" + ip);
    const wiped = await env.STORE.get("wipe:" + hash);

    if (wiped) {
      return new Response(
        "403 Forbidden — access to FreeTicTac has been permanently revoked for this network.",
        { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }
  } catch {}

  return next();
}

async function sha256hex(input) {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
