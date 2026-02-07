// ui.js — DOM helpers for Snake Arena
// Screen switching, theme toggle, sidebar/leaderboard toggle, toast notifications,
// room list rendering, player list rendering, leaderboard rendering, kill feed,
// countdown overlay, game-over overlay, HUD updates

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  //  UI Module
  // ═══════════════════════════════════════════════════════════════════════════

  const UI = {
    // Current active screen id
    currentScreen: "screen-welcome",

    // Theme
    isDark: true,

    // Sidebar state
    sidebarOpen: true,
    leaderboardOpen: true,

    // Leaderboard tab
    lbTab: "alive", // 'alive' | 'longest' | 'dead'

    // Kill feed entries
    _killFeedEntries: [],
    _killFeedMax: 6,
    _killFeedTimeouts: [],
    _chatMax: 40,
    chatOpenRoom: true,
    chatOpenGame: true,

    // Countdown state
    _countdownTimer: null,

    // ═════════════════════════════════════════════════════════════════════════
    //  Init
    // ═════════════════════════════════════════════════════════════════════════

    init() {
      this._bindThemeToggle();
      this._bindSidebarToggle();
      this._bindLeaderboardToggle();
      this._bindLeaderboardTabs();
      this._bindChatToggle();
      this._loadTheme();
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Screen Management
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Switch to a screen by id. Hides all others with a smooth transition.
     * @param {string} screenId — e.g. 'screen-welcome', 'screen-lobby', 'screen-room', 'screen-game'
     */
    showScreen(screenId) {
      const screens = document.querySelectorAll(".screen");
      screens.forEach((s) => {
        if (s.id === screenId) {
          s.classList.add("active");
        } else {
          s.classList.remove("active");
        }
      });

      this.currentScreen = screenId;

      // Update header nav visibility
      const navLobby = document.getElementById("nav-lobby");
      const navRoom = document.getElementById("nav-room");
      const headerNav = document.getElementById("header-nav");

      if (navLobby) navLobby.classList.add("hidden");
      if (navRoom) navRoom.classList.add("hidden");

      if (screenId === "screen-room" || screenId === "screen-game") {
        if (navLobby) {
          navLobby.classList.remove("hidden");
          navLobby.classList.add("flex");
        }
        if (headerNav) headerNav.classList.remove("hidden");
      }
      if (screenId === "screen-game") {
        if (navRoom) {
          navRoom.classList.remove("hidden");
          navRoom.classList.add("flex");
        }
      }
      if (screenId === "screen-lobby") {
        if (headerNav) headerNav.classList.remove("hidden");
      }
      if (screenId === "screen-welcome") {
        if (headerNav) headerNav.classList.add("hidden");
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Theme Toggle (Dark / Light)
    // ═════════════════════════════════════════════════════════════════════════

    _bindThemeToggle() {
      const btn = document.getElementById("btn-theme");
      if (!btn) return;

      btn.addEventListener("click", () => {
        this.isDark = !this.isDark;
        this._applyTheme();
        this._saveTheme();
      });
    },

    _applyTheme() {
      const html = document.documentElement;
      if (this.isDark) {
        html.classList.add("dark");
        html.classList.remove("light");
      } else {
        html.classList.remove("dark");
        html.classList.add("light");
      }
      // Notify renderer
      if (window.Renderer) {
        window.Renderer.setTheme(this.isDark);
      }
    },

    _saveTheme() {
      try {
        localStorage.setItem(
          "snake-arena-theme",
          this.isDark ? "dark" : "light",
        );
      } catch (e) {
        // localStorage not available
      }
    },

    _loadTheme() {
      try {
        const saved = localStorage.getItem("snake-arena-theme");
        if (saved === "light") {
          this.isDark = false;
        } else {
          this.isDark = true;
        }
      } catch (e) {
        this.isDark = true;
      }
      this._applyTheme();
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Sidebar Toggle (Lobby room list)
    // ═════════════════════════════════════════════════════════════════════════

    _bindSidebarToggle() {
      const btn = document.getElementById("btn-sidebar-toggle");
      const btnMain = document.getElementById("btn-sidebar-toggle-main");

      const toggleSidebar = () => {
        this.sidebarOpen = !this.sidebarOpen;
        this._applySidebarState();
      };

      if (btn) {
        btn.addEventListener("click", toggleSidebar);
      }

      if (btnMain) {
        btnMain.addEventListener("click", toggleSidebar);
      }
    },

    _applySidebarState() {
      const sidebar = document.getElementById("lobby-sidebar");
      if (!sidebar) return;

      sidebar.setAttribute("data-open", this.sidebarOpen ? "true" : "false");

      // Toggle icons for sidebar button (inside sidebar)
      const iconOpen = sidebar.querySelector(".sidebar-icon-open");
      const iconClosed = sidebar.querySelector(".sidebar-icon-closed");

      if (iconOpen && iconClosed) {
        if (this.sidebarOpen) {
          iconOpen.classList.remove("hidden");
          iconClosed.classList.add("hidden");
        } else {
          iconOpen.classList.add("hidden");
          iconClosed.classList.remove("hidden");
        }
      }

      // Toggle icons for main button (always visible in lobby header)
      const iconOpenMain = document.querySelector(".sidebar-icon-open-main");
      const iconClosedMain = document.querySelector(
        ".sidebar-icon-closed-main",
      );

      if (iconOpenMain && iconClosedMain) {
        if (this.sidebarOpen) {
          iconOpenMain.classList.remove("hidden");
          iconClosedMain.classList.add("hidden");
        } else {
          iconOpenMain.classList.add("hidden");
          iconClosedMain.classList.remove("hidden");
        }
      }

      // Ensure the main toggle button is ALWAYS visible (never hidden with sidebar)
      const btnMain = document.getElementById("btn-sidebar-toggle-main");
      if (btnMain) {
        btnMain.style.display = "flex";
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Leaderboard Toggle (Game screen)
    // ═════════════════════════════════════════════════════════════════════════

    _bindLeaderboardToggle() {
      const btn = document.getElementById("btn-lb-toggle");
      const btnFloat = document.getElementById("btn-lb-toggle-float");

      const toggleLb = () => {
        this.leaderboardOpen = !this.leaderboardOpen;
        this._applyLeaderboardState();
      };

      if (btn) {
        btn.addEventListener("click", toggleLb);
      }
      if (btnFloat) {
        btnFloat.addEventListener("click", toggleLb);
      }
    },

    _applyLeaderboardState() {
      const panel = document.getElementById("leaderboard-panel");
      if (!panel) return;

      panel.setAttribute("data-open", this.leaderboardOpen ? "true" : "false");

      const iconOpen = panel.querySelector(".lb-icon-open");
      const iconClosed = panel.querySelector(".lb-icon-closed");

      if (iconOpen && iconClosed) {
        if (this.leaderboardOpen) {
          iconOpen.classList.remove("hidden");
          iconClosed.classList.add("hidden");
        } else {
          iconOpen.classList.add("hidden");
          iconClosed.classList.remove("hidden");
        }
      }

      // Show/hide the floating toggle button (visible when panel is closed)
      const btnFloat = document.getElementById("btn-lb-toggle-float");
      if (btnFloat) {
        if (this.leaderboardOpen) {
          btnFloat.classList.add("hidden");
        } else {
          btnFloat.classList.remove("hidden");
        }
      }

      if (window.Renderer && typeof window.Renderer.resize === "function") {
        window.requestAnimationFrame(() => {
          window.Renderer.resize();
          setTimeout(() => window.Renderer.resize(), 320);
        });
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Leaderboard Tabs
    // ═════════════════════════════════════════════════════════════════════════

    _bindLeaderboardTabs() {
      const tabs = document.querySelectorAll(".lb-tab");
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          this.lbTab = tab.dataset.tab || "alive";
          this._applyLeaderboardTab();

          // Re-render leaderboard if we have cached data
          if (this._lastLeaderboard) {
            this.renderLeaderboard(this._lastLeaderboard, this._lastMyPlayerId);
          }
        });
      });
    },

    _applyLeaderboardTab() {
      const tabs = document.querySelectorAll(".lb-tab");
      tabs.forEach((tab) => {
        if (tab.dataset.tab === this.lbTab) {
          tab.classList.add("active");
          tab.classList.remove("text-muted-fg", "border-transparent");
          tab.classList.add("text-primary");
          tab.style.borderBottomColor = "hsl(234 100% 61%)";
        } else {
          tab.classList.remove("active", "text-primary");
          tab.classList.add("text-muted-fg");
          tab.style.borderBottomColor = "transparent";
        }
      });
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Connection Status
    // ═════════════════════════════════════════════════════════════════════════

    setConnectionStatus(status) {
      const dot = document.getElementById("conn-dot");
      const text = document.getElementById("conn-text");
      const container = document.getElementById("conn-status");

      if (!dot || !text) return;

      switch (status) {
        case "connected":
          dot.className =
            "w-2 h-2 rounded-full bg-green-500 transition-colors duration-300";
          text.textContent = "Online";
          if (container) container.title = "Connected";
          break;
        case "connecting":
          dot.className =
            "w-2 h-2 rounded-full bg-yellow-500 transition-colors duration-300 animate-pulse";
          text.textContent = "Connecting...";
          if (container) container.title = "Connecting...";
          break;
        case "reconnecting":
          dot.className =
            "w-2 h-2 rounded-full bg-orange-500 transition-colors duration-300 animate-pulse";
          text.textContent = "Reconnecting...";
          if (container) container.title = "Reconnecting...";
          break;
        case "disconnected":
        default:
          dot.className =
            "w-2 h-2 rounded-full bg-red-500 transition-colors duration-300";
          text.textContent = "Offline";
          if (container) container.title = "Disconnected";
          break;
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Ping Display
    // ═════════════════════════════════════════════════════════════════════════

    updatePing(latencyMs) {
      const el = document.getElementById("ping-value");
      if (el) {
        el.textContent =
          latencyMs >= 0 ? `${Math.round(latencyMs)} ms` : "— ms";
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Toast Notifications
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Show a toast notification.
     * @param {string} message
     * @param {'info'|'error'|'success'} [type='info']
     * @param {number} [durationMs=3000]
     */
    toast(message, type, durationMs) {
      type = type || "info";
      durationMs = durationMs || 3000;

      const container = document.getElementById("toast-container");
      if (!container) return;

      const toast = document.createElement("div");
      toast.className = "toast";
      if (type === "error") toast.classList.add("toast-error");
      if (type === "success") toast.classList.add("toast-success");
      toast.textContent = message;

      container.appendChild(toast);

      // Auto-remove
      setTimeout(() => {
        toast.classList.add("toast-exit");
        setTimeout(() => {
          if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
          }
        }, 300);
      }, durationMs);

      // Limit to 5 toasts on screen
      while (container.children.length > 5) {
        container.removeChild(container.firstChild);
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Welcome Screen Helpers
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Populate color swatches.
     * @param {string[]} colors — array of hex colors
     * @param {string} selectedColor
     * @param {function} onSelect — callback(color)
     */
    renderColorPicker(colors, selectedColor, onSelect) {
      const container = document.getElementById("color-picker");
      if (!container) return;
      container.innerHTML = "";

      colors.forEach((color) => {
        const swatch = document.createElement("div");
        swatch.className = "color-swatch";
        swatch.style.backgroundColor = color;
        swatch.style.setProperty("--swatch-color", color);
        if (color === selectedColor) {
          swatch.classList.add("selected");
        }

        swatch.addEventListener("click", () => {
          container
            .querySelectorAll(".color-swatch")
            .forEach((s) => s.classList.remove("selected"));
          swatch.classList.add("selected");
          if (onSelect) onSelect(color);
        });

        container.appendChild(swatch);
      });
    },

    /**
     * Populate pattern buttons.
     * @param {{ id: string, label: string }[]} patterns
     * @param {string} selectedPattern
     * @param {function} onSelect — callback(patternId)
     */
    renderPatternPicker(patterns, selectedPattern, onSelect) {
      const container = document.getElementById("pattern-picker");
      if (!container) return;
      container.innerHTML = "";

      patterns.forEach((p) => {
        const btn = document.createElement("button");
        btn.className = "pattern-btn";
        btn.textContent = p.label;
        btn.dataset.pattern = p.id;
        if (p.id === selectedPattern) {
          btn.classList.add("selected");
        }

        btn.addEventListener("click", () => {
          container
            .querySelectorAll(".pattern-btn")
            .forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
          if (onSelect) onSelect(p.id);
        });

        container.appendChild(btn);
      });
    },

    /**
     * Render a snake preview on the small canvas.
     * @param {string} color
     * @param {string} pattern
     */
    renderSnakePreview(color, pattern) {
      const canvas = document.getElementById("snake-preview-canvas");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const cellSize = Math.floor(h * 0.7);
      const count = Math.floor(w / (cellSize + 2));
      const startX = Math.floor((w - count * (cellSize + 2)) / 2);
      const startY = Math.floor((h - cellSize) / 2);

      for (let i = 0; i < count; i++) {
        const x = startX + i * (cellSize + 2);
        const y = startY;
        const t = i / Math.max(1, count - 1);
        const isHead = i === 0;

        let segColor;

        switch (pattern) {
          case "striped":
            segColor = i % 2 === 0 ? color : this._lighten(color, 40);
            break;
          case "neon":
            segColor = this._darken(color, 30);
            break;
          case "pixel":
            segColor =
              i % 3 === 0
                ? color
                : i % 3 === 1
                  ? this._lighten(color, 20)
                  : this._darken(color, 20);
            break;
          case "gradient":
            segColor = this._lerp(color, this._darken(color, 50), t);
            break;
          case "candy":
            segColor = i % 2 === 0 ? color : this._complementary(color);
            break;
          case "rainbow": {
            const rainbow = [
              "#EF4444",
              "#F97316",
              "#EAB308",
              "#22C55E",
              "#3B82F6",
              "#8B5CF6",
              "#EC4899",
            ];
            segColor = rainbow[i % rainbow.length];
            break;
          }
          case "galaxy": {
            const pulse = 0.5 + Math.sin(i * 0.7) * 0.5;
            segColor = this._lerp(this._darken(color, 40), color, pulse);
            break;
          }
          case "fire": {
            const flame = this._lerp("#FF4500", "#FFD700", 1 - t);
            const flicker = Math.sin(i * 0.9) * 0.1;
            segColor = this._lerp(flame, "#FF0000", Math.max(0, flicker + 0.1));
            break;
          }
          case "classic":
          default:
            segColor = isHead ? this._lighten(color, 15) : color;
            break;
        }

        ctx.fillStyle = segColor;
        ctx.fillRect(x, y, cellSize, cellSize);

        if (pattern === "neon") {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, cellSize, cellSize);
        }

        // Head eyes
        if (isHead) {
          const eyeSize = Math.max(2, Math.floor(cellSize * 0.2));
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(
            x + cellSize * 0.55,
            y + cellSize * 0.2,
            eyeSize,
            eyeSize,
          );
          ctx.fillRect(
            x + cellSize * 0.55,
            y + cellSize * 0.6,
            eyeSize,
            eyeSize,
          );

          ctx.fillStyle = "#111111";
          const pupil = Math.max(1, Math.floor(eyeSize * 0.5));
          ctx.fillRect(x + cellSize * 0.6, y + cellSize * 0.22, pupil, pupil);
          ctx.fillRect(x + cellSize * 0.6, y + cellSize * 0.62, pupil, pupil);
        }
      }
    },

    setEnterButtonEnabled(enabled) {
      const btn = document.getElementById("btn-enter-arena");
      if (btn) btn.disabled = !enabled;
    },

    setWelcomeError(msg) {
      const el = document.getElementById("welcome-error");
      if (!el) return;
      if (msg) {
        el.textContent = msg;
        el.classList.remove("hidden");
      } else {
        el.textContent = "";
        el.classList.add("hidden");
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Lobby Screen
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Update lobby user tag display.
     * @param {string} username
     * @param {string} color
     */
    setLobbyPlayer(username, color) {
      const nameEl = document.getElementById("lobby-username");
      const colorEl = document.getElementById("lobby-player-color");
      if (nameEl) nameEl.textContent = username;
      if (colorEl) colorEl.style.backgroundColor = color;
    },

    /**
     * Render the room list in the sidebar.
     * @param {{ id, name, state, gridPreset, mode, playerCount, maxPlayers, creatorName }[]} rooms
     * @param {function} onJoin — callback(roomId)
     */
    renderRoomList(rooms, onJoin) {
      const listEl = document.getElementById("room-list");
      const loadingEl = document.getElementById("room-list-loading");
      const emptyEl = document.getElementById("room-list-empty");

      if (loadingEl) loadingEl.classList.add("hidden");

      if (!listEl) return;
      listEl.innerHTML = "";

      if (!rooms || rooms.length === 0) {
        if (emptyEl) {
          emptyEl.classList.remove("hidden");
          emptyEl.classList.add("flex");
        }
        return;
      }

      if (emptyEl) {
        emptyEl.classList.add("hidden");
        emptyEl.classList.remove("flex");
      }

      const modeLabels = {
        last_standing: "Last Standing",
        timed: "Timed",
        free_play: "Free Play",
      };

      const stateLabels = {
        waiting: "Waiting",
        countdown: "Starting...",
        playing: "Playing",
        ended: "Ended",
      };

      rooms.forEach((room) => {
        const entry = document.createElement("div");
        entry.className = "room-entry";
        entry.dataset.roomId = room.id;

        const stateClass = "state-" + room.state;
        const stateLabel = stateLabels[room.state] || room.state;
        const modeLabel = modeLabels[room.mode] || room.mode;

        entry.innerHTML = `
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-semibold text-fg truncate flex-1 mr-2">${this._escapeHtml(room.name)}</span>
            <span class="text-[9px] font-medium px-1.5 py-0.5 ${stateClass} shrink-0">${stateLabel}</span>
          </div>
          <div class="flex items-center justify-between text-[10px] text-muted-fg">
            <span>${modeLabel} · ${room.gridPreset || "medium"}</span>
            <span>${room.playerCount}/${room.maxPlayers}</span>
          </div>
          <div class="text-[9px] text-muted-fg mt-0.5">by ${this._escapeHtml(room.creatorName || "???")}</div>
        `;

        entry.addEventListener("click", () => {
          if (typeof onJoin === "function") {
            onJoin(room.id);
          }
        });

        listEl.appendChild(entry);
      });
    },

    /**
     * Update lobby stats display.
     * @param {{ totalRooms, totalPlayers, playingRooms }} stats
     */
    updateLobbyStats(stats) {
      if (!stats) return;
      const roomsEl = document.getElementById("stat-rooms");
      const playersEl = document.getElementById("stat-players");
      const playingEl = document.getElementById("stat-playing");

      if (roomsEl) roomsEl.textContent = stats.totalRooms || 0;
      if (playersEl) playersEl.textContent = stats.totalPlayers || 0;
      if (playingEl) playingEl.textContent = stats.playingRooms || 0;
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Room Screen
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Update the room screen with room info.
     * @param {object} room — room public data
     * @param {string} myPlayerId
     */
    updateRoomScreen(room, myPlayerId) {
      if (!room) return;

      const modeLabels = {
        last_standing: "Last Standing",
        timed: "Timed",
        free_play: "Free Play",
      };
      const stateLabels = {
        waiting: "Waiting",
        countdown: "Starting...",
        playing: "In Game",
        ended: "Ended",
      };

      // Header
      const nameEl = document.getElementById("room-name-display");
      const idBadge = document.getElementById("room-id-badge");
      const modeBadge = document.getElementById("room-mode-badge");
      const gridBadge = document.getElementById("room-grid-badge");

      if (nameEl) nameEl.textContent = room.name;
      if (idBadge) idBadge.textContent = room.id;
      if (modeBadge)
        modeBadge.textContent =
          modeLabels[room.mode || room.gameMode] || room.mode;
      if (gridBadge)
        gridBadge.textContent = (
          room.gridPreset ||
          room.gridSizeKey ||
          "medium"
        ).toUpperCase();

      // Player count
      const countEl = document.getElementById("room-player-count");
      if (countEl)
        countEl.textContent = `${room.playerCount || (room.players ? room.players.length : 0)}/${room.maxPlayers}`;

      // State badge
      const stateBadge = document.getElementById("room-state-badge");
      if (stateBadge) {
        const stateKey = room.state || "waiting";
        stateBadge.textContent = (
          stateLabels[stateKey] || stateKey
        ).toUpperCase();
        stateBadge.className =
          "text-[10px] font-medium px-2 py-0.5 state-" + stateKey;
      }

      // Room info
      const modeInfo = document.getElementById("room-info-mode");
      const gridInfo = document.getElementById("room-info-grid");
      const creatorInfo = document.getElementById("room-info-creator");
      const roundInfo = document.getElementById("room-info-round");

      if (modeInfo)
        modeInfo.textContent = modeLabels[room.mode || room.gameMode] || "—";
      if (gridInfo)
        gridInfo.textContent =
          (room.gridPreset || room.gridSizeKey || "medium") +
          (room.gridSize ? ` (${room.gridSize}×${room.gridSize})` : "");
      if (creatorInfo)
        creatorInfo.textContent =
          room.creatorName ||
          room.players?.find((p) => p.id === room.creatorId)?.username ||
          "—";
      if (roundInfo) roundInfo.textContent = `#${room.roundNumber || 0}`;

      // Player list
      this.renderRoomPlayers(room.players || [], myPlayerId, room.creatorId);

      // Start button visibility
      const btnStart = document.getElementById("btn-start-game");
      const btnStartLabel = document.getElementById("btn-start-game-label");
      const waitingMsg = document.getElementById("room-waiting-msg");
      const isCreator = myPlayerId === room.creatorId;
      const canStart = room.state === "waiting" || room.state === "ended";

      if (btnStart) {
        if (isCreator && canStart) {
          btnStart.classList.remove("hidden");
          btnStart.classList.add("flex");
        } else {
          btnStart.classList.add("hidden");
          btnStart.classList.remove("flex");
        }
      }
      if (btnStartLabel) {
        btnStartLabel.textContent =
          room.state === "ended" ? "Play Again" : "Start Game";
      }

      if (waitingMsg) {
        if (!isCreator && canStart) {
          waitingMsg.classList.remove("hidden");
        } else {
          waitingMsg.classList.add("hidden");
        }
      }
    },

    /**
     * Render the player list inside the room screen.
     * @param {{ id, username, color, pattern, connected, isRoomCreator, spectating }[]} players
     * @param {string} myPlayerId
     * @param {string} creatorId
     */
    renderRoomPlayers(players, myPlayerId, creatorId) {
      const container = document.getElementById("room-player-list");
      if (!container) return;
      container.innerHTML = "";

      if (!players || players.length === 0) {
        container.innerHTML =
          '<div class="text-xs text-muted-fg text-center py-4">No players yet</div>';
        return;
      }

      players.forEach((p) => {
        const entry = document.createElement("div");
        entry.className = "player-entry";

        if (p.id === myPlayerId) entry.classList.add("is-you");
        if (!p.connected) entry.classList.add("player-disconnected");

        const isCreator = p.id === creatorId || p.isRoomCreator;

        let badges = "";
        if (isCreator) {
          badges +=
            '<span class="player-badge bg-primary/10 text-primary">HOST</span>';
        }
        if (p.id === myPlayerId) {
          badges +=
            '<span class="player-badge bg-teal/10 text-teal">YOU</span>';
        }
        if (p.spectating) {
          badges +=
            '<span class="player-badge bg-muted text-muted-fg">SPEC</span>';
        }

        entry.innerHTML = `
          <div class="player-color" style="background-color:${p.color || "#3A4DFF"}"></div>
          <span class="player-name">${this._escapeHtml(p.username || "Anonymous")}</span>
          <span class="text-[9px] text-muted-fg">${p.pattern || "classic"}</span>
          ${badges}
        `;

        container.appendChild(entry);
      });
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Game HUD
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Update the HUD top bar with the current player's stats.
     * @param {object} opts — { roomName, score, length, kills, tick }
     */
    updateHUD(opts) {
      if (!opts) return;

      const elRoom = document.getElementById("hud-room-name");
      const elScore = document.getElementById("hud-score");
      const elLength = document.getElementById("hud-length");
      const elKills = document.getElementById("hud-kills");
      const elTick = document.getElementById("hud-tick");

      if (elRoom && opts.roomName !== undefined)
        elRoom.textContent = opts.roomName;
      if (elScore && opts.score !== undefined) elScore.textContent = opts.score;
      if (elLength && opts.length !== undefined)
        elLength.textContent = opts.length;
      if (elKills && opts.kills !== undefined) elKills.textContent = opts.kills;
      if (elTick && opts.tick !== undefined)
        elTick.textContent = "T:" + opts.tick;
    },

    /**
     * Show active powerup badges in the HUD.
     * @param {string[]} activePowerups — e.g. ['speed', 'shield']
     */
    updateHUDPowerups(activePowerups) {
      const container = document.getElementById("hud-powerups");
      if (!container) return;
      container.innerHTML = "";

      if (!activePowerups || activePowerups.length === 0) return;

      const puInfo = {
        speed: { label: "SPEED", color: "#FACC15", icon: "⚡" },
        shield: { label: "SHIELD", color: "#38BDF8", icon: "🛡" },
        ghost: { label: "GHOST", color: "#C084FC", icon: "👻" },
      };

      activePowerups.forEach((type) => {
        const info = puInfo[type];
        if (!info) return;

        const badge = document.createElement("div");
        badge.className = "powerup-badge";
        badge.style.backgroundColor = info.color + "30";
        badge.style.color = info.color;
        badge.style.borderLeft = `3px solid ${info.color}`;
        badge.innerHTML = `<span>${info.icon}</span><span>${info.label}</span>`;

        container.appendChild(badge);
      });
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Leaderboard
    // ═════════════════════════════════════════════════════════════════════════

    // Cache for re-render on tab switch
    _lastLeaderboard: null,
    _lastMyPlayerId: null,

    /**
     * Render the leaderboard in the game screen sidebar.
     * @param {{ alive: [], dead: [], total: number, aliveCount: number }} lb
     * @param {string} myPlayerId
     */
    renderLeaderboard(lb, myPlayerId) {
      this._lastLeaderboard = lb;
      this._lastMyPlayerId = myPlayerId;

      const listEl = document.getElementById("lb-list");
      const emptyEl = document.getElementById("lb-empty");
      const aliveCountEl = document.getElementById("lb-alive-count");
      const totalCountEl = document.getElementById("lb-total-count");

      if (aliveCountEl) aliveCountEl.textContent = lb.aliveCount || 0;
      if (totalCountEl) totalCountEl.textContent = lb.total || 0;

      if (!listEl) return;
      listEl.innerHTML = "";

      let entries = [];

      switch (this.lbTab) {
        case "alive":
          entries = (lb.alive || []).slice();
          break;
        case "longest":
          entries = [...(lb.alive || []), ...(lb.dead || [])].sort(
            (a, b) => b.length - a.length || b.score - a.score,
          );
          // Re-rank
          entries.forEach((e, i) => (e.rank = i + 1));
          break;
        case "dead":
          entries = (lb.dead || []).slice();
          // Re-rank starting from 1
          entries.forEach((e, i) => (e.rank = i + 1));
          break;
      }

      if (entries.length === 0) {
        if (emptyEl) {
          emptyEl.classList.remove("hidden");
          emptyEl.classList.add("flex");
        }
        return;
      }

      if (emptyEl) {
        emptyEl.classList.add("hidden");
        emptyEl.classList.remove("flex");
      }

      entries.forEach((entry) => {
        const el = document.createElement("div");
        el.className = "lb-entry";
        if (entry.id === myPlayerId) el.classList.add("is-you");
        if (!entry.alive) el.classList.add("is-dead");

        const deathInfo =
          !entry.alive && entry.deathCause
            ? `<span class="text-[9px] text-destructive/60 ml-auto">${this._escapeHtml(entry.deathCause)}</span>`
            : "";

        el.innerHTML = `
          <span class="lb-rank">#${entry.rank}</span>
          <span class="lb-color" style="background-color:${entry.color || "#3A4DFF"}"></span>
          <span class="lb-name">${this._escapeHtml(entry.username || "???")}</span>
          <span class="lb-length">${entry.length || 0}</span>
          <span class="lb-score">${entry.score || 0}</span>
          ${deathInfo}
        `;

        listEl.appendChild(el);
      });
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Kill Feed
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Add a kill/death event to the kill feed.
     * @param {object} event — { type, killerName, victimName, cause, username, color }
     */
    addKillFeedEntry(event) {
      const container = document.getElementById("kill-feed");
      if (!container) return;

      const entry = document.createElement("div");
      entry.className = "kill-feed-entry";

      let text = "";
      if (event.type === "kill") {
        text = `<span style="color:${event.killerColor || "#FFF"}">${this._escapeHtml(event.killerName || "???")}</span> <span class="text-white/40">killed</span> <span style="color:${event.victimColor || "#FFF"}">${this._escapeHtml(event.victimName || "???")}</span>`;
      } else if (event.type === "death") {
        const causeText = {
          wall: "hit a wall",
          self: "bit themselves",
          collision: "was eaten",
          head_collision: "head collision",
        };
        text = `<span style="color:${event.color || "#FFF"}">${this._escapeHtml(event.username || "???")}</span> <span class="text-white/40">${causeText[event.cause] || "died"}</span>`;
      } else {
        return; // Ignore other event types
      }

      entry.innerHTML = text;
      container.appendChild(entry);

      // Limit feed entries
      while (container.children.length > this._killFeedMax) {
        container.removeChild(container.firstChild);
      }

      // Auto-fade after 5 seconds
      const timeout = setTimeout(() => {
        entry.classList.add("fading");
        setTimeout(() => {
          if (entry.parentNode) {
            entry.parentNode.removeChild(entry);
          }
        }, 500);
      }, 5000);

      this._killFeedTimeouts.push(timeout);
    },

    /**
     * Clear all kill feed entries.
     */
    clearKillFeed() {
      const container = document.getElementById("kill-feed");
      if (container) container.innerHTML = "";

      this._killFeedTimeouts.forEach((t) => clearTimeout(t));
      this._killFeedTimeouts = [];
    },

    _bindChatToggle() {
      const btnRoom = document.getElementById("btn-chat-toggle-room");
      if (btnRoom) {
        btnRoom.addEventListener("click", () => {
          this.chatOpenRoom = !this.chatOpenRoom;
          this._applyChatState("room");
        });
      }
      const btnGame = document.getElementById("btn-chat-toggle-game");
      if (btnGame) {
        btnGame.addEventListener("click", () => {
          this.chatOpenGame = !this.chatOpenGame;
          this._applyChatState("game");
        });
      }
      this._applyChatState("room");
      this._applyChatState("game");
    },

    _applyChatState(target) {
      const isRoom = target === "room";
      const open = isRoom ? this.chatOpenRoom : this.chatOpenGame;
      const body = document.getElementById(
        isRoom ? "room-chat-body" : "game-chat-body",
      );
      const btn = document.getElementById(
        isRoom ? "btn-chat-toggle-room" : "btn-chat-toggle-game",
      );
      if (body) body.classList.toggle("hidden", !open);
      if (btn) btn.textContent = open ? "Hide" : "Show";
    },

    _emoticonize(text) {
      if (!text) return "";
      const map = {
        ":-)": "🙂",
        ":)": "🙂",
        ":-D": "😄",
        ":D": "😄",
        ";-)": "😉",
        ";)": "😉",
        ":-(": "🙁",
        ":(": "🙁",
        ":'(": "😢",
        ":P": "😛",
        ":-P": "😛",
        "<3": "❤️",
        ":o": "😮",
        ":O": "😮",
      };
      let out = text;
      Object.keys(map).forEach((k) => {
        out = out.split(k).join(map[k]);
      });
      return out;
    },

    addChatMessage(msg) {
      const name = this._escapeHtml(msg.username || "???");
      const text = this._escapeHtml(this._emoticonize(msg.text || ""));
      const color = msg.color || "#3A4DFF";

      const containers = document.querySelectorAll(
        "#game-chat-messages, #room-chat-messages",
      );
      if (!containers.length) return;

      containers.forEach((container) => {
        const entry = document.createElement("div");
        entry.className = "text-[11px] leading-snug text-white/90";
        entry.innerHTML = `<span style="color:${color}" class="font-semibold">${name}</span> <span class="text-white/40">:</span> <span>${text}</span>`;
        container.appendChild(entry);

        while (container.children.length > this._chatMax) {
          container.removeChild(container.firstChild);
        }

        container.scrollTop = container.scrollHeight;
      });
    },

    clearChat() {
      const containers = document.querySelectorAll(
        "#game-chat-messages, #room-chat-messages",
      );
      containers.forEach((container) => {
        container.innerHTML = "";
      });
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Countdown Overlay
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Show the countdown overlay with a number (3, 2, 1, GO!).
     * @param {number} value — countdown number, 0 means "GO!"
     */
    showCountdown(value) {
      const overlay = document.getElementById("countdown-overlay");
      const numberEl = document.getElementById("countdown-number");
      if (!overlay || !numberEl) return;

      overlay.classList.remove("hidden");

      if (value > 0) {
        numberEl.textContent = value;
        numberEl.className =
          "text-8xl font-bold text-primary animate-countdown-pop drop-shadow-lg";
      } else {
        numberEl.textContent = "GO!";
        numberEl.className = "countdown-go";

        // Hide overlay after GO! animation
        setTimeout(() => {
          overlay.classList.add("hidden");
        }, 700);
      }

      // Force re-trigger animation by cloning
      const parent = numberEl.parentNode;
      const clone = numberEl.cloneNode(true);
      parent.replaceChild(clone, numberEl);
    },

    /**
     * Hide the countdown overlay.
     */
    hideCountdown() {
      const overlay = document.getElementById("countdown-overlay");
      if (overlay) overlay.classList.add("hidden");
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Death Overlay
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Show the death overlay when the local player dies.
     * @param {string} cause
     * @param {number} score
     */
    showDeathOverlay(cause, score) {
      const overlay = document.getElementById("death-overlay");
      const causeEl = document.getElementById("death-cause");
      const scoreEl = document.getElementById("death-score");

      if (!overlay) return;
      overlay.classList.remove("hidden");

      const causeText = {
        wall: "Hit a wall",
        self: "Bit yourself",
        collision: "Crashed into another snake",
        head_collision: "Head-on collision",
      };

      if (causeEl) causeEl.textContent = causeText[cause] || "You died";
      if (scoreEl) {
        const spanEl = scoreEl.querySelector("span");
        if (spanEl) spanEl.textContent = score || 0;
        else
          scoreEl.innerHTML = `Score: <span class="text-primary">${score || 0}</span>`;
      }
    },

    /**
     * Hide the death overlay.
     */
    hideDeathOverlay() {
      const overlay = document.getElementById("death-overlay");
      if (overlay) overlay.classList.add("hidden");
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Game Over Overlay
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Show the game over overlay with standings.
     * @param {object} data — { reason, standings, winner, duration, round }
     */
    showGameOver(data) {
      const overlay = document.getElementById("gameover-overlay");
      if (!overlay) return;
      overlay.classList.remove("hidden");

      // Hide death overlay if showing
      this.hideDeathOverlay();

      // Reason
      const reasonEl = document.getElementById("gameover-reason");
      const reasonText = {
        winner: "We have a winner!",
        draw: "It's a draw!",
        time_up: "Time's up!",
        game_over: "Game Over",
        all_dead: "Everyone died!",
      };
      if (reasonEl)
        reasonEl.textContent =
          reasonText[data.reason] || data.reason || "Game Over";

      // Winner card
      const winnerCard = document.getElementById("gameover-winner");
      if (winnerCard && data.winner) {
        winnerCard.classList.remove("hidden");
        const nameEl = document.getElementById("gameover-winner-name");
        const colorEl = document.getElementById("gameover-winner-color");
        const scoreEl = document.getElementById("gameover-winner-score");

        if (nameEl) nameEl.textContent = data.winner.username || "???";
        if (colorEl)
          colorEl.style.backgroundColor = data.winner.color || "#3A4DFF";
        if (scoreEl) scoreEl.textContent = `Score: ${data.winner.score || 0}`;
      } else if (winnerCard) {
        winnerCard.classList.add("hidden");
      }

      // Standings table
      const standingsEl = document.getElementById("gameover-standings");
      if (standingsEl && data.standings) {
        standingsEl.innerHTML = "";

        data.standings.forEach((s) => {
          const entry = document.createElement("div");
          entry.className = "standing-entry";

          const killsText =
            s.kills > 0 ? `${s.kills} kill${s.kills > 1 ? "s" : ""}` : "";
          const isMe = data.myPlayerId && s.id === data.myPlayerId;
          const youBadge = isMe
            ? '<span class="player-badge bg-teal/10 text-teal">YOU</span>'
            : "";

          entry.innerHTML = `
            <span class="standing-rank">#${s.rank}</span>
            <span class="standing-color" style="background-color:${s.color || "#3A4DFF"}"></span>
            <span class="standing-name">${this._escapeHtml(s.username || "???")}</span>
            ${youBadge}
            <span class="standing-kills">${killsText}</span>
            <span class="standing-score">${s.score || 0}</span>
          `;

          standingsEl.appendChild(entry);
        });
      }

      // Duration
      const durationEl = document.getElementById("gameover-duration");
      if (durationEl && data.duration !== undefined) {
        const mins = Math.floor(data.duration / 60);
        const secs = data.duration % 60;
        durationEl.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
      }

      // Round
      const roundEl = document.getElementById("gameover-round");
      if (roundEl) roundEl.textContent = `#${data.round || 1}`;
    },

    /**
     * Hide the game over overlay.
     */
    hideGameOver() {
      const overlay = document.getElementById("gameover-overlay");
      if (overlay) overlay.classList.add("hidden");
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Color Utility Helpers (simpler versions for preview rendering)
    // ═════════════════════════════════════════════════════════════════════════

    _parseHex(hex) {
      hex = hex.replace("#", "");
      if (hex.length === 3)
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16),
      };
    },

    _toHex(r, g, b) {
      const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
      return (
        "#" +
        c(r).toString(16).padStart(2, "0") +
        c(g).toString(16).padStart(2, "0") +
        c(b).toString(16).padStart(2, "0")
      );
    },

    _lighten(hex, amount) {
      const c = this._parseHex(hex);
      const t = amount / 100;
      return this._toHex(
        c.r + (255 - c.r) * t,
        c.g + (255 - c.g) * t,
        c.b + (255 - c.b) * t,
      );
    },

    _darken(hex, amount) {
      const c = this._parseHex(hex);
      const t = 1 - amount / 100;
      return this._toHex(c.r * t, c.g * t, c.b * t);
    },

    _lerp(hex1, hex2, t) {
      const c1 = this._parseHex(hex1);
      const c2 = this._parseHex(hex2);
      return this._toHex(
        c1.r + (c2.r - c1.r) * t,
        c1.g + (c2.g - c1.g) * t,
        c1.b + (c2.b - c1.b) * t,
      );
    },

    _complementary(hex) {
      const c = this._parseHex(hex);
      return this._toHex(255 - c.r, 255 - c.g, 255 - c.b);
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Escape HTML (XSS prevention)
    // ═════════════════════════════════════════════════════════════════════════

    _escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  Export as global
  // ═══════════════════════════════════════════════════════════════════════════

  window.UI = UI;
})();
