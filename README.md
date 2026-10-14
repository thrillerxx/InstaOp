# InstaOp

An Instagram-style live gallery of Bitcoin [OP_RETURN](https://opreturnbot.com) messages.

The chain writes the caption. InstaOp turns each message into a square piece of artwork and a post.

## What it does

- Ingests public OP_RETURN Bot notes from Nostr
- Saves each event once and generates artwork asynchronously
- Shows the original on-chain text, a short note, and hashtags
- Serves a dark, mobile-first feed with stories, explore, and a reel viewer

Artwork is procedural SVG until an image provider is configured with `INSTAOP_IMAGE_PROVIDER` and a server-side key. Keys stay on the server, never in the browser.

## Run

```bash
npm install
INSTAOP_DATA=./data INSTAOP_BIND=127.0.0.1 INSTAOP_PORT=8788 npm start
```

Then open `http://127.0.0.1:8788/`.

Optional provider config can live in a local env file that you do not commit.

## Nostr OTP Auth (ported from Livingry Ops)

Passwordless sign-in via NIP-04 encrypted DM — same stack running at `livingry-ops.livingry.services`.

- **Ephemeral sender keys:** every OTP DM is signed by a fresh throwaway keypair, never persisted.
- **CSPRNG codes:** `node:crypto randomInt` 6-digit, 5 min TTL, 5 attempts.
- **Working relays (proven):** `wss://relay.damus.io`, `wss://relay.primal.net`, `wss://nos.lol` — configurable via `INSTAOP_RELAYS`.
- **Allow-list:** only the configured operator npub (default `nprofile1qyt8w…cktjmk` from Livingry Ops) may receive, plus any `INSTAOP_OTP_ALLOWED_NPUBS` you add.
- **Session:** HMAC-SHA256 signed cookie (`instaop_session`), `HttpOnly; Secure; SameSite=Lax; Max-Age=7d`, verified with `timingSafeEqual`.

### Endpoints

```
GET  /api/auth/relays   -> { options, selected }
POST /api/auth/send     { npub } -> { ok, sessionKey, relaysSucceeded }
POST /api/auth/verify   { sessionKey, code } -> { ok } + Set-Cookie: instaop_session
GET  /api/auth/session  -> { granted: boolean }
DELETE /api/auth/session -> clears cookie
```

### Env

```
INSTAOP_OTP_NPROFILE=nprofile1qyt8w...   # operator recipient (nprofile or npub)
INSTAOP_OTP_ALLOWED_NPUBS=npub1...,npub1...  # extra allowed recipients
INSTAOP_RELAYS=wss://relay.damus.io,wss://relay.primal.net,wss://nos.lol
```

Source port: [`livingry-ops/src/lib/otp-store.ts`](https://github.com/OV1-Kenobi/livingry-company-os) `nostr-config.ts`, `session.ts`, `dashboard-auth/*` + `rate-limit.ts` — adapted from Next.js/TS to plain ESM for InstaOp's `node:http` server (no Supabase/Telegram deps).


