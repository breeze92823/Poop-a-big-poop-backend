import { Room, Client, CloseCode } from "colyseus";
import { LobbyState, PlayerState } from "./schema/LobbyState.js";
import {
  LEADERBOARD_REFRESH_MS,
  LEADERBOARD_QUERY_LIMIT,
  PLAYTIME_FLUSH_MS,
  MONEY_MAX,
  COUNTER_MAX,
  POOP_VALUE_MAX,
  POOP_MAX_STACKS,
  POOP_TYPES,
  FOOD_IDS,
  FOOD_MAX_KINDS,
  FOOD_MAX_COUNT,
  BOOST_STREAK_MAX,
  TUTORIAL_DONE_STEP,
  TIME_MAX,
  SAVED_FOODS_TTL_MS,
  POOP_SIZE_MIN,
  POOP_SIZE_MAX,
  POOP_MIN_INTERVAL_MS,
  STEAL_COST,
  STEAL_RANGE,
  STEAL_TIMEOUT_MS,
  STEAL_COOLDOWN_MS,
  STEAL_PROTECT_MS,
  STEAL_REVENGE_BLOCK_MS,
  CHEST_MAX_OPENS,
  CHEST_RESET_EPOCH,
  CHEST_ENABLED,
  MIN_CLIENT_VERSION,
} from "../constants.js";
import {
  getPlayers,
  getMeta,
  type PlayerDoc,
  type PoopStackDoc,
  type FoodSlotDoc,
  type BoostDoc,
  type SavedFoodsDoc,
} from "../db.js";
import { ShopShelf, canGrantTutorialFood } from "../shop.js";

// One separate board per stat. The Cliff Board shows money; the others are
// served too so more boards can be added without a server change.
const LEADERBOARD_STATS = ["money", "totalEarned", "totalPoops", "playTime"] as const;
type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
type LeaderboardRow = { id: string; name: string; value: number };
type LeaderboardPayload = Record<LeaderboardStat, LeaderboardRow[]>;
type OnlineRow = { sessionId: string; userId: string | null; username: string } & Record<LeaderboardStat, number>;

// Collapse online rows that still share a userId (e.g. a leave/join racing the
// same tick) down to one, keeping the higher value for the ranked stat.
// Guests have no id to key on and are never collapsed against each other.
function dedupeOnline(rows: OnlineRow[], stat: LeaderboardStat): OnlineRow[] {
  const byUserId = new Map<string, OnlineRow>();
  const anonymous: OnlineRow[] = [];
  for (const row of rows) {
    if (!row.userId) {
      anonymous.push(row);
      continue;
    }
    const existing = byUserId.get(row.userId);
    if (!existing || row[stat] > existing[stat]) byUserId.set(row.userId, row);
  }
  return [...byUserId.values(), ...anonymous];
}

// Cap on the JSON avatar blob (see LobbyState.ts PlayerState.avatar).
const AVATAR_MAX_LEN = 4096;

function sanitizeAvatar(raw: unknown): string {
  return typeof raw === "string" && raw.length <= AVATAR_MAX_LEN ? raw : "";
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}

function clampInt(v: number, max: number): number {
  return Math.min(max, Math.max(0, Math.floor(v)));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const isFoodId = (v: unknown): v is string => typeof v === "string" && (FOOD_IDS as readonly string[]).includes(v);
const isPoopType = (v: unknown): v is string => typeof v === "string" && POOP_TYPES.includes(v);

// Poop inventory -> only known types with a positive finite value, capped in
// count and per-stack value. Order is kept (the client sells/selects by position).
export function sanitizePoops(raw: unknown): PoopStackDoc[] {
  if (!Array.isArray(raw)) return [];
  const out: PoopStackDoc[] = [];
  for (const s of raw) {
    if (out.length >= POOP_MAX_STACKS) break;
    if (!isObject(s) || !isPoopType(s.type) || !finite(s.value)) continue;
    const value = clampNum(s.value, POOP_VALUE_MAX);
    if (value > 0) out.push({ type: s.type, value });
  }
  return out;
}

// [{ id, count }] pantry slots -> known food ids with positive integer counts,
// one slot per id (duplicates are summed), capped in kinds and count.
export function sanitizeFoods(raw: unknown): FoodSlotDoc[] {
  if (!Array.isArray(raw)) return [];
  const counts = new Map<string, number>();
  for (const s of raw) {
    if (!isObject(s) || !isFoodId(s.id) || !finite(s.count)) continue;
    if (!counts.has(s.id) && counts.size >= FOOD_MAX_KINDS) continue;
    counts.set(s.id, Math.min(FOOD_MAX_COUNT, (counts.get(s.id) ?? 0) + clampInt(s.count, FOOD_MAX_COUNT)));
  }
  return [...counts].filter(([, count]) => count > 0).map(([id, count]) => ({ id, count }));
}

export function sanitizeBoost(raw: unknown): BoostDoc | undefined {
  if (!isObject(raw)) return undefined;
  const { streak, nextClaimAt, streakEnd, boostEndsAt } = raw;
  if (![streak, nextClaimAt, streakEnd, boostEndsAt].every(finite)) return undefined;
  return {
    streak: clampInt(streak as number, BOOST_STREAK_MAX),
    nextClaimAt: clampInt(nextClaimAt as number, TIME_MAX),
    streakEnd: clampInt(streakEnd as number, TIME_MAX),
    boostEndsAt: clampInt(boostEndsAt as number, TIME_MAX),
  };
}

// Undefined for anything empty or already expired, and the expiry is capped at
// 24 h from now so a forged timestamp can't keep foods longer.
export function sanitizeSavedFoods(raw: unknown, now = Date.now()): SavedFoodsDoc | undefined {
  if (!isObject(raw) || !finite(raw.expiresAt)) return undefined;
  const expiresAt = Math.min(clampInt(raw.expiresAt, TIME_MAX), now + SAVED_FOODS_TTL_MS);
  const slots = sanitizeFoods(raw.slots);
  if (expiresAt <= now || !slots.length) return undefined;
  return { slots, expiresAt };
}

// Same client-trusted model as every other message here -- no server-side
// game-logic validation. What IS enforced: shape and bounds, so a malformed
// payload can never corrupt this player's own Mongo document. A forged number
// can only ever affect the sender's own save.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.money)) out.money = clampNum(raw.money, MONEY_MAX);
  if (finite(raw.totalEarned)) out.totalEarned = clampNum(raw.totalEarned, MONEY_MAX);
  if (finite(raw.totalPoops)) out.totalPoops = clampInt(raw.totalPoops, COUNTER_MAX);
  if (raw.poops !== undefined) out.poops = sanitizePoops(raw.poops);
  if (raw.pantry !== undefined) out.pantry = sanitizeFoods(raw.pantry);
  const boost = sanitizeBoost(raw.boost);
  if (boost) out.boost = boost;
  const savedFoods = sanitizeSavedFoods(raw.savedFoods);
  if (savedFoods) out.savedFoods = savedFoods;
  // One-way flag: a stale or forged `false` can never un-finish the tutorial.
  // One-way flag, like tutorialDone.
  if (raw.theftImmune === true) out.theftImmune = true;
  if (raw.tutorialDone === true) {
    out.tutorialDone = true;
    out.tutorialStep = TUTORIAL_DONE_STEP;
  }
  if (finite(raw.tutorialStep)) {
    const step = clampInt(raw.tutorialStep, TUTORIAL_DONE_STEP);
    out.tutorialStep = Math.max(step, out.tutorialStep ?? 0);
    if (step >= TUTORIAL_DONE_STEP) out.tutorialDone = true;
  }
  return out;
}

// True for a client whose reported build version is below MIN_CLIENT_VERSION (none = 0). Exported for tests.
export function clientNeedsReload(version: unknown, min = MIN_CLIENT_VERSION): boolean {
  return (finite(version) ? version : 0) < min;
}

// What loadProgress() sends down as tutorialStep. A doc saved before steps were tracked has
// only the done flag, and one with earnings predates the tutorial altogether, so it counts
// as finished. Exported for tests.
export function resolveTutorialStep(doc: PlayerDoc): number {
  if (doc.tutorialDone === true) return TUTORIAL_DONE_STEP;
  if (typeof doc.tutorialStep === "number") return clampInt(doc.tutorialStep, TUTORIAL_DONE_STEP);
  return (doc.totalEarned ?? 0) > 0 ? TUTORIAL_DONE_STEP : 0;
}

/**
 * Single global room every client joins via `client.joinOrCreate("lobby")`.
 * Clients report events (as they already do locally against systems/poop.js
 * and friends); this room relays/stores them so other clients see them too.
 * No server-side gameplay validation.
 */
export class LobbyRoom extends Room<{ state: LobbyState }> {
  state = new LobbyState();

  // sessionId -> Bloxity user id, for whichever connected clients are signed
  // in. Deliberately NOT part of LobbyState: it has no reason to be broadcast,
  // it only gates this room's own Mongo reads/writes for that connection.
  userIds = new Map<string, string>();

  // sessionId -> epoch ms up to which that connection's playtime has already
  // been counted. Also not synced.
  private playTimeMark = new Map<string, number>();

  // sessionId -> epoch ms of the last accepted `poop`, for the rate limit.
  private lastPoopAt = new Map<string, number>();

  // The Buy Food shelf, shared by everyone in the room (see ../shop.ts).
  private shelf = new ShopShelf();

  // Sessions that already got their free tutorial unit when the shelf was empty.
  private tutorialGrants = new Set<string>();

  // sessionId -> last known tutorial step of the signed-in account (from its save). A guest has
  // none and counts as step 0.
  private tutorialSteps = new Map<string, number>();

  // Steals waiting on the victim's client to hand its poop over, keyed by the VICTIM's sessionId.
  // The inventory lives on the client, so the server only brokers the transfer.
  private pendingSteals = new Map<string, { thief: string; timer: { clear(): void } }>();
  private stealReadyAt = new Map<string, number>();
  private stealProtectedUntil = new Map<string, number>();
  // "<robber identity>><target identity>" -> epoch ms until which the robber may not rob that target
  // (the target robbed them first). Identity is the account id, else the sessionId, so a
  // signed-in player can't dodge it by reconnecting.
  private stealBlockedUntil = new Map<string, number>();
  private stealIdentity(sessionId: string) {
    return this.userIds.get(sessionId) ?? sessionId;
  }

  // Treasure Chest: identities (account id, else session id) that already opened it. At most
  // CHEST_MAX_OPENS exist; signed-in claims are reloaded from Mongo (PlayerDoc.chestOpened) on
  // room creation, guest claims live only as long as the room.
  private chestClaims = new Set<string>();
  // The chest stays open for everyone once the first player opens it, until the room restarts.
  private chestOpen = false;
  private chestReady: Promise<void> = Promise.resolve();
  private chestInfo(sessionId: string) {
    return {
      left: Math.max(0, CHEST_MAX_OPENS - this.chestClaims.size),
      mine: this.chestClaims.has(this.stealIdentity(sessionId)),
      open: this.chestOpen,
    };
  }
  private sendChest(client: Client) {
    void this.chestReady.then(() => {
      try {
        client.send("chest", this.chestInfo(client.sessionId));
      } catch {
        // Already gone.
      }
    });
  }
  private async loadChestClaims() {
    const players = getPlayers();
    if (!players) return;
    try {
      // A deploy with a higher CHEST_RESET_EPOCH re-arms the chest once: every saved claim is cleared.
      const meta = getMeta();
      if (meta) {
        const mark = await meta.findOne({ _id: "chest" });
        if ((mark?.resetEpoch ?? 0) < CHEST_RESET_EPOCH) {
          const res = await players.updateMany({ chestOpened: true }, { $unset: { chestOpened: "" } });
          await meta.updateOne({ _id: "chest" }, { $set: { resetEpoch: CHEST_RESET_EPOCH } }, { upsert: true });
          console.log(`[LobbyRoom] chest re-armed (epoch ${CHEST_RESET_EPOCH}): cleared ${res.modifiedCount} claim(s)`);
        }
      }
      const docs = await players.find({ chestOpened: true }, { projection: { _id: 1 } }).limit(CHEST_MAX_OPENS).toArray();
      for (const doc of docs) this.chestClaims.add(doc._id);
    } catch (err) {
      console.warn("[LobbyRoom] chest claims load failed", err);
    }
  }

  messages = {
    // Throttled client-side -- not sent every physics frame.
    move: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (finite(msg?.x)) p.x = msg.x;
      if (finite(msg?.y)) p.y = msg.y;
      if (finite(msg?.z)) p.z = msg.z;
      if (finite(msg?.yaw)) p.yaw = msg.yaw;
      if (finite(msg?.moveBlend)) p.moveBlend = msg.moveBlend;
      if (typeof msg?.grounded === "boolean") p.grounded = msg.grounded;
      if (typeof msg?.bending === "boolean") p.bending = msg.bending;
    },
    // The player just dropped a poop. Only a counter plus the poop's flavour
    // and size are stored; every client (the sender included, ignoring its own
    // row) replays the drop from the bump. Rate-limited so a forged client
    // can't spam poops.
    poop: (client: Client, msg: { type?: string; size?: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const now = Date.now();
      if (now - (this.lastPoopAt.get(client.sessionId) ?? 0) < POOP_MIN_INTERVAL_MS) return;
      this.lastPoopAt.set(client.sessionId, now);
      p.poopType = isPoopType(msg?.type) ? msg.type : "plain";
      p.poopSize = finite(msg?.size) ? Math.min(POOP_SIZE_MAX, Math.max(POOP_SIZE_MIN, msg.size)) : 1;
      p.poopSeq += 1;
    },
    // Bloxity avatar JSON; sent on connect and whenever the portal reports a change.
    setAvatar: (client: Client, msg: { avatar?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const avatar = sanitizeAvatar(msg?.avatar);
      if (avatar) p.avatar = avatar;
    },
    // Live stats for the leaderboard, sent debounced on change.
    stats: (client: Client, msg: { money?: number; totalEarned?: number; totalPoops?: number; poopCount?: number; immune?: boolean }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (finite(msg?.money)) p.money = clampNum(msg.money, MONEY_MAX);
      if (finite(msg?.totalEarned)) p.totalEarned = clampNum(msg.totalEarned, MONEY_MAX);
      if (finite(msg?.totalPoops)) p.totalPoops = clampInt(msg.totalPoops, COUNTER_MAX);
      if (finite(msg?.poopCount)) p.poopCount = clampInt(msg.poopCount, POOP_MAX_STACKS);
      // One-way: a stale `false` can never drop a bought immunity.
      if (msg?.immune === true) p.immune = true;
    },
    // The sender wants to rob a nearby player. Checks reach, cost, cooldowns and that the
    // victim holds poop, then asks the victim's client to hand its inventory over.
    steal: (client: Client, msg: { target?: string }) => {
      const thiefId = client.sessionId;
      const fail = (reason: string) => client.send("stealResult", { ok: false, reason });
      const thief = this.state.players.get(thiefId);
      const targetId = typeof msg?.target === "string" ? msg.target : "";
      const victim = this.state.players.get(targetId);
      const victimClient = this.clients.find((c) => c.sessionId === targetId);
      if (!thief || !victim || !victimClient || targetId === thiefId) return fail("gone");
      if (thief.immune || victim.immune) return fail("immune");
      const now = Date.now();
      if (now < (this.stealReadyAt.get(thiefId) ?? 0)) return fail("cooldown");
      const blockedFor = (this.stealBlockedUntil.get(`${this.stealIdentity(thiefId)}>${this.stealIdentity(targetId)}`) ?? 0) - now;
      if (blockedFor > 0) return client.send("stealResult", { ok: false, reason: "revenge", ms: blockedFor });
      if (this.pendingSteals.has(targetId)) return fail("busy");
      if (now < (this.stealProtectedUntil.get(targetId) ?? 0)) return fail("protected");
      if (Math.hypot(thief.x - victim.x, thief.z - victim.z) > STEAL_RANGE) return fail("far");
      if (thief.money < STEAL_COST) return fail("poor");
      if (victim.poopCount <= 0) return fail("empty");
      this.stealReadyAt.set(thiefId, now + STEAL_COOLDOWN_MS);
      const timer = this.clock.setTimeout(() => this.finishSteal(targetId, null), STEAL_TIMEOUT_MS);
      this.pendingSteals.set(targetId, { thief: thiefId, timer });
      victimClient.send("stealRequest", { by: thief.username || "Someone" });
    },
    // The victim's client answers a `stealRequest` with the poop it just gave up.
    stealHandover: (client: Client, msg: { poops?: unknown }) => {
      if (!this.pendingSteals.has(client.sessionId)) return;
      this.finishSteal(client.sessionId, sanitizePoops(msg?.poops));
    },    // Debounced push of the durable half of the client state. A guest has no
    // userId and this no-ops. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      const patch = sanitizeProgress(msg);
      if (!patch) return;
      const { tutorialStep, ...setPatch } = patch;
      if (tutorialStep !== undefined) {
        this.tutorialSteps.set(client.sessionId, Math.max(tutorialStep, this.tutorialSteps.get(client.sessionId) ?? 0));
      }
      // Display name comes from this connection's own PlayerState, not `msg`.
      const p = this.state.players.get(client.sessionId);
      // A save that is empty or expired is removed from the document.
      const clearFoods = isObject(msg) && "savedFoods" in msg && !patch.savedFoods;
      try {
        await players.updateOne(
          { _id: userId },
          {
            $set: { ...setPatch, username: p?.username || "Player", updatedAt: new Date() },
            // Only ever raised, so a stale save can't send a player back a step.
            ...(tutorialStep !== undefined ? { $max: { tutorialStep } } : {}),
            $setOnInsert: { version: 1 },
            ...(clearFoods ? { $unset: { savedFoods: "" as const } } : {}),
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[LobbyRoom] saveProgress failed", err);
      }
    },
    // Buy one unit from the shared shelf. Money is the client's to spend; the
    // server only decides who got the last unit, then tells everyone the new stock.
    buyFood: (client: Client, msg: { id?: string; tutorial?: boolean }) => {
      const id = typeof msg?.id === "string" ? msg.id : "";
      let ok = this.shelf.buy(id);
      // The tutorial's buy step must never dead-end on a sold-out shelf: one unit of the
      // tutorial food per session is granted without touching the shared stock.
      if (
        !ok &&
        msg?.tutorial === true &&
        canGrantTutorialFood(id, this.tutorialSteps.get(client.sessionId) ?? 0, this.tutorialGrants.has(client.sessionId))
      ) {
        this.tutorialGrants.add(client.sessionId);
        ok = true;
      }
      client.send("buyResult", { id, ok });
      this.broadcast("shop", this.shelf.payload());
    },
    // The sender wants the Treasure Chest. The first claimant opens it for everyone (`chestAnim`
    // plays the opening on every client and it then stays open); each later player redeems with
    // the same message. Only the first CHEST_MAX_OPENS distinct players win, once each; the prize
    // itself is granted by the client on `chestResult` ok.
    openChest: async (client: Client) => {
      if (!CHEST_ENABLED) return client.send("chestResult", { ok: false, reason: "disabled", first: false, ...this.chestInfo(client.sessionId) });
      await this.chestReady;
      const identity = this.stealIdentity(client.sessionId);
      const reply = (ok: boolean, reason?: string, first = false) =>
        client.send("chestResult", { ok, reason, first, ...this.chestInfo(client.sessionId) });
      if (this.chestClaims.has(identity)) return reply(false, "mine");
      if (this.chestClaims.size >= CHEST_MAX_OPENS) return reply(false, "empty");
      // Claim synchronously so two simultaneous requests can't both take the last slot.
      this.chestClaims.add(identity);
      const first = !this.chestOpen;
      this.chestOpen = true;
      const userId = this.userIds.get(client.sessionId);
      const players = getPlayers();
      if (userId && players) {
        try {
          await players.updateOne(
            { _id: userId },
            { $set: { chestOpened: true, updatedAt: new Date() }, $setOnInsert: { version: 1 } },
            { upsert: true },
          );
        } catch (err) {
          console.warn("[LobbyRoom] chest claim save failed", err);
          this.chestClaims.delete(identity);
          if (first && this.chestClaims.size === 0) this.chestOpen = false;
          return reply(false, "error");
        }
      }
      // Opening animation for every player first, then the new state and our own prize.
      if (first) this.broadcast("chestAnim", { by: this.state.players.get(client.sessionId)?.username || "Someone" });
      for (const c of this.clients) this.sendChest(c);
      // Every claim (the opener's and each redeemer's) shows the treasure flying to this player.
      this.broadcast("chestClaim", { id: client.sessionId });
      reply(true, undefined, first);
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest
    // who signs in mid-session). Without this a late sign-in would never get
    // a userId and saveProgress would no-op for the whole session.
    identify: (client: Client, msg: { username?: string; userId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = msg.username.slice(0, 64);
      this.setUserId(client, p, typeof msg?.userId === "string" ? msg.userId : "");
    },
  };

  // Runs once immediately -- a fresh room shouldn't sit on an empty board for
  // a full LEADERBOARD_REFRESH_MS -- then on a timer.
  onCreate() {
    this.chestReady = this.loadChestClaims();
    void this.refreshLeaderboard();
    this.clock.setInterval(() => {
      void this.refreshLeaderboard();
    }, LEADERBOARD_REFRESH_MS);
    this.clock.setInterval(() => this.flushAllPlaytime(), PLAYTIME_FLUSH_MS);
    this.shelf.sync();
    // New foods every RESTOCK_MS, on the epoch-aligned clock.
    this.clock.setInterval(() => {
      if (this.shelf.sync()) this.broadcast("shop", this.shelf.payload());
    }, 1000);
  }

  // Adds the seconds elapsed since this session's last mark to its live
  // playTime and, for a signed-in player, $inc's the same amount into Mongo.
  // $inc (not $set) so it can't race saveProgress and a client can never
  // forge or reset its own time. Called by the interval, and right before a
  // session is dropped so the tail end of a visit isn't lost.
  private flushPlaytime(sessionId: string) {
    const mark = this.playTimeMark.get(sessionId);
    if (mark === undefined) return;
    const seconds = Math.floor((Date.now() - mark) / 1000);
    if (seconds <= 0) return;
    // Advance by whole seconds only, so sub-second remainders aren't dropped.
    this.playTimeMark.set(sessionId, mark + seconds * 1000);
    const p = this.state.players.get(sessionId);
    if (p) p.playTime += seconds;
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    players
      .updateOne(
        { _id: userId },
        { $inc: { playTime: seconds }, $set: { username: p?.username || "Player", updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      )
      .catch((err) => console.warn("[LobbyRoom] playtime flush failed", err));
  }

  private flushAllPlaytime() {
    for (const sessionId of [...this.playTimeMark.keys()]) this.flushPlaytime(sessionId);
  }

  // Ends a pending steal: `poops` is what the victim handed over, or null when it never
  // answered. The thief is told either way so its cost can be kept or refunded.
  private finishSteal(victimId: string, poops: PoopStackDoc[] | null) {
    const pending = this.pendingSteals.get(victimId);
    if (!pending) return;
    pending.timer.clear();
    this.pendingSteals.delete(victimId);
    const thiefClient = this.clients.find((c) => c.sessionId === pending.thief);
    if (!poops?.length) {
      thiefClient?.send("stealResult", { ok: false, reason: poops ? "empty" : "timeout" });
      return;
    }
    const now = Date.now();
    this.stealProtectedUntil.set(victimId, now + STEAL_PROTECT_MS);
    for (const [key, until] of this.stealBlockedUntil) if (until <= now) this.stealBlockedUntil.delete(key);
    // The victim may not rob the thief back for a while, and is told so.
    this.stealBlockedUntil.set(`${this.stealIdentity(victimId)}>${this.stealIdentity(pending.thief)}`, now + STEAL_REVENGE_BLOCK_MS);
    this.clients
      .find((c) => c.sessionId === victimId)
      ?.send("stealBlock", { target: pending.thief, ms: STEAL_REVENGE_BLOCK_MS });
    const victim = this.state.players.get(victimId);
    if (victim) victim.poopCount = 0;
    thiefClient?.send("stealResult", { ok: true, poops, from: victim?.username || "Player", cost: STEAL_COST });
  }

  // Drops a session's per-connection bookkeeping after a final playtime flush.
  private forgetSession(sessionId: string) {
    for (const [victimId, pending] of [...this.pendingSteals]) {
      if (victimId === sessionId || pending.thief === sessionId) this.finishSteal(victimId, null);
    }
    this.stealReadyAt.delete(sessionId);
    this.stealProtectedUntil.delete(sessionId);
    this.flushPlaytime(sessionId);
    this.playTimeMark.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.lastPoopAt.delete(sessionId);
    this.tutorialGrants.delete(sessionId);
    this.tutorialSteps.delete(sessionId);
  }

  onJoin(client: Client, options?: { username?: string; avatar?: string; userId?: string; version?: number }) {
    // No spawn assignment -- the client reports its real position in its
    // first "move" message.
    const p = new PlayerState();
    p.username = typeof options?.username === "string" ? options.username.slice(0, 64) : "";
    p.avatar = sanitizeAvatar(options?.avatar);
    this.state.players.set(client.sessionId, p);
    this.playTimeMark.set(client.sessionId, Date.now());

    this.setUserId(client, p, options?.userId ?? "");
    client.send("shop", this.shelf.payload());
    // A stale tab is told to refresh (it saves first, then reloads).
    if (clientNeedsReload(options?.version)) client.send("reload", { min: MIN_CLIENT_VERSION });
    this.sendChest(client);
    void this.refreshLeaderboard();
  }

  // Client-trusted Bloxity user id. A forged id can only read/overwrite the
  // SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    const userId = typeof raw === "string" ? raw.slice(0, 128) : "";
    const prev = this.userIds.get(client.sessionId) || "";
    if (userId === prev) return; // no change -- e.g. a username-only identify

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one
      // account never shows as two leaderboard rows / two racing Mongo writers
      // (a crashed tab lingers up to 20s via allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
      void this.loadProgress(client, userId, p);
    } else {
      // Logged out: stop persisting for this connection. The client flushes a
      // final saveProgress under the OLD id before sending this.
      this.userIds.delete(client.sessionId);
    }

    this.sendChest(client);
    void this.refreshLeaderboard();
  }

  // Seeds this player's own leaderboard row immediately and sends the saved
  // doc to just this client so it can hydrate what LobbyState doesn't carry
  // (inventory, pantry, boost). A missing doc or unreachable Mongo leaves the
  // client on its own defaults.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    if (!players) return;
    try {
      const doc = await players.findOne({ _id: userId });
      if (!doc) {
        // A brand-new account: tell the client there's nothing to load so it
        // can start from its defaults right away instead of waiting on a timeout.
        client.send("noProgress", {});
        return;
      }
      const savedFoods = sanitizeSavedFoods(doc.savedFoods);
      if (doc.savedFoods && !savedFoods) {
        // Expired: remove it from the document.
        players
          .updateOne({ _id: userId }, { $unset: { savedFoods: "" } })
          .catch((err) => console.warn("[LobbyRoom] expired savedFoods cleanup failed", err));
      }
      p.money = doc.money ?? 0;
      p.totalEarned = doc.totalEarned ?? 0;
      p.totalPoops = doc.totalPoops ?? 0;
      // Saved total (already includes anything flushed while signed in this
      // session) -- guest time before signing in isn't counted.
      p.playTime = doc.playTime ?? 0;
      if (doc.theftImmune === true) p.immune = true;
      this.tutorialSteps.set(client.sessionId, resolveTutorialStep(doc));
      client.send("progress", {
        money: p.money,
        totalEarned: p.totalEarned,
        totalPoops: p.totalPoops,
        playTime: p.playTime,
        poops: sanitizePoops(doc.poops),
        pantry: sanitizeFoods(doc.pantry),
        // Absent for an account that never claimed a boost / saved foods.
        boost: sanitizeBoost(doc.boost) ?? null,
        savedFoods: savedFoods ?? null,
        theftImmune: doc.theftImmune === true,
        tutorialDone: doc.tutorialDone === true,
        tutorialStep: resolveTutorialStep(doc),
      });
    } catch (err) {
      console.warn("[LobbyRoom] loadProgress failed", err);
    }
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at
  // once. Anything else (WiFi blip, backgrounded tab) gets 20s to reconnect
  // with the same session, instead of re-joining as a brand new player.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.forgetSession(client.sessionId);
      return;
    }
    // Count time up to the drop, then pause the clock for the reconnect window.
    this.flushPlaytime(client.sessionId);
    this.playTimeMark.delete(client.sessionId);
    try {
      await this.allowReconnection(client, 20);
      this.playTimeMark.set(client.sessionId, Date.now());
    } catch {
      this.forgetSession(client.sessionId);
    }
  }

  // Builds and broadcasts the merged "all-time saved + currently online"
  // leaderboard. Only the server has both the live roster and the
  // sessionId->userId map needed to tell "this online player already IS a
  // saved account" apart from "this saved account is offline". A private
  // method so tests can call and await it directly.
  private async refreshLeaderboard() {
    const onlineRows: OnlineRow[] = [];
    const onlineUserIds = new Set<string>();
    this.state.players.forEach((p, sessionId) => {
      const userId = this.userIds.get(sessionId) ?? null;
      if (userId) onlineUserIds.add(userId);
      onlineRows.push({
        sessionId,
        userId,
        username: p.username || "Player",
        money: p.money,
        totalEarned: p.totalEarned,
        totalPoops: p.totalPoops,
        playTime: p.playTime,
      });
    });

    const players = getPlayers();
    const payload = { money: [], totalEarned: [], totalPoops: [], playTime: [] } as LeaderboardPayload;

    for (const stat of LEADERBOARD_STATS) {
      // Online rows first: a connected player's live value is more current
      // than their last debounced save.
      const merged: LeaderboardRow[] = dedupeOnline(onlineRows, stat).map((row) => ({
        id: row.sessionId,
        name: row.username,
        value: row[stat],
      }));

      // Then everyone who has EVER saved, minus accounts already shown live.
      if (players) {
        try {
          const docs = await players
            .find({}, { projection: { _id: 1, username: 1, [stat]: 1 } })
            .sort({ [stat]: -1 })
            .limit(LEADERBOARD_QUERY_LIMIT)
            .toArray();

          let offlineIndex = 0;
          for (const doc of docs) {
            if (onlineUserIds.has(doc._id)) continue;
            // Synthetic id -- never broadcast another account's raw Bloxity id.
            merged.push({
              id: `offline:${stat}:${offlineIndex++}`,
              name: doc.username || "Player",
              value: (doc[stat] as number | undefined) ?? 0,
            });
          }
        } catch (err) {
          console.warn(`[LobbyRoom] leaderboard query failed for stat=${stat}`, err);
        }
      }

      // Collapse rows sharing a display name (the same account under a
      // different id would otherwise appear twice). Keep the higher value but
      // prefer an online row's id so the client can recognise its own row.
      const byName = new Map<string, LeaderboardRow>();
      for (const row of merged) {
        const key = row.name || "Player";
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, row);
          continue;
        }
        const preferId = existing.id.startsWith("offline:") && !row.id.startsWith("offline:") ? row.id : existing.id;
        byName.set(key, { id: preferId, name: key, value: Math.max(existing.value, row.value) });
      }
      const deduped = [...byName.values()];

      deduped.sort((a, b) => b.value - a.value);
      payload[stat] = deduped.slice(0, LEADERBOARD_QUERY_LIMIT);
    }

    this.broadcast("leaderboard", payload);
  }
}
