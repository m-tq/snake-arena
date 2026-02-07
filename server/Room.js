// Room.js — Single game room: state machine, tick loop, player management, broadcasting
// Supports an onGameOver callback hook for DB integration
const crypto = require("crypto");
const GameEngine = require("./GameEngine");
const {
  TICK_RATE,
  SYNC_FULL_EVERY,
  WORLD_SIZES,
  GRID_SIZES,
  ROOM_STATES,
  GAME_MODES,
  COUNTDOWN_SECONDS,
  TIMED_GAME_DURATION,
  DISCONNECT_GRACE_MS,
  MAX_PLAYERS_PER_ROOM,
} = require("./constants");

class Room {
  /**
   * @param {string} roomId   – short unique room code
   * @param {object} opts
   *   name, maxPlayers, gridPreset ('small'|'medium'|'large'),
   *   mode ('last_standing'|'timed'|'free_play'),
   *   creatorId, creatorName
   */
  constructor(roomId, opts = {}) {
    this.id = roomId;
    this.name = opts.name || `Room-${roomId}`;
    this.creatorId = opts.creatorId || null;
    this.creatorName = opts.creatorName || "???";
    this.state = ROOM_STATES.WAITING;

    // World size (continuous movement)
    this.gridPreset = opts.gridPreset || "medium";
    this.worldSize = WORLD_SIZES[this.gridPreset] || WORLD_SIZES.medium;
    // Keep gridSize as alias for backward compat (DB, toPublic, etc.)
    this.gridSize = this.worldSize;

    // Options
    this.maxPlayers = Math.min(opts.maxPlayers || 6, MAX_PLAYERS_PER_ROOM);
    this.mode = opts.mode || GAME_MODES.LAST_STANDING;
    this.timedDuration = opts.timedDuration || TIMED_GAME_DURATION;

    // Players  – Map<playerId, Player>
    this.players = new Map();

    // Engine
    this.engine = null;

    // Timers / intervals
    this._tickInterval = null;
    this._countdownInterval = null;
    this._countdownValue = 0;
    this._timedGameTimeout = null;

    // Meta
    this.createdAt = Date.now();
    this.startedAt = null;
    this.endedAt = null;
    this.roundNumber = 0;

    // Kill-feed buffer (last 50 events)
    this.recentEvents = [];

    // External callback hook — set by RoomManager/server to record results to DB
    // Signature: onGameOver(room, gameOverData)
    this.onGameOver = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Player management
  // ═══════════════════════════════════════════════════════════════════════════

  /** Can one more player join? */
  isFull() {
    return this.players.size >= this.maxPlayers;
  }

  getPlayerCount() {
    return this.players.size;
  }

  getPlayers() {
    return [...this.players.values()];
  }

  getPlayer(playerId) {
    return this.players.get(playerId) || null;
  }

  /**
   * Add a Player object to this room.
   * Returns { error } on failure or { success, asSpectator } on success.
   */
  addPlayer(player) {
    // During active game allow joining as spectator only
    if (
      this.state === ROOM_STATES.PLAYING ||
      this.state === ROOM_STATES.COUNTDOWN
    ) {
      player.roomId = this.id;
      player.spectating = true;
      this.players.set(player.id, player);

      player.send({
        type: "room_joined",
        room: this.toPublic(),
        playerId: player.id,
        asSpectator: true,
      });

      if (this.engine) {
        player.send({
          type: "game_state",
          state: this.engine.getFullState(),
          leaderboard: this.engine.getLeaderboard(),
        });
      }

      this.broadcast(
        { type: "spectator_joined", player: player.toPublic() },
        player.id,
      );

      return { success: true, asSpectator: true };
    }

    if (this.isFull()) {
      return { error: "Room is full" };
    }

    this.players.set(player.id, player);
    player.roomId = this.id;
    player.spectating = false;
    player.isRoomCreator = player.id === this.creatorId;

    player.send({
      type: "room_joined",
      room: this.toPublic(),
      playerId: player.id,
      asSpectator: false,
    });

    this.broadcast(
      {
        type: "player_joined",
        player: player.toPublic(),
        playerCount: this.players.size,
      },
      player.id,
    );

    return { success: true, asSpectator: false };
  }

  /**
   * Remove a player from the room. Returns 'empty' if room has no players left.
   */
  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return "not_found";

    const wasCreator = player.id === this.creatorId;

    // Clean up player state
    this.players.delete(playerId);
    player.roomId = null;
    player.isRoomCreator = false;
    player.spectating = false;
    player.reset();

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    // Remove from engine
    if (this.engine) {
      this.engine.removeSnake(playerId);
    }

    // Transfer creator
    if (wasCreator && this.players.size > 0) {
      const next = this.players.values().next().value;
      this.creatorId = next.id;
      this.creatorName = next.username;
      next.isRoomCreator = true;

      this.broadcast({
        type: "room_creator_changed",
        newCreatorId: next.id,
        newCreatorName: next.username,
      });
    }

    this.broadcast({
      type: "player_left",
      playerId,
      playerCount: this.players.size,
    });

    // Check game-end conditions
    if (this.state === ROOM_STATES.PLAYING) {
      this._checkGameEnd();
    }

    if (this.players.size === 0) {
      this.destroy();
      return "empty";
    }

    return "ok";
  }

  // ── Disconnect / Reconnect ────────────────────────────────────────────────

  markDisconnected(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.onDisconnect();

    this.broadcast({
      type: "player_disconnected",
      playerId,
      username: player.username,
      gracePeriodMs: DISCONNECT_GRACE_MS,
    });
  }

  markReconnected(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    // onReconnect is called externally (sets ws + clears timer)
    this.broadcast(
      {
        type: "player_reconnected",
        playerId,
        username: player.username,
      },
      playerId,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Game lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start the countdown. Only the room creator may call this.
   * Returns { success } or { error }.
   */
  startCountdown() {
    if (
      this.state !== ROOM_STATES.WAITING &&
      this.state !== ROOM_STATES.ENDED
    ) {
      return { error: "Game cannot be started in current state" };
    }

    const connected = this.getPlayers().filter((p) => p.connected);
    if (connected.length < 1) {
      return { error: "Need at least 1 connected player to start" };
    }

    this.state = ROOM_STATES.COUNTDOWN;
    this._countdownValue = COUNTDOWN_SECONDS;

    this.broadcast({
      type: "countdown_start",
      seconds: COUNTDOWN_SECONDS,
    });

    this._countdownInterval = setInterval(() => {
      this._countdownValue--;

      this.broadcast({
        type: "countdown_tick",
        value: this._countdownValue,
      });

      if (this._countdownValue <= 0) {
        clearInterval(this._countdownInterval);
        this._countdownInterval = null;
        this._beginGame();
      }
    }, 1000);

    return { success: true };
  }

  _beginGame() {
    this.state = ROOM_STATES.PLAYING;
    this.roundNumber++;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.recentEvents = [];

    // Create fresh engine with continuous-movement world size
    this.engine = new GameEngine(this.worldSize);

    // Spawn a snake for every connected, non-spectating player
    for (const [id, player] of this.players) {
      if (!player.connected) continue;

      player.reset();
      player.alive = true;
      player.spectating = false;

      this.engine.spawnSnake(id, player.username, player.pattern, player.color);
    }

    const initialState = this.engine.getFullState();

    this.broadcast({
      type: "game_started",
      state: initialState,
      leaderboard: this.engine.getLeaderboard(),
      gameMode: this.mode,
      worldSize: this.worldSize,
      gridSize: this.worldSize, // backward compat
      round: this.roundNumber,
    });

    // Start the deterministic tick loop
    this._startTickLoop();

    // Timed mode: schedule auto-end
    if (this.mode === GAME_MODES.TIMED) {
      this._timedGameTimeout = setTimeout(() => {
        this._endGame("time_up");
      }, this.timedDuration * 1000);
    }
  }

  _startTickLoop() {
    if (this._tickInterval) clearInterval(this._tickInterval);

    this._tickInterval = setInterval(() => {
      if (this.state !== ROOM_STATES.PLAYING || !this.engine) return;

      // Advance engine
      const result = this.engine.update();

      // Buffer recent events for kill feed
      for (const evt of result.events) {
        this.recentEvents.push(evt);
        if (this.recentEvents.length > 50) this.recentEvents.shift();
      }

      // Sync player objects with engine state
      for (const [id, player] of this.players) {
        const snake = this.engine.snakes.get(id);
        if (snake) {
          player.alive = snake.alive;
          player.score = snake.score;
          player.kills = snake.kills;
          if (!snake.alive && !player.spectating) {
            player.spectating = true;
          }
        }
      }

      // Build tick message
      const isKeyframe = this.engine.tick % SYNC_FULL_EVERY === 0;
      const msg = {
        type: "game_tick",
        tick: this.engine.tick,
        state: this.engine.getFullState(),
        leaderboard: this.engine.getLeaderboard(),
        events: result.events,
        isKeyframe,
      };

      this.broadcast(msg);

      // Check end conditions
      this._checkGameEnd();
    }, TICK_RATE);
  }

  _checkGameEnd() {
    if (this.state !== ROOM_STATES.PLAYING || !this.engine) return;

    const alive = this.engine.getAliveCount();
    const total = this.engine.snakes.size;

    let shouldEnd = false;
    let reason = "";

    switch (this.mode) {
      case GAME_MODES.LAST_STANDING:
        if (total >= 2 && alive <= 1) {
          shouldEnd = true;
          reason = alive === 1 ? "winner" : "draw";
        } else if (total === 1 && alive === 0) {
          shouldEnd = true;
          reason = "game_over";
        }
        break;

      case GAME_MODES.FREE_PLAY: {
        const connAlive = [...this.players.values()].filter(
          (p) => p.connected && p.alive,
        ).length;
        if (connAlive === 0 && total > 0) {
          shouldEnd = true;
          reason = "all_dead";
        }
        break;
      }

      case GAME_MODES.TIMED:
        if (total > 0 && alive <= 1) {
          shouldEnd = true;
          reason = alive === 1 ? "winner" : "all_dead";
        }
        break;
    }

    if (shouldEnd) this._endGame(reason);
  }

  _endGame(reason) {
    if (this.state === ROOM_STATES.ENDED) return;

    this.state = ROOM_STATES.ENDED;
    this.endedAt = Date.now();

    // Clear loops
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    if (this._timedGameTimeout) {
      clearTimeout(this._timedGameTimeout);
      this._timedGameTimeout = null;
    }

    const standings = this.engine ? this.engine.getStandings() : [];
    const winner = standings.length > 0 ? standings[0] : null;
    const duration = this.startedAt
      ? Math.floor((Date.now() - this.startedAt) / 1000)
      : 0;

    const gameOverData = {
      reason,
      standings,
      winner: winner
        ? {
            id: winner.id,
            username: winner.username,
            score: winner.score,
            color: winner.color,
          }
        : null,
      duration,
      round: this.roundNumber,
    };

    this.broadcast({
      type: "game_over",
      ...gameOverData,
    });

    // Fire the external callback (DB recording hook)
    if (typeof this.onGameOver === "function") {
      try {
        this.onGameOver(this, gameOverData);
      } catch (err) {
        console.error("[Room] onGameOver callback error:", err);
      }
    }

    // Reset player flags so they're ready for next round
    for (const player of this.players.values()) {
      player.alive = false;
      player.spectating = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Game input
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle angle-based input (continuous movement).
   * @param {string} playerId
   * @param {number} angle – target heading in radians
   * @param {boolean} boosting
   */
  handleInput(playerId, angle, boosting) {
    if (this.state !== ROOM_STATES.PLAYING || !this.engine) return;
    this.engine.queueInput(playerId, angle, boosting);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Full game state (for resync on reconnect)
  // ═══════════════════════════════════════════════════════════════════════════

  getFullGameState() {
    if (!this.engine) return null;
    return {
      state: this.engine.getFullState(),
      leaderboard: this.engine.getLeaderboard(),
      events: this.recentEvents.slice(-20),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Broadcasting
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send data to every player in the room, optionally excluding one id.
   */
  broadcast(data, excludeId = null) {
    for (const [id, player] of this.players) {
      if (id !== excludeId) {
        player.send(data);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Cleanup
  // ═══════════════════════════════════════════════════════════════════════════

  destroy() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    if (this._countdownInterval) {
      clearInterval(this._countdownInterval);
      this._countdownInterval = null;
    }
    if (this._timedGameTimeout) {
      clearTimeout(this._timedGameTimeout);
      this._timedGameTimeout = null;
    }
    for (const player of this.players.values()) {
      if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
      }
    }
    this.engine = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Serialization
  // ═══════════════════════════════════════════════════════════════════════════

  /** Public room info (for room view / lobby list detail). */
  toPublic() {
    const players = [];
    for (const p of this.players.values()) {
      players.push(p.toPublic());
    }

    return {
      id: this.id,
      name: this.name,
      creatorId: this.creatorId,
      creatorName: this.creatorName,
      state: this.state,
      gridPreset: this.gridPreset,
      gridSize: this.worldSize,
      worldSize: this.worldSize,
      maxPlayers: this.maxPlayers,
      mode: this.mode,
      players,
      playerCount: this.players.size,
      roundNumber: this.roundNumber,
      createdAt: this.createdAt,
    };
  }

  /** Compact entry for room list in lobby. */
  toListEntry() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      gridPreset: this.gridPreset,
      mode: this.mode,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
      creatorName: this.creatorName,
      roundNumber: this.roundNumber,
    };
  }
}

module.exports = Room;
