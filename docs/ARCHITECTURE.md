# InstaOp architecture

InstaOp is a Bitcoin-native social network. The social graph lives in our database. A public post exists only after a confirmed Bitcoin OP_RETURN.

Phase 1 is the social layer around the existing OP_RETURN Bot feed. Phase 2 is the composer, byte optimizer, and private draft queue. Phase 3 is Lightning invoices. A public post still requires a confirmed OP_RETURN.

## What we keep

- Node 20 HTTP server, SSE live stream, and static InstaOp frontend
- Nostr ingest of the official OP_RETURN Bot pubkey
- Official imported posts use mempool.space transaction unfurls, letterboxed to 1080×1080. Other posts stay procedural until an image provider is set.
- JSON post cache plus on-disk SVG art
- Private Tailscale preview. No public domain.

## What we rejected

**Appwrite (including Snapgram / `adrianhajdin/social_media_app`)**  
Self-hosted Appwrite wants Docker Compose, about 16 containers, and a 4 GB production floor. This VPS already runs other Compose stacks and a Postgres instance we do not own. Snapgram is an Appwrite Cloud tutorial, not a Bitcoin product. Its license file is not present on the default branch. We take UI patterns, not the stack.

**Pixelfed**  
A real photo network, but AGPL PHP/ActivityPub. Wrong content model for mandatory onchain posts.

**Sharing the existing Postgres on this host**  
It belongs to another app. We will not put InstaOp tables there.

## Phase 1 stack

| Piece | Choice |
| --- | --- |
| App | Same Node process as the live gallery |
| Social database | SQLite (`social.sqlite`) with WAL, migrations on boot |
| Password auth | Email or username + scrypt |
| Nostr auth | Signed challenge. Never store an `nsec`. |
| Sessions | Opaque tokens in SQLite, `HttpOnly` cookies |
| Profile photos | Local files under the data directory |
| Realtime | Existing SSE, plus refetch of counts |
| Tests | `npm test` against an isolated temp database |

SQLite is the lightweight alternative to Appwrite. The schema is ordinary SQL and can move to a dedicated PostgreSQL later without changing the product model. We do not add a new networked database or new public ports for Phase 1.

## Product rules

1. Imported OP_RETURN Bot notes become posts owned by the official `@OP_RETURN_Bot` account.
2. Those posts are **published through** OP_RETURN Bot. A transaction does not identify the person who paid for the original message.
3. Likes, comments, follows, bookmarks, and profiles are offchain and server-authorized.
4. Guests can browse. Only signed-in users can interact.
5. Demo / simulated posts are not public. No fake like or comment counts.
6. Deleting an InstaOp account or hiding a post does not delete Bitcoin data. The UI must say so.
7. No mainnet invoice or broadcast until Phase 3 is explicitly enabled (`INSTAOP_PAYMENTS=1`). Drafts never enter the public feed.

## Official account

- Username: `OP_RETURN_Bot` (old `@opreturn` URLs still resolve here)
- Display name: `OP_RETURN Bo`
- Avatar: official OP_RETURN Bot cube (`public/opreturn-avatar.svg`, from https://opreturnbot.com/assets/images/logo.svg)
- Website: `https://opreturnbot.com` (seeded; any user can add their own website on their profile)
- System account, seeded on migrate
- New users follow it automatically so Home is not empty
- Attribution on every imported post: the bot is the InstaOp publisher, not a proven author of the onchain bytes

## Identity

Internal account IDs are ours (`users.id`). A person may link a Nostr pubkey later. Email and Nostr are both `identities` rows. Phase 1 login:

1. Email/username + password
2. Nostr: server issues a challenge, the browser signs with NIP-07 (`window.nostr`). Server verifies Schnorr over the canonical event id. Private keys never leave the signer.

## Feeds

| Surface | Ranking |
| --- | --- |
| Home | Chronological posts from accounts the viewer follows. `@OP_RETURN_Bot` is always included and cannot be unfollowed. |
| Live | Chronological imported OP_RETURN events, newest first. Official posts stay in this feed. |
| Explore | Image grid of published posts, plus hashtag and user search |
| Profile | That account's published posts, plus Saved on the viewer's own profile |

New Live posts do not jump the Home scroll. A "new posts" pill appears when the viewer is pinned down the page.

## Schema

See `server/db.mjs`. Core tables:

- `users`, `identities`, `sessions`, `nostr_challenges`
- `follows`, `blocks`, `reports`
- `posts` (social overlay keyed by ingest id)
- `likes`, `comments`, `bookmarks`
- `notifications`
- `publication_requests`, `jobs` (created now, used in Phase 2–3)
- `moderation_actions`

Post publication states for later phases: `draft`, `pending_payment`, `paid`, `broadcast`, `confirmed`, `failed`, `expired`. Only `confirmed` may enter the public feed.

## OP_RETURN Bot API (Phase 2–3, do not call on mainnet yet)

Verified in [benthecarman/OP-RETURN-Bot](https://github.com/benthecarman/OP-RETURN-Bot) (`conf/routes`, `Controller.scala`, `Forms.scala`, `MessageLimits.scala`, `InvoiceMonitor.scala`):

| Endpoint | Body / result |
| --- | --- |
| `POST /api/create` | Form `message` (UTF-8 string) + `noTwitter`. Returns a Lightning invoice string. |
| `POST /api/unified` | Same form. JSON: `address`, `invoice`, `amountBtc`, `rHash`, `paymentString`. |
| `GET /api/status/:rHash` | Txid hex if broadcast; `null` if paid but no txid yet; 400 if unpaid. |
| `GET /api/view/:txId` | Message text if the tx came from this bot. |
| `GET /api/mempool-limit` | `true` / `false`. |

Limits:

- Website and form validator advertise **99,000 bytes** (`MessageLimits.MaxBytes`).
- Invoice creation also `require`s **≤ 90,000 bytes** in `InvoiceMonitor.getPaymentParams`. Treat **90,000** as the hard quote limit until we confirm a file path that bypasses it.
- The public site accepts a file in the browser, but the HTTP API encodes `message` as a UTF-8 string. Binary through that form will corrupt image bytes. Phase 2 needs a server-side adapter (and a dry-run against their file POST) before we charge anyone.
- `status` returning a txid means the bot broadcast a transaction. That is not the same as a mempool.space confirmation. Phase 3 must check confirmation separately.
- Paid + `null` is "broadcasting / waiting", not success.

## Phases

1. **Done** — accounts, profiles, follows, likes, comments, saves, notifications, profile photos, `@OP_RETURN_Bot` import, Home / Live / Explore.
2. **Now** — text + image drafts, client-side byte optimizer, unpublished queue, fee *estimate* only. No invoices.
3. **Now** — Lightning invoices via OP_RETURN Bot (`/api/unified` for text, `/createRequest` multipart `file` for images). InstaOp does not run LND. Tests use a mock bot. A public post still requires a mempool confirmation, not just broadcast.
4. **Now** — hashtag explorer, clickable `@mentions`, confirm-time mempool card refresh, optional AI shorten/art when a server key is set. PWA / mobile is live.

Phase 2 payload rules:

- Hard cap **90,000 bytes** (invoice `require` in OP_RETURN Bot). Advertised site max is 99,000.
- Text uses UTF-8 byte length. The shortening helper never overwrites the statement unless the author accepts it.
- Images keep the original file and store the exact optimized bytes that would be sent to the bot. Not a hash.
- Text + image uses an `IO1` envelope so both payloads sit in one OP_RETURN. Text-only stays raw UTF-8 so it remains readable on explorers.
- Fee numbers shown in the composer are estimates from the bot's published formula plus a public mempool rate. They are not invoices.

## Deploy notes

- Bind the Node process to localhost. Proxy only on the tailnet.
- Prefer Tailscale HTTPS before treating sessions as production-grade.
- Back up `social.sqlite`, `posts.json`, `images/`, and `avatars/` together.
- Do not publish hostnames, tailnet IPs, or env files.
