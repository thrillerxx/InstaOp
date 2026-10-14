import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createApp } from "./index.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const dir = mkdtempSync(join(tmpdir(), "instaop-ui-"));
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

await fetch(`${base}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: "bob",
    email: "bob@example.com",
    password: "correct horse",
    displayName: "Bob",
  }),
});

const browser = await chromium.launch({
  executablePath: process.env.INSTAOP_CHROME || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  for (const width of [375, 430, 768, 900, 1024, 1440, 1600]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector(".post, .empty-box, .skel-post", { timeout: 8000 });
    await page.waitForFunction(() => document.fonts ? document.fonts.status === "loaded" : true, { timeout: 3000 }).catch(() => {});
    const metrics = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: window.innerWidth,
      stories: [...document.querySelectorAll(".story-chip span")].map((el) => el.textContent),
      tabs: Boolean(document.querySelector(".tabbar") && getComputedStyle(document.querySelector(".tabbar")).display !== "none"),
      side: Boolean(document.querySelector(".sidenav") && getComputedStyle(document.querySelector(".sidenav")).display !== "none"),
      rail: Boolean(document.querySelector(".rail") && getComputedStyle(document.querySelector(".rail")).display !== "none"),
      chain: Boolean(document.querySelector("[data-chain]")),
    }));
    assert(metrics.scroll <= metrics.view + 1, `horizontal overflow at ${width}: ${metrics.scroll} > ${metrics.view}`);
    assert(new Set(metrics.stories).size === metrics.stories.length, `duplicate stories at ${width}`);
    if (width <= 430) assert(metrics.tabs && !metrics.side, "mobile chrome");
    if (width >= 1100) assert(metrics.side, "desktop sidebar");
    if (width >= 1264) assert(metrics.rail, "desktop rail");
    if (width < 1264) assert(!metrics.rail, "rail hidden until 1264");
    assert(metrics.chain, "onchain badge");
    const shotDir = join(tmpdir(), "instaop-ui");
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, `${width}.png`), fullPage: false });
    await page.getByRole("button", { name: "Live", exact: true }).first().click();
    await page.waitForTimeout(50);
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const logs = [];
  page.on("pageerror", (err) => logs.push(err.message));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForSelector(".post", { timeout: 8000 });

  await page.locator("#me-switch").click();
  await page.locator("#auth-username").fill("alice");
  await page.locator("#auth-email").fill("alice@example.com");
  await page.locator("#auth-password").fill("correct horse");
  await page.locator("#auth-submit").click();
  await page.waitForFunction(() => document.getElementById("me-user")?.textContent === "alice", { timeout: 8000 });

  await page.locator(".like").first().click();
  await page.waitForFunction(() => document.querySelector(".like")?.classList.contains("liked"), { timeout: 5000 });
  await page.locator(".like").first().click();
  await page.waitForFunction(() => !document.querySelector(".like")?.classList.contains("liked"), { timeout: 5000 });

  await page.locator(".open-comments").first().click();
  await page.waitForSelector("#comments-view:not(.hidden)");
  await page.locator("#comment-input").fill("nice permanence");
  await page.locator("#comment-form button").click();
  await page.waitForSelector(".comment");
  await page.locator(".comment-like").first().click();
  await page.waitForFunction(() => document.querySelector(".comment-like")?.classList.contains("liked"), { timeout: 5000 });
  await page.locator("#comments-close").click();

  await page.locator(".onchain-badge").first().click();
  await page.waitForSelector("#chain-view:not(.hidden)");
  const chain = await page.locator("#chain-body").innerText();
  assert(chain.includes("Bitcoin mainnet"), "chain panel");
  assert(chain.includes("does not identify"), "no false authorship");
  await page.locator("#chain-close").click();

  await page.locator(".share").first().click();
  await page.waitForTimeout(200);

  await page.locator(".save").first().click();
  await page.waitForFunction(() => document.querySelector(".save")?.classList.contains("saved"), { timeout: 5000 });

  await page.locator(".media").first().click();
  await page.waitForSelector("#post-view:not(.hidden)", { timeout: 3000 });
  await page.locator("#post-close").click();

  await page.locator("[data-go=more]").first().click();
  await page.getByRole("button", { name: "About InstaOp" }).click();
  await page.waitForSelector("#about-view:not(.hidden)");
  const about = await page.locator("#about-view").innerText();
  assert(about.includes("TabConf 8"), "about mentions TabConf");
  assert(about.includes("OP_RETURN Bot"), "about mentions OP_RETURN Bot");
  await page.locator("#about-close").click();

  await page.locator("[data-go=explore]").first().click();
  await page.waitForSelector("#search-view:not(.hidden)");

  await page.goto(`${base}/#/u/bob`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#profile-view:not(.hidden)");
  await page.locator("#profile-follow").click();
  await page.waitForFunction(() => document.getElementById("profile-follow")?.textContent === "Following", { timeout: 5000 });

  await page.locator("[data-go=create]").first().click();
  await page.waitForSelector("#create-view:not(.hidden)");
  await page.locator("#co-statement").fill("hello bitcoin");
  await page.locator("#co-preview-btn").click();
  await page.waitForSelector("[data-step=preview]:not(.hidden), #co-error:not(.hidden)");

  assert(!logs.length, `console errors: ${logs.join("; ")}`);

  console.log("instaop ui checks ok");
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
