import { MongoClient, type Collection } from "mongodb";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated
// database with scoped credentials, no provisioning. A local `npm start`
// normally has no Mongo reachable at all, so a missing/unreachable URI must
// degrade this to "no persistence" rather than crash the room -- same stance
// every external dependency in the client takes (systems/bloxity.js).
export interface PoopStackDoc {
  type: string; // food id or "plain" (constants.ts POOP_TYPES)
  value: number; // yield in lb, sold at $0.01 each
}

export interface FoodSlotDoc {
  id: string;
  count: number;
}

export interface BoostDoc {
  streak: number;
  nextClaimAt: number;
  streakEnd: number;
  boostEndsAt: number;
}

export interface SavedFoodsDoc {
  slots: FoodSlotDoc[];
  expiresAt: number;
}

export interface PlayerDoc {
  _id: string; // Bloxity user id (SDK.auth.getUser()._id) -- see LobbyRoom.ts
  // Display name as of the last save, so an offline leaderboard row still has
  // something to show. Older docs may lack it; readers fall back to "Player".
  username?: string;
  // Money in the client (systems/poop.js `money`).
  money: number;
  // Lifetime counters; only ever grow on the client.
  totalPoops: number;
  totalEarned: number;
  // Poop yield held but not yet sold, one entry per poop.
  poops?: PoopStackDoc[];
  // Pantry: foods bought and not yet used (systems/pantry.js).
  pantry?: FoodSlotDoc[];
  // Daily Size Boost claim state (systems/boost.js).
  boost?: BoostDoc;
  // "Save Food Effects" stall: foods kept for 24 h (systems/foodFx.js).
  savedFoods?: SavedFoodsDoc;
  // The first-run tutorial was finished (or skipped); only ever set, never cleared
  // (client systems/tutorial.js).
  tutorialDone?: boolean;
  // Step the first-run tutorial is on (constants.ts TUTORIAL_DONE_STEP = finished). Only ever
  // raised ($max in LobbyRoom saveProgress). Older docs lack it; see resolveTutorialStep.
  tutorialStep?: number;
  // Bought Theft Immunity at the Locked Jar: nobody can steal this player's poop and they can't
  // steal either. Only ever set, never cleared (client systems/theftImmunity.js).
  theftImmune?: boolean;
  // This account opened the Treasure Chest (constants.ts CHEST_MAX_OPENS players in total can).
  // Set only by the server's `openChest` handler, never accepted from a client save.
  chestOpened?: boolean;
  // Total seconds this account has spent connected, measured by the SERVER
  // clock (LobbyRoom.ts flushPlaytime) -- never client-reported, so it can't
  // be forged via saveProgress. Older docs may lack it.
  playTime?: number;
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
// Small key/value docs for the server's own bookkeeping (e.g. the chest reset epoch).
export interface MetaDoc {
  _id: string;
  resetEpoch?: number;
}

let players: Collection<PlayerDoc> | null = null;
let meta: Collection<MetaDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this
    // game+channel's own isolated database.
    players = client.db().collection<PlayerDoc>("players");
    meta = client.db().collection<MetaDoc>("meta");
    console.log("[db] connected to MongoDB");

    // refreshLeaderboard() sorts by each of these; createIndex is idempotent.
    // A failure only means those queries stay unindexed, never blocks startup.
    try {
      await players.createIndex({ money: -1 });
      await players.createIndex({ totalEarned: -1 });
      await players.createIndex({ totalPoops: -1 });
      await players.createIndex({ playTime: -1 });
    } catch (err) {
      console.warn("[db] failed to create leaderboard indexes:", err);
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
    meta = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as
// "skip persistence for this request", never throw.
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

export function getMeta(): Collection<MetaDoc> | null {
  return meta;
}

// Test-only seam: lets tests exercise the leaderboard/save logic against an
// in-memory fake collection instead of a real MongoDB.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
