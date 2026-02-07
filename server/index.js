// server/index.js — Express HTTP server + WebSocket server entry point
// Handles: static file serving, WS connection lifecycle, message routing, DB integration

const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");

const Player = require("./Player");
const RoomManager = require("./RoomManager");
const db = require("./db");
const {
  SNAKE_PATTERNS,
  SNAKE_COLORS,
  POWERUP_TYPES,
  GRID_SIZES,
  WORLD_SIZES,
  MAX_PLAYERS_PER_ROOM,
} = require("./constants");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DISPLAY_HOST = HOST === "0.0.0.0" ? "localhost" : HOST;

// ─── Rate Limiting & Security ────────────────────────────────────────────────
const rateLimits = new Map(); // ip -> { actions: Map<action, timestamps[]> }
const playerRoomCounts = new Map(); // playerId -> number of rooms created

// Rate limit configuration
const RATE_LIMITS = {
  create_room: { max: 3, window: 60000 }, // 3 rooms per minute
  join_room: { max: 10, window: 10000 }, // 10 joins per 10 seconds
  set_profile: { max: 5, window: 30000 }, // 5 profile updates per 30 seconds
  start_game: { max: 5, window: 30000 }, // 5 game starts per 30 seconds
  chat: { max: 8, window: 4000 },
};

const MAX_ROOMS_PER_PLAYER = 3; // Maximum active rooms a player can create
const INPUT_RATE_LIMIT = { max: 60, window: 1000 };
const inputRateLimits = new Map();
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS
      .split(",")
      .map((origin) => origin.trim().toLowerCase())
      .filter(Boolean)
  : null;

/**
 * Check if an action is rate limited for a given IP
 * @param {string} ip - Client IP address
 * @param {string} action - Action type
 * @returns {boolean} - true if rate limited, false if allowed
 */
function isRateLimited(ip, action) {
  const config = RATE_LIMITS[action];
  if (!config) return false;

  const now = Date.now();

  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { actions: new Map() });
  }

  const clientData = rateLimits.get(ip);

  if (!clientData.actions.has(action)) {
    clientData.actions.set(action, []);
  }

  const timestamps = clientData.actions.get(action);

  // Remove old timestamps outside the window
  const validTimestamps = timestamps.filter((ts) => now - ts < config.window);
  clientData.actions.set(action, validTimestamps);

  // Check if limit exceeded
  if (validTimestamps.length >= config.max) {
    return true;
  }

  // Add current timestamp
  validTimestamps.push(now);
  return false;
}

function isInputRateLimited(playerId) {
  const now = Date.now();
  const entry = inputRateLimits.get(playerId);
  if (!entry || now - entry.windowStart >= INPUT_RATE_LIMIT.window) {
    inputRateLimits.set(playerId, { windowStart: now, count: 1 });
    return false;
  }
  if (entry.count >= INPUT_RATE_LIMIT.max) {
    return true;
  }
  entry.count += 1;
  return false;
}

function isAllowedOrigin(origin, hostHeader) {
  if (!origin) return true;
  const normalized = origin.toLowerCase();
  if (ALLOWED_ORIGINS) {
    return ALLOWED_ORIGINS.includes(normalized);
  }
  const allowed = new Set();
  if (hostHeader) {
    const host = hostHeader.toLowerCase();
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  const display = String(DISPLAY_HOST).toLowerCase();
  const port = String(PORT);
  allowed.add(`http://${display}:${port}`);
  allowed.add(`https://${display}:${port}`);
  allowed.add(`http://localhost:${port}`);
  allowed.add(`https://localhost:${port}`);
  allowed.add(`http://127.0.0.1:${port}`);
  allowed.add(`https://127.0.0.1:${port}`);
  return allowed.has(normalized);
}

// Clean up rate limit data every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimits.entries()) {
    for (const [action, timestamps] of data.actions.entries()) {
      const config = RATE_LIMITS[action];
      if (!config) continue;

      const validTimestamps = timestamps.filter(
        (ts) => now - ts < config.window,
      );
      if (validTimestamps.length === 0) {
        data.actions.delete(action);
      } else {
        data.actions.set(action, validTimestamps);
      }
    }

    if (data.actions.size === 0) {
      rateLimits.delete(ip);
    }
  }
}, 300000);

// ─── Express ─────────────────────────────────────────────────────────────────
const app = express();

// Security middleware
app.use((req, res, next) => {
  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Prevent caching of API responses
  if (req.path.startsWith("/api/")) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }

  next();
});

// Body size limits to prevent DoS
app.use(express.json({ limit: "10kb" }));
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders: (res, filePath) => {
      if (
        filePath.endsWith(".js") ||
        filePath.endsWith(".css") ||
        filePath.endsWith(".html")
      ) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }),
);

// ─── Initialize Database ─────────────────────────────────────────────────────
db.init();

// Health / stats endpoint
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    stats: roomManager.getStats(),
    db: db.getGlobalSummary(),
  });
});

// Available patterns + colors (so the client can stay in sync)
app.get("/api/config", (_req, res) => {
  res.json({
    patterns: SNAKE_PATTERNS,
    colors: SNAKE_COLORS,
    maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
    powerupTypes: Object.entries(POWERUP_TYPES).map(([id, def]) => ({
      id,
      label: def.label,
      icon: def.icon,
      color: def.color,
    })),
    worldSizes: Object.entries(WORLD_SIZES).map(([key, val]) => ({
      key,
      size: val,
    })),
    gridSizes: Object.entries(GRID_SIZES).map(([key, val]) => ({
      key,
      cols: val.cols,
      rows: val.rows,
    })),
  });
});

// ─── DB API Endpoints ────────────────────────────────────────────────────────

// Global leaderboard
app.get("/api/leaderboard", (req, res) => {
  const sortBy = req.query.sort || "totalScore";
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const board = db.getGlobalLeaderboard(sortBy, limit);
  const summary = db.getGlobalSummary();
  res.json({ leaderboard: board, summary });
});

// Player profile + stats
app.get("/api/player/:id/stats", (req, res) => {
  const data = db.getPlayerWithStats(req.params.id);
  if (!data) {
    return res.status(404).json({ error: "Player not found" });
  }
  const recentGames = db.getPlayerGames(req.params.id, 10);
  res.json({ player: data, recentGames });
});

// Recent game history
app.get("/api/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const games = db.getRecentGames(limit);
  res.json({ games, totalGames: db.getGameCount() });
});

// ─── HTTP + WS servers ───────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 10 * 1024, // 10KB max message size
  clientTracking: true,
  perMessageDeflate: false, // Disable compression — prevents silent message delivery failures
});

// ─── State ───────────────────────────────────────────────────────────────────
const roomManager = new RoomManager();
const connectedPlayers = new Map(); // playerId -> Player
const connectionsPerIP = new Map(); // ip -> count

// Map ws -> playerId  (so we can look up players on ws events)
const wsToPlayerId = new WeakMap();

const MAX_CONNECTIONS_PER_IP = 5; // Maximum concurrent connections from same IP

// ─── WebSocket connection handler ────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress;
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin, req.headers.host)) {
    console.log(`[WS] Connection rejected from ${ip}: origin ${origin}`);
    ws.close(1008, "Origin not allowed");
    return;
  }

  // Check connection limit per IP
  const currentConnections = connectionsPerIP.get(ip) || 0;
  if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
    console.log(`[WS] Connection rejected from ${ip}: too many connections`);
    ws.close(1008, "Too many connections from this IP");
    return;
  }

  // Track connection
  connectionsPerIP.set(ip, currentConnections + 1);

  console.log(
    `[WS] New connection from ${ip} (${currentConnections + 1}/${MAX_CONNECTIONS_PER_IP})`,
  );

  // Immediately send a hello handshake so the client can verify
  // it is connected to THIS server instance (not a stale process on the same port)
  try {
    ws.send(
      JSON.stringify({ type: "hello", ts: Date.now(), v: "snake-arena" }),
    );
  } catch (err) {
    console.error("[WS] Failed to send hello:", err.message);
  }

  let player = null;

  // ── Heartbeat ──────────────────────────────────────────────────────────
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // ── Message router ─────────────────────────────────────────────────────
  ws.on("message", (raw) => {
    // Log every inbound frame so we can confirm the server actually receives data
    const rawText = typeof raw === "string" ? raw : raw.toString();
    const rawStr = rawText.substring(0, 200);
    if (!rawStr.includes('"ping"')) {
      console.log(`[WS] ← ${ip}: ${rawStr}`);
    }

    let msg;
    try {
      msg = JSON.parse(rawText);
    } catch {
      return sendError(ws, "Invalid JSON");
    }

    if (!msg || !msg.type) return sendError(ws, "Missing message type");

    // Check rate limiting for sensitive actions
    if (RATE_LIMITS[msg.type]) {
      if (isRateLimited(ip, msg.type)) {
        return sendError(ws, "Rate limit exceeded. Please slow down.");
      }
    }

    try {
      switch (msg.type) {
        // ── Profile ────────────────────────────────────────────────────
        case "set_profile":
          player = handleSetProfile(ws, msg, player, ip);
          break;

        case "get_my_stats":
          if (!requirePlayer(ws, player)) break;
          handleGetMyStats(player);
          break;

        case "get_global_leaderboard":
          handleGetGlobalLeaderboard(ws, msg);
          break;

        // ── Rooms ──────────────────────────────────────────────────────
        case "get_rooms":
          handleGetRooms(ws);
          break;

        case "create_room":
          if (!requirePlayer(ws, player)) break;
          handleCreateRoom(player, msg);
          break;

        case "join_room":
          if (!requirePlayer(ws, player)) break;
          handleJoinRoom(player, msg);
          break;

        case "leave_room":
          if (!requirePlayer(ws, player)) break;
          handleLeaveRoom(player);
          break;

        // ── Game ───────────────────────────────────────────────────────
        case "start_game":
          if (!requirePlayer(ws, player)) break;
          handleStartGame(player);
          break;

        case "input":
          if (!requirePlayer(ws, player)) break;
          if (isInputRateLimited(player.id)) break;
          handleInput(player, msg);
          break;

        case "chat":
          if (!requirePlayer(ws, player)) break;
          handleChat(player, msg);
          break;

        // ── Misc ───────────────────────────────────────────────────────
        case "hello":
          try {
            ws.send(
              JSON.stringify({
                type: "hello",
                ts: Date.now(),
                v: "snake-arena",
              }),
            );
          } catch (err) {
            console.error("[WS] Failed to reply hello:", err.message);
          }
          break;

        case "ping":
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          break;

        case "get_room_state":
          if (!requirePlayer(ws, player)) break;
          handleGetRoomState(player);
          break;

        default:
          sendError(ws, `Unknown message type: ${msg.type}`);
      }
    } catch (err) {
      console.error(`[WS] Error handling message type=${msg.type}:`, err);
      sendError(ws, "Internal server error");
    }
  });

  // ── Close handler ──────────────────────────────────────────────────────
  ws.on("close", () => {
    // Decrement connection count for this IP
    const currentConnections = connectionsPerIP.get(ip) || 0;
    if (currentConnections > 0) {
      connectionsPerIP.set(ip, currentConnections - 1);
      if (currentConnections - 1 === 0) {
        connectionsPerIP.delete(ip);
      }
    }

    if (player) {
      console.log(
        `[WS] Player disconnected: ${player.username} (${player.id})`,
      );
      player.onDisconnect();
      inputRateLimits.delete(player.id);
      roomManager.handleDisconnect(player);

      // Don't immediately delete from connectedPlayers – they may reconnect
      // The RoomManager's grace timer will call leaveRoom if they don't
      setTimeout(() => {
        if (!player.connected) {
          connectedPlayers.delete(player.id);
          console.log(`[WS] Player removed after timeout: ${player.username}`);
        }
      }, 15_000);
    }
  });

  ws.on("error", (err) => {
    console.error(`[WS] Socket error:`, err.message);
  });
});

// ─── Heartbeat interval ──────────────────────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

// ═════════════════════════════════════════════════════════════════════════════
//  Message handlers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Handle set_profile — either create a new Player or update an existing one.
 * Also handles reconnecting: if the client sends a `playerId` that we still
 * have in connectedPlayers, we reattach the ws.
 */
function handleSetProfile(ws, msg, existingPlayer, ip) {
  console.log(
    `[WS] set_profile received: username="${msg.username}", pattern="${msg.pattern}", ` +
      `color="${msg.color}", playerId=${msg.playerId || "null"}, hasExisting=${!!existingPlayer}`,
  );

  // Input validation
  const username =
    String(msg.username || "Anonymous")
      .substring(0, 20)
      .trim()
      .replace(/[<>]/g, "") || "Anonymous"; // Remove potential XSS chars

  const validPatterns = SNAKE_PATTERNS.map((p) => p.id);
  const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;

  // Auto-correct invalid pattern/color instead of rejecting —
  // prevents silent enter-arena failures when client has stale saved values
  let pattern = msg.pattern || "classic";
  if (!validPatterns.includes(pattern)) {
    console.warn(
      `[WS] Invalid pattern "${msg.pattern}" from ${ip}, defaulting to "classic"`,
    );
    pattern = "classic";
  }

  let color =
    msg.color || SNAKE_COLORS[Math.floor(Math.random() * SNAKE_COLORS.length)];
  if (!hexColorRegex.test(color)) {
    console.warn(
      `[WS] Invalid color "${msg.color}" from ${ip}, defaulting to random`,
    );
    color = SNAKE_COLORS[Math.floor(Math.random() * SNAKE_COLORS.length)];
  }

  // Reconnect path
  if (msg.playerId && connectedPlayers.has(msg.playerId)) {
    const reconnecting = connectedPlayers.get(msg.playerId);
    if (!msg.sessionToken || msg.sessionToken !== reconnecting.sessionToken) {
      sendError(ws, "Invalid session token");
      return existingPlayer;
    }
    console.log(
      `[WS] Player reconnecting: ${reconnecting.username} (${reconnecting.id})`,
    );

    // Update profile in DB if username/color/pattern changed
    reconnecting.username = username;
    reconnecting.pattern = pattern;
    reconnecting.color = color;
    db.upsertPlayer(reconnecting.id, username, color, pattern);

    roomManager.handleReconnect(reconnecting, ws);

    wsToPlayerId.set(ws, reconnecting.id);

    const dbStats = db.getStats(reconnecting.id);

    const response = {
      type: "profile_set",
      playerId: reconnecting.id,
      username: reconnecting.username,
      pattern: reconnecting.pattern,
      color: reconnecting.color,
      sessionToken: reconnecting.sessionToken,
      reconnected: true,
      stats: dbStats,
    };

    // Send directly via ws to guarantee delivery (bypasses Player.send state checks)
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(response));
        console.log(
          `[WS] profile_set sent (reconnect) to ${reconnecting.username} (${reconnecting.id})`,
        );
      } else {
        console.error(
          `[WS] Cannot send profile_set: ws.readyState=${ws.readyState} for ${reconnecting.username}`,
        );
      }
    } catch (err) {
      console.error(
        `[WS] Failed to send profile_set to ${reconnecting.username}:`,
        err.message,
      );
    }

    return reconnecting;
  }

  // New player (or profile update for existing)
  if (existingPlayer) {
    existingPlayer.ws = ws;
    existingPlayer.username = username;
    existingPlayer.pattern = pattern;
    existingPlayer.color = color;
    existingPlayer.connected = true;

    // Update DB
    db.upsertPlayer(existingPlayer.id, username, color, pattern);
    const dbStats = db.getStats(existingPlayer.id);

    const response = {
      type: "profile_set",
      playerId: existingPlayer.id,
      username,
      pattern,
      color,
    sessionToken: existingPlayer.sessionToken,
      reconnected: false,
      stats: dbStats,
    };

    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(response));
        console.log(
          `[WS] profile_set sent (update) to ${existingPlayer.username} (${existingPlayer.id})`,
        );
      } else {
        console.error(
          `[WS] Cannot send profile_set: ws.readyState=${ws.readyState} for ${existingPlayer.username}`,
        );
      }
    } catch (err) {
      console.error(
        `[WS] Failed to send profile_set to ${existingPlayer.username}:`,
        err.message,
      );
    }

    return existingPlayer;
  }

  // Brand new player
  const player = new Player(ws, username, pattern, color);
  connectedPlayers.set(player.id, player);
  wsToPlayerId.set(ws, player.id);

  // Persist to DB
  db.upsertPlayer(player.id, username, color, pattern);
  const dbStats = db.getStats(player.id);

  console.log(`[WS] New player: ${player.username} (${player.id})`);

  const response = {
    type: "profile_set",
    playerId: player.id,
    username: player.username,
    pattern: player.pattern,
    color: player.color,
    sessionToken: player.sessionToken,
    reconnected: false,
    stats: dbStats,
  };

  // Send directly via ws to guarantee delivery
  try {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(response));
      console.log(
        `[WS] profile_set sent (new) to ${player.username} (${player.id})`,
      );
    } else {
      console.error(
        `[WS] Cannot send profile_set: ws.readyState=${ws.readyState} for ${player.username}`,
      );
    }
  } catch (err) {
    console.error(
      `[WS] Failed to send profile_set to ${player.username}:`,
      err.message,
    );
  }

  return player;
}

function handleGetRooms(ws) {
  const rooms = roomManager.listRooms();
  const stats = roomManager.getStats();

  if (ws.readyState === 1) {
    ws.send(
      JSON.stringify({
        type: "room_list",
        rooms,
        stats,
      }),
    );
  }
}

function handleCreateRoom(player, msg) {
  // Input validation
  if (!msg.name || typeof msg.name !== "string") {
    return player.send({ type: "error", message: "Invalid room name" });
  }

  const name = msg.name.substring(0, 24).trim().replace(/[<>]/g, "");
  if (!name) {
    return player.send({ type: "error", message: "Room name cannot be empty" });
  }

  const maxPlayers = parseInt(msg.maxPlayers, 10);
  if (
    isNaN(maxPlayers) ||
    maxPlayers < 2 ||
    maxPlayers > MAX_PLAYERS_PER_ROOM
  ) {
    return player.send({
      type: "error",
      message: `Invalid max players (2-${MAX_PLAYERS_PER_ROOM})`,
    });
  }

  const validGridSizes = ["small", "medium", "large"];
  if (!validGridSizes.includes(msg.gridSize)) {
    return player.send({ type: "error", message: "Invalid grid size" });
  }

  const validModes = ["last_standing", "timed", "free_play"];
  if (!validModes.includes(msg.mode)) {
    return player.send({ type: "error", message: "Invalid game mode" });
  }

  const allowedTimedDurations = [180, 300, 600];
  let timedDuration = null;
  if (msg.mode === "timed") {
    const parsedDuration =
      msg.timedDuration == null ? 180 : parseInt(msg.timedDuration, 10);
    if (!allowedTimedDurations.includes(parsedDuration)) {
      return player.send({
        type: "error",
        message: "Invalid timed duration (3, 5, or 10 minutes)",
      });
    }
    timedDuration = parsedDuration;
  }

  // Check if player has too many active rooms
  const currentRoomCount = playerRoomCounts.get(player.id) || 0;
  if (currentRoomCount >= MAX_ROOMS_PER_PLAYER) {
    return player.send({
      type: "error",
      message: `You can only create ${MAX_ROOMS_PER_PLAYER} rooms at a time. Please close an existing room first.`,
    });
  }

  // If player is already in a room, leave first
  if (player.roomId) {
    roomManager.leaveRoom(player);
  }

  try {
    const room = roomManager.createRoom(player, {
      name: name,
      maxPlayers: maxPlayers,
      gridSize: msg.gridSize,
      mode: msg.mode,
      timedDuration: timedDuration ?? undefined,
    });

    // Track room creation
    playerRoomCounts.set(player.id, currentRoomCount + 1);

    console.log(
      `[Server] Room created successfully: ${room.id} by ${player.username}`,
    );

    // Broadcast updated room list to everyone not in a room
    broadcastRoomList();
  } catch (err) {
    console.error("[Server] Error creating room:", err);
    player.send({
      type: "error",
      message: "Failed to create room. Please try again.",
    });
  }
}

function handleJoinRoom(player, msg) {
  if (!msg.roomId || typeof msg.roomId !== "string") {
    return player.send({ type: "error", message: "Invalid room ID" });
  }

  // Sanitize room ID (should be 6 alphanumeric chars)
  const roomId = msg.roomId.toUpperCase().substring(0, 6);
  if (!/^[A-Z0-9]{6}$/.test(roomId)) {
    return player.send({ type: "error", message: "Invalid room ID format" });
  }

  const result = roomManager.joinRoom(player, roomId);

  if (result.error) {
    player.send({ type: "error", message: result.error });
    return;
  }

  console.log(`[Server] ${player.username} joined room ${roomId}`);
  broadcastRoomList();
}

function handleLeaveRoom(player) {
  const result = roomManager.leaveRoom(player);

  if (result.error) {
    player.send({ type: "error", message: result.error });
    return;
  }

  player.send({ type: "room_left" });

  broadcastRoomList();
}

function handleStartGame(player) {
  const result = roomManager.startGame(player.id);

  if (result.error) {
    player.send({ type: "error", message: result.error });
    return;
  }

  broadcastRoomList();
}

function handleGetMyStats(player) {
  const data = db.getPlayerWithStats(player.id);
  const recentGames = db.getPlayerGames(player.id, 10);

  player.send({
    type: "my_stats",
    player: data,
    recentGames,
  });
}

function handleGetGlobalLeaderboard(ws, msg) {
  const sortBy = msg.sortBy || "totalScore";
  const limit = Math.min(parseInt(msg.limit, 10) || 20, 100);
  const board = db.getGlobalLeaderboard(sortBy, limit);
  const summary = db.getGlobalSummary();

  if (ws.readyState === 1) {
    ws.send(
      JSON.stringify({
        type: "global_leaderboard",
        leaderboard: board,
        summary,
      }),
    );
  }
}

function handleInput(player, msg) {
  // Support both angle-based (continuous) and legacy direction input
  if (typeof msg.angle === "number" && isFinite(msg.angle)) {
    roomManager.handleInput(player.id, msg.angle, !!msg.boosting);
  } else if (msg.direction) {
    // Legacy 4-direction fallback — convert to angle
    const dirAngles = {
      right: 0,
      down: Math.PI / 2,
      left: Math.PI,
      up: -Math.PI / 2,
    };
    const angle = dirAngles[msg.direction];
    if (angle !== undefined) {
      roomManager.handleInput(player.id, angle, false);
    }
  }
}

function handleChat(player, msg) {
  const room = roomManager.getRoomByPlayer(player.id);
  if (!room) {
    return player.send({ type: "error", message: "Not in any room" });
  }
  if (!msg || typeof msg.text !== "string") {
    return player.send({ type: "error", message: "Invalid chat message" });
  }

  const text = msg.text.replace(/\s+/g, " ").trim();
  if (!text) return;

  const trimmed = text.substring(0, 120);
  room.broadcast({
    type: "chat",
    playerId: player.id,
    username: player.username,
    color: player.color,
    text: trimmed,
    ts: Date.now(),
    spectating: player.spectating,
  });
}

function handleGetRoomState(player) {
  const room = roomManager.getRoomByPlayer(player.id);
  if (!room) {
    return player.send({ type: "error", message: "Not in any room" });
  }

  player.send({
    type: "room_state",
    room: room.toPublic(),
  });

  if (room.state === "playing") {
    const gameState = room.getFullGameState();
    if (gameState) {
      player.send({
        type: "game_state",
        ...gameState,
        isResync: true,
      });
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Utility
// ═════════════════════════════════════════════════════════════════════════════

function sendError(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "error", message }));
  }
}

function requirePlayer(ws, player) {
  if (!player) {
    sendError(ws, "Must set profile first (send set_profile message)");
    return false;
  }
  return true;
}

/**
 * Record the result of a completed game into the DB.
 * Called by the Room's game_over broadcast hook.
 * @param {object} room — the Room instance
 * @param {object} gameOverData — { reason, standings, winner, duration, round }
 */
function recordGameResultToDB(room, gameOverData) {
  try {
    const standings = gameOverData.standings || [];
    const winner = gameOverData.winner;
    const durationSec = gameOverData.duration || 0;

    // Record the game itself
    db.recordGame({
      roomName: room.name,
      gameMode: room.mode,
      gridSize: room.gridPreset,
      playerCount: standings.length,
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.username : null,
      durationSeconds: durationSec,
      players: standings,
    });

    // Record per-player results
    for (const entry of standings) {
      const pid = entry.id;
      if (!pid) continue;

      db.recordPlayerGameResult(pid, {
        rank: entry.rank,
        score: entry.score || 0,
        kills: entry.kills || 0,
        length: entry.length || 0,
        alive: !!entry.alive,
        durationMs: durationSec * 1000,
        won: winner && winner.id === pid,
        foodEaten: 0, // not tracked per-standing yet
      });
    }

    console.log(
      `[DB] Recorded game result for room "${room.name}" (${standings.length} players)`,
    );
  } catch (err) {
    console.error("[DB] Error recording game result:", err);
  }
}

// Expose the record function so Room.js can call it via a hook
roomManager._onGameOver = recordGameResultToDB;

// Hook for room destruction to update player room counts
roomManager._onRoomDestroyed = (creatorId) => {
  const currentCount = playerRoomCounts.get(creatorId) || 0;
  if (currentCount > 0) {
    playerRoomCounts.set(creatorId, currentCount - 1);
  }
};

/**
 * Broadcast the updated room list to all connected players who are NOT
 * currently in a room (i.e. they're in the lobby).
 */
function broadcastRoomList() {
  const rooms = roomManager.listRooms();
  const stats = roomManager.getStats();
  const msg = JSON.stringify({ type: "room_list", rooms, stats });

  for (const [, player] of connectedPlayers) {
    // Only send to players in the lobby (no roomId) or send to all for updates
    if (player.connected && player.ws && player.ws.readyState === 1) {
      player.ws.send(msg);
    }
  }
}

// ─── Start server ────────────────────────────────────────────────────────────
// Catch port-in-use BEFORE listen so we get a clear error
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[Server] ❌  Port ${PORT} is already in use!`);
    console.error(`[Server] Another server process is probably still running.`);
    console.error(
      `[Server] Fix:  npx kill-port ${PORT}   (or on Windows:  netstat -ano | findstr :${PORT})\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║          🐍  Snake Arena — Multiplayer Server        ║
║                                                      ║
║   HTTP  →  http://${DISPLAY_HOST}:${PORT}                      ║
║   WS    →  ws://${DISPLAY_HOST}:${PORT}/ws                     ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
  `);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[Server] Received ${signal}, shutting down...`);

  // Notify all connected players
  const msg = JSON.stringify({
    type: "server_shutdown",
    message: "Server is shutting down",
  });
  wss.clients.forEach((ws) => {
    try {
      ws.send(msg);
      ws.close();
    } catch {
      /* ignore */
    }
  });

  roomManager.shutdown();
  db.flush();

  server.close(() => {
    console.log("[Server] HTTP server closed");
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.log("[Server] Forcing exit...");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  db.shutdown();
});
