import { composeVoice, classifyArt, hashSeed, inspectMessage } from "./captions.mjs";
import { HARD_MAX } from "./limits.mjs";
import { validatePayload } from "./optimize.mjs";
import { nowSec } from "./auth.mjs";

const REPAY = new Set(["ready", "expired", "failed"]);
const WATCH = new Set(["pending_payment", "paid", "broadcast"]);

export function createPay({
  publish,
  bot,
  store,
  social,
  lookupConfirmed,
  paymentsEnabled = false,
  onPublished = () => {},
}) {
  async function refreshRow(row) {
    if (!row.r_hash || !WATCH.has(row.status)) return publish.get(row.user_id, row.id);
    if (row.status === "pending_payment" && row.invoice_expires_at && row.invoice_expires_at < nowSec()) {
      return publish.setPayment(row.user_id, row.id, { status: "expired", lastError: "Invoice expired. Create a new one to try again." });
    }
    const status = await bot.status(row.r_hash);
    if (status.state === "unpaid") return publish.get(row.user_id, row.id);
    if (status.state === "paid") {
      return publish.setPayment(row.user_id, row.id, { status: "paid", lastError: null });
    }
    if (status.state === "broadcast" && status.txid) {
      const confirmed = await lookupConfirmed(status.txid);
      if (confirmed === true) return promote(row, status.txid);
      return publish.setPayment(row.user_id, row.id, {
        status: "broadcast",
        txid: status.txid,
        confirmed: false,
        lastError: null,
      });
    }
    return publish.get(row.user_id, row.id);
  }

  async function promote(row, txid) {
    const postId = `pub-${row.id}`;
    const bytes = publish.payloadBytes(row.user_id, row.id);
    const inspected = inspectMessage(row.payload_kind === "text" ? row.statement : row.statement || "onchain image");
    const seed = hashSeed(postId + inspected.message);
    const voice = composeVoice(inspected.message, inspected.messageKind, seed);
    const hashtags = unique([...(JSON.parse(row.hashtags || "[]") || []), ...voice.hashtags]);
    const image = publish.imageBytes(row.user_id, row.id);
    let artStatus = "pending";
    if (image?.bytes) {
      store.writeImage(postId, image.bytes, extFor(image.mime));
      artStatus = "ready";
    }
    const post = store.upsert({
      id: postId,
      txid,
      message: row.statement || inspected.message,
      messageKind: image ? "image" : inspected.messageKind,
      bytes: row.byte_count || bytes.length,
      note: row.caption || voice.note,
      hashtags,
      created_at: nowSec(),
      demo: false,
      artStatus,
      artStyle: classifyArt(inspected.message, inspected.messageKind, seed),
      confirmed: true,
    }).post;
    social.claimUserPost({ id: postId, userId: row.user_id, txid, createdAt: post.created_at });
    const draft = publish.setPayment(row.user_id, row.id, {
      status: "confirmed",
      txid,
      confirmed: true,
      postId,
      lastError: null,
    });
    onPublished(post);
    return draft;
  }

  return {
    enabled() {
      return Boolean(paymentsEnabled && bot);
    },
    async pay(userId, id) {
      if (!paymentsEnabled || !bot) {
        throw Object.assign(new Error("Lightning payments are not enabled."), { status: 403 });
      }
      let row = publish.row(userId, id);
      if (WATCH.has(row.status) && row.invoice && (!row.invoice_expires_at || row.invoice_expires_at > nowSec())) {
        return { draft: publish.get(userId, id), reused: true };
      }
      if (row.status === "confirmed") {
        throw Object.assign(new Error("This draft is already confirmed on Bitcoin."), { status: 409 });
      }
      if (!REPAY.has(row.status) && row.status !== "pending_payment") {
        throw Object.assign(new Error("Queue the draft and accept the permanence warning first."), { status: 400 });
      }
      if (!row.consent) throw Object.assign(new Error("Confirm that this will be permanent on Bitcoin."), { status: 400 });
      const bytes = publish.payloadBytes(userId, id);
      const check = validatePayload(bytes);
      if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
      if (bytes.length > HARD_MAX) throw Object.assign(new Error("Payload is over the invoice limit."), { status: 400 });
      const created = await bot.create(bytes, { noTwitter: Boolean(row.no_twitter), kind: row.payload_kind });
      const draft = publish.setPayment(userId, id, {
        status: "pending_payment",
        rHash: created.rHash,
        invoice: created.invoice,
        amountMsat: created.amountMsat,
        amountBtc: created.amountBtc,
        expiresAt: created.expiresAt,
        idempotencyKey: created.rHash,
        lastError: null,
      });
      return { draft, reused: false };
    },
    async refresh(userId, id) {
      return refreshRow(publish.row(userId, id));
    },
    async watchAll() {
      const rows = publish.pendingWatch();
      for (const row of rows) {
        try {
          await refreshRow(row);
        } catch (err) {
          console.error("pay watch", row.id, err.message);
        }
      }
    },
  };
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function extFor(mime) {
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}
