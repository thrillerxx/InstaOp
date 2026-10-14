import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeVoice, inspectMessage } from "./captions.mjs";
import { renderArtwork } from "./art.mjs";
import { previewUrl, squareMempoolSvg } from "./mempool-preview.mjs";
import { parseEvent, AUTHORS } from "./nostr.mjs";

const bolt = inspectMessage("OP_RETURN Bot now supports BOLT 12!");
const voice = composeVoice(bolt.message, bolt.messageKind, 2);
if (!voice.hashtags.includes("Lightning")) throw new Error("expected Lightning tag");
if (voice.note.includes("Lightning") === false) throw new Error("expected lightning note");

const raw = inspectMessage("\x00\x01\x02binary");
if (raw.messageKind !== "raw") throw new Error("expected raw");

const event = parseEvent({
  id: "abc",
  kind: 1,
  pubkey: AUTHORS[0],
  created_at: 1,
  content: "hello world\nhttps://mempool.space/tx/d8e6aaaa25d6ecbfb8cb959ffde21b9079da9341ca499854b781dd9500db4dff",
});
if (event.txid !== "d8e6aaaa25d6ecbfb8cb959ffde21b9079da9341ca499854b781dd9500db4dff") {
  throw new Error("txid parse failed");
}
if (!event.message.includes("hello world")) throw new Error("message parse failed");

const dir = mkdtempSync(join(tmpdir(), "instaop-"));
const dest = join(dir, "art.svg");
renderArtwork({ id: "t1", message: "now in rust", messageKind: "text", txid: "", artStyle: "rust" }, dest);
const svg = readFileSync(dest, "utf8");
if (!svg.includes("<svg")) throw new Error("art missing svg");

const preview = previewUrl("d8e6aaaa25d6ecbfb8cb959ffde21b9079da9341ca499854b781dd9500db4dff");
if (!preview.endsWith("/tx/d8e6aaaa25d6ecbfb8cb959ffde21b9079da9341ca499854b781dd9500db4dff")) {
  throw new Error("mempool preview url");
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const square = squareMempoolSvg(png);
if (!square.includes('width="1080"') || !square.includes("data:image/png;base64,")) {
  throw new Error("square mempool card");
}

console.log("instaop checks ok");
