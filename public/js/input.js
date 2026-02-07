// input.js — Mouse, touch, and keyboard input handler for snake.io-style controls
// Sends angle (radians) + boosting state to the network layer

(function () {
  "use strict";

  const Input = {
    enabled: false,
    _onInput: null, // callback(angle, boosting)
    _bound: false,

    // Current input state
    _angle: 0, // current angle in radians (0 = right, PI/2 = down)
    _boosting: false,
    _hasMouseTarget: false,

    // Mouse/touch tracking
    _mouseX: 0,
    _mouseY: 0,
    _canvas: null,
    _canvasRect: null,

    // Keyboard state
    _keysDown: {},
    _keyAngleMode: false, // true when arrow keys are being used instead of mouse

    // Send throttle
    _lastSentAngle: null,
    _lastSentBoosting: null,
    _sendInterval: null,
    _sendRateMs: 50, // send input every 50ms (20 times/sec matches tick rate)

    /**
     * Initialize input handling.
     * @param {function} onInput — called with (angle: number, boosting: boolean)
     */
    init(onInput) {
      this._onInput = onInput;

      if (this._bound) return;
      this._bound = true;

      this._canvas = document.getElementById("game-canvas");

      // ── Mouse movement on canvas ─────────────────────────────────────
      if (this._canvas) {
        this._canvas.addEventListener("mousemove", (e) =>
          this._handleMouseMove(e),
        );
        this._canvas.addEventListener("mousedown", (e) =>
          this._handleMouseDown(e),
        );
        this._canvas.addEventListener("mouseup", (e) => this._handleMouseUp(e));
        this._canvas.addEventListener("contextmenu", (e) => e.preventDefault());

        // Touch events on canvas
        this._canvas.addEventListener(
          "touchstart",
          (e) => this._handleTouchStart(e),
          { passive: false },
        );
        this._canvas.addEventListener(
          "touchmove",
          (e) => this._handleTouchMove(e),
          { passive: false },
        );
        this._canvas.addEventListener(
          "touchend",
          (e) => this._handleTouchEnd(e),
          { passive: false },
        );
      }

      // ── Mouse movement on entire game container ──────────────────────
      const container = document.getElementById("game-canvas-container");
      if (container) {
        container.addEventListener("mousemove", (e) =>
          this._handleMouseMove(e),
        );
        container.addEventListener("mousedown", (e) =>
          this._handleMouseDown(e),
        );
        container.addEventListener("mouseup", (e) => this._handleMouseUp(e));
      }

      // ── Keyboard ─────────────────────────────────────────────────────
      document.addEventListener("keydown", (e) => this._handleKeyDown(e));
      document.addEventListener("keyup", (e) => this._handleKeyUp(e));

      // ── Window blur — release all keys ───────────────────────────────
      window.addEventListener("blur", () => {
        this._keysDown = {};
        this._boosting = false;
        this._keyAngleMode = false;
      });

      // ── Touch D-pad buttons (mobile) ─────────────────────────────────
      const touchBtns = document.querySelectorAll(".touch-btn[data-dir]");
      touchBtns.forEach((btn) => {
        btn.addEventListener(
          "touchstart",
          (e) => {
            e.preventDefault();
            this._handleDpadDirection(btn.dataset.dir);
          },
          { passive: false },
        );
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          this._handleDpadDirection(btn.dataset.dir);
        });
      });

      // ── Boost button (mobile) ────────────────────────────────────────
      const boostBtn = document.getElementById("btn-mobile-boost");
      if (boostBtn) {
        boostBtn.addEventListener(
          "touchstart",
          (e) => {
            e.preventDefault();
            this._boosting = true;
          },
          { passive: false },
        );
        boostBtn.addEventListener(
          "touchend",
          (e) => {
            e.preventDefault();
            this._boosting = false;
          },
          { passive: false },
        );
      }

      // ── Periodic send ────────────────────────────────────────────────
      this._startSendLoop();

      // Cache canvas rect
      this._updateCanvasRect();
      window.addEventListener("resize", () => this._updateCanvasRect());
    },

    /**
     * Enable or disable input dispatching.
     */
    setEnabled(enabled) {
      this.enabled = !!enabled;
      if (!enabled) {
        this._boosting = false;
        this._keysDown = {};
        this._keyAngleMode = false;
      }
    },

    /**
     * Set the current angle (from game state).
     */
    setCurrentAngle(angle) {
      if (typeof angle === "number" && isFinite(angle)) {
        this._angle = angle;
      }
    },

    /**
     * Reset state.
     */
    reset() {
      this._angle = 0;
      this._boosting = false;
      this._hasMouseTarget = false;
      this._keysDown = {};
      this._keyAngleMode = false;
      this._lastSentAngle = null;
      this._lastSentBoosting = null;
    },

    /**
     * Get the canvas center point (where the player's head is rendered).
     */
    getCanvasCenter() {
      if (!this._canvasRect) this._updateCanvasRect();
      if (!this._canvasRect) return { x: 0, y: 0 };
      return {
        x: this._canvasRect.left + this._canvasRect.width / 2,
        y: this._canvasRect.top + this._canvasRect.height / 2,
      };
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Internal: Mouse / Touch handlers
    // ═════════════════════════════════════════════════════════════════════════

    _updateCanvasRect() {
      if (this._canvas) {
        this._canvasRect = this._canvas.getBoundingClientRect();
      }
    },

    _handleMouseMove(e) {
      if (!this.enabled) return;

      this._mouseX = e.clientX;
      this._mouseY = e.clientY;
      this._hasMouseTarget = true;
      this._keyAngleMode = false;

      this._updateAngleFromMouse();
    },

    _handleMouseDown(e) {
      if (!this.enabled) return;

      // Left click or any click = boost
      if (e.button === 0 || e.button === 2) {
        this._boosting = true;
      }

      this._mouseX = e.clientX;
      this._mouseY = e.clientY;
      this._hasMouseTarget = true;
      this._keyAngleMode = false;
      this._updateAngleFromMouse();
    },

    _handleMouseUp(e) {
      if (e.button === 0 || e.button === 2) {
        this._boosting = false;
      }
    },

    _handleTouchStart(e) {
      if (!this.enabled) return;
      e.preventDefault();

      if (e.touches.length > 0) {
        const touch = e.touches[0];
        this._mouseX = touch.clientX;
        this._mouseY = touch.clientY;
        this._hasMouseTarget = true;
        this._keyAngleMode = false;
        this._updateAngleFromMouse();

        // Two-finger touch = boost
        if (e.touches.length >= 2) {
          this._boosting = true;
        }
      }
    },

    _handleTouchMove(e) {
      if (!this.enabled) return;
      e.preventDefault();

      if (e.touches.length > 0) {
        const touch = e.touches[0];
        this._mouseX = touch.clientX;
        this._mouseY = touch.clientY;
        this._hasMouseTarget = true;
        this._updateAngleFromMouse();
      }
    },

    _handleTouchEnd(e) {
      if (!this.enabled) return;
      e.preventDefault();
      if (e.touches.length < 2) {
        this._boosting = false;
      }
    },

    _updateAngleFromMouse() {
      // Calculate angle from canvas center to mouse position
      // The canvas center is where the player's snake head is rendered
      const center = this.getCanvasCenter();
      const dx = this._mouseX - center.x;
      const dy = this._mouseY - center.y;

      // Only update if mouse is far enough from center (deadzone)
      if (dx * dx + dy * dy > 10 * 10) {
        this._angle = Math.atan2(dy, dx);
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Internal: Keyboard handlers
    // ═════════════════════════════════════════════════════════════════════════

    _handleKeyDown(e) {
      if (!this.enabled) return;
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) {
        return;
      }

      const key = e.key;

      // Prevent page scrolling with arrow keys / space
      if (
        key === "ArrowUp" ||
        key === "ArrowDown" ||
        key === "ArrowLeft" ||
        key === "ArrowRight" ||
        key === " "
      ) {
        e.preventDefault();
      }

      this._keysDown[key] = true;

      // Space or Shift = boost
      if (key === " " || key === "Shift") {
        this._boosting = true;
      }

      // Arrow keys or WASD = angle mode
      if (this._isDirectionKey(key)) {
        this._keyAngleMode = true;
        this._updateAngleFromKeys();
      }
    },

    _handleKeyUp(e) {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) {
        return;
      }
      const key = e.key;
      delete this._keysDown[key];

      if (key === " " || key === "Shift") {
        // Only stop boosting if neither space nor shift is held
        if (!this._keysDown[" "] && !this._keysDown["Shift"]) {
          this._boosting = false;
        }
      }

      if (this._isDirectionKey(key)) {
        this._updateAngleFromKeys();
      }
    },

    _isDirectionKey(key) {
      return (
        key === "ArrowUp" ||
        key === "ArrowDown" ||
        key === "ArrowLeft" ||
        key === "ArrowRight" ||
        key === "w" ||
        key === "W" ||
        key === "a" ||
        key === "A" ||
        key === "s" ||
        key === "S" ||
        key === "d" ||
        key === "D"
      );
    },

    _updateAngleFromKeys() {
      let dx = 0;
      let dy = 0;

      // Arrow keys
      if (
        this._keysDown["ArrowLeft"] ||
        this._keysDown["a"] ||
        this._keysDown["A"]
      )
        dx -= 1;
      if (
        this._keysDown["ArrowRight"] ||
        this._keysDown["d"] ||
        this._keysDown["D"]
      )
        dx += 1;
      if (
        this._keysDown["ArrowUp"] ||
        this._keysDown["w"] ||
        this._keysDown["W"]
      )
        dy -= 1;
      if (
        this._keysDown["ArrowDown"] ||
        this._keysDown["s"] ||
        this._keysDown["S"]
      )
        dy += 1;

      if (dx !== 0 || dy !== 0) {
        this._angle = Math.atan2(dy, dx);
        this._keyAngleMode = true;
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Internal: D-pad (mobile) direction handler
    // ═════════════════════════════════════════════════════════════════════════

    _handleDpadDirection(dir) {
      if (!this.enabled) return;

      const dirAngles = {
        right: 0,
        down: Math.PI / 2,
        left: Math.PI,
        up: -Math.PI / 2,
      };

      if (dirAngles[dir] !== undefined) {
        this._angle = dirAngles[dir];
        this._keyAngleMode = true;
        this._dispatch();
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Dispatch — send current angle + boost to callback
    // ═════════════════════════════════════════════════════════════════════════

    _startSendLoop() {
      if (this._sendInterval) return;

      this._sendInterval = setInterval(() => {
        if (!this.enabled) return;
        this._dispatch();
      }, this._sendRateMs);
    },

    _dispatch() {
      if (!this.enabled) return;
      if (typeof this._onInput !== "function") return;

      // Only send if angle or boosting changed
      const angleDiff =
        this._lastSentAngle === null
          ? 1
          : Math.abs(this._angle - this._lastSentAngle);
      const boostChanged = this._lastSentBoosting !== this._boosting;

      if (angleDiff > 0.01 || boostChanged) {
        this._lastSentAngle = this._angle;
        this._lastSentBoosting = this._boosting;
        this._onInput(this._angle, this._boosting);
      }
    },

    /**
     * Clean up intervals.
     */
    destroy() {
      if (this._sendInterval) {
        clearInterval(this._sendInterval);
        this._sendInterval = null;
      }
    },
  };

  // Expose globally
  window.SnakeInput = Input;
})();
