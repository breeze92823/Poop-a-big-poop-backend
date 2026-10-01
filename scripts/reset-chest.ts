// Re-arms the Treasure Chest: clears every account's `chestOpened` flag so all CHEST_MAX_OPENS
// slots are free again. Usage: MONGODB_URI=... npm run reset-chest
// A running room keeps its claims and the open chest in memory, so restart/redeploy the server
// afterwards (that also closes the chest); guests' claims only ever live in room memory.
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Set MONGODB_URI to the game's database first.");
  process.exit(1);
}
const client = new MongoClient(uri);
try {
  await client.connect();
  const players = client.db().collection("players");
  const res = await players.updateMany({ chestOpened: true }, { $unset: { chestOpened: "" } });
  console.log(`Chest reset: cleared ${res.modifiedCount} account(s). Restart the server to apply.`);
} finally {
  await client.close();
}
