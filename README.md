# Poop a Big Poop Server

Colyseus multiplayer server for [Poop-a-big-poop](../Poop-a-big-poop). Same
stack as the Fart to Break Doors backend (`colyseus` + `@colyseus/schema` +
Mongo persistence + Bloxity Legion deploy), adapted to this game's state:
money, the poop inventory, the pantry, the Daily Size Boost and Save Food
Effects.

The client does not talk to this server yet (it has no `systems/net.js`); this
document is the contract to build it against. The client's `GAME_SLUG` is
`poop-a-big-poop`.

## Usage

```
npm install
npm start
```

Then open http://localhost:2567 for the playground, or /monitor for the monitor.

## Structure

- `src/index.ts`: entry point (connects Mongo, then listens)
- `src/app.config.ts`: rooms, `/health`, CORS, dev-only monitor/playground
- `src/rooms/LobbyRoom.ts`: the single global room every client joins (`client.joinOrCreate("lobby")`)
- `src/rooms/schema/LobbyState.ts`: state synchronized to every client
- `src/db.ts`: Mongo-backed progress persistence (no-op if `MONGODB_URI` is unset/unreachable)
- `src/constants.ts`: leaderboard timing, value caps, food-id allow-list
- `test/LobbyRoom.test.ts`: boots the real server against a fake Mongo collection

## Scripts

- `npm start`: watch mode (`tsx watch src/index.ts`)
- `npm test`: mocha suite
- `npm run build`: compile to `build/`
- `npm run loadtest`: N simulated clients

## Wire protocol

Join with `client.joinOrCreate("lobby", { username, avatar, userId })`.
`userId` is the stable Bloxity user id; omit it for a guest, whose progress
isn't persisted.

### Client → server

| Message | Payload | Cadence |
|---|---|---|
| `move` | `{ x, y, z, yaw, moveBlend, grounded }` (all optional) | throttled |
| `poop` | `{ type, size }`: `type` is a food id or `"plain"` (unknown falls back to `plain`), `size` is clamped 0.4–2.5. Bumps `PlayerState.poopSeq`; others replay the drop. Rate-limited to one per 300 ms | on each poop |
| `setAvatar` | `{ avatar }` (opaque JSON string, ≤4 KB) | on connect + on change |
| `stats` | `{ money, totalEarned, totalPoops }` (all optional) | debounced on change |
| `saveProgress` | `{ money, totalEarned, totalPoops, poops, pantry, boost, savedFoods }` (all optional, see below); no-op for a guest | debounced |
| `identify` | `{ username, userId }` | when sign-in state changes after join |

`saveProgress` shapes, mirroring the client's state:

- `poops`: `[{ type, value }]`, one per held poop (`systems/poop.js` stacks). `type` ∈ `plain` + food ids; max 500; zero/negative values dropped.
- `pantry`: `[{ id, count }]` (`systems/pantry.js` slots). Known food ids only, duplicates summed, zero counts dropped.
- `boost`: `{ streak, nextClaimAt, streakEnd, boostEndsAt }` (`systems/boost.js`, epoch ms). Ignored unless all four are numbers.
- `savedFoods`: `{ slots: [{ id, count }], expiresAt }` (`systems/foodFx.js`).

Food ids are the client's `FOODS` in `systems/shop.js`; the server allow-list is
`FOOD_IDS` in `src/constants.ts`. Add a food in both places.

### Server → client

| Message | Payload | When |
|---|---|---|
| `progress` | `{ money, totalEarned, totalPoops, playTime, poops, pantry, boost, savedFoods }` (`boost`/`savedFoods` are `null` if never saved) | after a signed-in join/identify, if a saved doc exists |
| `noProgress` | `{}` | after a signed-in join/identify with no saved doc (new account) |
| `leaderboard` | `{ money, totalEarned, totalPoops, playTime }`, each `Row[]` with `Row = { id, name, value }` | every 15 s and on roster changes; live roster merged with all-time Mongo top scorers |

The Cliff Board is the natural home for the `money` board; the others are
broadcast too so more boards need no server change. `id` equals the client's
`sessionId` on its own row (so a board can highlight it); offline rows use a
synthetic `offline:` id and never expose a real Bloxity id. `playTime` (total
seconds connected) is **measured by the server clock** and `$inc`'d to Mongo
every 30 s and on leave, so `saveProgress` can't forge it.

`LobbyState.players` (keyed by `sessionId`) carries `username`, `x/y/z/yaw`,
`moveBlend`, `grounded`, `poopSeq/poopType/poopSize`, `avatar`, `money`,
`totalEarned`, `totalPoops`, `playTime` for every connected player. The poop
inventory, pantry and boost are private and never synced.

The server trusts the client for gameplay values (the client is authoritative
locally); it only enforces shape and bounds so a bad payload can't corrupt the
sender's own save. Note the boost streak and saved foods currently live in
`localStorage` on the client; once wired up, `progress` should win for a
signed-in player.

## Environment (runtime)

- `MONGODB_URI`: injected by Bloxity Legion; unset locally (persistence off).
- `CLIENT_ORIGIN`: injected when deployed; CORS falls back to `*` locally.
- `PORT`: injected by Legion; falls back to 2567.

## Deploy

`.github/workflows/deploy.yml` runs build + tests on every push and pull
request to `dev`/`main`. On a push (or manual run) it then builds a Docker
image, pushes it to GHCR and calls the Bloxity Legion deploy API: `dev` →
`dev` channel, `main` → `prod` channel.

GitHub settings (Settings → Secrets and variables → Actions):

| Name | Type | Value |
|---|---|---|
| `LEGION_GAME_ID` | **Variable** | Lowercase game ID from the Bloxity "My Games" dashboard (should be `poop-a-big-poop`) |
| `LEGION_DEPLOY_TOKEN` | **Secret** | Deploy token from the Bloxity dashboard |
| `GITHUB_TOKEN` | Automatic | Provided by GitHub; used to push to GHCR. Nothing to configure |

Also make sure Actions has write access to packages (Settings → Actions →
General → Workflow permissions), and that the GHCR package is readable by
Legion (public, or per Bloxity's instructions).
