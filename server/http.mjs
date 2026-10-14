export function sendJson(res, code, body, extra = {}) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

export function readRaw(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req, limit = 200_000) {
  const raw = await readRaw(req, limit);
  if (!raw.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function isHttps(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https" || req.socket?.encrypted === true;
}

export function sessionCookie(token, req, maxAgeSec) {
  const parts = [
    `io_sid=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(req) {
  const parts = ["io_sid=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

export function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

export function createLimiter({ windowMs = 60_000, max = 20 } = {}) {
  const hits = new Map();
  return function limit(key) {
    const now = Date.now();
    const row = hits.get(key);
    if (!row || now - row.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    row.count += 1;
    return row.count <= max;
  };
}

export function parseMultipart(buffer, contentType, limit = 2_000_000) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw Object.assign(new Error("missing boundary"), { status: 400 });
  const boundary = `--${match[1] || match[2]}`;
  const text = buffer;
  const parts = [];
  let start = text.indexOf(boundary);
  while (start >= 0) {
    const next = text.indexOf(boundary, start + boundary.length);
    if (next < 0) break;
    const slice = text.subarray(start + boundary.length, next);
    const split = slice.indexOf("\r\n\r\n");
    if (split >= 0) {
      const head = slice.subarray(0, split).toString("utf8");
      let body = slice.subarray(split + 4);
      if (body.slice(-2).toString() === "\r\n") body = body.subarray(0, body.length - 2);
      const name = /name="([^"]+)"/i.exec(head)?.[1] || "";
      const filename = /filename="([^"]*)"/i.exec(head)?.[1] || "";
      const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] || "";
      if (body.length > limit) throw Object.assign(new Error("too large"), { status: 413 });
      parts.push({ name, filename, type, body });
    }
    start = next;
  }
  return parts;
}
