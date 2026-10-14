import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, nowSec } from "./auth.mjs";
import { HARD_MAX, ORIGINAL_UPLOAD_MAX, estimateSats, formatBytes, utf8Bytes } from "./limits.mjs";
import { buildPayload, sniffImage, suggestShortenSmart, validatePayload } from "./optimize.mjs";

const OPEN = new Set(["draft", "ready"]);

function parseTags(value) {
  if (Array.isArray(value)) return value.map((tag) => String(tag).replace(/^#/, "").slice(0, 32)).filter(Boolean).slice(0, 8);
  try {
    return parseTags(JSON.parse(value || "[]"));
  } catch {
    return [];
  }
}

export function createPublish(db, { dataDir }) {
  mkdirSync(join(dataDir, "drafts"), { recursive: true });

  const insert = db.prepare(`
    INSERT INTO publication_requests(
      id, user_id, post_id, status, payload_kind, payload_hash, byte_count, r_hash, invoice,
      amount_msat, txid, confirmed, idempotency_key, last_error, created_at, updated_at,
      statement, caption, hashtags, payload_path, original_path, mime, width, height,
      original_bytes, consent, no_twitter
    ) VALUES (
      @id, @user_id, NULL, @status, @payload_kind, @payload_hash, @byte_count, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, @created_at, @updated_at,
      @statement, @caption, @hashtags, @payload_path, @original_path, @mime, @width, @height,
      @original_bytes, @consent, @no_twitter
    )
  `);
  const update = db.prepare(`
    UPDATE publication_requests SET
      status = @status, payload_kind = @payload_kind, payload_hash = @payload_hash, byte_count = @byte_count,
      statement = @statement, caption = @caption, hashtags = @hashtags, payload_path = @payload_path,
      original_path = @original_path, mime = @mime, width = @width, height = @height,
      original_bytes = @original_bytes, consent = @consent, no_twitter = @no_twitter,
      last_error = @last_error, updated_at = @updated_at
    WHERE id = @id AND user_id = @user_id
  `);
  const get = db.prepare(`SELECT * FROM publication_requests WHERE id = ?`);
  const owned = db.prepare(`SELECT * FROM publication_requests WHERE id = ? AND user_id = ?`);
  const list = db.prepare(`
    SELECT * FROM publication_requests WHERE user_id = ?
    ORDER BY updated_at DESC LIMIT 40
  `);
  const patch = db.prepare(`
    UPDATE publication_requests SET
      status = COALESCE(@status, status),
      r_hash = COALESCE(@r_hash, r_hash),
      invoice = COALESCE(@invoice, invoice),
      amount_msat = COALESCE(@amount_msat, amount_msat),
      amount_btc = COALESCE(@amount_btc, amount_btc),
      txid = COALESCE(@txid, txid),
      confirmed = COALESCE(@confirmed, confirmed),
      idempotency_key = COALESCE(@idempotency_key, idempotency_key),
      invoice_expires_at = COALESCE(@invoice_expires_at, invoice_expires_at),
      post_id = COALESCE(@post_id, post_id),
      last_error = @last_error,
      updated_at = @updated_at
    WHERE id = @id AND user_id = @user_id
  `);
  const del = db.prepare(`DELETE FROM publication_requests WHERE id = ? AND user_id = ? AND status IN ('draft', 'ready')`);

  function dirFor(id) {
    const dest = join(dataDir, "drafts", id);
    mkdirSync(dest, { recursive: true });
    return dest;
  }

  function writePayload(id, buffer) {
    dirFor(id);
    const rel = `${id}/payload.bin`;
    writeFileSync(join(dataDir, "drafts", rel), buffer);
    return rel;
  }

  function payloadBuffer(row) {
    if (!row.payload_path) return Buffer.alloc(0);
    const file = join(dataDir, "drafts", row.payload_path);
    return existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  }

  function imagePart(row) {
    const dedicated = join(dataDir, "drafts", row.id, "image.bin");
    if (existsSync(dedicated)) {
      const bytes = readFileSync(dedicated);
      return { mime: row.mime || sniffImage(bytes), bytes };
    }
    if (row.payload_kind === "image" && row.payload_path) {
      const file = join(dataDir, "drafts", row.payload_path);
      if (existsSync(file)) {
        const bytes = readFileSync(file);
        if (sniffImage(bytes)) return { mime: row.mime || sniffImage(bytes), bytes };
      }
    }
    return null;
  }

  function refreshPayload(row) {
    const image = imagePart(row);
    const built = buildPayload({
      statement: row.statement,
      image: row.payload_kind === "text" ? null : image,
    });
    const rel = writePayload(row.id, built);
    return { payload_path: rel, payload_hash: sha(built), byte_count: built.length };
  }

  function publicDraft(row) {
    if (!row) return null;
    const check = validatePayload(Buffer.alloc(row.byte_count || 0));
    const ready = Boolean(row.consent) && (row.byte_count || 0) > 0 && (row.byte_count || 0) <= HARD_MAX;
    return {
      id: row.id,
      status: row.status,
      kind: row.payload_kind,
      statement: row.statement,
      caption: row.caption,
      hashtags: parseTags(row.hashtags),
      byteCount: row.byte_count || 0,
      originalBytes: row.original_bytes || 0,
      hash: row.payload_hash,
      mime: row.mime,
      width: row.width,
      height: row.height,
      noTwitter: Boolean(row.no_twitter),
      consent: Boolean(row.consent),
      ready,
      overLimit: (row.byte_count || 0) > HARD_MAX,
      hardMax: HARD_MAX,
      previewUrl: row.payload_path ? `/media/draft/${row.id}/preview` : null,
      originalUrl: row.original_path ? `/media/draft/${row.id}/original` : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      warning: "Nothing here is on Bitcoin yet. A public InstaOp post appears only after a confirmed OP_RETURN.",
      lastError: row.last_error,
      fits: check.ok || ((row.byte_count || 0) > 0 && (row.byte_count || 0) <= HARD_MAX),
      invoice: row.invoice || null,
      rHash: row.r_hash || null,
      qrUrl: row.invoice ? `/api/publish/drafts/${row.id}/qr` : null,
      expiresAt: row.invoice_expires_at || null,
      amountMsat: row.amount_msat || null,
      amountBtc: row.amount_btc || null,
      txid: row.txid || null,
      confirmed: row.confirmed == null ? null : Boolean(row.confirmed),
      postId: row.post_id || null,
    };
  }

  function requireOpen(userId, id) {
    const row = owned.get(id, userId);
    if (!row) throw Object.assign(new Error("Draft not found."), { status: 404 });
    if (!OPEN.has(row.status)) throw Object.assign(new Error("That draft is already in the payment flow."), { status: 409 });
    return row;
  }

  function save(row) {
    const next = { ...row, ...refreshPayload(row), updated_at: nowSec() };
    update.run(next);
    return publicDraft(get.get(row.id));
  }

  return {
    create(userId, body = {}) {
      const statement = String(body.statement || "");
      const kind = body.kind === "image" || body.kind === "both" ? body.kind : "text";
      if (kind === "text" && !statement.trim()) {
        throw Object.assign(new Error("Write a statement to put on Bitcoin."), { status: 400 });
      }
      const id = newId();
      const created = nowSec();
      const row = {
        id,
        user_id: userId,
        status: "draft",
        payload_kind: kind,
        payload_hash: "",
        byte_count: utf8Bytes(statement),
        created_at: created,
        updated_at: created,
        statement,
        caption: String(body.caption || "").slice(0, 500),
        hashtags: JSON.stringify(parseTags(body.hashtags)),
        payload_path: null,
        original_path: null,
        mime: null,
        width: null,
        height: null,
        original_bytes: 0,
        consent: 0,
        no_twitter: body.noTwitter === false ? 0 : 1,
        last_error: null,
      };
      insert.run(row);
      return save(get.get(id));
    },
    update(userId, id, body = {}) {
      const row = requireOpen(userId, id);
      if (body.kind === "text" || body.kind === "image" || body.kind === "both") row.payload_kind = body.kind;
      if (body.statement != null) row.statement = String(body.statement);
      if (body.caption != null) row.caption = String(body.caption).slice(0, 500);
      if (body.hashtags != null) row.hashtags = JSON.stringify(parseTags(body.hashtags));
      if (body.noTwitter != null) row.no_twitter = body.noTwitter ? 1 : 0;
      if (body.consent === false) {
        row.consent = 0;
        row.status = "draft";
      }
      row.last_error = null;
      return save(row);
    },
    attachImage(userId, id, { original, payload, width, height, mime }) {
      const row = requireOpen(userId, id);
      if (!original?.length) throw Object.assign(new Error("Keep the original photograph as well as the optimized file."), { status: 400 });
      if (original.length > ORIGINAL_UPLOAD_MAX) {
        throw Object.assign(new Error(`Original photo must be under ${formatBytes(ORIGINAL_UPLOAD_MAX)}.`), { status: 400 });
      }
      if (!payload?.length) throw Object.assign(new Error("Upload the optimized bytes that would go onchain."), { status: 400 });
      const sniffed = sniffImage(payload);
      if (!sniffed) throw Object.assign(new Error("Optimized file must be JPEG, PNG, or WebP."), { status: 400 });
      if (payload.length > HARD_MAX) {
        throw Object.assign(new Error(`Optimized image is ${payload.length} bytes. It must be ≤ ${HARD_MAX.toLocaleString()} before it can be queued.`), { status: 400 });
      }
      const dest = dirFor(id);
      writeFileSync(join(dest, "original.bin"), original);
      writeFileSync(join(dest, "image.bin"), payload);
      row.original_path = `${id}/original.bin`;
      row.original_bytes = original.length;
      row.mime = mime || sniffed;
      row.width = Number(width) || null;
      row.height = Number(height) || null;
      row.payload_kind = row.statement.trim() ? "both" : "image";
      if (row.payload_kind === "image") {
        writeFileSync(join(dest, "payload.bin"), payload);
        row.payload_path = `${id}/payload.bin`;
      } else {
        row.payload_path = `${id}/image.bin`;
      }
      row.last_error = null;
      row.consent = 0;
      row.status = "draft";
      return save(row);
    },
    ready(userId, id, { consent }) {
      const row = requireOpen(userId, id);
      if (!consent) throw Object.assign(new Error("Confirm that this will be permanent on Bitcoin."), { status: 400 });
      const built = payloadBuffer(get.get(id)) || Buffer.alloc(0);
      const check = validatePayload(built);
      if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
      if ((row.payload_kind === "image" || row.payload_kind === "both") && !row.original_path) {
        throw Object.assign(new Error("Keep the original photograph. InstaOp will not publish an image without it."), { status: 400 });
      }
      row.consent = 1;
      row.status = "ready";
      row.last_error = null;
      update.run({ ...row, updated_at: nowSec() });
      return publicDraft(get.get(id));
    },
    list(userId) {
      return list.all(userId).map(publicDraft);
    },
    get(userId, id) {
      const row = owned.get(id, userId);
      if (!row) throw Object.assign(new Error("Draft not found."), { status: 404 });
      return publicDraft(row);
    },
    remove(userId, id) {
      const row = requireOpen(userId, id);
      del.run(id, userId);
      rmSync(join(dataDir, "drafts", id), { recursive: true, force: true });
      return { deleted: true, id: row.id };
    },
    file(userId, id, which) {
      const row = owned.get(id, userId);
      if (!row) return null;
      if (which === "original") {
        if (!row.original_path) return null;
        const file = join(dataDir, "drafts", row.original_path);
        return existsSync(file) ? { file, type: row.mime || "application/octet-stream" } : null;
      }
      if (row.payload_kind === "both") {
        const image = join(dataDir, "drafts", id, "image.bin");
        if (existsSync(image)) return { file: image, type: row.mime || "application/octet-stream" };
      }
      if (!row.payload_path) return null;
      const file = join(dataDir, "drafts", row.payload_path);
      const type = row.payload_kind === "text" ? "text/plain; charset=utf-8" : row.mime || "application/octet-stream";
      return existsSync(file) ? { file, type } : null;
    },
    async shorten(text) {
      return suggestShortenSmart(text);
    },
    estimate(userId, id, feeRate) {
      const row = owned.get(id, userId);
      if (!row) throw Object.assign(new Error("Draft not found."), { status: 404 });
      return {
        draft: publicDraft(row),
        cost: estimateSats(row.byte_count || 0, { feeRate, noTwitter: Boolean(row.no_twitter) }),
      };
    },
    row(userId, id) {
      const row = owned.get(id, userId);
      if (!row) throw Object.assign(new Error("Draft not found."), { status: 404 });
      return row;
    },
    payloadBytes(userId, id) {
      return payloadBuffer(this.row(userId, id));
    },
    imageBytes(userId, id) {
      return imagePart(this.row(userId, id));
    },
    setPayment(userId, id, fields) {
      patch.run({
        id,
        user_id: userId,
        status: fields.status ?? null,
        r_hash: fields.rHash ?? null,
        invoice: fields.invoice ?? null,
        amount_msat: fields.amountMsat ?? null,
        amount_btc: fields.amountBtc ?? null,
        txid: fields.txid ?? null,
        confirmed: fields.confirmed == null ? null : fields.confirmed ? 1 : 0,
        idempotency_key: fields.idempotencyKey ?? null,
        invoice_expires_at: fields.expiresAt ?? null,
        post_id: fields.postId ?? null,
        last_error: fields.lastError ?? null,
        updated_at: nowSec(),
      });
      return publicDraft(owned.get(id, userId));
    },
    pendingWatch() {
      return db.prepare(`
        SELECT * FROM publication_requests
        WHERE status IN ('pending_payment', 'paid', 'broadcast')
      `).all();
    },
  };
}

function sha(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
