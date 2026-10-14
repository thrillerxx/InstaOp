import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./index.mjs";

function runSmoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("xvfb-run", ["-a", "python3", ...args]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`webkit timeout: ${stderr}`));
    }, 20000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const dir = mkdtempSync(join(tmpdir(), "instaop-webkit-"));
writeFileSync(join(dir, "posts.json"), JSON.stringify({
  lastSeen: 10,
  posts: {
    ev1: {
      id: "ev1",
      txid: "d8e6aaaa25d6ecbfb8cb959ffde21b9079da9341ca499854b781dd9500db4dff",
      message: "hello from the chain",
      messageKind: "text",
      bytes: 20,
      note: "A small act of permanence.",
      hashtags: ["OP_RETURN"],
      created_at: Math.floor(Date.now() / 1000) - 3600,
      demo: false,
      artStatus: "pending",
      artStyle: "type",
      confirmed: true,
    },
  },
}));

const app = createApp({
  dataDir: dir,
  bind: "127.0.0.1",
  port: 0,
  noIngest: true,
  paymentsEnabled: false,
  fetchPreview: async () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  lookupConfirmed: async () => true,
});
const addr = await new Promise((resolve) => {
  app.server.listen(0, "127.0.0.1", () => resolve(app.server.address()));
});
const base = `http://127.0.0.1:${addr.port}`;
const smoke = fileURLToPath(new URL("./webkit-smoke.py", import.meta.url));

try {
  for (const [width, path, extra] of [
    [375, "/", null],
    [1024, "/", null],
    [1280, "/#/about", "tabconf"],
  ]) {
    const ran = await runSmoke([smoke, base, String(width), path]);
    assert(ran.status === 0, `webkit ${width}${path} failed: ${ran.stderr || ran.stdout}`);
    const metrics = JSON.parse(ran.stdout.trim().split("\n").at(-1));
    assert(!metrics.error, metrics.error || "webkit js");
    assert(metrics.scroll <= metrics.view + 1, `webkit overflow at ${width}: ${metrics.scroll} > ${metrics.view}`);
    assert(metrics.posts > 0 || metrics.about, "webkit rendered");
    if (extra === "tabconf") assert(metrics.tabconf && metrics.about, "webkit about modal");
  }
  console.log("instaop webkit checks ok");
} finally {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
