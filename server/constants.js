// ─── Snake Arena · Server Constants ─────────────────────────────────────────

module.exports = {
  // ── Tick Engine ────────────────────────────────────────────────────────────
  TICK_RATE: 50, // ms per tick (20 TPS for smooth movement)
  SYNC_FULL_EVERY: 10, // send full state every N ticks (keyframe)

  // ── World ──────────────────────────────────────────────────────────────────
  WORLD_SIZES: {
    small: 2000,
    medium: 3000,
    large: 4500,
  },

  // ── Grid Presets (kept for backward compat with DB / room creation) ────────
  GRID_SIZES: {
    small: { cols: 2000, rows: 2000 },
    medium: { cols: 3000, rows: 3000 },
    large: { cols: 4500, rows: 4500 },
  },

  // ── Snake ──────────────────────────────────────────────────────────────────
  INITIAL_SNAKE_LENGTH: 10, // number of body segments at spawn
  SNAKE_SPEED: 3, // units per tick base speed
  SNAKE_BOOST_SPEED: 5.5, // units per tick when boosting
  SNAKE_TURN_RATE: 0.12, // radians per tick max turn speed
  SNAKE_SEGMENT_RADIUS: 8, // base radius of each body segment
  SNAKE_HEAD_RADIUS: 10, // base head radius
  GROW_PER_FOOD: 2, // segments gained per food eaten
  BOOST_COST_INTERVAL: 5, // lose 1 length every N ticks while boosting
  MAX_SNAKE_SEGMENTS: 200, // performance cap on segments

  // ── Food ───────────────────────────────────────────────────────────────────
  FOOD_BASE_COUNT: 120, // minimum food on map
  FOOD_PER_PLAYER: 8, // extra food per alive player
  FOOD_SCORE: 10,
  FOOD_RADIUS: 5, // collision/visual radius of food dot
  BONUS_FOOD_CHANCE: 0.12, // chance a new food is "bonus" type

  // ── Power-ups ──────────────────────────────────────────────────────────────
  POWERUP_SPAWN_CHANCE: 0.008, // chance per tick to spawn a powerup
  POWERUP_MAX: 5, // max powerups on map at once
  POWERUP_DESPAWN_TICKS: 200, // despawn after this many ticks
  POWERUP_TYPES: {
    speed: {
      label: "Speed Boost",
      icon: "zap",
      color: "#FACC15",
      duration: 80,
    },
    shield: { label: "Shield", icon: "shield", color: "#38BDF8", duration: 60 },
    ghost: { label: "Ghost", icon: "ghost", color: "#C084FC", duration: 50 },
  },

  // ── Collision ──────────────────────────────────────────────────────────────
  COLLISION_GRACE_SEGMENTS: 5, // skip first N segments of other snake (near head)
  BOUNDARY_KILL_MARGIN: 50, // how far inside boundary edge counts as dead zone

  // ── Room / Match ───────────────────────────────────────────────────────────
  ROOM_STATES: {
    WAITING: "waiting",
    COUNTDOWN: "countdown",
    PLAYING: "playing",
    ENDED: "ended",
  },

  GAME_MODES: {
    LAST_STANDING: "last_standing", // last alive wins
    TIMED: "timed", // highest score after time limit
    FREE_PLAY: "free_play", // no end condition
  },

  MAX_ROOM_NAME_LENGTH: 24,
  MAX_USERNAME_LENGTH: 16,
  MIN_PLAYERS_TO_START: 1, // 1 for testing, bump to 2 for prod
  MAX_PLAYERS_PER_ROOM: 50,
  COUNTDOWN_SECONDS: 3,
  TIMED_GAME_DURATION: 180, // seconds

  // ── Network ────────────────────────────────────────────────────────────────
  DISCONNECT_GRACE_MS: 10_000, // 10 s before removing disconnected player
  MAX_INPUT_QUEUE: 3, // not used in continuous mode but kept

  // ── Snake Patterns (visual presets — rendered client-side) ─────────────────
  SNAKE_PATTERNS: [
    { id: "classic", label: "Classic" },
    { id: "striped", label: "Striped" },
    { id: "neon", label: "Neon Glow" },
    { id: "gradient", label: "Gradient" },
    { id: "candy", label: "Candy" },
    { id: "rainbow", label: "Rainbow" },
    { id: "galaxy", label: "Galaxy" },
    { id: "fire", label: "Fire" },
  ],

  // ── Palette choices for players ────────────────────────────────────────────
  SNAKE_COLORS: [
    "#EF4444", // red
    "#F97316", // orange
    "#EAB308", // yellow
    "#22C55E", // green
    "#14B8A6", // teal
    "#3B82F6", // blue
    "#8B5CF6", // violet
    "#EC4899", // pink
    "#F43F5E", // rose
    "#06B6D4", // cyan
    "#10B981", // emerald
    "#6366F1", // indigo
    "#D946EF", // fuchsia
    "#F59E0B", // amber
    "#84CC16", // lime
  ],
};
