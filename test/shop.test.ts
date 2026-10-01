import assert from "assert";
import { ShopShelf, canGrantTutorialFood, stockForCycle, FOOD_RARITY, SHOP_RARITY, RESTOCKS_PER_HOUR } from "../src/shop.js";

describe("shop schedule", () => {
  it("stocks each food on exactly its per-hour number of restocks", () => {
    for (const hour of [0, 1, 490000, 490001]) {
      for (const [id, rarity] of Object.entries(FOOD_RARITY)) {
        let n = 0;
        for (let s = 0; s < RESTOCKS_PER_HOUR; s++) {
          const q = stockForCycle(hour * RESTOCKS_PER_HOUR + s)[id];
          if (q > 0) {
            n++;
            assert.strictEqual(q, SHOP_RARITY[rarity].qty);
          }
        }
        assert.strictEqual(n, SHOP_RARITY[rarity].perHour, `${id} hour ${hour}`);
      }
    }
  });

  it("is deterministic and shared: purchases drain the shelf, a new restock refills it", () => {
    const t = 4 * 60_000 * 1000;
    const a = new ShopShelf();
    a.sync(t);
    assert.deepStrictEqual(a.stock, stockForCycle(t / (4 * 60_000)));
    assert.ok(a.buy("lettuce", t));
    assert.strictEqual(a.stock.lettuce, SHOP_RARITY.Common.qty - 1);
    for (let i = 0; i < 10; i++) a.buy("lettuce", t);
    assert.strictEqual(a.buy("lettuce", t), false);
    assert.strictEqual(a.buy("nope", t), false);
    assert.ok(a.sync(t + 4 * 60_000));
    assert.strictEqual(a.stock.lettuce, SHOP_RARITY.Common.qty);
  });

  it("grants the free tutorial food only to lettuce, once, and not past the buy step", () => {
    assert.strictEqual(canGrantTutorialFood("lettuce", 0, false), true);
    assert.strictEqual(canGrantTutorialFood("lettuce", 3, false), true);
    assert.strictEqual(canGrantTutorialFood("lettuce", 4, false), false);
    assert.strictEqual(canGrantTutorialFood("lettuce", 6, false), false);
    assert.strictEqual(canGrantTutorialFood("lettuce", 0, true), false);
    assert.strictEqual(canGrantTutorialFood("pizza", 0, false), false);
  });
});
