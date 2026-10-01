// LobbyRoom.ts's refreshLeaderboard(): how often it re-queries Mongo for the
// all-time top players per stat, and how many rows it fetches per stat before
// merging with the live online roster.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;

// Playtime: how often each connected player's elapsed time is added to their
// total (in memory for everyone, $inc'd to Mongo for signed-in players).
export const PLAYTIME_FLUSH_MS = 30_000;

// Upper bounds for saved values, so a forged payload can't push a bogus number
// onto the leaderboards. Generous ceilings, not game rules.
export const MONEY_MAX = 1_000_000_000_000_000;
export const COUNTER_MAX = 1_000_000_000_000; // totalPoops
export const POOP_VALUE_MAX = 1_000_000_000_000; // yield of a single poop stack

// Poop inventory: the client's systems/poop.js keeps one stack per poop, never merged.
export const POOP_MAX_STACKS = 500;

// Food ids of the client's FOODS (systems/shop.js). Ids are allow-listed so a
// forged payload can't invent a food; keep in step by hand when foods are added.
export const FOOD_IDS = [
  "lettuce",
  "donut",
  "hotsauce",
  "cola",
  "banana",
  "milk",
  "goldapple",
  "energy",
  "pizza",
] as const;
// A poop's type is a food id, or "plain" for an unflavoured one.
export const POOP_TYPES: readonly string[] = ["plain", ...FOOD_IDS];
export const FOOD_MAX_KINDS = FOOD_IDS.length;
export const FOOD_MAX_COUNT = 1_000_000;

// First-run tutorial progress: the client's data/tutorial.js TUTORIAL_STEPS (steps 0..5,
// 6 = finished). Keep in step by comment.
export const TUTORIAL_DONE_STEP = 6;
// The step whose Buy A Food needs the guaranteed unit (client TUTORIAL_STEPS index of `buy`).
export const TUTORIAL_BUY_STEP = 3;

// Daily Size Boost (client systems/boost.js): streak is days claimed in a row.
export const BOOST_STREAK_MAX = 100_000;
// Epoch-ms fields (nextClaimAt, streakEnd, boostEndsAt, saved-food expiry)
// must be a plausible timestamp; 0 means "never".
export const TIME_MAX = 8_640_000_000_000_000; // JS Date range
// Save Food Effects keeps foods for 24 h (client systems/foodFx.js); a save
// never lives longer than that, and an expired one is removed.
export const SAVED_FOODS_TTL_MS = 24 * 3600 * 1000;

// Poop-size multiplier bounds; keep in step with the client's poopScale
// (systems/poop.js: 0.4..2.5).
export const POOP_SIZE_MIN = 0.4;
export const POOP_SIZE_MAX = 2.5;

// Minimum gap between two accepted `poop` messages from one connection, so a
// modified client can't flood every other client with poop drops.
export const POOP_MIN_INTERVAL_MS = 300;

// Forced client update. The client sends its CLIENT_VERSION (its data/net.js) when joining; one
// below this gets a `reload` message and refreshes the page (components/UpdateNotice.jsx). Raise
// this together with CLIENT_VERSION whenever a deploy must not be run by stale tabs. Clients from
// before the handshake send no version (counted as 0) and can't act on it, so they only pick it
// up on their next manual reload.
export const MIN_CLIENT_VERSION = 3;

// Treasure Chest on/off. While false the chest is hidden in the client (CHEST_ENABLED in its
// data/world.js) and `openChest` is refused, so stale tabs that still show it can't claim.
export const CHEST_ENABLED = false;

// Treasure Chest (client systems/chest.js): only this many players, ever, can open it, each
// once. Claims are keyed by account id (guests by session id) and persisted as
// PlayerDoc.chestOpened. Keep in step with the client's CHEST_MAX_OPENS.
export const CHEST_MAX_OPENS = 5;
// Bump this number and deploy to re-arm the chest: on startup the room clears every account's
// chestOpened once per value (remembered in the `meta` collection), so all slots are free again.
export const CHEST_RESET_EPOCH = 1;

// Stealing poop from another player (LobbyRoom.ts `steal` / `stealHandover`). The cost is
// burned, not paid to the victim; keep STEAL_COST in step with the client's data/net.js.
export const STEAL_COST = 1000;
// Horizontal reach the server accepts. The client prompt appears much closer (data/net.js
// STEAL_RANGE); this is looser because both positions are throttled samples.
export const STEAL_RANGE = 4;
// How long the victim's client has to hand its poop over before the steal fails.
export const STEAL_TIMEOUT_MS = 5_000;
// Per-thief gap between two steal attempts.
export const STEAL_COOLDOWN_MS = 3_000;
// After being robbed a player can't be robbed again for this long.
export const STEAL_PROTECT_MS = 30_000;
// After A robs B, B can't rob A back for this long (shown to B; keep in step with the client).
export const STEAL_REVENGE_BLOCK_MS = 5 * 60 * 1000;
