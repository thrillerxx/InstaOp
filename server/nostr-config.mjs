// Ported from livingry-ops/src/lib/nostr-config.ts
// Working relays proven in production at livingry-ops.livingry.services
// InstaOp env overrides: INSTAOP_OTP_NPROFILE, INSTAOP_OTP_ALLOWED_NPUBS (comma csv), INSTAOP_RELAYS (comma urls)
export const DEFAULT_RELAYS = [
  { id: "damus", label: "Damus", url: "wss://relay.damus.io", operator: "Damus (Casarin)", note: "Default relay bundled with the Damus iOS client. Free, high-traffic, no signup." },
  { id: "primal", label: "Primal", url: "wss://relay.primal.net", operator: "Primal", note: "Default relay bundled with the Primal client. Free, no signup." },
  { id: "nos_lol", label: "nos.lol (Amethyst default)", url: "wss://nos.lol", operator: "nos.lol", note: "Amethyst is a client, not a relay operator — nos.lol is one of its standard bundled free public relays." },
];

// Fixed operator recipient used as allow-list anchor in the source app.
// Override per-deploy with INSTAOP_OTP_NPROFILE (nprofile or npub). Public value — not a secret.
export const OTP_RECIPIENT_NPROFILE =
  process.env.INSTAOP_OTP_NPROFILE ||
  "nprofile1qyt8wumn8ghj7un9d3shjtnwdaehgu3wvfskueqqyqqz3uf0sdv6kwpt39t44dtg8q80y2hmsv4krtk49mh56njn9swxwcktjmk";

export const RELAY_COOKIE = "instaop_relay_prefs";
export const SESSION_COOKIE = "instaop_session";

export function resolveRelayUrls() {
  const env = process.env.INSTAOP_RELAYS;
  if (env) return env.split(",").map(s => s.trim()).filter(Boolean);
  return DEFAULT_RELAYS.map(r => r.url);
}
