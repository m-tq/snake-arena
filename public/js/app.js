// app.js — Main application controller for Snake Arena
// Initializes all modules, handles screen flow, processes WebSocket messages,
// coordinates game state between Network, Renderer, Input, and UI.

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  //  App State
  // ═══════════════════════════════════════════════════════════════════════════

  const App = {
    // Player profile
    playerId: null,
    sessionToken: null,
    username: "",
    color: "#3A4DFF",
    pattern: "classic",

    // Room state
    currentRoom: null, // room public data from server
    inGame: false,

    // Config from server
    serverConfig: null,

    // Default fallback config
    defaultColors: [
      "#EF4444",
      "#F97316",
      "#EAB308",
      "#22C55E",
      "#14B8A6",
      "#3B82F6",
      "#8B5CF6",
      "#EC4899",
      "#F43F5E",
      "#06B6D4",
    ],
    defaultPatterns: [
      { id: "classic", label: "Classic" },
      { id: "striped", label: "Striped" },
      { id: "neon", label: "Neon Glow" },
      { id: "gradient", label: "Gradient" },
      { id: "candy", label: "Candy" },
      { id: "rainbow", label: "Rainbow" },
      { id: "galaxy", label: "Galaxy" },
      { id: "fire", label: "Fire" },
    ],

    // Create room form state
    selectedGridSize: "medium",
    selectedMode: "last_standing",
    selectedTimedDuration: 180,

    // Lobby tab state
    lobbyTab: "create", // 'create' | 'leaderboard' | 'my-stats'

    // Game state tracking
    lastGameState: null,
    mySnakeAlive: false,

    // My stats from DB (received from server on profile_set)
    myStats: null,

    // Whether we already attempted auto-enter on WS open
    _autoEnterAttempted: false,
    // Whether the user explicitly clicked "Enter Arena"
    _enterClicked: false,
    // Whether we are currently in the "entering arena" flow (waiting for profile_set)
    _enteringArena: false,
    // Timeout handle for enter arena flow recovery
    _enterTimeout: null,
    // How many times we've retried sending set_profile
    _enterRetries: 0,

    // Server hello handshake (proves bidirectional WS before sending profile)
    _helloReceived: false,
    _helloTimeout: null,
    _helloRetryTimer: null,
    _helloRetryCount: 0,

    // Room polling
    _roomPollInterval: null,

    // ═════════════════════════════════════════════════════════════════════════
    //  Initialization
    // ═════════════════════════════════════════════════════════════════════════

    init() {
      console.log("[App] Initializing Snake Arena...");

      // Load saved profile
      this._loadProfile();

      // Init UI module
      UI.init();

      // Init renderer
      Renderer.init("game-canvas");
      Renderer.setTheme(UI.isDark);

      // Init input handler (angle-based for continuous movement)
      SnakeInput.init((angle, boosting) => {
        if (this.inGame && this.mySnakeAlive) {
          Network.send({ type: "input", angle, boosting });
        }
      });

      // Fetch server config
      this._fetchConfig();

      // Bind all UI event handlers
      this._bindWelcomeScreen();
      this._bindLobbyScreen();
      this._bindRoomScreen();
      this._bindGameScreen();
      this._bindNavigation();
      this._bindLobbyTabs();
      this._bindJoinByCode();

      // Connect to WebSocket
      this._setupNetwork();

      // Show welcome screen
      UI.showScreen("screen-welcome");
      this._updateWelcomeConnectionStatus("connecting");

      console.log("[App] Initialization complete");
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Server Config
    // ═════════════════════════════════════════════════════════════════════════

    async _fetchConfig() {
      try {
        const res = await fetch("/api/config");
        if (res.ok) {
          this.serverConfig = await res.json();
          console.log("[App] Server config loaded:", this.serverConfig);
        }
      } catch (err) {
        console.warn(
          "[App] Failed to fetch server config, using defaults:",
          err,
        );
      }

      // Apply config to welcome screen
      const colors = this.serverConfig?.colors || this.defaultColors;
      const patterns = this.serverConfig?.patterns || this.defaultPatterns;

      // Update max players slider from server config
      const maxPlayersPerRoom = this.serverConfig?.maxPlayersPerRoom || 50;
      const maxPlayersInput = document.getElementById("input-max-players");
      if (maxPlayersInput) {
        maxPlayersInput.max = maxPlayersPerRoom;
      }

      // Pick a random color if not already set or if saved color is not valid hex
      const hexRe = /^#[0-9A-Fa-f]{6}$/;
      if (!this.color || !hexRe.test(this.color)) {
        this.color = colors[Math.floor(Math.random() * colors.length)];
      }

      UI.renderColorPicker(colors, this.color, (c) => {
        this.color = c;
        this._saveProfile();
        UI.renderSnakePreview(this.color, this.pattern);
      });

      UI.renderPatternPicker(patterns, this.pattern, (p) => {
        this.pattern = p;
        this._saveProfile();
        UI.renderSnakePreview(this.color, this.pattern);
      });

      UI.renderSnakePreview(this.color, this.pattern);

      // Pre-fill username if saved — IMPORTANT: set input value AND this.username
      const usernameInput = document.getElementById("input-username");
      if (usernameInput && this.username) {
        usernameInput.value = this.username;
      }

      // Enable enter button if connected (may already be connected by now)
      this._updateEnterButton();
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Network Setup
    // ═════════════════════════════════════════════════════════════════════════

    _setupNetwork() {
      const net = Network;

      // Connection events
      net.on("open", () => {
        console.log("[App] WebSocket connected, waiting for server hello...");
        this._helloReceived = false;
        UI.setConnectionStatus("connecting");
        this._updateWelcomeConnectionStatus("connecting");

        // If the server doesn't send a hello within 4s, the client is
        // likely connected to a stale / dead process on this port.
        if (this._helloTimeout) clearTimeout(this._helloTimeout);
        this._helloTimeout = setTimeout(() => {
          if (!this._helloReceived) {
            if (Network.isConnected) {
              console.warn(
                "[App] No hello from server — continuing with open socket",
              );
              this._helloReceived = true;
              if (this._helloRetryTimer) {
                clearInterval(this._helloRetryTimer);
                this._helloRetryTimer = null;
              }
              UI.setConnectionStatus("connected");
              UI.setWelcomeError(null);
              this._updateWelcomeConnectionStatus("connected");
              this._updateEnterButton();
              return;
            }
            console.error(
              "[App] No hello from server — stale process? Forcing reconnect...",
            );
            UI.setWelcomeError(
              "Server not responding. Make sure the server is restarted, then refresh. Try to hard refresh browser by Ctrl + Shift + R",
            );
            this._cancelEnterFlow();
            Network.reconnect();
          }
        }, 4000);

        if (this._helloRetryTimer) {
          clearInterval(this._helloRetryTimer);
          this._helloRetryTimer = null;
        }
        this._helloRetryCount = 0;
        net.send({ type: "hello" });
        this._helloRetryTimer = setInterval(() => {
          if (this._helloReceived || !Network.isConnected) {
            clearInterval(this._helloRetryTimer);
            this._helloRetryTimer = null;
            return;
          }
          if (this._helloRetryCount >= 3) {
            clearInterval(this._helloRetryTimer);
            this._helloRetryTimer = null;
            return;
          }
          this._helloRetryCount += 1;
          net.send({ type: "hello" });
        }, 1000);

        if (this._enteringArena) {
          this._sendProfileAndWait();
        }
      });

      // ── Server hello — confirms bidirectional WS is working ────────
      net.on("hello", () => {
        console.log("[App] Server hello received — connection verified");
        this._helloReceived = true;
        if (this._helloTimeout) {
          clearTimeout(this._helloTimeout);
          this._helloTimeout = null;
        }
        if (this._helloRetryTimer) {
          clearInterval(this._helloRetryTimer);
          this._helloRetryTimer = null;
        }
        UI.setConnectionStatus("connected");
        UI.setWelcomeError(null);

        // ── Auto-Enter logic ───────────────────────────────────────────
        // If user has a saved profile with a username, auto-send set_profile
        // so they skip the welcome screen on refresh/reconnect.
        if (this.username && this.username.trim().length > 0) {
          if (!this._autoEnterAttempted) {
            this._autoEnterAttempted = true;
            console.log(
              "[App] Auto-entering arena with saved profile:",
              this.username,
            );
            this._updateWelcomeConnectionStatus("entering");
            this._doEnterArena();
          } else if (this.playerId && this.sessionToken) {
            // Subsequent reconnect: just re-set profile
            this._updateWelcomeConnectionStatus("connected");
            net.send({
              type: "set_profile",
              playerId: this.playerId,
              sessionToken: this.sessionToken,
              username: this.username,
              pattern: this.pattern,
              color: this.color,
            });
          } else {
            this._updateWelcomeConnectionStatus("connected");
            this._updateEnterButton();
          }
        } else {
          // No saved username — just show connected, let user type name
          this._updateWelcomeConnectionStatus("connected");
          this._updateEnterButton();
        }
      });

      net.on("close", () => {
        UI.setConnectionStatus("disconnected");
        this._updateWelcomeConnectionStatus("disconnected");

        // Clear hello handshake state
        this._helloReceived = false;
        if (this._helloTimeout) {
          clearTimeout(this._helloTimeout);
          this._helloTimeout = null;
        }
        if (this._helloRetryTimer) {
          clearInterval(this._helloRetryTimer);
          this._helloRetryTimer = null;
        }

        // Cancel enter flow if in progress
        if (this._enteringArena) {
          this._enterRetries = 0;
          if (this._enterTimeout) {
            clearTimeout(this._enterTimeout);
            this._enterTimeout = null;
          }
          this._setEnterButtonLoading(true, "Reconnecting...");
        }

        // Always allow auto-enter to fire again on the next reconnect,
        // even if the enter flow already failed (3 attempts exhausted)
        // before the connection dropped.
        this._autoEnterAttempted = false;

        this._updateEnterButton();
      });

      net.on("reconnecting", (data) => {
        UI.setConnectionStatus("reconnecting");
        this._updateWelcomeConnectionStatus("connecting");

        if (this._enteringArena) {
          this._enterRetries = 0;
          if (this._enterTimeout) {
            clearTimeout(this._enterTimeout);
            this._enterTimeout = null;
          }
          this._setEnterButtonLoading(true, "Reconnecting...");
        }

        // Always allow auto-enter on next successful connection
        this._autoEnterAttempted = false;

        UI.toast(`Reconnecting... (attempt #${data.attempt})`, "info", 2000);
      });

      // ws_error = low-level WebSocket error (always followed by "close" event)
      // The "close" handler above already cancels enter flow & updates UI,
      // so we only log here to avoid double-cancellation.
      net.on("ws_error", () => {
        console.warn("[App] WebSocket error (close event will follow)");
      });

      net.on("pong", (data) => {
        if (!this._helloReceived) {
          this._helloReceived = true;
          if (this._helloTimeout) {
            clearTimeout(this._helloTimeout);
            this._helloTimeout = null;
          }
          if (this._helloRetryTimer) {
            clearInterval(this._helloRetryTimer);
            this._helloRetryTimer = null;
          }
          UI.setConnectionStatus("connected");
          UI.setWelcomeError(null);
          this._updateWelcomeConnectionStatus("connected");
          this._updateEnterButton();
        }
        UI.updatePing(data.latency);
      });

      // ── Server message handlers ──────────────────────────────────────────

      net.on("profile_set", (msg) => this._onProfileSet(msg));
      net.on("my_stats", (msg) => this._onMyStats(msg));
      net.on("global_leaderboard", (msg) => this._onGlobalLeaderboard(msg));
      net.on("room_list", (msg) => this._onRoomList(msg));
      net.on("room_joined", (msg) => this._onRoomJoined(msg));
      net.on("room_left", () => this._onRoomLeft());
      net.on("player_joined", (msg) => this._onPlayerJoined(msg));
      net.on("player_left", (msg) => this._onPlayerLeft(msg));
      net.on("room_creator_changed", (msg) => this._onCreatorChanged(msg));
      net.on("player_disconnected", (msg) => this._onPlayerDisconnected(msg));
      net.on("player_reconnected", (msg) => this._onPlayerReconnected(msg));
      net.on("spectator_joined", (msg) => this._onSpectatorJoined(msg));
      net.on("countdown_start", (msg) => this._onCountdownStart(msg));
      net.on("countdown_tick", (msg) => this._onCountdownTick(msg));
      net.on("game_started", (msg) => this._onGameStarted(msg));
      net.on("game_tick", (msg) => this._onGameTick(msg));
      net.on("game_state", (msg) => this._onGameState(msg));
      net.on("game_over", (msg) => this._onGameOver(msg));
      net.on("room_state", (msg) => this._onRoomState(msg));
      net.on("chat", (msg) => this._onChatMessage(msg));
      // Server-sent {type:"error"} messages — show toast but NEVER cancel enter flow.
      // These are application-level errors (e.g. "Room not found"), not connection errors.
      net.on("error", (msg) => {
        if (msg && msg.message) {
          console.warn("[App] Server error:", msg.message);
          UI.toast(msg.message, "error", 4000);
        }
        if (
          msg &&
          typeof msg.message === "string" &&
          msg.message.toLowerCase().includes("session token")
        ) {
          this.playerId = null;
          this.sessionToken = null;
          this._saveProfile();
          if (Network.isConnected && this.username) {
            Network.send({
              type: "set_profile",
              username: this.username,
              pattern: this.pattern,
              color: this.color,
            });
          }
        }
      });
      net.on("server_shutdown", () => {
        UI.toast("Server is shutting down...", "error", 10000);
      });

      // Connect
      UI.setConnectionStatus("connecting");
      net.connect();
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Message Handlers
    // ═════════════════════════════════════════════════════════════════════════

    _onProfileSet(msg) {
      this.playerId = msg.playerId;
      this.sessionToken = msg.sessionToken || this.sessionToken;
      this.username = msg.username;
      this.color = msg.color;
      this.pattern = msg.pattern;
      Network.playerId = msg.playerId;

      // Store DB stats if sent
      if (msg.stats) {
        this.myStats = msg.stats;
      }

      this._saveProfile();

      // Clear enter flow state
      this._enteringArena = false;
      if (this._enterTimeout) {
        clearTimeout(this._enterTimeout);
        this._enterTimeout = null;
      }

      // Reset enter button to normal state
      this._setEnterButtonLoading(false);

      console.log(`[App] Profile set: ${msg.username} (${msg.playerId})`);

      if (msg.reconnected && this.currentRoom) {
        // Reconnected — server should send room_joined next
        UI.toast("Reconnected!", "success", 2000);
      } else {
        // Go to lobby
        UI.showScreen("screen-lobby");
        UI.setLobbyPlayer(this.username, this.color);

        // Request room list
        Network.send({ type: "get_rooms" });
        this._startRoomPolling();
      }
    },

    _onMyStats(msg) {
      if (msg.player && msg.player.stats) {
        this.myStats = msg.player.stats;
        this._renderMyStatsPanel(msg.player.stats, msg.recentGames || []);
      }
    },

    _onGlobalLeaderboard(msg) {
      this._renderGlobalLeaderboard(msg.leaderboard || [], msg.summary || {});
    },

    _onRoomList(msg) {
      UI.renderRoomList(msg.rooms || [], (roomId) => {
        // Join room on click
        Network.send({ type: "join_room", roomId });
      });

      if (msg.stats) {
        UI.updateLobbyStats(msg.stats);

        // Update the extended stats from DB if available (fetched via REST)
        this._fetchDbSummaryForLobby();
      }
    },

    /**
     * Fetch DB summary stats (total players / total games) via REST API for lobby display.
     */
    async _fetchDbSummaryForLobby() {
      try {
        const res = await fetch("/api/leaderboard?limit=1&mode=all");
        if (res.ok) {
          const data = await res.json();
          if (data.summary) {
            const totalPlayersEl =
              document.getElementById("stat-total-players");
            const totalGamesEl = document.getElementById("stat-total-games");
            if (totalPlayersEl)
              totalPlayersEl.textContent = data.summary.totalPlayers || 0;
            if (totalGamesEl)
              totalGamesEl.textContent = data.summary.totalGames || 0;
          }
        }
      } catch (e) {
        // ignore — non-critical
      }
    },

    _onRoomJoined(msg) {
      this.currentRoom = msg.room;
      this._stopRoomPolling();

      if (msg.room.state === "playing" || msg.room.state === "countdown") {
        // Joined as spectator during active game
        this._enterGameScreen(msg.room);
      } else {
        // Normal join — show room screen
        UI.showScreen("screen-room");
        UI.updateRoomScreen(msg.room, this.playerId);
      }

      if (msg.asSpectator) {
        UI.toast("Joined as spectator", "info", 2000);
      }
      const roomChatStatus = document.getElementById("room-chat-status");
      if (roomChatStatus) roomChatStatus.textContent = msg.room?.name || "Room";
    },

    _onRoomLeft() {
      this.currentRoom = null;
      this.inGame = false;
      this.mySnakeAlive = false;

      Renderer.stop();
      SnakeInput.setEnabled(false);
      this._setGameCursor(false);

      UI.hideCountdown();
      UI.hideDeathOverlay();
      UI.hideGameOver();
      UI.clearKillFeed();
      UI.clearChat();

      UI.showScreen("screen-lobby");
      UI.setLobbyPlayer(this.username, this.color);

      Network.send({ type: "get_rooms" });
      this._startRoomPolling();
    },

    _onPlayerJoined(msg) {
      if (!this.currentRoom) return;

      // Update the player list in the room data
      if (msg.player) {
        const existing = this.currentRoom.players.find(
          (p) => p.id === msg.player.id,
        );
        if (!existing) {
          this.currentRoom.players.push(msg.player);
        }
        this.currentRoom.playerCount =
          msg.playerCount || this.currentRoom.players.length;
      }

      UI.updateRoomScreen(this.currentRoom, this.playerId);
      UI.toast(`${msg.player?.username || "Someone"} joined`, "info", 2000);
    },

    _onPlayerLeft(msg) {
      if (!this.currentRoom) return;

      this.currentRoom.players = this.currentRoom.players.filter(
        (p) => p.id !== msg.playerId,
      );
      this.currentRoom.playerCount =
        msg.playerCount || this.currentRoom.players.length;

      UI.updateRoomScreen(this.currentRoom, this.playerId);
    },

    _onCreatorChanged(msg) {
      if (!this.currentRoom) return;

      this.currentRoom.creatorId = msg.newCreatorId;
      this.currentRoom.creatorName = msg.newCreatorName;

      // Update the isRoomCreator flags
      this.currentRoom.players.forEach((p) => {
        p.isRoomCreator = p.id === msg.newCreatorId;
      });

      UI.updateRoomScreen(this.currentRoom, this.playerId);
      this._updatePlayAgainButton();

      if (msg.newCreatorId === this.playerId) {
        UI.toast("You are now the room host!", "success", 3000);
      } else {
        UI.toast(`${msg.newCreatorName} is now the host`, "info", 2000);
      }
    },

    _onPlayerDisconnected(msg) {
      if (!this.currentRoom) return;

      const player = this.currentRoom.players.find(
        (p) => p.id === msg.playerId,
      );
      if (player) {
        player.connected = false;
      }

      UI.updateRoomScreen(this.currentRoom, this.playerId);

      if (this.inGame) {
        UI.addKillFeedEntry({
          type: "death",
          username: msg.username || "???",
          cause: "disconnected",
          color: player?.color || "#888",
        });
      }
    },

    _onPlayerReconnected(msg) {
      if (!this.currentRoom) return;

      const player = this.currentRoom.players.find(
        (p) => p.id === msg.playerId,
      );
      if (player) {
        player.connected = true;
      }

      UI.updateRoomScreen(this.currentRoom, this.playerId);
    },

    _onSpectatorJoined(msg) {
      // A spectator joined while the game is playing
      if (msg.player) {
        UI.toast(
          `${msg.player.username || "Someone"} is spectating`,
          "info",
          2000,
        );
      }
    },

    // ── Countdown ──────────────────────────────────────────────────────────

    _onCountdownStart(msg) {
      if (!this.currentRoom) return;

      this.currentRoom.state = "countdown";
      UI.updateRoomScreen(this.currentRoom, this.playerId);

      // Switch to game screen if not there yet
      if (UI.currentScreen !== "screen-game") {
        this._enterGameScreen(this.currentRoom);
      }

      UI.showCountdown(msg.seconds);
      UI.toast("Game starting...", "info", 1500);
    },

    _onCountdownTick(msg) {
      if (msg.value > 0) {
        UI.showCountdown(msg.value);
      } else {
        UI.showCountdown(0); // Shows "GO!"
      }
    },

    // ── Game Start ──────────────────────────────────────────────────────────

    _onGameStarted(msg) {
      if (!this.currentRoom) return;

      this.currentRoom.state = "playing";
      this.inGame = true;
      this.mySnakeAlive = true;

      // Apply game state
      const state = msg.state;
      if (state) {
        Renderer.setWorldSize(state.worldSize || state.gridSize);
        Renderer.setGameState(state);
        Renderer.setPlayerId(this.playerId);
        this.lastGameState = state;
      }

      // Enable input
      SnakeInput.setEnabled(true);
      SnakeInput.reset();

      // Set initial angle from the snake's spawn angle
      if (state && state.snakes && state.snakes[this.playerId]) {
        const mySnake = state.snakes[this.playerId];
        if (typeof mySnake.angle === "number") {
          SnakeInput.setCurrentAngle(mySnake.angle);
        }
      }

      // Start renderer
      Renderer.clearEffects();
      Renderer.start();

      // Hide overlays
      UI.hideCountdown();
      UI.hideDeathOverlay();
      UI.hideGameOver();
      UI.clearKillFeed();

      // Update HUD
      this._updateHUD(state);

      // Update leaderboard
      if (msg.leaderboard) {
        UI.renderLeaderboard(msg.leaderboard, this.playerId);
      }

      // Ensure we're on the game screen
      if (UI.currentScreen !== "screen-game") {
        UI.showScreen("screen-game");
      }

      console.log(
        "[App] Game started! Mode:",
        msg.gameMode,
        "Round:",
        msg.round,
      );
    },

    // ── Game Tick ──────────────────────────────────────────────────────────

    _onGameTick(msg) {
      if (!this.inGame) return;

      const state = msg.state;
      if (!state) return;

      // Update renderer
      Renderer.setGameState(state);
      this.lastGameState = state;

      // Update HUD
      this._updateHUD(state);

      // Update leaderboard
      if (msg.leaderboard) {
        UI.renderLeaderboard(msg.leaderboard, this.playerId);
      }

      // Process events
      if (msg.events && msg.events.length > 0) {
        this._processGameEvents(msg.events, state);
      }

      // Check if my snake is still alive
      const mySnake = state.snakes ? state.snakes[this.playerId] : null;
      if (mySnake) {
        // Update input's current angle
        if (mySnake.alive && typeof mySnake.angle === "number") {
          SnakeInput.setCurrentAngle(mySnake.angle);
        }

        // Detect my death
        if (this.mySnakeAlive && !mySnake.alive) {
          this.mySnakeAlive = false;
          SnakeInput.setEnabled(false);

          const cause = mySnake.deathCause || "unknown";
          const score = mySnake.score || 0;
          UI.showDeathOverlay(cause, score);

          // Death effect
          if (mySnake.segments && mySnake.segments.length > 0) {
            const head = mySnake.segments[0];
            Renderer.spawnDeathEffect(head.x, head.y, mySnake.color, true);
          }
        }
      }
    },

    // ── Full Game State (resync / spectator join) ──────────────────────────

    _onGameState(msg) {
      const state = msg.state;
      if (!state) return;

      // If we weren't in game yet, set up
      if (!this.inGame && this.currentRoom) {
        this.inGame = true;
        this.currentRoom.state = "playing";

        Renderer.setWorldSize(state.worldSize || state.gridSize);
        Renderer.setPlayerId(this.playerId);
        Renderer.clearEffects();
        Renderer.start();
        this._setGameCursor(true);

        if (UI.currentScreen !== "screen-game") {
          UI.showScreen("screen-game");
        }
      }

      Renderer.setGameState(state);
      this.lastGameState = state;
      this._updateHUD(state);

      if (msg.leaderboard) {
        UI.renderLeaderboard(msg.leaderboard, this.playerId);
      }

      // Check if we're alive or spectating
      const mySnake = state.snakes ? state.snakes[this.playerId] : null;
      if (mySnake && mySnake.alive) {
        this.mySnakeAlive = true;
        SnakeInput.setEnabled(true);
        if (typeof mySnake.angle === "number") {
          SnakeInput.setCurrentAngle(mySnake.angle);
        }
        UI.hideDeathOverlay();
      } else {
        this.mySnakeAlive = false;
        SnakeInput.setEnabled(false);
      }
    },

    // ── Game Over ──────────────────────────────────────────────────────────

    _onGameOver(msg) {
      this.inGame = false;
      this.mySnakeAlive = false;
      SnakeInput.setEnabled(false);
      this._setGameCursor(false);

      if (this.currentRoom) {
        this.currentRoom.state = "ended";
      }

      // Show game over overlay
      UI.showGameOver({
        reason: msg.reason,
        standings: msg.standings,
        winner: msg.winner,
        duration: msg.duration,
        round: msg.round,
        myPlayerId: this.playerId,
      });
      this._updatePlayAgainButton();

      // Stop renderer after a short delay (let final frame render)
      setTimeout(() => {
        Renderer.stop();
      }, 500);

      console.log(
        "[App] Game over:",
        msg.reason,
        "Winner:",
        msg.winner?.username,
      );
    },

    _updatePlayAgainButton() {
      const playAgainBtn = document.getElementById("btn-play-again");
      if (!playAgainBtn) return;

      const isHost =
        this.currentRoom && this.currentRoom.creatorId === this.playerId;

      playAgainBtn.disabled = !isHost;
      playAgainBtn.classList.toggle("hidden", !isHost);
    },

    _setGameCursor(enabled) {
      const canvas = document.getElementById("game-canvas");
      const container = document.getElementById("game-canvas-container");
      const cursorDefault = "default";

      if (!enabled) {
        if (canvas) canvas.style.cursor = cursorDefault;
        if (container) container.style.cursor = cursorDefault;
        return;
      }

      const color = this.color || "#3A4DFF";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="${color}"><path d="M3 2l7 18 2-7 7-2L3 2z"/></svg>`;
      const cursorUrl = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 2 2, auto`;

      if (canvas) canvas.style.cursor = cursorUrl;
      if (container) container.style.cursor = cursorUrl;
    },

    // ── Room State Update ──────────────────────────────────────────────────

    _onRoomState(msg) {
      if (msg.room) {
        this.currentRoom = msg.room;
        UI.updateRoomScreen(msg.room, this.playerId);
        this._updatePlayAgainButton();
        const roomChatStatus = document.getElementById("room-chat-status");
        if (roomChatStatus)
          roomChatStatus.textContent = msg.room?.name || "Room";
      }
    },

    _onChatMessage(msg) {
      if (!msg || !msg.text) return;
      UI.addChatMessage(msg);
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Game Event Processing
    // ═════════════════════════════════════════════════════════════════════════

    _processGameEvents(events, state) {
      for (const evt of events) {
        switch (evt.type) {
          case "eat": {
            // Food pickup — spawn particles at world position
            if (evt.food) {
              const color = evt.food.type === "bonus" ? "#FACC15" : "#22C55E";
              Renderer.spawnParticles(evt.food.x, evt.food.y, color, 4);

              // Score popup for local player
              if (evt.playerId === this.playerId) {
                Renderer.spawnFloatingText(
                  evt.food.x,
                  evt.food.y,
                  `+${evt.points || 10}`,
                  color,
                );
              }
            }
            break;
          }

          case "death": {
            // Death event — show in kill feed
            UI.addKillFeedEntry(evt);

            // Death visual effect
            const deadSnake = state.snakes ? state.snakes[evt.playerId] : null;
            if (
              deadSnake &&
              deadSnake.segments &&
              deadSnake.segments.length > 0
            ) {
              const head = deadSnake.segments[0];
              const isMe = evt.playerId === this.playerId;
              Renderer.spawnDeathEffect(
                head.x,
                head.y,
                deadSnake.color || evt.color || "#EF4444",
                isMe,
              );
            }
            break;
          }

          case "kill": {
            // Kill event — show in kill feed
            const killerSnake = state.snakes
              ? state.snakes[evt.killerId]
              : null;
            const victimSnake = state.snakes
              ? state.snakes[evt.victimId]
              : null;

            UI.addKillFeedEntry({
              ...evt,
              killerColor: killerSnake?.color || "#FFF",
              victimColor: victimSnake?.color || "#FFF",
            });

            // Kill bonus popup for local player
            if (evt.killerId === this.playerId) {
              UI.toast(
                `You eliminated ${evt.victimName || "a snake"}! +50`,
                "success",
                2000,
              );
            }
            break;
          }

          case "powerup_pickup": {
            // Powerup pickup visual
            if (evt.playerId === this.playerId) {
              UI.toast(
                `${evt.powerupLabel || evt.powerupType || "Powerup"}!`,
                "success",
                2000,
              );
            }
            break;
          }

          case "powerup_spawn": {
            // Subtle notification that a powerup appeared
            if (evt.powerup) {
              Renderer.spawnParticles(
                evt.powerup.x,
                evt.powerup.y,
                "#C084FC",
                4,
              );
            }
            break;
          }

          // Other events: powerup_expired, powerup_despawn, etc.
          // We don't need to do anything special for these
        }
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  HUD Update
    // ═════════════════════════════════════════════════════════════════════════

    _updateHUD(state) {
      if (!state) return;

      const mySnake = state.snakes ? state.snakes[this.playerId] : null;

      UI.updateHUD({
        roomName: this.currentRoom?.name || "Room",
        score: mySnake ? mySnake.score : 0,
        length: mySnake ? mySnake.length : 0,
        kills: mySnake ? mySnake.kills : 0,
        tick: state.tick || 0,
      });

      // Update HUD powerup badges
      if (mySnake && mySnake.activePowerups) {
        const activePUs = Object.keys(mySnake.activePowerups);
        UI.updateHUDPowerups(activePUs);
      } else {
        UI.updateHUDPowerups([]);
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Screen: Welcome — Bindings
    // ═════════════════════════════════════════════════════════════════════════

    _bindWelcomeScreen() {
      const usernameInput = document.getElementById("input-username");
      const enterBtn = document.getElementById("btn-enter-arena");

      // Username input validation
      if (usernameInput) {
        usernameInput.addEventListener("input", () => {
          this.username = usernameInput.value.trim();
          this._updateEnterButton();
          UI.setWelcomeError(null);
        });

        // Enter on pressing Enter key
        usernameInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (enterBtn && !enterBtn.disabled) {
              enterBtn.click();
            }
          }
        });

        // Auto-focus the username input for immediate typing
        setTimeout(() => {
          if (UI.currentScreen === "screen-welcome" && !this.username) {
            usernameInput.focus();
          }
        }, 500);
      }

      // Enter Arena button
      if (enterBtn) {
        enterBtn.addEventListener("click", () => {
          // Prevent double-click while already entering
          if (this._enteringArena) return;

          this._enterClicked = true;

          const name = (usernameInput?.value || "").trim();
          if (!name) {
            UI.setWelcomeError("Please enter a username");
            return;
          }

          this.username = name;
          UI.setWelcomeError(null);

          if (!Network.isConnected) {
            // Show spinner and attempt to connect — will auto-enter when connected
            this._setEnterButtonLoading(true, "Connecting...");
            this._updateWelcomeConnectionStatus("connecting");
            this._autoEnterAttempted = false; // allow auto-enter once connected
            Network.connect();
            return;
          }

          this._doEnterArena();
        });
      }
    },

    /**
     * Actually send the profile to the server and transition to lobby.
     */
    _doEnterArena() {
      this._enteringArena = true;
      this._enterRetries = 0;
      this._setEnterButtonLoading(true, "Entering Arena...");
      this._updateWelcomeConnectionStatus("entering");
      this._saveProfile();

      // Send profile and start retry loop
      this._sendProfileAndWait();
    },

    /**
     * Send set_profile to the server and schedule a retry if no response.
     * Auto-retries up to 3 times (every 3s). Gives up after that.
     */
    _sendProfileAndWait() {
      if (!this._enteringArena) return;

      const payload = {
        type: "set_profile",
        username: this.username,
        pattern: this.pattern,
        color: this.color,
      };
      if (this.playerId && this.sessionToken) {
        payload.playerId = this.playerId;
        payload.sessionToken = this.sessionToken;
      }

      console.log(
        `[App] Sending set_profile (attempt ${this._enterRetries + 1}/3):`,
        JSON.stringify(payload),
      );

      Network.send(payload);

      // Schedule retry if no profile_set response within 3 seconds
      if (this._enterTimeout) clearTimeout(this._enterTimeout);
      this._enterTimeout = setTimeout(() => {
        if (!this._enteringArena) return;

        this._enterRetries++;

        if (this._enterRetries >= 3) {
          console.error("[App] No profile_set after retries — reconnecting...");
          if (this._enterTimeout) {
            clearTimeout(this._enterTimeout);
            this._enterTimeout = null;
          }
          this._enterRetries = 0;
          this._setEnterButtonLoading(true, "Reconnecting...");
          this._updateWelcomeConnectionStatus("connecting");
          UI.setWelcomeError(
            "Server not responding. Trying to reconnect automatically...",
          );
          Network.reconnect();
          return;
        }

        // Retry if still connected, otherwise cancel
        if (Network.isConnected) {
          console.warn(
            `[App] No profile_set response, retrying (${this._enterRetries}/3)...`,
          );
          this._sendProfileAndWait();
        } else {
          console.warn("[App] Connection lost during enter, cancelling...");
          this._cancelEnterFlow();
        }
      }, 3000);
    },

    /**
     * Cancel the enter flow and reset UI to a usable state.
     */
    _cancelEnterFlow() {
      this._enteringArena = false;
      this._enterRetries = 0;
      if (this._enterTimeout) {
        clearTimeout(this._enterTimeout);
        this._enterTimeout = null;
      }
      this._setEnterButtonLoading(false);

      // Restore connection status based on actual WS state
      if (Network.isConnected) {
        this._updateWelcomeConnectionStatus("connected");
      } else {
        this._updateWelcomeConnectionStatus("disconnected");
      }
    },

    /**
     * Set the enter button to loading/normal state.
     * @param {boolean} loading
     * @param {string} [labelText] — custom label text while loading (default: "Entering Arena...")
     */
    _setEnterButtonLoading(loading, labelText) {
      const btn = document.getElementById("btn-enter-arena");
      if (!btn) return;

      const spinner = btn.querySelector(".enter-spinner");
      const icon = btn.querySelector(".enter-icon");
      const label = document.getElementById("enter-btn-label");

      if (loading) {
        btn.disabled = true;
        if (spinner) spinner.classList.remove("hidden");
        if (icon) icon.classList.add("hidden");
        if (label) label.textContent = labelText || "Entering Arena...";
      } else {
        btn.disabled = false;
        if (spinner) spinner.classList.add("hidden");
        if (icon) icon.classList.remove("hidden");
        if (label) label.textContent = "Enter Arena";
      }
    },

    /**
     * Update the connection status indicator on the welcome screen.
     */
    _updateWelcomeConnectionStatus(status) {
      const dot = document.getElementById("welcome-conn-dot");
      const text = document.getElementById("welcome-conn-text");
      if (!dot || !text) return;

      switch (status) {
        case "connected":
          dot.className = "w-2 h-2 rounded-full bg-green-500";
          text.textContent = "Connected to server";
          text.className = "text-green-500 text-xs";
          break;
        case "entering":
          dot.className = "w-2 h-2 rounded-full bg-green-500 animate-pulse";
          text.textContent = "Entering Arena...";
          text.className = "text-green-500 text-xs";
          break;
        case "connecting":
          dot.className = "w-2 h-2 rounded-full bg-yellow-500 animate-pulse";
          text.textContent = "Connecting to server...";
          text.className = "text-muted-fg text-xs";
          break;
        case "disconnected":
          dot.className = "w-2 h-2 rounded-full bg-red-500";
          text.textContent = "Cannot reach server — check connection";
          text.className = "text-destructive text-xs";
          break;
      }
    },

    _updateEnterButton() {
      const btn = document.getElementById("btn-enter-arena");
      const input = document.getElementById("input-username");
      if (!btn) return;

      // Don't touch the button if we're in the middle of entering
      if (this._enteringArena) return;

      const hasName = (input?.value || "").trim().length > 0;

      // Enable the button as long as the user has typed a name.
      // If WS isn't connected yet, clicking will trigger a connect + queue.
      btn.disabled = !hasName;

      // Also ensure the label/spinner are reset to normal state
      const spinner = btn.querySelector(".enter-spinner");
      const icon = btn.querySelector(".enter-icon");
      const label = document.getElementById("enter-btn-label");
      if (spinner) spinner.classList.add("hidden");
      if (icon) icon.classList.remove("hidden");
      if (label) label.textContent = "Enter Arena";
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Screen: Lobby — Bindings
    // ═════════════════════════════════════════════════════════════════════════

    // ═════════════════════════════════════════════════════════════════════════
    //  Lobby Tabs (Create / Leaderboard / My Stats)
    // ═════════════════════════════════════════════════════════════════════════

    _bindLobbyTabs() {
      const tabs = document.querySelectorAll(".lobby-tab");
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          const tabId = tab.dataset.tab;
          if (!tabId) return;

          this.lobbyTab = tabId;

          // Update tab active states
          tabs.forEach((t) => {
            if (t.dataset.tab === tabId) {
              t.classList.add("text-primary");
              t.classList.remove("text-muted-fg", "border-transparent");
              t.style.borderBottomColor = "hsl(234 100% 61%)";
            } else {
              t.classList.remove("text-primary");
              t.classList.add("text-muted-fg");
              t.style.borderBottomColor = "transparent";
            }
          });

          // Show/hide panels
          const panels = document.querySelectorAll(".lobby-tab-panel");
          panels.forEach((p) => {
            if (p.dataset.panel === tabId) {
              p.classList.remove("hidden");
              p.classList.add("animate-fade-in");
            } else {
              p.classList.add("hidden");
              p.classList.remove("animate-fade-in");
            }
          });

          // Load data for the tab
          if (tabId === "leaderboard") {
            this._loadGlobalLeaderboard();
          } else if (tabId === "my-stats") {
            this._loadMyStats();
          }
        });
      });
    },

    _loadGlobalLeaderboard() {
      const sortEl = document.getElementById("global-lb-sort");
      const modeEl = document.getElementById("global-lb-mode");
      const sortBy = sortEl ? sortEl.value : "totalScore";
      const gameMode = modeEl ? modeEl.value : "last_standing";
      Network.send({
        type: "get_global_leaderboard",
        sortBy,
        limit: 20,
        gameMode,
      });
    },

    _loadMyStats() {
      Network.send({ type: "get_my_stats" });
    },

    _renderGlobalLeaderboard(leaderboard, summary) {
      // Summary
      const els = {
        players: document.getElementById("glb-total-players"),
        games: document.getElementById("glb-total-games"),
        kills: document.getElementById("glb-total-kills"),
        score: document.getElementById("glb-total-score"),
      };
      if (els.players) els.players.textContent = summary.totalPlayers || 0;
      if (els.games) els.games.textContent = summary.totalGames || 0;
      if (els.kills) els.kills.textContent = summary.totalKills || 0;
      if (els.score) els.score.textContent = summary.totalScore || 0;

      const modeEl = document.getElementById("global-lb-mode");
      const titleEl = document.getElementById("global-lb-title");
      const modeLabelMap = {
        last_standing: "Last Standing",
        timed: "Timed",
        free_play: "Free Play",
      };
      if (titleEl) {
        const label =
          modeLabelMap[modeEl ? modeEl.value : "last_standing"] ||
          "Last Standing";
        titleEl.textContent = `${label} Leaderboard`;
      }

      // List
      const listEl = document.getElementById("global-lb-list");
      if (!listEl) return;
      listEl.innerHTML = "";

      if (!leaderboard || leaderboard.length === 0) {
        listEl.innerHTML =
          '<div class="text-xs text-muted-fg text-center py-4">No data yet — play some games!</div>';
        return;
      }

      const sortEl = document.getElementById("global-lb-sort");
      const sortField = sortEl ? sortEl.value : "totalScore";
      const fieldLabels = {
        totalScore: "Score",
        gamesWon: "Wins",
        totalKills: "Kills",
        highestScore: "Best",
        longestSnake: "Length",
        gamesPlayed: "Games",
      };
      const valueLabel = fieldLabels[sortField] || "Value";

      for (const entry of leaderboard) {
        const isMe = entry.playerId === this.playerId;
        const el = document.createElement("div");
        el.className = "lb-entry" + (isMe ? " is-you" : "");
        el.innerHTML = `
          <span class="lb-rank">#${entry.rank}</span>
          <span class="lb-color" style="background-color:${entry.color || "#3A4DFF"}"></span>
          <span class="lb-name">${this._escapeHtml(entry.username || "???")}</span>
          <span class="text-[9px] text-muted-fg">${entry.stats ? entry.stats.gamesPlayed + "G" : ""}</span>
          <span class="lb-score">${entry.value || 0}</span>
        `;
        listEl.appendChild(el);
      }
    },

    _renderMyStatsPanel(stats, recentGames) {
      if (!stats) return;

      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };

      set("ms-games-played", stats.gamesPlayed || 0);
      set("ms-games-won", stats.gamesWon || 0);
      const winRate =
        stats.gamesPlayed > 0
          ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100)
          : 0;
      set("ms-win-rate", winRate + "%");
      set("ms-total-kills", stats.totalKills || 0);
      set("ms-highest-score", stats.highestScore || 0);
      set("ms-longest-snake", stats.longestSnake || 0);
      set("ms-total-score", stats.totalScore || 0);
      set("ms-total-deaths", stats.totalDeaths || 0);
      set("ms-best-rank", stats.bestRank > 0 ? "#" + stats.bestRank : "—");

      // Recent games
      const gamesEl = document.getElementById("my-recent-games");
      if (!gamesEl) return;
      gamesEl.innerHTML = "";

      if (!recentGames || recentGames.length === 0) {
        gamesEl.innerHTML =
          '<div class="text-xs text-muted-fg text-center py-3">No games played yet</div>';
        return;
      }

      for (const game of recentGames) {
        const date = new Date(game.playedAt);
        const timeStr =
          date.toLocaleDateString() +
          " " +
          date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const myEntry = game.players.find((p) => p.playerId === this.playerId);
        const rankStr = myEntry ? `#${myEntry.rank}` : "—";
        const scoreStr = myEntry ? myEntry.score : 0;
        const won = game.winnerId === this.playerId;

        const el = document.createElement("div");
        el.className = "standing-entry";
        if (won) el.style.borderColor = "hsl(45 100% 50% / 0.4)";
        el.innerHTML = `
          <span class="standing-rank">${rankStr}</span>
          <span class="standing-name text-xs">${this._escapeHtml(game.roomName || "Room")}</span>
          <span class="text-[9px] text-muted-fg">${game.playerCount || 0}P</span>
          <span class="text-[9px] text-muted-fg">${timeStr}</span>
          <span class="standing-score">${scoreStr}</span>
          ${won ? '<span class="text-[9px] text-yellow-500 font-bold">WIN</span>' : ""}
        `;
        gamesEl.appendChild(el);
      }
    },

    _escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Join by Room Code
    // ═════════════════════════════════════════════════════════════════════════

    _bindJoinByCode() {
      const input = document.getElementById("input-room-code");
      const btn = document.getElementById("btn-join-by-code");
      const errorEl = document.getElementById("join-code-error");

      if (!input || !btn) return;

      // Auto-uppercase as user types
      input.addEventListener("input", () => {
        input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (errorEl) errorEl.classList.add("hidden");
      });

      // Join on click
      btn.addEventListener("click", () => {
        this._doJoinByCode(input, errorEl);
      });

      // Join on Enter key
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this._doJoinByCode(input, errorEl);
        }
      });
    },

    _doJoinByCode(input, errorEl) {
      const code = (input.value || "").trim().toUpperCase();
      if (!code || code.length < 4) {
        if (errorEl) {
          errorEl.textContent = "Enter a valid room code";
          errorEl.classList.remove("hidden");
        }
        return;
      }

      if (!Network.isConnected) {
        if (errorEl) {
          errorEl.textContent = "Not connected to server";
          errorEl.classList.remove("hidden");
        }
        return;
      }

      if (errorEl) errorEl.classList.add("hidden");

      Network.send({ type: "join_room", roomId: code });
      input.value = "";
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Screen: Lobby — Create Room Form Bindings
    // ═════════════════════════════════════════════════════════════════════════

    _bindLobbyScreen() {
      // Grid size picker
      const gridBtns = document.querySelectorAll(".grid-size-btn");
      gridBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          gridBtns.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.selectedGridSize = btn.dataset.size;
        });
      });

      // Max players slider
      const maxPlayersInput = document.getElementById("input-max-players");
      const maxPlayersValue = document.getElementById("max-players-value");
      if (maxPlayersInput && maxPlayersValue) {
        // Set default value and max from config
        maxPlayersInput.max = this.serverConfig?.maxPlayersPerRoom || 50;
        maxPlayersInput.value = Math.min(
          parseInt(maxPlayersInput.value) || 10,
          parseInt(maxPlayersInput.max),
        );
        maxPlayersValue.textContent = maxPlayersInput.value;
        maxPlayersInput.addEventListener("input", () => {
          maxPlayersValue.textContent = maxPlayersInput.value;
        });
      }

      // Game mode picker
      const modeBtns = document.querySelectorAll(".mode-btn");
      modeBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          modeBtns.forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.selectedMode = btn.dataset.mode;
          updateTimedUi();
        });
      });

      const timedDurationRow = document.getElementById("timed-duration-row");
      const timedDurationInput = document.getElementById("input-timed-duration");
      const timedModeLabel = document.getElementById("timed-mode-label");

      const updateTimedUi = () => {
        const minutes = Math.round(this.selectedTimedDuration / 60);
        if (timedModeLabel) {
          timedModeLabel.textContent = `Timed (${minutes} min)`;
        }
        if (timedDurationRow) {
          timedDurationRow.classList.toggle(
            "hidden",
            this.selectedMode !== "timed",
          );
        }
      };

      if (timedDurationInput) {
        const initialDuration = parseInt(timedDurationInput.value, 10);
        if (!isNaN(initialDuration)) {
          this.selectedTimedDuration = initialDuration;
        }
        timedDurationInput.addEventListener("change", () => {
          const val = parseInt(timedDurationInput.value, 10);
          if (!isNaN(val)) {
            this.selectedTimedDuration = val;
          }
          updateTimedUi();
        });
      }

      updateTimedUi();

      // Global leaderboard sort change
      const globalLbSort = document.getElementById("global-lb-sort");
      if (globalLbSort) {
        globalLbSort.addEventListener("change", () => {
          this._loadGlobalLeaderboard();
        });
      }
      const globalLbMode = document.getElementById("global-lb-mode");
      if (globalLbMode) {
        globalLbMode.addEventListener("change", () => {
          this._loadGlobalLeaderboard();
        });
      }

      // Create room button
      const createBtn = document.getElementById("btn-create-room");
      if (createBtn) {
        createBtn.addEventListener("click", () => {
          const nameInput = document.getElementById("input-room-name");
          const maxPlayers = document.getElementById("input-max-players");

          const roomName =
            (nameInput?.value || "").trim() || `${this.username}'s Room`;

          Network.send({
            type: "create_room",
            name: roomName,
            gridSize: this.selectedGridSize,
            maxPlayers: parseInt(maxPlayers?.value || "6", 10),
            mode: this.selectedMode,
            timedDuration:
              this.selectedMode === "timed"
                ? this.selectedTimedDuration
                : undefined,
          });
        });
      }

      // Show create room panel button (in sidebar)
      const showCreateBtn = document.getElementById("btn-show-create-room");
      if (showCreateBtn) {
        showCreateBtn.addEventListener("click", () => {
          const panel = document.getElementById("create-room-panel");
          if (panel) {
            panel.classList.remove("hidden");
            panel.classList.add("animate-fade-in");
          }
        });
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Screen: Room — Bindings
    // ═════════════════════════════════════════════════════════════════════════

    _bindRoomScreen() {
      // Leave room
      const leaveBtn = document.getElementById("btn-leave-room");
      if (leaveBtn) {
        leaveBtn.addEventListener("click", () => {
          Network.send({ type: "leave_room" });
        });
      }

      // Start game
      const startBtn = document.getElementById("btn-start-game");
      if (startBtn) {
        startBtn.addEventListener("click", () => {
          Network.send({ type: "start_game" });
        });
      }

      const copyBtn = document.getElementById("btn-copy-room-id");
      if (copyBtn) {
        copyBtn.addEventListener("click", async () => {
          const idEl = document.getElementById("room-id-badge");
          const roomId = (idEl?.textContent || "").trim();
          if (!roomId || roomId === "CODE") return;

          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(roomId);
            } else {
              const temp = document.createElement("textarea");
              temp.value = roomId;
              temp.setAttribute("readonly", "");
              temp.style.position = "fixed";
              temp.style.opacity = "0";
              document.body.appendChild(temp);
              temp.select();
              document.execCommand("copy");
              document.body.removeChild(temp);
            }
            UI.toast("Room ID copied", "success", 2000);
          } catch {
            UI.toast("Failed to copy room ID", "error", 2000);
          }
        });
      }

      const chatForm = document.getElementById("room-chat-form");
      const chatInput = document.getElementById("room-chat-input");
      if (chatForm && chatInput) {
        chatForm.addEventListener("submit", (e) => {
          e.preventDefault();
          if (!this.currentRoom) return;
          const text = chatInput.value.replace(/\s+/g, " ").trim();
          if (!text) return;
          Network.send({ type: "chat", text });
          chatInput.value = "";
        });
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Screen: Game — Bindings
    // ═════════════════════════════════════════════════════════════════════════

    _bindGameScreen() {
      // Death overlay: Spectate button (just dismiss the overlay)
      const deathSpectateBtn = document.getElementById("btn-death-spectate");
      if (deathSpectateBtn) {
        deathSpectateBtn.addEventListener("click", () => {
          UI.hideDeathOverlay();
        });
      }

      // Death overlay: Leave button (leave the room)
      const deathLeaveBtn = document.getElementById("btn-death-leave");
      if (deathLeaveBtn) {
        deathLeaveBtn.addEventListener("click", () => {
          UI.hideDeathOverlay();
          UI.hideGameOver();
          UI.clearKillFeed();
          Renderer.stop();
          Renderer.clearEffects();

          this.inGame = false;
          this.mySnakeAlive = false;
          SnakeInput.setEnabled(false);
          this._setGameCursor(false);

          Network.send({ type: "leave_room" });
        });
      }

      // Play Again button (game over overlay)
      const playAgainBtn = document.getElementById("btn-play-again");
      if (playAgainBtn) {
        playAgainBtn.addEventListener("click", () => {
          UI.hideGameOver();
          UI.hideDeathOverlay();
          UI.clearKillFeed();
          Renderer.clearEffects();

          // If we're the creator, start another game
          if (
            this.currentRoom &&
            this.currentRoom.creatorId === this.playerId
          ) {
            Network.send({ type: "start_game" });
          } else {
            // Go back to room view and wait for creator
            UI.showScreen("screen-room");
            if (this.currentRoom) {
              // Request fresh room state
              Network.send({ type: "get_room_state" });
            }
          }
        });
      }

      // Back to Lobby button (game over overlay)
      const backLobbyBtn = document.getElementById("btn-back-lobby");
      if (backLobbyBtn) {
        backLobbyBtn.addEventListener("click", () => {
          UI.hideGameOver();
          UI.hideDeathOverlay();
          UI.clearKillFeed();
          Renderer.stop();
          Renderer.clearEffects();

          Network.send({ type: "leave_room" });
        });
      }

      const chatForm = document.getElementById("game-chat-form");
      const chatInput = document.getElementById("game-chat-input");
      if (chatForm && chatInput) {
        chatForm.addEventListener("submit", (e) => {
          e.preventDefault();
          if (!this.currentRoom) return;
          const text = chatInput.value.replace(/\s+/g, " ").trim();
          if (!text) return;
          Network.send({ type: "chat", text });
          chatInput.value = "";
        });
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Navigation Bindings (header nav buttons)
    // ═════════════════════════════════════════════════════════════════════════

    _bindNavigation() {
      const navLobby = document.getElementById("nav-lobby");
      const navRoom = document.getElementById("nav-room");

      if (navLobby) {
        navLobby.addEventListener("click", () => {
          // If in game, confirm first
          if (this.inGame) {
            if (!confirm("Leave the current game and go back to lobby?")) {
              return;
            }
          }

          UI.hideGameOver();
          UI.hideDeathOverlay();
          UI.clearKillFeed();
          Renderer.stop();
          Renderer.clearEffects();

          this.inGame = false;
          this.mySnakeAlive = false;
          SnakeInput.setEnabled(false);

          Network.send({ type: "leave_room" });
        });
      }

      if (navRoom) {
        navRoom.addEventListener("click", () => {
          if (this.inGame && this.currentRoom) {
            // Go back to room screen (leave game view but stay in room)
            UI.hideGameOver();
            UI.hideDeathOverlay();
            UI.clearKillFeed();
            Renderer.stop();
            Renderer.clearEffects();

            this.inGame = false;
            this.mySnakeAlive = false;
            SnakeInput.setEnabled(false);
            this._setGameCursor(false);

            UI.showScreen("screen-room");
            Network.send({ type: "get_room_state" });
          }
        });
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Enter Game Screen Helper
    // ═════════════════════════════════════════════════════════════════════════

    _enterGameScreen(room) {
      UI.showScreen("screen-game");
      this._setGameCursor(true);

      // Set up HUD
      UI.updateHUD({
        roomName: room.name || "Room",
        score: 0,
        length: 3,
        kills: 0,
        tick: 0,
      });

      // Ensure leaderboard panel is visible
      UI.leaderboardOpen = true;
      const panel = document.getElementById("leaderboard-panel");
      if (panel) panel.setAttribute("data-open", "true");

      // Clear previous state
      UI.hideCountdown();
      UI.hideDeathOverlay();
      UI.hideGameOver();
      UI.clearKillFeed();
      UI.clearChat();
      Renderer.clearEffects();

      // Set world size from room data
      if (room.worldSize || room.gridSize) {
        Renderer.setWorldSize(room.worldSize || room.gridSize);
      }

      Renderer.setPlayerId(this.playerId);
      Renderer.setTheme(UI.isDark);
      const chatStatus = document.getElementById("game-chat-status");
      if (chatStatus) chatStatus.textContent = room.name || "Room";
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Room Polling (periodic refresh of room list while in lobby)
    // ═════════════════════════════════════════════════════════════════════════

    _startRoomPolling() {
      this._stopRoomPolling();

      this._roomPollInterval = setInterval(() => {
        if (
          UI.currentScreen === "screen-lobby" &&
          Network.isConnected &&
          !this.currentRoom
        ) {
          Network.send({ type: "get_rooms" });
        }
      }, 5000); // Poll every 5 seconds
    },

    _stopRoomPolling() {
      if (this._roomPollInterval) {
        clearInterval(this._roomPollInterval);
        this._roomPollInterval = null;
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Profile Persistence (localStorage)
    // ═════════════════════════════════════════════════════════════════════════

    _saveProfile() {
      try {
        localStorage.setItem(
          "snake-arena-profile",
          JSON.stringify({
            playerId: this.playerId,
            sessionToken: this.sessionToken,
            username: this.username,
            color: this.color,
            pattern: this.pattern,
          }),
        );
      } catch (e) {
        // localStorage not available
      }
    },

    _loadProfile() {
      try {
        const saved = localStorage.getItem("snake-arena-profile");
        if (saved) {
          const data = JSON.parse(saved);
          if (data.playerId) this.playerId = data.playerId;
          if (data.sessionToken) this.sessionToken = data.sessionToken;
          if (data.username) this.username = data.username;
          if (data.color) this.color = data.color;
          if (data.pattern) this.pattern = data.pattern;
        }
      } catch (e) {
        // localStorage not available or corrupt data
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  Bootstrap — initialize the app when the DOM is ready
  // ═══════════════════════════════════════════════════════════════════════════

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => App.init());
  } else {
    // DOM already loaded
    App.init();
  }

  // Expose for debugging
  window.SnakeApp = App;
})();
