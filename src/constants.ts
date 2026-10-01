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
