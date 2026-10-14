import { createHash, randomBytes } from "node:crypto";

export const BOT_URL = "https://opreturnbot.com";
const INVOICE_TTL = 5 * 60;

export function isUtf8Payload(buffer) {
  try {
    const text = buffer.toString("utf8");
    return Buffer.from(text, "utf8").equals(buffer);
  } catch {
    return false;
  }
}

export function parseInvoiceAmountMsat(invoice) {
  const match = String(invoice || "").match(/^lnbc(\d+)([munp]?)/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2] || "";
  if (unit === "m") return n * 100_000_000;
  if (unit === "u") return n * 100_000;
  if (unit === "n") return n * 100;
  if (unit === "p") return Math.round(n / 10);
  return n * 100_000_000_000;
}

function extractRHash(location, invoice) {
  const url = String(location || "");
  const fromQuery = /[?&](?:invoice|rHash|rhash)=([0-9a-fA-F]{64}|lnbc[0-9a-z]+)/i.exec(url);
  if (fromQuery) return fromQuery[1];
  const fromPath = /\/(?:invoice|status)\/([0-9a-fA-F]{64})/i.exec(url);
  if (fromPath) return fromPath[1];
  if (invoice && /^ln/i.test(invoice)) {
    return createHash("sha256").update(invoice).digest("hex");
  }
  return "";
}

export function createOpReturnClient({
  baseUrl = process.env.INSTAOP_OPRETURN_URL || BOT_URL,
  fetchImpl = fetch,
} = {}) {
  const root = String(baseUrl).replace(/\/$/, "");

  async function createText(message, noTwitter) {
    const form = new URLSearchParams();
    form.set("message", message);
    form.set("noTwitter", noTwitter ? "true" : "false");
    const unified = await fetchImpl(`${root}/api/unified`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (unified.ok) {
      const json = await unified.json();
      return normalizeCreated({
        invoice: json.invoice,
        rHash: json.rHash,
        amountBtc: json.amountBtc,
        address: json.address,
        paymentString: json.paymentString,
      });
    }
    const created = await fetchImpl(`${root}/api/create`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!created.ok) {
      const err = await created.text();
      throw Object.assign(new Error(err || "OP_RETURN Bot rejected the text invoice."), { status: 502 });
    }
    const invoice = (await created.text()).trim();
    return normalizeCreated({ invoice, rHash: extractRHash("", invoice) });
  }

  async function createFile(bytes, filename = "payload.bin") {
    const form = new FormData();
    form.set("file", new Blob([bytes]), filename);
    form.set("noTwitter", "true");
    const res = await fetchImpl(`${root}/createRequest`, {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    const location = res.headers.get("location") || "";
    if (res.status >= 300 && res.status < 400 && location) {
      const rHash = extractRHash(location);
      const invoicePage = await fetchImpl(new URL(location, root).href);
      const html = await invoicePage.text();
      const invoice = /ln(bc|tb)[0-9a-z]+/i.exec(html)?.[0] || "";
      return normalizeCreated({ invoice, rHash: rHash || extractRHash(location, invoice) });
    }
    if (res.ok) {
      const text = await res.text();
      try {
        return normalizeCreated(JSON.parse(text));
      } catch {
        const invoice = /ln(bc|tb)[0-9a-z]+/i.exec(text)?.[0] || "";
        if (invoice) return normalizeCreated({ invoice, rHash: extractRHash("", invoice) });
      }
    }
    throw Object.assign(new Error("OP_RETURN Bot did not accept the file payload as raw bytes."), { status: 502 });
  }

  return {
    name: "opreturnbot",
    async create(bytes, { noTwitter = true, kind = "text" } = {}) {
      if (!bytes?.length) throw Object.assign(new Error("Nothing to publish."), { status: 400 });
      if (kind === "text" || isUtf8Payload(bytes)) {
        return createText(Buffer.from(bytes).toString("utf8"), noTwitter);
      }
      return createFile(bytes, kind === "both" ? "instaop.bin" : "instaop.jpg");
    },
    async status(rHash) {
      const res = await fetchImpl(`${root}/api/status/${encodeURIComponent(rHash)}`);
      const text = (await res.text()).trim();
      if (res.status === 400) return { state: "unpaid", txid: null };
      if (!res.ok) throw Object.assign(new Error("Could not read invoice status."), { status: 502 });
      if (text === "null" || text === "") return { state: "paid", txid: null };
      const txid = text.replace(/"/g, "");
      if (!/^[0-9a-f]{64}$/i.test(txid)) return { state: "paid", txid: null };
      return { state: "broadcast", txid: txid.toLowerCase() };
    },
    async view(txid) {
      const res = await fetchImpl(`${root}/api/view/${encodeURIComponent(txid)}`);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function normalizeCreated(row) {
  const invoice = String(row.invoice || "").trim();
  if (!invoice) throw Object.assign(new Error("OP_RETURN Bot returned no invoice."), { status: 502 });
  const rHash = String(row.rHash || extractRHash("", invoice));
  const amountMsat = row.amountMsat || parseInvoiceAmountMsat(invoice);
  return {
    invoice,
    rHash,
    amountBtc: row.amountBtc || null,
    amountMsat,
    address: row.address || null,
    paymentString: row.paymentString || invoice,
    expiresAt: Math.floor(Date.now() / 1000) + INVOICE_TTL,
    estimate: false,
  };
}

export function createMockBot() {
  const invoices = new Map();
  return {
    name: "mock",
    invoices,
    async create(bytes, { noTwitter = true } = {}) {
      const rHash = randomBytes(32).toString("hex");
      const invoice = `lnbcmock${rHash.slice(0, 12)}`;
      invoices.set(rHash, {
        bytes: Buffer.from(bytes),
        noTwitter,
        paid: false,
        txid: null,
        invoice,
      });
      return {
        invoice,
        rHash,
        amountBtc: "0.00001234",
        amountMsat: 1234000,
        address: null,
        paymentString: invoice,
        expiresAt: Math.floor(Date.now() / 1000) + INVOICE_TTL,
        estimate: false,
      };
    },
    async status(rHash) {
      const row = invoices.get(rHash);
      if (!row) return { state: "unpaid", txid: null };
      if (row.txid) return { state: "broadcast", txid: row.txid };
      if (row.paid) return { state: "paid", txid: null };
      return { state: "unpaid", txid: null };
    },
    async view(txid) {
      for (const row of invoices.values()) {
        if (row.txid === txid) return row.bytes;
      }
      return null;
    },
    pay(rHash) {
      const row = invoices.get(rHash);
      if (row) row.paid = true;
    },
    broadcast(rHash, txid) {
      const row = invoices.get(rHash);
      if (row) {
        row.paid = true;
        row.txid = txid;
      }
    },
  };
}
