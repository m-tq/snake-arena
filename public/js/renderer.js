// renderer.js — Snake Arena Renderer
// Camera-follow, smooth circle-based snake rendering, minimap, snake.io-style visuals

(function () {
  "use strict";

  // ── Particle effect class ──────────────────────────────────────────────────
  class Particle {
    constructor(x, y, vx, vy, color, life, size) {
      this.x = x;
      this.y = y;
      this.vx = vx;
      this.vy = vy;
      this.color = color;
      this.life = life;
      this.maxLife = life;
      this.size = size;
    }
    update(dt) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      this.vx *= 0.96;
      this.vy *= 0.96;
      this.life -= dt;
      return this.life > 0;
    }
    draw(ctx, cam) {
      const alpha = Math.max(0, this.life / this.maxLife);
      const sx = (this.x - cam.x) * cam.scale + cam.hw;
      const sy = (this.y - cam.y) * cam.scale + cam.hh;
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(sx, sy, this.size * cam.scale * alpha, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // ── Floating text effect class ─────────────────────────────────────────────
  class FloatingText {
    constructor(x, y, text, color) {
      this.x = x;
      this.y = y;
      this.text = text;
      this.color = color;
      this.life = 1.2;
      this.maxLife = 1.2;
      this.vy = -40;
    }
    update(dt) {
      this.y += this.vy * dt;
      this.vy *= 0.95;
      this.life -= dt;
      return this.life > 0;
    }
    draw(ctx, cam) {
      const alpha = Math.max(0, this.life / this.maxLife);
      const sx = (this.x - cam.x) * cam.scale + cam.hw;
      const sy = (this.y - cam.y) * cam.scale + cam.hh;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.color;
      ctx.font = `bold ${Math.round(14 * cam.scale)}px 'Fira Code', monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 3;
      ctx.fillText(this.text, sx, sy);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Main Renderer
  // ═══════════════════════════════════════════════════════════════════════════

  const Renderer = {
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,

    // World info (from game state)
    worldSize: 3000,
    boundaryRadius: 1450,
    centerX: 1500,
    centerY: 1500,

    // Camera
    camera: {
      x: 1500,
      y: 1500,
      targetX: 1500,
      targetY: 1500,
      scale: 1,
      targetScale: 1,
      hw: 0, // half width
      hh: 0, // half height
    },
    baseScale: 1.2,

    // State
    gameState: null,
    prevGameState: null,
    myPlayerId: null,
    animTime: 0,

    // Visual effects
    particles: [],
    floatingTexts: [],
    screenShake: { x: 0, y: 0, intensity: 0, decay: 0.9 },
    deathFlashes: [],

    // Theme
    isDark: true,

    // Background pattern cache
    _bgPattern: null,
    _bgPatternDark: true,

    // Performance
    _frameId: null,
    _lastFrameTime: 0,
    _running: false,

    // Minimap
    _minimapSize: 140,
    _minimapPadding: 10,

    // ═════════════════════════════════════════════════════════════════════════
    //  Init
    // ═════════════════════════════════════════════════════════════════════════

    init(canvasId) {
      this.canvas = document.getElementById(canvasId || "game-canvas");
      if (!this.canvas) {
        console.error("[Renderer] Canvas not found:", canvasId);
        return;
      }
      this.ctx = this.canvas.getContext("2d");

      this._handleResize = () => this.resize();
      window.addEventListener("resize", this._handleResize);
      this.resize();

      this.particles = [];
      this.floatingTexts = [];
      this.deathFlashes = [];
    },

    resize() {
      if (!this.canvas) return;

      const container = this.canvas.parentElement;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      this.width = rect.width;
      this.height = rect.height;

      this.canvas.width = Math.floor(this.width * dpr);
      this.canvas.height = Math.floor(this.height * dpr);
      this.canvas.style.width = this.width + "px";
      this.canvas.style.height = this.height + "px";

      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.camera.hw = this.width / 2;
      this.camera.hh = this.height / 2;

      this._bgPattern = null; // invalidate pattern cache
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Game state
    // ═════════════════════════════════════════════════════════════════════════

    setWorldSize(size) {
      if (size && size > 0) {
        this.worldSize = size;
      }
    },

    setGridSize(size) {
      // Backward compatibility alias
      this.setWorldSize(size);
    },

    setGameState(state) {
      this.prevGameState = this.gameState;
      this.gameState = state;

      if (state) {
        if (state.worldSize) this.worldSize = state.worldSize;
        if (state.boundaryRadius) this.boundaryRadius = state.boundaryRadius;
        if (state.centerX) this.centerX = state.centerX;
        if (state.centerY) this.centerY = state.centerY;
      }
    },

    setPlayerId(id) {
      this.myPlayerId = id;
    },

    setTheme(dark) {
      this.isDark = dark;
      this._bgPattern = null; // invalidate
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Render loop
    // ═════════════════════════════════════════════════════════════════════════

    start() {
      if (this._running) return;
      this._running = true;
      this._lastFrameTime = performance.now();
      this._tick();
    },

    stop() {
      this._running = false;
      if (this._frameId) {
        cancelAnimationFrame(this._frameId);
        this._frameId = null;
      }
    },

    _tick() {
      if (!this._running) return;
      this._frameId = requestAnimationFrame(() => this._tick());

      const now = performance.now();
      const dt = Math.min((now - this._lastFrameTime) / 1000, 0.1);
      this._lastFrameTime = now;

      this.animTime += dt;

      // Update camera
      this._updateCamera(dt);

      // Update effects
      this._updateParticles(dt);
      this._updateFloatingTexts(dt);
      this._updateScreenShake(dt);
      this._updateDeathFlashes(dt);

      // Draw
      this._render();
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Camera
    // ═════════════════════════════════════════════════════════════════════════

    _updateCamera(dt) {
      const cam = this.camera;
      const state = this.gameState;

      // Find my snake's head position
      if (state && state.snakes && this.myPlayerId) {
        const me = state.snakes[this.myPlayerId];
        if (me && me.segments && me.segments.length > 0) {
          cam.targetX = me.segments[0].x;
          cam.targetY = me.segments[0].y;

          // Zoom out slightly for longer snakes
          const len = me.length || me.segments.length;
          cam.targetScale = this.baseScale * Math.max(0.5, 1 - len * 0.002);
        } else if (me && !me.alive) {
          // Dead — keep last position but slowly zoom out
          cam.targetScale = Math.max(0.3, cam.targetScale - dt * 0.05);
        }
      }

      // Smooth lerp camera position
      const lerpSpeed = 1 - Math.pow(0.001, dt);
      cam.x += (cam.targetX - cam.x) * lerpSpeed;
      cam.y += (cam.targetY - cam.y) * lerpSpeed;
      cam.scale += (cam.targetScale - cam.scale) * lerpSpeed * 0.5;
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Main render
    // ═════════════════════════════════════════════════════════════════════════

    _render() {
      const ctx = this.ctx;
      if (!ctx) return;

      const cam = this.camera;

      // Clear
      ctx.clearRect(0, 0, this.width, this.height);

      // Apply screen shake
      ctx.save();
      ctx.translate(this.screenShake.x, this.screenShake.y);

      // Draw layers
      this._drawBackground(ctx, cam);
      this._drawBoundary(ctx, cam);

      if (this.gameState) {
        this._drawFood(ctx, cam);
        this._drawPowerups(ctx, cam);
        this._drawSnakes(ctx, cam);
      }

      this._drawDeathFlashes(ctx, cam);
      this._drawParticles(ctx, cam);
      this._drawFloatingTexts(ctx, cam);

      ctx.restore();

      // HUD overlays (not affected by camera)
      if (this.gameState) {
        this._drawMinimap(ctx);
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Drawing: Background (snake.io style dot pattern)
    // ═════════════════════════════════════════════════════════════════════════

    _drawBackground(ctx, cam) {
      // Fill entire canvas with dark background
      const bgColor = this.isDark ? "#0a0a12" : "#e0e8f0";
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, this.width, this.height);

      // Draw subtle dot grid pattern that moves with camera
      const dotSpacing = 40;
      const dotRadius = this.isDark ? 1 : 1.2;
      const dotColor = this.isDark
        ? "rgba(255,255,255,0.06)"
        : "rgba(0,0,0,0.06)";

      ctx.fillStyle = dotColor;

      // Calculate visible world range
      const left = cam.x - cam.hw / cam.scale;
      const right = cam.x + cam.hw / cam.scale;
      const top = cam.y - cam.hh / cam.scale;
      const bottom = cam.y + cam.hh / cam.scale;

      const startCol = Math.floor(left / dotSpacing) - 1;
      const endCol = Math.ceil(right / dotSpacing) + 1;
      const startRow = Math.floor(top / dotSpacing) - 1;
      const endRow = Math.ceil(bottom / dotSpacing) + 1;

      for (let row = startRow; row <= endRow; row++) {
        for (let col = startCol; col <= endCol; col++) {
          const wx = col * dotSpacing;
          const wy = row * dotSpacing;
          const sx = (wx - cam.x) * cam.scale + cam.hw;
          const sy = (wy - cam.y) * cam.scale + cam.hh;

          ctx.beginPath();
          ctx.arc(sx, sy, dotRadius * cam.scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Draw the area outside the boundary as darker overlay
      this._drawOutsideBoundary(ctx, cam);
    },

    _drawOutsideBoundary(ctx, cam) {
      // Draw a semi-transparent overlay outside the circular boundary
      const bx = (this.centerX - cam.x) * cam.scale + cam.hw;
      const by = (this.centerY - cam.y) * cam.scale + cam.hh;
      const br = this.boundaryRadius * cam.scale;

      ctx.save();

      // Create clipping path that is the entire canvas MINUS the circle
      ctx.beginPath();
      ctx.rect(0, 0, this.width, this.height);
      ctx.arc(bx, by, br, 0, Math.PI * 2, true); // counter-clockwise = subtract
      ctx.closePath();

      ctx.fillStyle = this.isDark
        ? "rgba(0, 0, 0, 0.6)"
        : "rgba(0, 0, 0, 0.15)";
      ctx.fill();

      ctx.restore();
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Drawing: Boundary circle (subtle, no hard wall)
    // ═════════════════════════════════════════════════════════════════════════

    _drawBoundary(ctx, cam) {
      const bx = (this.centerX - cam.x) * cam.scale + cam.hw;
      const by = (this.centerY - cam.y) * cam.scale + cam.hh;
      const br = this.boundaryRadius * cam.scale;

      // Subtle dashed circle
      ctx.save();
      ctx.strokeStyle = this.isDark
        ? "rgba(255, 100, 100, 0.15)"
        : "rgba(200, 50, 50, 0.12)";
      ctx.lineWidth = 2 * cam.scale;
      ctx.setLineDash([10 * cam.scale, 8 * cam.scale]);
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Glow effect near boundary — red warning gradient
      const glowWidth = 60 * cam.scale;
      ctx.save();
      const gradient = ctx.createRadialGradient(
        bx,
        by,
        br - glowWidth,
        bx,
        by,
        br,
      );
      gradient.addColorStop(0, "rgba(255, 50, 50, 0)");
      gradient.addColorStop(
        1,
        this.isDark ? "rgba(255, 50, 50, 0.08)" : "rgba(255, 50, 50, 0.04)",
      );
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Drawing: Food
    // ═════════════════════════════════════════════════════════════════════════

    _drawFood(ctx, cam) {
      const food = this.gameState.food;
      if (!food || !food.length) return;

      const viewMargin = 100;
      const viewLeft = cam.x - cam.hw / cam.scale - viewMargin;
      const viewRight = cam.x + cam.hw / cam.scale + viewMargin;
      const viewTop = cam.y - cam.hh / cam.scale - viewMargin;
      const viewBottom = cam.y + cam.hh / cam.scale + viewMargin;

      for (const f of food) {
        // Frustum cull
        if (
          f.x < viewLeft ||
          f.x > viewRight ||
          f.y < viewTop ||
          f.y > viewBottom
        )
          continue;

        const sx = (f.x - cam.x) * cam.scale + cam.hw;
        const sy = (f.y - cam.y) * cam.scale + cam.hh;
        const isBonus = f.type === "bonus";

        const baseRadius = isBonus ? 6 : 3.5;
        const bob = Math.sin(this.animTime * 3 + f.x * 0.1 + f.y * 0.07) * 0.5;
        const radius = (baseRadius + bob) * cam.scale;

        if (isBonus) {
          // Golden glow
          ctx.shadowColor = "#FACC15";
          ctx.shadowBlur = 8 * cam.scale;
          ctx.fillStyle = "#FACC15";
          ctx.beginPath();
          ctx.arc(sx, sy, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;

          // Inner highlight
          ctx.fillStyle = "rgba(255,255,255,0.4)";
          ctx.beginPath();
          ctx.arc(
            sx - radius * 0.25,
            sy - radius * 0.25,
            radius * 0.35,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        } else {
          // Normal food — colorful dots
          const hue = (((f.x * 7 + f.y * 13) % 360) + 360) % 360;
          ctx.fillStyle = `hsl(${hue}, 80%, 60%)`;
          ctx.beginPath();
          ctx.arc(sx, sy, radius, 0, Math.PI * 2);
          ctx.fill();

          // Subtle glow
          ctx.fillStyle = `hsla(${hue}, 80%, 60%, 0.3)`;
          ctx.beginPath();
          ctx.arc(sx, sy, radius * 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Drawing: Powerups
    // ═════════════════════════════════════════════════════════════════════════

    _drawPowerups(ctx, cam) {
      const powerups = this.gameState.powerups;
      if (!powerups || !powerups.length) return;

      const puColors = {
        speed: "#FACC15",
        shield: "#38BDF8",
        ghost: "#C084FC",
      };

      const puIcons = {
        speed: "\u26A1",
        shield: "\uD83D\uDEE1",
        ghost: "\uD83D\uDC7B",
      };

      for (const pu of powerups) {
        const sx = (pu.x - cam.x) * cam.scale + cam.hw;
        const sy = (pu.y - cam.y) * cam.scale + cam.hh;
        const color = puColors[pu.type] || "#FFFFFF";

        const pulse = 1 + Math.sin(this.animTime * 3 + pu.x * 0.3) * 0.15;
        const radius = 14 * pulse * cam.scale;

        // Outer glow
        ctx.shadowColor = color;
        ctx.shadowBlur = 12 * cam.scale;

        // Circle background
        ctx.fillStyle = color + "40";
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * cam.scale;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;

        // Icon
        const icon = puIcons[pu.type] || "?";
        const fontSize = Math.max(8, Math.round(12 * cam.scale));
        ctx.fillStyle = color;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(icon, sx, sy);
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Drawing: Snakes
    // ═════════════════════════════════════════════════════════════════════════

    _drawSnakes(ctx, cam) {
      const snakes = this.gameState.snakes;
      if (!snakes) return;

      // Sort: dead first, then alive, then me on top
      const sorted = Object.values(snakes).sort((a, b) => {
        if (a.alive && !b.alive) return 1;
        if (!a.alive && b.alive) return -1;
        if (a.id === this.myPlayerId) return 1;
        if (b.id === this.myPlayerId) return -1;
        return 0;
      });

      for (const snake of sorted) {
        if (!snake.segments || snake.segments.length === 0) continue;
        this._drawSingleSnake(ctx, cam, snake);
      }
    },

    _drawSingleSnake(ctx, cam, snake) {
      const segments = snake.segments;
      const pattern = snake.pattern || "classic";
      const baseColor = snake.color || "#3B82F6";
      const isAlive = snake.alive;
      const isMe = snake.id === this.myPlayerId;
      const len = segments.length;

      if (len === 0) return;

      // Check if any part of the snake is visible
      const head = segments[0];
      const headSx = (head.x - cam.x) * cam.scale + cam.hw;
      const headSy = (head.y - cam.y) * cam.scale + cam.hh;
      const snakeVisualLength = len * 3 * cam.scale + 200;
      if (
        headSx < -snakeVisualLength ||
        headSx > this.width + snakeVisualLength ||
        headSy < -snakeVisualLength ||
        headSy > this.height + snakeVisualLength
      ) {
        return; // Off screen
      }

      // Fade dead snakes
      const baseAlpha = isAlive ? 1 : 0.25;
      const ghostAlpha =
        snake.activePowerups && snake.activePowerups.ghost !== undefined
          ? 0.4
          : 1;

      ctx.save();
      ctx.globalAlpha = baseAlpha * ghostAlpha;

      const hasShield =
        snake.activePowerups && snake.activePowerups.shield !== undefined;
      const isBoosting = snake.boosting && isAlive;

      // ── Segment radius ─────────────────────────────────────────────────
      const baseRadius = 8;
      const headRadius = 10;

      // ── Draw body segments (back to front) ─────────────────────────────
      for (let i = len - 1; i >= 0; i--) {
        const seg = segments[i];
        const sx = (seg.x - cam.x) * cam.scale + cam.hw;
        const sy = (seg.y - cam.y) * cam.scale + cam.hh;
        const isHead = i === 0;
        const t = len > 1 ? i / (len - 1) : 0; // 0 at head, 1 at tail

        // Taper at the tail
        let radius;
        if (isHead) {
          radius = headRadius;
        } else if (i > len - 4) {
          // Tail taper
          const taperT = (len - i) / 4;
          radius = baseRadius * taperT;
        } else {
          radius = baseRadius;
        }
        radius *= cam.scale;

        // Skip tiny segments
        if (radius < 0.5) continue;

        // ── Pattern-based coloring ─────────────────────────────────────
        let color = this._getSegmentColor(
          pattern,
          baseColor,
          i,
          len,
          t,
          isHead,
        );

        // ── Draw segment circle ────────────────────────────────────────
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();

        // ── Pattern-specific effects ───────────────────────────────────
        if (pattern === "neon" && isAlive) {
          ctx.shadowColor = baseColor;
          ctx.shadowBlur = 6 * cam.scale;
          ctx.strokeStyle = baseColor;
          ctx.lineWidth = 1.5 * cam.scale;
          ctx.beginPath();
          ctx.arc(sx, sy, radius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
        }

        if (pattern === "galaxy" && i % 3 === 0 && radius > 2) {
          // Sparkle dots
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          const sparkleAngle = this.animTime * 2 + i * 1.5;
          const sparkleR = radius * 0.4;
          ctx.beginPath();
          ctx.arc(
            sx + Math.cos(sparkleAngle) * sparkleR,
            sy + Math.sin(sparkleAngle) * sparkleR,
            radius * 0.15,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }

        // ── Head details ───────────────────────────────────────────────
        if (isHead && isAlive) {
          this._drawSnakeHead(ctx, cam, snake, sx, sy, radius);
        }
      }

      // ── Boost trail effect ───────────────────────────────────────────────
      if (isBoosting && len > 2) {
        ctx.globalAlpha = baseAlpha * 0.3;
        for (let i = Math.max(0, len - 5); i < len; i++) {
          const seg = segments[i];
          const sx = (seg.x - cam.x) * cam.scale + cam.hw;
          const sy = (seg.y - cam.y) * cam.scale + cam.hh;
          const trailR =
            baseRadius * cam.scale * (1 - (i - (len - 5)) / 5) * 0.5;
          ctx.fillStyle = baseColor + "60";
          ctx.beginPath();
          ctx.arc(sx, sy, trailR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = baseAlpha * ghostAlpha;
      }

      // ── Shield overlay ───────────────────────────────────────────────────
      if (hasShield && isAlive) {
        const shieldAlpha = 0.2 + Math.sin(this.animTime * 4) * 0.1;
        ctx.globalAlpha = shieldAlpha;
        ctx.strokeStyle = "#38BDF8";
        ctx.lineWidth = 3 * cam.scale;
        ctx.shadowColor = "#38BDF8";
        ctx.shadowBlur = 8 * cam.scale;

        for (let i = 0; i < len; i += 2) {
          const seg = segments[i];
          const sx = (seg.x - cam.x) * cam.scale + cam.hw;
          const sy = (seg.y - cam.y) * cam.scale + cam.hh;
          const sr =
            (i === 0 ? headRadius : baseRadius) * cam.scale + 3 * cam.scale;
          ctx.beginPath();
          ctx.arc(sx, sy, sr, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.globalAlpha = baseAlpha * ghostAlpha;
      }

      // ── Username label above head ────────────────────────────────────────
      if (len > 0) {
        const labelSx = headSx;
        const labelSy = headSy - headRadius * cam.scale - 10 * cam.scale;

        ctx.globalAlpha = isAlive ? 0.9 : 0.3;
        ctx.fillStyle = isMe
          ? "#60A5FA"
          : this.isDark
            ? "rgba(255,255,255,0.85)"
            : "rgba(0,0,0,0.75)";
        const fontSize = Math.max(9, Math.min(13, Math.round(11 * cam.scale)));
        ctx.font = `bold ${fontSize}px 'Fira Code', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 3;

        const label = isMe ? "\u25CF " + snake.username : snake.username;
        ctx.fillText(label, labelSx, labelSy);

        // Score below name for other players
        if (!isMe && isAlive && snake.score > 0) {
          ctx.font = `${Math.max(7, fontSize - 2)}px 'Fira Code', monospace`;
          ctx.fillStyle = this.isDark
            ? "rgba(255,255,255,0.5)"
            : "rgba(0,0,0,0.4)";
          ctx.textBaseline = "top";
          ctx.fillText(
            String(snake.score),
            labelSx,
            headSy - headRadius * cam.scale - 2,
          );
        }

        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }

      ctx.restore();
    },

    // ── Snake head with eyes ──────────────────────────────────────────────────
    _drawSnakeHead(ctx, cam, snake, sx, sy, radius) {
      const angle = snake.angle || 0;
      const eyeSize = radius * 0.35;
      const eyeOffset = radius * 0.45;
      const pupilSize = eyeSize * 0.55;

      // Eye positions (perpendicular to heading direction)
      const perpX = Math.cos(angle + Math.PI / 2);
      const perpY = Math.sin(angle + Math.PI / 2);
      const fwdX = Math.cos(angle);
      const fwdY = Math.sin(angle);

      const eye1x = sx + perpX * eyeOffset * 0.7 + fwdX * eyeOffset * 0.5;
      const eye1y = sy + perpY * eyeOffset * 0.7 + fwdY * eyeOffset * 0.5;
      const eye2x = sx - perpX * eyeOffset * 0.7 + fwdX * eyeOffset * 0.5;
      const eye2y = sy - perpY * eyeOffset * 0.7 + fwdY * eyeOffset * 0.5;

      // Eye whites
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.arc(eye1x, eye1y, eyeSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(eye2x, eye2y, eyeSize, 0, Math.PI * 2);
      ctx.fill();

      // Pupils (look in direction of movement)
      const pupilOffX = fwdX * pupilSize * 0.3;
      const pupilOffY = fwdY * pupilSize * 0.3;

      ctx.fillStyle = "#111111";
      ctx.beginPath();
      ctx.arc(eye1x + pupilOffX, eye1y + pupilOffY, pupilSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(eye2x + pupilOffX, eye2y + pupilOffY, pupilSize, 0, Math.PI * 2);
      ctx.fill();

      // Highlight dot on head
      ctx.fillStyle = "rgba(255,255,255,0.2)";
      ctx.beginPath();
      ctx.arc(
        sx - fwdX * radius * 0.15 + perpX * radius * 0.2,
        sy - fwdY * radius * 0.15 + perpY * radius * 0.2,
        radius * 0.2,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    },

    // ── Segment color based on pattern ────────────────────────────────────────
    _getSegmentColor(pattern, baseColor, index, len, t, isHead) {
      switch (pattern) {
        case "striped":
          return index % 2 === 0
            ? baseColor
            : this._lightenColor(baseColor, 40);

        case "neon":
          return this._darkenColor(baseColor, 30);

        case "gradient":
          return this._lerpColor(
            baseColor,
            this._darkenColor(baseColor, 55),
            t,
          );

        case "candy":
          return index % 2 === 0 ? baseColor : this._rotateHue(baseColor, 180);

        case "rainbow": {
          const hueShift = (index * 15) % 360;
          return this._rotateHue(baseColor, hueShift);
        }

        case "galaxy":
          return this._lerpColor(
            this._darkenColor(baseColor, 40),
            baseColor,
            0.5 + Math.sin(index * 0.5 + this.animTime * 2) * 0.5,
          );

        case "fire": {
          const fireT = Math.max(0, Math.min(1, t));
          const fireColor = this._lerpColor("#FF4500", "#FFD700", 1 - fireT);
          const flicker = Math.sin(this.animTime * 8 + index * 0.8) * 0.15;
          return this._lerpColor(
            fireColor,
            "#FF0000",
            Math.max(0, Math.min(1, flicker + 0.1)),
          );
        }

        case "classic":
        default:
          return isHead ? this._lightenColor(baseColor, 18) : baseColor;
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Drawing: Death flashes
    // ═════════════════════════════════════════════════════════════════════════

    _drawDeathFlashes(ctx, cam) {
      for (const flash of this.deathFlashes) {
        if (flash.time <= 0) continue;

        const alpha = Math.min(1, flash.time * 3);
        const radius = (1 - flash.time) * 80 * cam.scale;

        const sx = (flash.x - cam.x) * cam.scale + cam.hw;
        const sy = (flash.y - cam.y) * cam.scale + cam.hh;

        ctx.save();
        ctx.globalAlpha = alpha * 0.4;
        ctx.fillStyle = flash.color;
        ctx.shadowColor = flash.color;
        ctx.shadowBlur = 20 * cam.scale;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Drawing: Particles & Floating text
    // ═════════════════════════════════════════════════════════════════════════

    _drawParticles(ctx, cam) {
      for (const p of this.particles) {
        p.draw(ctx, cam);
      }
    },

    _drawFloatingTexts(ctx, cam) {
      for (const ft of this.floatingTexts) {
        ft.draw(ctx, cam);
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Drawing: Minimap
    // ═════════════════════════════════════════════════════════════════════════

    _drawMinimap(ctx) {
      const size = this._minimapSize;
      const pad = this._minimapPadding;
      const mx = this.width - size - pad;
      const my = this.height - size - pad;

      const mapScale = size / (this.worldSize || 3000);
      const cx = this.centerX || this.worldSize / 2;
      const cy = this.centerY || this.worldSize / 2;
      const br = (this.boundaryRadius || this.worldSize / 2 - 50) * mapScale;

      // Background
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = this.isDark
        ? "rgba(10,10,20,0.85)"
        : "rgba(240,240,250,0.85)";
      ctx.beginPath();
      ctx.arc(mx + size / 2, my + size / 2, size / 2, 0, Math.PI * 2);
      ctx.fill();

      // Boundary circle
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = this.isDark
        ? "rgba(255,100,100,0.4)"
        : "rgba(200,50,50,0.3)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mx + size / 2, my + size / 2, br, 0, Math.PI * 2);
      ctx.stroke();

      // Food dots (tiny)
      ctx.globalAlpha = 0.3;
      const food = this.gameState.food;
      if (food) {
        ctx.fillStyle = this.isDark ? "#888" : "#666";
        for (let i = 0; i < food.length; i += 3) {
          // Only draw every 3rd food for perf
          const f = food[i];
          const fx = mx + (f.x - cx + this.worldSize / 2) * mapScale;
          const fy = my + (f.y - cy + this.worldSize / 2) * mapScale;
          ctx.fillRect(fx, fy, 1, 1);
        }
      }

      // Snakes
      ctx.globalAlpha = 0.9;
      const snakes = this.gameState.snakes;
      if (snakes) {
        for (const snake of Object.values(snakes)) {
          if (!snake.segments || snake.segments.length === 0) continue;
          const head = snake.segments[0];
          const hx = mx + (head.x - cx + this.worldSize / 2) * mapScale;
          const hy = my + (head.y - cy + this.worldSize / 2) * mapScale;

          const isMe = snake.id === this.myPlayerId;
          const dotRadius = isMe ? 3.5 : 2;

          ctx.fillStyle = snake.alive
            ? snake.color || "#FFF"
            : "rgba(128,128,128,0.3)";
          ctx.beginPath();
          ctx.arc(hx, hy, dotRadius, 0, Math.PI * 2);
          ctx.fill();

          // Draw a white ring around "me"
          if (isMe && snake.alive) {
            ctx.strokeStyle = "#FFF";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(hx, hy, dotRadius + 2, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }

      // Viewport indicator
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = "#FFF";
      ctx.lineWidth = 1;
      const viewW = (this.width / this.camera.scale) * mapScale;
      const viewH = (this.height / this.camera.scale) * mapScale;
      const viewX =
        mx + (this.camera.x - cx + this.worldSize / 2) * mapScale - viewW / 2;
      const viewY =
        my + (this.camera.y - cy + this.worldSize / 2) * mapScale - viewH / 2;
      ctx.strokeRect(viewX, viewY, viewW, viewH);

      ctx.restore();
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Update: Effects
    // ═════════════════════════════════════════════════════════════════════════

    _updateParticles(dt) {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        if (!this.particles[i].update(dt)) {
          this.particles.splice(i, 1);
        }
      }
    },

    _updateFloatingTexts(dt) {
      for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
        if (!this.floatingTexts[i].update(dt)) {
          this.floatingTexts.splice(i, 1);
        }
      }
    },

    _updateScreenShake(dt) {
      if (this.screenShake.intensity > 0.1) {
        this.screenShake.x = (Math.random() - 0.5) * this.screenShake.intensity;
        this.screenShake.y = (Math.random() - 0.5) * this.screenShake.intensity;
        this.screenShake.intensity *= this.screenShake.decay;
      } else {
        this.screenShake.x = 0;
        this.screenShake.y = 0;
        this.screenShake.intensity = 0;
      }
    },

    _updateDeathFlashes(dt) {
      for (let i = this.deathFlashes.length - 1; i >= 0; i--) {
        this.deathFlashes[i].time -= dt;
        if (this.deathFlashes[i].time <= 0) {
          this.deathFlashes.splice(i, 1);
        }
      }
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Effect Spawners (called from app.js on game events)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Spawn particles at a world position.
     * @param {number} wx – world x
     * @param {number} wy – world y
     * @param {string} color
     * @param {number} [count=8]
     */
    spawnParticles(wx, wy, color, count) {
      count = count || 8;
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
        const speed = 30 + Math.random() * 50;
        const vx = Math.cos(angle) * speed;
        const vy = Math.sin(angle) * speed;
        const life = 0.3 + Math.random() * 0.5;
        const size = 2 + Math.random() * 3;
        this.particles.push(new Particle(wx, wy, vx, vy, color, life, size));
      }
    },

    /**
     * Show a floating score text at a world position.
     */
    spawnFloatingText(wx, wy, text, color) {
      this.floatingTexts.push(
        new FloatingText(wx, wy, text, color || "#FFFFFF"),
      );
    },

    /**
     * Flash + shake when a death occurs.
     */
    spawnDeathEffect(wx, wy, color, isMe) {
      this.deathFlashes.push({
        x: wx,
        y: wy,
        color: color || "#EF4444",
        time: 0.6,
      });
      this.spawnParticles(wx, wy, color || "#EF4444", 16);
      this.screenShake.intensity = isMe ? 14 : 6;
      this.screenShake.decay = 0.88;
    },

    /**
     * Spawn a powerup pickup effect.
     */
    spawnPowerupEffect(wx, wy, color, label) {
      this.spawnParticles(wx, wy, color, 12);
      this.spawnFloatingText(wx, wy, label, color);
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Color Utilities
    // ═════════════════════════════════════════════════════════════════════════

    _parseColor(hex) {
      hex = hex.replace("#", "");
      if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }
      return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16),
      };
    },

    _toHex(r, g, b) {
      const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
      return (
        "#" +
        clamp(r).toString(16).padStart(2, "0") +
        clamp(g).toString(16).padStart(2, "0") +
        clamp(b).toString(16).padStart(2, "0")
      );
    },

    _lightenColor(hex, amount) {
      const c = this._parseColor(hex);
      const t = amount / 100;
      return this._toHex(
        c.r + (255 - c.r) * t,
        c.g + (255 - c.g) * t,
        c.b + (255 - c.b) * t,
      );
    },

    _darkenColor(hex, amount) {
      const c = this._parseColor(hex);
      const t = 1 - amount / 100;
      return this._toHex(c.r * t, c.g * t, c.b * t);
    },

    _lerpColor(hex1, hex2, t) {
      const c1 = this._parseColor(hex1);
      const c2 = this._parseColor(hex2);
      return this._toHex(
        c1.r + (c2.r - c1.r) * t,
        c1.g + (c2.g - c1.g) * t,
        c1.b + (c2.b - c1.b) * t,
      );
    },

    _rotateHue(hex, degrees) {
      const c = this._parseColor(hex);
      let r = c.r / 255,
        g = c.g / 255,
        b = c.b / 255;
      const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
      let h,
        s,
        l = (max + min) / 2;

      if (max === min) {
        h = s = 0;
      } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r:
            h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            break;
          case g:
            h = ((b - r) / d + 2) / 6;
            break;
          case b:
            h = ((r - g) / d + 4) / 6;
            break;
        }
      }

      h = ((h * 360 + degrees) % 360) / 360;
      if (h < 0) h += 1;

      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };

      if (s === 0) {
        r = g = b = l;
      } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
      }

      return this._toHex(r * 255, g * 255, b * 255);
    },

    // ═════════════════════════════════════════════════════════════════════════
    //  Cleanup
    // ═════════════════════════════════════════════════════════════════════════

    clearEffects() {
      this.particles = [];
      this.floatingTexts = [];
      this.deathFlashes = [];
      this.screenShake = { x: 0, y: 0, intensity: 0, decay: 0.9 };
    },

    destroy() {
      this.stop();
      this.clearEffects();
      window.removeEventListener("resize", this._handleResize);
      this.canvas = null;
      this.ctx = null;
      this.gameState = null;
      this.prevGameState = null;
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  Export as global
  // ═══════════════════════════════════════════════════════════════════════════

  window.Renderer = Renderer;
})();
