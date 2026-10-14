const CACHE = "instaop-shell-v4";
const SHELL = [
  "/",
  "/index.html",
  "/logo.png",
  "/favicon.png",
  "/opreturn-avatar.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

function liveRequest(url) {
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (liveRequest(url)) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (url.pathname === "/" || url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || SHELL.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(url.pathname === "/" ? "/" : req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req) || await caches.match("/");
        return cached || new Response("InstaOp is offline.", { status: 503, headers: { "content-type": "text/plain" } });
      })
  );
});
