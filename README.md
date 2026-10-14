# InstaOp

A Bitcoin-native social network around [OP_RETURN](https://opreturnbot.com) messages.

The first official account is `opreturn` / OP_RETURN Bot. It imports the public OP_RETURN Bot Nostr feed. A Bitcoin transaction does not identify who wrote the original message. Likes, comments, and follows live in InstaOp. A public post is only allowed after a confirmed onchain publication.

Phase 3 sends queued drafts to OP_RETURN Bot for a Lightning invoice. InstaOp does not run a Lightning node. A public post appears only after the transaction confirms. Tests never create mainnet invoices.

## What it does

- Ingests public OP_RETURN Bot notes from Nostr
- Owns those posts as the official `opreturn` publisher
- Real email or Nostr login (NIP-07). Private keys never touch the server
- Follows, likes, comments, saves, notifications, and profile photos
- Generated artwork and onchain captions
- Guests can browse. Signed-in users can interact

Artwork is procedural SVG until an image provider is configured with `INSTAOP_IMAGE_PROVIDER` and a server-side key. Keys stay on the server, never in the browser.

## Run

```bash
npm install
npm test
INSTAOP_DATA=./data INSTAOP_BIND=127.0.0.1 INSTAOP_PORT=8788 npm start
```

Then open `http://127.0.0.1:8788/`.

See `docs/ARCHITECTURE.md` for the schema, OP_RETURN Bot API notes, and later phases.

Optional provider config can live in a local env file that you do not commit.
