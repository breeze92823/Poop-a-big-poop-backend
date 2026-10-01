import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    x: t.number().default(0),
    y: t.number().default(0),
    z: t.number().default(0),
    yaw: t.number().default(0),
    // 0..1 eased gait factor (client systems/avatarAnim.js) -- purely cosmetic,
    // drives the remote walk-cycle blend.
    moveBlend: t.number().default(0),
    // Airborne tucks the limbs on the remote walk-cycle.
    grounded: t.boolean().default(true),
    // Bent over to poop (charging, the timing meter, and the moment after a drop): remotes pose the spine.
    bending: t.boolean().default(false),
    // Bumped once per poop dropped (see LobbyRoom.ts `poop`). Every client
    // replays the drop locally when this changes, so only a counter plus the
    // last poop's flavour and size are synced, not the poop itself.
    poopSeq: t.number().default(0),
    // Food id of the last poop ("plain" for an unflavoured one) -> its colour.
    poopType: t.string().default("plain"),
    // Size multiplier of the last poop (client poopScale), clamped.
    poopSize: t.number().default(1),
    // The player's Bloxity avatar as an opaque JSON string, stored and relayed
    // as-is (length-capped, never parsed here). See LobbyRoom.ts AVATAR_MAX_LEN.
    avatar: t.string().default(""),
    // Live client-reported stats so the Cliff Board can rank currently
    // connected players. Only finite/non-negative checked, same trust model as
    // `username`/`avatar`. Durable state lives in Mongo (src/db.ts). The poop
    // inventory, pantry and boost are private and never synced.
    money: t.number().default(0),
    totalEarned: t.number().default(0),
    totalPoops: t.number().default(0),
    // How many poops this player is holding, so others know whether stealing is worth it.
    // Only the count is public; the inventory itself stays private.
    poopCount: t.number().default(0),
    // Bought Theft Immunity (Locked Jar): can't be robbed and can't rob. One-way per session.
    immune: t.boolean().default(false),
    // Total seconds connected (saved total for a signed-in player + this
    // session), server-measured -- see LobbyRoom.ts flushPlaytime().
    playTime: t.number().default(0),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const LobbyState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "LobbyState",
);
export type LobbyState = SchemaType<typeof LobbyState>;
