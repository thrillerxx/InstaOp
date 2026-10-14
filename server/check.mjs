import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeVoice, inspectMessage } from "./captions.mjs";
import { renderArtwork } from "./art.mjs";
import { previewUrl, squareMempoolSvg } from "./mempool-preview.mjs";
import { suggestShortenSmart } from "./optimize.mjs";
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
if (!square.includes('width="1200"') || square.includes("y=\"270\"") || !square.includes("data:image/png;base64,")) {
  throw new Error("mempool card should be 2:1 without letterbox bars");
}

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
if (!css.includes("max-width: var(--feed)") || !css.includes("min-width: 0")) {
  throw new Error("feed column must shrink with the viewport and cap at --feed");
}
if (!css.includes(".media") || !css.includes("object-fit: contain") || !css.includes("overflow: hidden")) {
  throw new Error("1080 art must stay inside the post frame");
}
if (css.includes("minmax(var(--feed), 630px)")) {
  throw new Error("desktop grid must not grow the feed track past the post width");
}
if (!css.includes("overscroll-behavior-x: contain")) {
  throw new Error("stories scroll inside the feed, not the page");
}

const smart = await suggestShortenSmart("I just really actually love Bitcoin forever");
if (smart.engine !== "rules") throw new Error("no key uses rules engine");
if (!smart.suggested.toLowerCase().includes("bitcoin")) throw new Error("shorten keeps meaning");

console.log("instaop checks ok");
