// Buy Food shop schedule, shared by every player in the room. The client's
// systems/shop.js carries a copy of RESTOCK_MS / SHOP_RARITY / stockForCycle for
// offline play: keep the two in step by hand.
//
// Time is cut into restocks of RESTOCK_MS (4 min = 15 per hour, aligned to the
// epoch so every server instance agrees). What is on the shelf at a restock is a
// pure function of the clock, so a server restart never reshuffles it. Each food
// shows up on a fixed number of restocks per hour set by its rarity; WHICH
// restocks is a seeded shuffle per (hour, food).
export const RESTOCK_MS = 4 * 60_000;
export const HOUR_MS = 60 * 60_000;
export const RESTOCKS_PER_HOUR = HOUR_MS / RESTOCK_MS; // 15

export type Rarity = "Common" | "Uncommon" | "Rare" | "Legendary" | "Prismatic";

// perHour = restocks (of 15) on which the food is stocked; qty = units on the shelf then.
export const SHOP_RARITY: Record<Rarity, { perHour: number; qty: number }> = {
  Common: { perHour: 15, qty: 6 }, // every restock
  Uncommon: { perHour: 10, qty: 4 },
  Rare: { perHour: 6, qty: 3 },
  Legendary: { perHour: 3, qty: 2 },
  Prismatic: { perHour: 2, qty: 1 },
};

// Keep in step with FOOD_IDS and the client's FOODS.
export const FOOD_RARITY: Record<string, Rarity> = {
  lettuce: "Common",
  donut: "Common",
  hotsauce: "Uncommon",
  cola: "Uncommon",
  banana: "Uncommon",
  milk: "Rare",
  goldapple: "Legendary",
  energy: "Legendary",
  pizza: "Prismatic",
};

export const cycleOf = (now: number) => Math.floor(now / RESTOCK_MS);
export const cycleEndsAt = (cycle: number) => (cycle + 1) * RESTOCK_MS;

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The restock slots (0..14) of `hour` on which `foodId` is stocked.
function slotsFor(hour: number, foodId: string, perHour: number): Set<number> {
  const rand = mulberry32(hash(`${hour}:${foodId}`));
  const slots = Array.from({ length: RESTOCKS_PER_HOUR }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return new Set(slots.slice(0, perHour));
}

// Units of every food on the shelf for the given restock cycle.
export function stockForCycle(cycle: number): Record<string, number> {
  const hour = Math.floor(cycle / RESTOCKS_PER_HOUR);
  const slot = cycle - hour * RESTOCKS_PER_HOUR;
  const out: Record<string, number> = {};
  for (const [id, rarity] of Object.entries(FOOD_RARITY)) {
    const { perHour, qty } = SHOP_RARITY[rarity];
    out[id] = slotsFor(hour, id, perHour).has(slot) ? qty : 0;
  }
  return out;
}

// The live shelf: stock for the current cycle minus what players have bought.
export class ShopShelf {
  cycle = -1;
  stock: Record<string, number> = {};

  // Rolls over to a new restock if the clock has moved on; true when it did.
  sync(now = Date.now()): boolean {
    const c = cycleOf(now);
    if (c === this.cycle) return false;
    this.cycle = c;
    this.stock = stockForCycle(c);
    return true;
  }

  buy(id: string, now = Date.now()): boolean {
    this.sync(now);
    if (!(this.stock[id] > 0)) return false;
    this.stock[id] -= 1;
    return true;
  }

  payload(now = Date.now()) {
    return { stock: { ...this.stock }, endsInMs: Math.max(0, cycleEndsAt(this.cycle) - now) };
  }
}
