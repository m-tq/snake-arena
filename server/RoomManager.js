// RoomManager.js — Manages all game rooms, player-room mappings, room lifecycle
const Room = require("./Room");
const {
  MAX_ROOM_NAME_LENGTH,
  MAX_PLAYERS_PER_ROOM,
  DISCONNECT_GRACE_MS,
  WORLD_SIZES,
} = require("./constants");
const crypto = require("crypto");

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> Room
    this.playerRoomMap = new Map(); // playerId -> roomId

    // External hook: set by server/index.js to record game results to DB
    // Signature: _onGameOver(room, gameOverData)
    this._onGameOver = null;

    // Periodically clean up empty / stale rooms
    this._cleanupInterval = setInterval(() => this._cleanup(), 30_000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Room creation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new room and auto-join the creator.
   * @param {Player} creator
   * @param {object} opts – { name, maxPlayers, gridSize, mode }
   * @returns {Room}
   */
  createRoom(creator, opts = {}) {
    const roomId = this._generateRoomId();

    const name = (opts.name || `${creator.username}'s Room`)
      .substring(0, MAX_ROOM_NAME_LENGTH)
      .trim();

    const maxPlayers = Math.min(
      Math.max(parseInt(opts.maxPlayers, 10) || 6, 2),
      MAX_PLAYERS_PER_ROOM,
    );

    const gridPreset = ["small", "medium", "large"].includes(opts.gridSize)
      ? opts.gridSize
      : "medium";

    const mode = ["last_standing", "timed", "free_play"].includes(opts.mode)
      ? opts.mode
      : "last_standing";

    const room = new Room(roomId, {
      name,
      maxPlayers,
      gridPreset,
      mode,
      timedDuration: opts.timedDuration,
      creatorId: creator.id,
      creatorName: creator.username,
    });

    // Forward the onGameOver hook from RoomManager to the Room instance
    if (typeof this._onGameOver === "function") {
      room.onGameOver = this._onGameOver;
    }

    this.rooms.set(roomId, room);

    // Auto-join the creator into the room
    this.joinRoom(creator, roomId);
    creator.isRoomCreator = true;

    console.log(
      `[RoomManager] Room created: "${name}" (${roomId}) by ${creator.username}`,
    );

    return room;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Join / Leave
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Join an existing room.
   * @param {Player} player
   * @param {string} roomId
   * @returns {{ success?: boolean, error?: string, room?: Room }}
   */
  joinRoom(player, roomId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { error: "Room not found" };
    }

    // If already in a room, leave it first
    if (this.playerRoomMap.has(player.id)) {
      this.leaveRoom(player);
    }

    const result = room.addPlayer(player);
    if (result.error) return result;

    this.playerRoomMap.set(player.id, roomId);
    player.roomId = roomId;

    console.log(
      `[RoomManager] ${player.username} joined room "${room.name}" (${roomId})`,
    );

    return { success: true, room };
  }

  /**
   * Remove a player from their current room.
   * @param {Player} player
   * @returns {{ success?: boolean, error?: string }}
   */
  leaveRoom(player) {
    const roomId = this.playerRoomMap.get(player.id);
    if (!roomId) return { error: "Not in any room" };

    const room = this.rooms.get(roomId);
    if (!room) {
      this.playerRoomMap.delete(player.id);
      player.roomId = null;
      return { error: "Room not found" };
    }

    const result = room.removePlayer(player.id);
    this.playerRoomMap.delete(player.id);
    player.roomId = null;
    player.isRoomCreator = false;

    console.log(
      `[RoomManager] ${player.username} left room "${room.name}" (${roomId})`,
    );

    // Destroy room if it reported empty
    if (result === "empty") {
      this._destroyRoom(roomId);
    }

    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Room queries
  // ═══════════════════════════════════════════════════════════════════════════

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  getRoomByPlayer(playerId) {
    const roomId = this.playerRoomMap.get(playerId);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  getPlayerRoomId(playerId) {
    return this.playerRoomMap.get(playerId) || null;
  }

  /**
   * Return a sorted list of room summaries for the lobby.
   */
  listRooms() {
    const list = [];

    for (const [, room] of this.rooms) {
      list.push(room.toListEntry());
    }

    // Sort: waiting rooms first, then by newest
    const stateOrder = { waiting: 0, countdown: 1, playing: 2, ended: 3 };
    list.sort((a, b) => {
      const sa = stateOrder[a.state] ?? 9;
      const sb = stateOrder[b.state] ?? 9;
      if (sa !== sb) return sa - sb;
      return b.createdAt - a.createdAt;
    });

    return list;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Game control
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start the game in the player's room. Only the room creator may call this.
   * @param {string} playerId
   * @returns {{ success?: boolean, error?: string }}
   */
  startGame(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return { error: "Not in any room" };

    if (room.creatorId !== playerId) {
      return { error: "Only the room creator can start the game" };
    }

    return room.startCountdown();
  }

  /**
   * Forward angle-based input to the correct room's engine.
   * @param {string} playerId
   * @param {number} angle – target heading in radians
   * @param {boolean} boosting – whether the player is boosting
   */
  handleInput(playerId, angle, boosting) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return;
    room.handleInput(playerId, angle, boosting);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Disconnect / Reconnect
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle a player's WebSocket disconnecting.
   * During an active game the player gets a grace period; otherwise they are
   * removed immediately.
   * @param {Player} player
   */
  handleDisconnect(player) {
    const roomId = this.playerRoomMap.get(player.id);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) {
      this.playerRoomMap.delete(player.id);
      return;
    }

    player.onDisconnect();

    if (room.state === "playing" || room.state === "countdown") {
      // Mark as disconnected in the room (broadcasts notification)
      room.markDisconnected(player.id);

      // Start grace period – if player doesn't reconnect, remove them
      player.disconnectTimer = setTimeout(() => {
        if (!player.connected) {
          console.log(
            `[RoomManager] ${player.username} grace period expired, removing from room "${room.name}"`,
          );
          this.leaveRoom(player);
        }
      }, DISCONNECT_GRACE_MS);
    } else {
      // Waiting / ended – just remove immediately
      this.leaveRoom(player);
    }
  }

  /**
   * Handle a player reconnecting with a new WebSocket.
   * @param {Player} player
   * @param {WebSocket} ws
   */
  handleReconnect(player, ws) {
    player.onReconnect(ws);

    const room = this.getRoomByPlayer(player.id);
    if (!room) return;

    room.markReconnected(player.id);

    // Send current room state to the reconnected player
    player.send({
      type: "room_joined",
      room: room.toPublic(),
      playerId: player.id,
    });

    // If a game is in progress, resync the full game state
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  Internal helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a short, human-readable room code (6 chars, alphanumeric).
   */
  _generateRoomId() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let id = "";
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
      id += chars[bytes[i] % chars.length];
    }
    // Ensure uniqueness (collision is astronomically unlikely but be safe)
    if (this.rooms.has(id)) return this._generateRoomId();
    return id;
  }

  /**
   * Destroy a room and clean up all mappings.
   */
  _destroyRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // Notify server to decrement room count for creator
    if (this._onRoomDestroyed && room.creatorId) {
      this._onRoomDestroyed(room.creatorId);
    }

    room.destroy();
    this.rooms.delete(roomId);

    // Clean up player-room mappings that still reference this room
    for (const [playerId, rid] of this.playerRoomMap) {
      if (rid === roomId) {
        this.playerRoomMap.delete(playerId);
      }
    }

    console.log(`[RoomManager] Room destroyed: "${room.name}" (${roomId})`);
  }

  /**
   * Periodic cleanup of empty or stale rooms.
   */
  _cleanup() {
    const now = Date.now();

    for (const [roomId, room] of this.rooms) {
      // Remove empty rooms older than 2 minutes
      if (room.getPlayerCount() === 0 && now - room.createdAt > 120_000) {
        this._destroyRoom(roomId);
        continue;
      }

      // Remove ended rooms with no connected players after 5 minutes
      if (room.state === "ended") {
        const elapsed = now - (room.endedAt || room.createdAt);
        if (elapsed > 300_000) {
          const hasConnected = room.getPlayers().some((p) => p.connected);
          if (!hasConnected) {
            this._destroyRoom(roomId);
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Shutdown
  // ═══════════════════════════════════════════════════════════════════════════

  shutdown() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }

    for (const [, room] of this.rooms) {
      room.destroy();
    }

    this.rooms.clear();
    this.playerRoomMap.clear();

    console.log("[RoomManager] Shutdown complete");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Stats
  // ═══════════════════════════════════════════════════════════════════════════

  getStats() {
    let totalPlayers = 0;
    let playingRooms = 0;
    let waitingRooms = 0;

    for (const [, room] of this.rooms) {
      totalPlayers += room.getPlayerCount();
      if (room.state === "playing") playingRooms++;
      if (room.state === "waiting") waitingRooms++;
    }

    return {
      totalRooms: this.rooms.size,
      totalPlayers,
      playingRooms,
      waitingRooms,
    };
  }
}

module.exports = RoomManager;
