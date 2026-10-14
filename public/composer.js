(() => {
  const opt = () => window.InstaOpOptimize;
  let draft = null;
  let originalFile = null;
  let optimized = null;
  let slider = 50;

  const root = () => document.getElementById("create-view");

  function $(id) {
    return document.getElementById(id);
  }

  function utf8(text) {
    return opt().utf8Bytes(text);
  }

  function bytes(n) {
    return opt().formatBytes(n);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: options.body instanceof FormData ? {} : { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Request failed");
    return body;
  }

  function setStep(name) {
    root().querySelectorAll("[data-step]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.step !== name);
    });
  }

  function renderMeter() {
    const statement = $("co-statement").value;
    const n = draft?.byteCount || (optimized ? optimized.bytes : utf8(statement));
    const max = opt().HARD_MAX;
    $("co-bytes").textContent = `${n.toLocaleString()} / ${max.toLocaleString()} bytes`;
    $("co-bytes").classList.toggle("over", n > max);
    const pct = Math.min(100, Math.round((n / max) * 100));
    $("co-meter").style.width = `${pct}%`;
    $("co-meter").classList.toggle("over", n > max);
    $("co-shorten").classList.toggle("hidden", utf8(statement) < 8);
  }

  function renderCompare() {
    if (!optimized || !originalFile) {
      $("co-compare").classList.add("hidden");
      return;
    }
    $("co-compare").classList.remove("hidden");
    $("co-orig-img").src = URL.createObjectURL(originalFile);
    $("co-opt-img").src = URL.createObjectURL(optimized.blob);
    $("co-orig-size").textContent = bytes(optimized.originalBytes);
    $("co-opt-size").textContent = `${bytes(optimized.bytes)} · ${optimized.width}×${optimized.height}`;
    $("co-opt-status").textContent = optimized.bytes <= opt().HARD_MAX ? "Ready for OP_RETURN" : "Still too large";
    setSlider(slider);
  }

  function setSlider(value) {
    slider = Number(value);
    $("co-slider").value = String(slider);
    $("co-opt-img").style.clipPath = `inset(0 ${100 - slider}% 0 0)`;
  }

  async function saveText() {
    const body = {
      statement: $("co-statement").value,
      caption: $("co-caption").value,
      hashtags: $("co-tags").value.split(/[\s,#]+/).filter(Boolean),
      kind: originalFile ? ( $("co-statement").value.trim() ? "both" : "image") : "text",
      noTwitter: $("co-private").checked,
    };
    if (!draft) {
      const created = await api("/api/publish/drafts", { method: "POST", body: JSON.stringify(body) });
      draft = created.draft;
    } else {
      const updated = await api(`/api/publish/drafts/${draft.id}`, { method: "PATCH", body: JSON.stringify(body) });
      draft = updated.draft;
    }
    renderMeter();
    return draft;
  }

  async function onFile(file) {
    if (!file) return;
    originalFile = file;
    $("co-opt-copy").textContent = `Your photo is ${bytes(file.size)}. Let's get it ready for Bitcoin.`;
    $("co-opt-copy").classList.remove("hidden");
    setStep("optimize");
    const result = await opt().optimizeImage(file, (progress) => {
      $("co-opt-live").textContent = `${bytes(progress.originalBytes)} → ${bytes(progress.currentBytes)}`;
    });
    if (!result.ok) {
      $("co-error").textContent = result.error;
      $("co-error").classList.remove("hidden");
      return;
    }
    optimized = result;
    await saveText();
    const data = new FormData();
    data.append("original", originalFile, originalFile.name || "original.jpg");
    data.append("payload", optimized.blob, `payload.${optimized.mime === "image/webp" ? "webp" : "jpg"}`);
    data.append("width", String(optimized.width));
    data.append("height", String(optimized.height));
    data.append("mime", optimized.mime);
    const attached = await api(`/api/publish/drafts/${draft.id}/image`, { method: "POST", body: data });
    draft = attached.draft;
    renderCompare();
    renderMeter();
    setStep("compose");
  }

  async function loadQueue() {
    const data = await api("/api/publish/drafts");
    $("co-queue").innerHTML = data.drafts.map((item) => `
      <button class="queue-item" data-draft="${item.id}" type="button">
        <strong>${escape(item.statement || item.kind)}</strong>
        <small>${item.status} · ${item.byteCount.toLocaleString()} bytes</small>
      </button>`).join("") || `<p class="hint">No drafts yet. Nothing here is on Bitcoin.</p>`;
    $("co-queue").querySelectorAll("[data-draft]").forEach((btn) => {
      btn.addEventListener("click", () => openDraft(btn.dataset.draft));
    });
  }

  async function openDraft(id) {
    const data = await api(`/api/publish/drafts/${id}`);
    draft = data.draft;
    $("co-statement").value = draft.statement || "";
    $("co-caption").value = draft.caption || "";
    $("co-tags").value = (draft.hashtags || []).map((tag) => `#${tag}`).join(" ");
    $("co-private").checked = draft.noTwitter;
    renderMeter();
    setStep("compose");
  }

  function escape(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  async function preview() {
    await saveText();
    const quote = await api(`/api/publish/drafts/${draft.id}/estimate`);
    draft = quote.draft;
    $("co-preview-text").textContent = draft.statement || "(image payload)";
    $("co-preview-meta").innerHTML = `
      <p><b>${draft.byteCount.toLocaleString()} bytes</b> would be written to Bitcoin.</p>
      <p>${draft.kind === "image" || draft.kind === "both" ? "The photograph bytes themselves go onchain, not a hash." : "The exact UTF-8 statement goes onchain."}</p>
      <p class="warn">This cannot be deleted from the blockchain later. Removing it from InstaOp will not remove the transaction.</p>
      ${quote.cost.ok ? `<p class="cost">Estimated ${quote.cost.sats.toLocaleString()} sats · ${quote.cost.standard ? "standard" : "non-standard"} · not an invoice</p>` : `<p class="error">${quote.cost.error}</p>`}
    `;
    if (draft.previewUrl && draft.kind !== "text") {
      $("co-preview-img").src = draft.previewUrl;
      $("co-preview-img").classList.remove("hidden");
    } else {
      $("co-preview-img").classList.add("hidden");
    }
    $("co-consent").checked = false;
    setStep("preview");
  }

  window.InstaOpComposer = {
    async open() {
      root().classList.remove("hidden");
      $("co-error").classList.add("hidden");
      if (!draft) {
        $("co-statement").value = "";
        $("co-caption").value = "";
        $("co-tags").value = "";
        originalFile = null;
        optimized = null;
      }
      renderMeter();
      await loadQueue();
      setStep("compose");
    },
    close() {
      root().classList.add("hidden");
    },
  };

  $("co-close").addEventListener("click", () => window.InstaOpComposer.close());
  $("co-statement").addEventListener("input", renderMeter);
  $("co-photo").addEventListener("change", (event) => {
    $("co-error").classList.add("hidden");
    onFile(event.target.files[0]).catch((err) => {
      $("co-error").textContent = err.message;
      $("co-error").classList.remove("hidden");
    });
  });
  $("co-slider").addEventListener("input", (event) => setSlider(event.target.value));
  $("co-save").addEventListener("click", () => {
    saveText().then(loadQueue).catch((err) => {
      $("co-error").textContent = err.message;
      $("co-error").classList.remove("hidden");
    });
  });
  $("co-preview-btn").addEventListener("click", () => {
    preview().catch((err) => {
      $("co-error").textContent = err.message;
      $("co-error").classList.remove("hidden");
    });
  });
  $("co-back").addEventListener("click", () => setStep("compose"));
  $("co-shorten").addEventListener("click", async () => {
    const data = await api("/api/publish/shorten", { method: "POST", body: JSON.stringify({ statement: $("co-statement").value }) });
    $("co-suggest").classList.remove("hidden");
    $("co-suggest-body").textContent = data.suggested;
    $("co-suggest-meta").textContent = `${data.originalBytes} → ${data.suggestedBytes} bytes · save ${data.savings}${data.engine === "ai" ? " · AI" : ""}`;
    $("co-accept-short").onclick = () => {
      $("co-statement").value = data.suggested;
      $("co-suggest").classList.add("hidden");
      renderMeter();
    };
  });
  let poll = null;

  function showInvoice(row) {
    draft = row;
    if (!row.invoice) return;
    $("co-invoice").classList.remove("hidden");
    $("co-qr").src = row.qrUrl || `/api/publish/drafts/${row.id}/qr`;
    $("co-bolt11").value = row.invoice;
    $("co-pay-status").textContent = statusText(row);
    $("co-done").classList.remove("hidden");
    $("co-done").textContent = row.status === "confirmed"
      ? "Confirmed on Bitcoin. It is now a public InstaOp post."
      : "Invoice is from OP_RETURN Bot. This draft stays private until the transaction confirms.";
  }

  function statusText(row) {
    if (row.status === "pending_payment") return "Waiting for Lightning payment…";
    if (row.status === "paid") return "Paid. Waiting for the bot to broadcast…";
    if (row.status === "broadcast") return "Broadcast. Waiting for a Bitcoin confirmation…";
    if (row.status === "confirmed") return "Confirmed on Bitcoin.";
    if (row.status === "expired") return "Invoice expired. Pay again to get a new one.";
    return row.status;
  }

  function startPoll() {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!draft?.id) return;
      try {
        const data = await api(`/api/publish/drafts/${draft.id}/refresh`, { method: "POST", body: "{}" });
        showInvoice(data.draft);
        if (data.draft.status === "confirmed" || data.draft.status === "expired" || data.draft.status === "failed") {
          clearInterval(poll);
          loadQueue();
        }
      } catch {
        // keep waiting
      }
    }, 2500);
  }

  $("co-ready").addEventListener("click", async () => {
    try {
      if (!$("co-consent").checked) throw new Error("Check the permanence warning before queuing this for Bitcoin.");
      await saveText();
      const data = await api(`/api/publish/drafts/${draft.id}/ready`, { method: "POST", body: JSON.stringify({ consent: true }) });
      draft = data.draft;
      $("co-done").classList.remove("hidden");
      $("co-done").textContent = "Queued. Pay the Lightning invoice to write it on Bitcoin.";
      loadQueue();
    } catch (err) {
      $("co-error").textContent = err.message;
      $("co-error").classList.remove("hidden");
    }
  });
  $("co-pay").addEventListener("click", async () => {
    try {
      $("co-error").classList.add("hidden");
      if (!draft?.id) await saveText();
      if (!$("co-consent").checked) throw new Error("Check the permanence warning first.");
      if (draft.status !== "ready" && draft.status !== "expired" && draft.status !== "failed" && draft.status !== "pending_payment") {
        const queued = await api(`/api/publish/drafts/${draft.id}/ready`, { method: "POST", body: JSON.stringify({ consent: true }) });
        draft = queued.draft;
      }
      const data = await api(`/api/publish/drafts/${draft.id}/pay`, { method: "POST", body: "{}" });
      showInvoice(data.draft);
      startPoll();
      loadQueue();
    } catch (err) {
      $("co-error").textContent = err.message;
      $("co-error").classList.remove("hidden");
    }
  });
  $("co-copy-inv").addEventListener("click", async () => {
    if ($("co-bolt11").value) await navigator.clipboard.writeText($("co-bolt11").value);
  });
})();
