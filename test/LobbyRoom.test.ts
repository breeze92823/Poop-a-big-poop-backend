import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { LobbyState } from "../src/rooms/schema/LobbyState.js";
import {
  sanitizeProgress,
  sanitizePoops,
  sanitizeFoods,
  sanitizeBoost,
  sanitizeSavedFoods,
  type LobbyRoom,
} from "../src/rooms/LobbyRoom.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";

// Hand-rolled fake `players` collection implementing only the subset
// LobbyRoom.ts calls: find().sort().limit().toArray(), updateOne() (upsert),
// findOne(). No MongoDB runs in the test process.
function fakePlayersCollection(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return;
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      const next = { ...base, ...(update.$set ?? {}) } as any;
      for (const k of Object.keys(update.$unset ?? {})) delete next[k];
      docs.set(filter._id, next as PlayerDoc);
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

function baseDoc(overrides: Partial<PlayerDoc> = {}): PlayerDoc {
  return {
    _id: "test",
    money: 0,
    totalPoops: 0,
    totalEarned: 0,
    version: 1,
    updatedAt: new Date(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The `progress` / `noProgress` reply can land before a client-side handler is
// registered, so capture what the server sends on the server side.
function captureSends(room: any) {
  const sent: [string, any][] = [];
  const origLoad = room.loadProgress.bind(room);
  room.loadProgress = (c: any, ...rest: any[]) => {
    const origSend = c.send.bind(c);
    c.send = (type: string, msg: any) => {
      sent.push([type, msg]);
      origSend(type, msg);
    };
    return origLoad(c, ...rest);
  };
  return sent;
}

describe("LobbyRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  // Tests that swap in a fake collection reset it so the others keep
  // exercising the real "no MONGODB_URI" no-op path.
  afterEach(() => __setPlayersForTest(null));

  it("relays move, avatar and stats between two clients", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);

    client1.send("move", { x: 1, y: 2, z: 3, yaw: 0.5, moveBlend: 0.75, grounded: false });
    await room.waitForNextPatch();
    const p1 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(p1.x, 1);
    assert.strictEqual(p1.moveBlend, 0.75);
    assert.strictEqual(p1.grounded, false);

    const avatar = JSON.stringify({ e: { headId: "42" }, p: { height: 1.2 } });
    client1.send("setAvatar", { avatar });
    await room.waitForNextPatch();
    assert.strictEqual(client2.state.players.get(client1.sessionId).avatar, avatar);

    client1.send("stats", { money: 250.5, totalEarned: 900, totalPoops: 30 });
    await room.waitForNextPatch();
    const s = client2.state.players.get(client1.sessionId);
    assert.strictEqual(s.money, 250.5);
    assert.strictEqual(s.totalEarned, 900);
    assert.strictEqual(s.totalPoops, 30);

    // Negatives clamp to 0.
    client1.send("stats", { money: -5, totalPoops: -1 });
    await room.waitForNextPatch();
    const s2 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(s2.money, 0);
    assert.strictEqual(s2.totalPoops, 0);
  });

  it("relays poop drops, rate-limited, with allow-listed type and clamped size", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);

    assert.strictEqual(client2.state.players.get(client1.sessionId)?.poopSeq ?? 0, 0);
    client1.send("poop", { type: "lettuce", size: 99 });
    client1.send("poop", { type: "pizza", size: 1 }); // inside POOP_MIN_INTERVAL_MS: dropped
    await room.waitForNextPatch();
    await sleep(100);
    const p = client2.state.players.get(client1.sessionId);
    assert.strictEqual(p.poopSeq, 1);
    assert.strictEqual(p.poopType, "lettuce");
    assert.strictEqual(p.poopSize, 2.5); // clamped

    await sleep(350);
    client1.send("poop", { type: "not-a-food", size: "big" });
    await room.waitForNextPatch();
    await sleep(100);
    const p2 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(p2.poopSeq, 2);
    assert.strictEqual(p2.poopType, "plain"); // unknown type falls back
    assert.strictEqual(p2.poopSize, 1);
  });

  it("degrades to no-op persistence when Mongo is unreachable", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "bloxity-user-1" });
    client1.send("saveProgress", { money: 42 });
    await room.waitForNextPatch();
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "");
  });

  it("registers/clears the userId mapping via identify, independent of join", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { username: "Guest" });
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(client1.sessionId), false);

    client1.send("identify", { username: "RealName", userId: "u1" });
    await room.waitForNextPatch();
    assert.strictEqual((room as unknown as LobbyRoom).userIds.get(client1.sessionId), "u1");
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "RealName");

    client1.send("identify", { username: "Guest", userId: "" });
    await room.waitForNextPatch();
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(client1.sessionId), false);
  });

  it("evicts a stale session that already claims the same userId", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const first = await colyseus.connectTo(room, { userId: "dup" });
    const second = await colyseus.connectTo(room, { userId: "dup" });
    await sleep(50);
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(first.sessionId), false);
    assert.strictEqual((room as unknown as LobbyRoom).userIds.get(second.sessionId), "dup");
    assert.strictEqual(room.state.players.has(first.sessionId), false);
  });

  it("saves progress, then sends it back as `progress` on the next sign-in", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Pooper" });

    const expiresAt = Date.now() + 3_600_000;
    const boost = { streak: 3, nextClaimAt: 2_000, streakEnd: 3_000, boostEndsAt: 1_500 };
    client1.send("saveProgress", {
      money: 1234.5,
      totalEarned: 5000,
      totalPoops: 12,
      poops: [
        { type: "plain", value: 100 },
        { type: "lettuce", value: 300 },
        { type: "bogus", value: 50 },
      ],
      pantry: [
        { id: "lettuce", count: 3 },
        { id: "bogus", count: 9 },
        { id: "donut", count: 0 },
      ],
      boost,
      savedFoods: { slots: [{ id: "donut", count: 1 }], expiresAt },
    });
    await sleep(100);

    const saved = fake.docs.get("u1")!;
    assert.strictEqual(saved.money, 1234.5);
    assert.strictEqual(saved.totalPoops, 12);
    assert.strictEqual(saved.username, "Pooper");
    // Unknown types/ids and zero counts are dropped.
    assert.deepStrictEqual(saved.poops, [
      { type: "plain", value: 100 },
      { type: "lettuce", value: 300 },
    ]);
    assert.deepStrictEqual(saved.pantry, [{ id: "lettuce", count: 3 }]);
    assert.deepStrictEqual(saved.boost, boost);

    const sent = captureSends(room);
    const client2 = await colyseus.connectTo(room, { userId: "u1" });
    await sleep(100);
    const progress = sent.find(([t]) => t === "progress")?.[1];
    assert.ok(progress, "progress message was sent");
    assert.strictEqual(progress.money, 1234.5);
    assert.strictEqual(progress.totalEarned, 5000);
    assert.deepStrictEqual(progress.pantry, [{ id: "lettuce", count: 3 }]);
    assert.deepStrictEqual(progress.boost, boost);
    assert.deepStrictEqual(progress.savedFoods, { slots: [{ id: "donut", count: 1 }], expiresAt });
    assert.strictEqual(client2.state.players.get(client2.sessionId).money, 1234.5);
  });

  it("sends `noProgress` for a brand-new account", async () => {
    __setPlayersForTest(fakePlayersCollection());
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const sent = captureSends(room);
    await colyseus.connectTo(room, { userId: "fresh" });
    await sleep(100);
    assert.ok(sent.some(([t]) => t === "noProgress"));
    assert.ok(!sent.some(([t]) => t === "progress"));
  });

  it("ignores saves from guests", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const guest = await colyseus.connectTo(room);
    guest.send("saveProgress", { money: 999 });
    await sleep(50);
    assert.strictEqual(fake.docs.size, 0);
  });

  it("broadcasts a leaderboard merging online players with saved offline ones", async () => {
    const fake = fakePlayersCollection([
      baseDoc({ _id: "off1", username: "OfflineAce", money: 9000, totalPoops: 400, playTime: 7200, totalEarned: 20000 }),
      baseDoc({ _id: "u1", username: "Me", money: 1 }), // online below -- must not duplicate
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Me" });
    client1.send("stats", { money: 500, totalPoops: 3 });
    await room.waitForNextPatch();

    const board: any = await new Promise((resolve) => {
      client1.onMessage("leaderboard", resolve);
      void (room as any).refreshLeaderboard();
    });
    assert.deepStrictEqual(
      board.money.map((r: any) => [r.name, r.value]),
      [["OfflineAce", 9000], ["Me", 500]],
    );
    assert.strictEqual(board.money.filter((r: any) => r.name === "Me").length, 1);
    assert.strictEqual(board.totalPoops[0].name, "OfflineAce");
    assert.strictEqual(board.totalEarned[0].name, "OfflineAce");
    assert.strictEqual(board.playTime[0].value, 7200);
    assert.ok(board.money[1].id === client1.sessionId, "own row keeps the session id");
    assert.ok(board.money[0].id.startsWith("offline:"), "offline rows never expose the real id");
    assert.deepStrictEqual(Object.keys(board).sort(), ["money", "playTime", "totalEarned", "totalPoops"]);
  });

  it("counts server-measured playtime for signed-in players and persists it with $inc", async () => {
    const fake = fakePlayersCollection([baseDoc({ _id: "u1", playTime: 100 })]);
    // The fake has no $inc; emulate it so the flush is observable.
    const origUpdate = fake.updateOne.bind(fake);
    (fake as any).updateOne = async (f: any, u: any, o: any) => {
      if (u.$inc) {
        const d = fake.docs.get(f._id)!;
        d.playTime = (d.playTime ?? 0) + u.$inc.playTime;
        return;
      }
      return origUpdate(f, u, o);
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const c = await colyseus.connectTo(room, { userId: "u1" });
    await sleep(100);
    const r = room as any;
    assert.strictEqual(c.state.players.get(c.sessionId).playTime, 100);
    // Pretend 90s have passed, then flush.
    r.playTimeMark.set(c.sessionId, Date.now() - 90_000);
    r.flushAllPlaytime();
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    assert.strictEqual(room.state.players.get(c.sessionId).playTime, 190);
    // A client cannot forge it through saveProgress.
    c.send("saveProgress", { money: 10, playTime: 999999 });
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    assert.strictEqual(fake.docs.get("u1")!.money, 10);
  });

  describe("sanitizeProgress", () => {
    it("rejects non-objects and clamps values", () => {
      assert.strictEqual(sanitizeProgress(null), null);
      assert.strictEqual(sanitizeProgress("x"), null);
      const out = sanitizeProgress({ money: -3, totalEarned: 1e30, totalPoops: 12.9, poops: "x", pantry: 5 })!;
      assert.strictEqual(out.money, 0);
      assert.strictEqual(out.totalEarned, 1_000_000_000_000_000);
      assert.strictEqual(out.totalPoops, 12);
      assert.deepStrictEqual(out.poops, []);
      assert.deepStrictEqual(out.pantry, []);
      assert.strictEqual(out.boost, undefined);
      assert.strictEqual(sanitizeProgress({ money: NaN })!.money, undefined);
    });
  });

  describe("sanitizePoops", () => {
    it("keeps known types with positive values, in order, and caps the count", () => {
      assert.deepStrictEqual(
        sanitizePoops([{ type: "plain", value: 5 }, { type: "x", value: 5 }, { type: "pizza", value: -1 }, { type: "pizza", value: 1e30 }]),
        [{ type: "plain", value: 5 }, { type: "pizza", value: 1_000_000_000_000 }],
      );
      assert.strictEqual(sanitizePoops(Array.from({ length: 900 }, () => ({ type: "plain", value: 1 }))).length, 500);
      assert.deepStrictEqual(sanitizePoops(null), []);
    });
  });

  describe("sanitizeFoods", () => {
    it("merges duplicate ids and drops unknown ids and zero counts", () => {
      assert.deepStrictEqual(
        sanitizeFoods([{ id: "lettuce", count: 2.9 }, { id: "lettuce", count: 1 }, { id: "Bad", count: 4 }, { id: "donut", count: 0 }]),
        [{ id: "lettuce", count: 3 }],
      );
      assert.deepStrictEqual(sanitizeFoods({ lettuce: 1 }), []);
      assert.strictEqual(sanitizeFoods([{ id: "pizza", count: 1e15 }])[0].count, 1_000_000);
    });
  });

  describe("sanitizeSavedFoods", () => {
    const now = 1_000_000;
    const slots = [{ id: "donut", count: 1 }];
    it("drops empty or expired saves and caps the expiry at 24 h", () => {
      assert.strictEqual(sanitizeSavedFoods({ slots, expiresAt: now - 1 }, now), undefined);
      assert.strictEqual(sanitizeSavedFoods({ slots: [], expiresAt: now + 5 }, now), undefined);
      assert.strictEqual(sanitizeSavedFoods({ slots }, now), undefined);
      assert.strictEqual(sanitizeSavedFoods({ slots, expiresAt: 1e15 }, now)!.expiresAt, now + 86_400_000);
    });

    it("removes the stored save when the client sends an empty one", async () => {
      const fake = fakePlayersCollection([baseDoc({ _id: "u1", savedFoods: { slots, expiresAt: Date.now() + 1000 } })]);
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<LobbyState>("lobby", {});
      const c = await colyseus.connectTo(room, { userId: "u1" });
      c.send("saveProgress", { money: 5, savedFoods: { slots: [], expiresAt: 0 } });
      await sleep(80);
      assert.strictEqual(fake.docs.get("u1")!.savedFoods, undefined);
      assert.strictEqual(fake.docs.get("u1")!.money, 5);
    });
  });

  describe("sanitizeBoost", () => {
    it("requires all four numbers", () => {
      assert.strictEqual(sanitizeBoost({ streak: 1 }), undefined);
      assert.strictEqual(sanitizeBoost(null), undefined);
      assert.deepStrictEqual(sanitizeBoost({ streak: 2.5, nextClaimAt: 1, streakEnd: 2, boostEndsAt: -4 }), {
        streak: 2,
        nextClaimAt: 1,
        streakEnd: 2,
        boostEndsAt: 0,
      });
    });
  });
});
