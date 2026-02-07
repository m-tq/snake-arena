// GameEngine.js — Core deterministic snake game logic (server-authoritative)
// Continuous movement engine (snake.io style): angle-based steering, distance collisions,
// circular world boundary, smooth body chain, food/powerup systems.

const {
  INITIAL_SNAKE_LENGTH,
  SNAKE_SPEED,
  SNAKE_BOOST_SPEED,
  SNAKE_TURN_RATE,
  SNAKE_SEGMENT_RADIUS,
  SNAKE_HEAD_RADIUS,
  GROW_PER_FOOD,
  BOOST_COST_INTERVAL,
  MAX_SNAKE_SEGMENTS,
  FOOD_BASE_COUNT,
  FOOD_PER_PLAYER,
  FOOD_SCORE,
  FOOD_RADIUS,
  BONUS_FOOD_CHANCE,
  POWERUP_SPAWN_CHANCE,
  POWERUP_MAX,
  POWERUP_DESPAWN_TICKS,
  POWERUP_TYPES,
  COLLISION_GRACE_SEGMENTS,
  BOUNDARY_KILL_MARGIN,
} = require("./constants");

const TWO_PI = Math.PI * 2;

class GameEngine {
  /**
   * @param {number} worldSize – width & height of the square world
   */
  constructor(worldSize) {
    this.worldSize = worldSize;
    this.centerX = worldSize / 2;
    this.centerY = worldSize / 2;
    // Circular play area radius — snakes die when leaving this circle
    this.boundaryRadius = worldSize / 2 - BOUNDARY_KILL_MARGIN;

    this.snakes = new Map(); // playerId -> SnakeState
    this.food = []; // [{ x, y, type:'normal'|'bonus', value }]
    this.powerups = []; // [{ id, x, y, type, spawnTick }]
    this.events = []; // per-tick events for broadcast
    this.tick = 0;

    // Deterministic seeded PRNG
    this._seed = Date.now();
    this._rng = this._createRng(this._seed);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Seeded pseudo-random number generator (Park-Miller LCG)
  // ═══════════════════════════════════════════════════════════════════════════

  _createRng(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  _randInt(min, max) {
    return Math.floor(this._rng() * (max - min + 1)) + min;
  }

  _randFloat() {
    return this._rng();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Snake lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Spawn a new snake for a player.
   * Finds a safe spawn position, builds the initial body chain.
   */
  spawnSnake(playerId, username, pattern, color) {
    const pos = this._findSpawnPosition();
    // Angle toward world center
    const angle = Math.atan2(this.centerY - pos.y, this.centerX - pos.x);

    // Build initial segments behind the head
    const segments = [];
    for (let i = 0; i < INITIAL_SNAKE_LENGTH; i++) {
      segments.push({
        x: pos.x - Math.cos(angle) * i * SNAKE_SPEED,
        y: pos.y - Math.sin(angle) * i * SNAKE_SPEED,
      });
    }

    const snake = {
      id: playerId,
      username,
      pattern: pattern || "classic",
      color: color || "#3B82F6",
      segments, // [0] = head
      angle, // current heading (radians)
      targetAngle: angle, // target heading from input
      boosting: false,
      alive: true,
      score: 0,
      kills: 0,
      length: INITIAL_SNAKE_LENGTH, // target segment count
      growPending: 0,
      activePowerups: {}, // type -> remainingTicks
      deathTick: null,
      deathCause: null,
      killedBy: null,
      spawnTick: this.tick,
    };

    this.snakes.set(playerId, snake);
    return snake;
  }

  removeSnake(playerId) {
    this.snakes.delete(playerId);
  }

  /**
   * Find a safe spawn position away from other snakes and the boundary.
   */
  _findSpawnPosition() {
    const safeRadius = this.boundaryRadius * 0.75;

    for (let attempt = 0; attempt < 200; attempt++) {
      // Random position within safe circle
      const a = this._randFloat() * TWO_PI;
      const r = Math.sqrt(this._randFloat()) * safeRadius;
      const x = this.centerX + Math.cos(a) * r;
      const y = this.centerY + Math.sin(a) * r;

      // Check distance from all existing snake heads
      let tooClose = false;
      for (const other of this.snakes.values()) {
        if (!other.alive || other.segments.length === 0) continue;
        const head = other.segments[0];
        const dx = head.x - x;
        const dy = head.y - y;
        if (dx * dx + dy * dy < 150 * 150) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) return { x, y };
    }

    // Fallback — random inside safe zone
    const a = this._randFloat() * TWO_PI;
    const r = Math.sqrt(this._randFloat()) * safeRadius * 0.5;
    return {
      x: this.centerX + Math.cos(a) * r,
      y: this.centerY + Math.sin(a) * r,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Input
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set the target angle and boost state for a player.
   * Called from Room.handleInput().
   * @param {string} playerId
   * @param {number} angle – target heading in radians
   * @param {boolean} boosting
   */
  queueInput(playerId, angle, boosting) {
    const snake = this.snakes.get(playerId);
    if (!snake || !snake.alive) return;

    if (typeof angle === "number" && isFinite(angle)) {
      snake.targetAngle = angle;
    }
    snake.boosting = !!boosting;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Main tick — called once per server tick
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Advance the game by one tick. Returns { tick, events }.
   */
  update() {
    this.tick++;
    this.events = [];

    // 1) Move all alive snakes (smooth turning + forward movement)
    this._moveSnakes();

    // 2) Detect collisions (boundary, self, other snakes)
    this._detectCollisions();

    // 3) Check food consumption
    this._checkFood();

    // 4) Check powerup pickup
    this._checkPowerupPickup();

    // 5) Tick down active powerups
    this._tickActivePowerups();

    // 6) Maintain minimum food count
    this._maintainFood();

    // 7) Maybe spawn a powerup
    this._maybeSpawnPowerup();

    return { tick: this.tick, events: [...this.events] };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Movement
  // ═══════════════════════════════════════════════════════════════════════════

  _moveSnakes() {
    for (const snake of this.snakes.values()) {
      if (!snake.alive) continue;

      // ── Smooth turn toward target angle ──────────────────────────────
      let angleDiff = snake.targetAngle - snake.angle;
      // Normalize to [-PI, PI]
      while (angleDiff > Math.PI) angleDiff -= TWO_PI;
      while (angleDiff < -Math.PI) angleDiff += TWO_PI;

      const turnRate = SNAKE_TURN_RATE;
      if (Math.abs(angleDiff) <= turnRate) {
        snake.angle = snake.targetAngle;
      } else {
        snake.angle += Math.sign(angleDiff) * turnRate;
      }
      // Keep angle in [0, 2π)
      snake.angle = ((snake.angle % TWO_PI) + TWO_PI) % TWO_PI;

      // ── Calculate speed ──────────────────────────────────────────────
      const canBoost =
        snake.boosting && snake.length > INITIAL_SNAKE_LENGTH + 3;
      let speed = canBoost ? SNAKE_BOOST_SPEED : SNAKE_SPEED;

      // Speed powerup
      if (snake.activePowerups.speed) {
        speed *= 1.4;
      }

      // ── Move head forward ────────────────────────────────────────────
      const head = snake.segments[0];
      const newHead = {
        x: head.x + Math.cos(snake.angle) * speed,
        y: head.y + Math.sin(snake.angle) * speed,
      };
      snake.segments.unshift(newHead);

      // ── Growth / trimming ────────────────────────────────────────────
      const targetLen = snake.length + snake.growPending;
      if (snake.segments.length > targetLen) {
        snake.segments.length = targetLen;
      }
      // Settle growth
      if (snake.growPending > 0 && snake.segments.length >= targetLen) {
        snake.length = Math.min(targetLen, MAX_SNAKE_SEGMENTS);
        snake.growPending = 0;
      }
      // Cap at max
      if (snake.segments.length > MAX_SNAKE_SEGMENTS) {
        snake.segments.length = MAX_SNAKE_SEGMENTS;
        snake.length = MAX_SNAKE_SEGMENTS;
      }

      // ── Boost cost: shrink slowly while boosting ─────────────────────
      if (canBoost && this.tick % BOOST_COST_INTERVAL === 0) {
        if (snake.length > INITIAL_SNAKE_LENGTH + 3) {
          snake.length--;
          // Drop a food particle behind
          const tail = snake.segments[snake.segments.length - 1];
          if (tail) {
            this.food.push({
              x: tail.x,
              y: tail.y,
              type: "normal",
              value: FOOD_SCORE,
            });
          }
        }
      }

      // ── Ghost wrap-around ────────────────────────────────────────────
      if (snake.activePowerups.ghost) {
        const gh = snake.segments[0];
        const gdx = gh.x - this.centerX;
        const gdy = gh.y - this.centerY;
        const gDist = Math.sqrt(gdx * gdx + gdy * gdy);
        if (gDist > this.boundaryRadius) {
          // Teleport to opposite side
          gh.x = this.centerX - gdx * 0.8;
          gh.y = this.centerY - gdy * 0.8;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Collision detection
  // ═══════════════════════════════════════════════════════════════════════════

  _detectCollisions() {
    const deaths = []; // [{ id, cause, killerId }]
    const entries = [...this.snakes.entries()];
    const headRadius = SNAKE_HEAD_RADIUS;
    const segRadius = SNAKE_SEGMENT_RADIUS;

    for (const [id, snake] of entries) {
      if (!snake.alive) continue;
      const head = snake.segments[0];

      // ── Boundary collision (circular world edge) ─────────────────────
      const dx = head.x - this.centerX;
      const dy = head.y - this.centerY;
      const distFromCenter = Math.sqrt(dx * dx + dy * dy);

      if (distFromCenter > this.boundaryRadius) {
        if (!snake.activePowerups.ghost) {
          deaths.push({ id, cause: "wall", killerId: null });
          continue;
        }
      }

      // ── Self collision (skip first few segments) ─────────────────────
      if (!snake.activePowerups.shield) {
        const selfGrace = Math.max(8, Math.floor(snake.segments.length * 0.15));
        for (let i = selfGrace; i < snake.segments.length; i++) {
          const seg = snake.segments[i];
          const sdx = head.x - seg.x;
          const sdy = head.y - seg.y;
          const sDist = sdx * sdx + sdy * sdy;
          const threshold = headRadius + segRadius * 0.6;
          if (sDist < threshold * threshold) {
            deaths.push({ id, cause: "self", killerId: null });
            break;
          }
        }
      }
    }

    // ── Cross-snake collision ───────────────────────────────────────────
    for (let i = 0; i < entries.length; i++) {
      const [idA, snakeA] = entries[i];
      if (!snakeA.alive || deaths.some((d) => d.id === idA)) continue;
      const headA = snakeA.segments[0];

      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        const [idB, snakeB] = entries[j];
        if (!snakeB.alive) continue;
        if (deaths.some((d) => d.id === idA)) break;

        const headB = snakeB.segments[0];

        // Head-to-head
        if (j > i) {
          const hhDx = headA.x - headB.x;
          const hhDy = headA.y - headB.y;
          const hhDist = hhDx * hhDx + hhDy * hhDy;
          const hhThreshold = headRadius * 2;
          if (hhDist < hhThreshold * hhThreshold) {
            const prevHeadA = snakeA.segments[1] || headA;
            const prevHeadB = snakeB.segments[1] || headB;
            const dAtoPrevB =
              (headA.x - prevHeadB.x) * (headA.x - prevHeadB.x) +
              (headA.y - prevHeadB.y) * (headA.y - prevHeadB.y);
            const dBtoPrevA =
              (headB.x - prevHeadA.x) * (headB.x - prevHeadA.x) +
              (headB.y - prevHeadA.y) * (headB.y - prevHeadA.y);

            const colliderIsA = dAtoPrevB <= dBtoPrevA;
            const colliderId = colliderIsA ? idA : idB;
            const collider = colliderIsA ? snakeA : snakeB;
            const targetId = colliderIsA ? idB : idA;

            if (!collider.activePowerups.shield) {
              deaths.push({
                id: colliderId,
                cause: "head_collision",
                killerId: targetId,
              });
            }
            continue;
          }
        }

        // Head of A hits body of B
        if (!snakeA.activePowerups.ghost && !snakeA.activePowerups.shield) {
          const grace = COLLISION_GRACE_SEGMENTS;
          const collisionThreshold = headRadius + segRadius * 0.7;
          const ct2 = collisionThreshold * collisionThreshold;

          for (let s = grace; s < snakeB.segments.length; s++) {
            const seg = snakeB.segments[s];
            const cDx = headA.x - seg.x;
            const cDy = headA.y - seg.y;
            if (cDx * cDx + cDy * cDy < ct2) {
              deaths.push({ id: idA, cause: "collision", killerId: idB });
              break;
            }
          }
        }
      }
    }

    // ── Apply deaths (deduplicated) ────────────────────────────────────
    const killed = new Set();
    for (const death of deaths) {
      if (killed.has(death.id)) continue;
      killed.add(death.id);
      this._applyDeath(death.id, death.cause, death.killerId);
    }
  }

  _applyDeath(playerId, cause, killerId) {
    const snake = this.snakes.get(playerId);
    if (!snake || !snake.alive) return;

    snake.alive = false;
    snake.deathTick = this.tick;
    snake.deathCause = cause;
    snake.killedBy = killerId;

    // Drop food along the dead snake's body (every 3rd segment)
    for (let i = 0; i < snake.segments.length; i += 3) {
      const seg = snake.segments[i];
      // Only drop if inside the boundary
      const fdx = seg.x - this.centerX;
      const fdy = seg.y - this.centerY;
      if (fdx * fdx + fdy * fdy < this.boundaryRadius * this.boundaryRadius) {
        this.food.push({
          x: seg.x + (this._randFloat() - 0.5) * 8,
          y: seg.y + (this._randFloat() - 0.5) * 8,
          type: "bonus",
          value: 30,
        });
      }
    }

    // Credit the killer
    if (killerId) {
      const killer = this.snakes.get(killerId);
      if (killer && killer.alive) {
        killer.kills++;
        killer.score += 50;

        this.events.push({
          type: "kill",
          killerId,
          killerName: killer.username,
          victimId: playerId,
          victimName: snake.username,
          cause,
        });
      }
    }

    this.events.push({
      type: "death",
      playerId,
      username: snake.username,
      color: snake.color,
      cause,
      killerId,
      finalScore: snake.score,
      finalLength: snake.length,
      tick: this.tick,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Food
  // ═══════════════════════════════════════════════════════════════════════════

  _desiredFoodCount() {
    const alive = [...this.snakes.values()].filter((s) => s.alive).length;
    return FOOD_BASE_COUNT + alive * FOOD_PER_PLAYER;
  }

  _maintainFood() {
    const desired = this._desiredFoodCount();

    while (this.food.length < desired) {
      const pos = this._randomWorldPosition(0.9);
      if (!pos) break;

      const isBonus = this._randFloat() < BONUS_FOOD_CHANCE;
      this.food.push({
        x: pos.x,
        y: pos.y,
        type: isBonus ? "bonus" : "normal",
        value: isBonus ? 30 : FOOD_SCORE,
      });
    }
  }

  _checkFood() {
    for (const snake of this.snakes.values()) {
      if (!snake.alive) continue;

      const head = snake.segments[0];
      const pickupRadius = SNAKE_HEAD_RADIUS + FOOD_RADIUS;
      const pr2 = pickupRadius * pickupRadius;

      for (let i = this.food.length - 1; i >= 0; i--) {
        const f = this.food[i];
        const fdx = head.x - f.x;
        const fdy = head.y - f.y;

        if (fdx * fdx + fdy * fdy < pr2) {
          const growth = f.type === "bonus" ? GROW_PER_FOOD + 2 : GROW_PER_FOOD;
          const points = f.value || FOOD_SCORE;

          snake.growPending += growth;
          snake.score += points;

          this.events.push({
            type: "eat",
            playerId: snake.id,
            username: snake.username,
            food: { x: f.x, y: f.y, type: f.type },
            growth,
            points,
          });

          this.food.splice(i, 1);
          // Allow eating multiple food per tick (snake can overlap several)
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Powerups
  // ═══════════════════════════════════════════════════════════════════════════

  _maybeSpawnPowerup() {
    const aliveCount = [...this.snakes.values()].filter((s) => s.alive).length;
    if (aliveCount < 1) return;
    if (this.powerups.length >= POWERUP_MAX) return;
    if (this._randFloat() > POWERUP_SPAWN_CHANCE) return;

    const pos = this._randomWorldPosition(0.75);
    if (!pos) return;

    const types = Object.keys(POWERUP_TYPES);
    const type = types[this._randInt(0, types.length - 1)];

    const powerup = {
      id: `pu_${this.tick}_${this._randInt(0, 9999)}`,
      x: pos.x,
      y: pos.y,
      type,
      spawnTick: this.tick,
    };

    this.powerups.push(powerup);

    this.events.push({
      type: "powerup_spawn",
      powerup: { ...powerup },
    });
  }

  _checkPowerupPickup() {
    for (const snake of this.snakes.values()) {
      if (!snake.alive) continue;
      const head = snake.segments[0];
      const pickupRadius = SNAKE_HEAD_RADIUS + 12;
      const pr2 = pickupRadius * pickupRadius;

      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const pu = this.powerups[i];
        const pdx = head.x - pu.x;
        const pdy = head.y - pu.y;

        if (pdx * pdx + pdy * pdy < pr2) {
          const def = POWERUP_TYPES[pu.type];

          if (def) {
            // Timed buff
            snake.activePowerups[pu.type] = def.duration;
          }

          snake.score += 15;

          this.events.push({
            type: "powerup_pickup",
            playerId: snake.id,
            username: snake.username,
            powerupType: pu.type,
            powerupLabel: def ? def.label : pu.type,
          });

          this.powerups.splice(i, 1);
          break;
        }
      }
    }
  }

  _tickActivePowerups() {
    for (const snake of this.snakes.values()) {
      if (!snake.alive) continue;

      for (const type of Object.keys(snake.activePowerups)) {
        snake.activePowerups[type]--;
        if (snake.activePowerups[type] <= 0) {
          delete snake.activePowerups[type];
          this.events.push({
            type: "powerup_expired",
            playerId: snake.id,
            powerupType: type,
          });
        }
      }
    }

    // Despawn field powerups after N ticks
    const despawnAfter = POWERUP_DESPAWN_TICKS || 200;
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      if (this.tick - this.powerups[i].spawnTick > despawnAfter) {
        this.events.push({
          type: "powerup_despawn",
          powerupId: this.powerups[i].id,
        });
        this.powerups.splice(i, 1);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Random position within the circular play area.
   * @param {number} radiusFraction – 0..1 fraction of boundaryRadius
   */
  _randomWorldPosition(radiusFraction) {
    const maxR = this.boundaryRadius * (radiusFraction || 0.85);
    const a = this._randFloat() * TWO_PI;
    const r = Math.sqrt(this._randFloat()) * maxR;
    return {
      x: this.centerX + Math.cos(a) * r,
      y: this.centerY + Math.sin(a) * r,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  State serialization
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Full state snapshot.
   * Coordinates are rounded to 1 decimal for bandwidth savings.
   */
  getFullState() {
    const snakes = {};
    for (const [id, s] of this.snakes) {
      snakes[id] = {
        id: s.id,
        username: s.username,
        pattern: s.pattern,
        color: s.color,
        segments: s.segments.map((seg) => ({
          x: Math.round(seg.x * 10) / 10,
          y: Math.round(seg.y * 10) / 10,
        })),
        angle: Math.round(s.angle * 1000) / 1000,
        alive: s.alive,
        score: s.score,
        kills: s.kills,
        length: s.length,
        boosting: s.boosting,
        activePowerups: { ...s.activePowerups },
        deathTick: s.deathTick,
        deathCause: s.deathCause,
        killedBy: s.killedBy,
      };
    }

    return {
      tick: this.tick,
      worldSize: this.worldSize,
      boundaryRadius: this.boundaryRadius,
      centerX: this.centerX,
      centerY: this.centerY,
      snakes,
      food: this.food.map((f) => ({
        x: Math.round(f.x),
        y: Math.round(f.y),
        type: f.type,
      })),
      powerups: this.powerups.map((p) => ({
        id: p.id,
        x: Math.round(p.x),
        y: Math.round(p.y),
        type: p.type,
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Query helpers
  // ═══════════════════════════════════════════════════════════════════════════

  getAliveCount() {
    let count = 0;
    for (const s of this.snakes.values()) {
      if (s.alive) count++;
    }
    return count;
  }

  getAliveIds() {
    const ids = [];
    for (const s of this.snakes.values()) {
      if (s.alive) ids.push(s.id);
    }
    return ids;
  }

  /**
   * Leaderboard data — sorted alive first by score, then dead by death tick.
   */
  getLeaderboard() {
    const all = [...this.snakes.values()];

    const alive = all
      .filter((s) => s.alive)
      .sort((a, b) => b.score - a.score || b.length - a.length)
      .map((s, i) => ({
        rank: i + 1,
        id: s.id,
        username: s.username,
        color: s.color,
        pattern: s.pattern,
        score: s.score,
        length: s.length,
        kills: s.kills,
        alive: true,
      }));

    const dead = all
      .filter((s) => !s.alive && s.deathTick !== null)
      .sort((a, b) => (b.deathTick || 0) - (a.deathTick || 0))
      .map((s, i) => ({
        rank: alive.length + i + 1,
        id: s.id,
        username: s.username,
        color: s.color,
        pattern: s.pattern,
        score: s.score,
        length: s.length,
        kills: s.kills,
        alive: false,
        deathTick: s.deathTick,
        deathCause: s.deathCause,
        killedBy: s.killedBy,
      }));

    return {
      alive,
      dead,
      total: all.length,
      aliveCount: alive.length,
    };
  }

  /**
   * Final standings sorted by placement (for game-over screen).
   */
  getStandings() {
    const all = [...this.snakes.values()];
    return all
      .sort((a, b) => {
        // Alive players first
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        // Then by score
        if (b.score !== a.score) return b.score - a.score;
        // Then by length
        return b.length - a.length;
      })
      .map((s, i) => ({
        rank: i + 1,
        id: s.id,
        username: s.username,
        pattern: s.pattern,
        color: s.color,
        score: s.score,
        length: s.length,
        kills: s.kills,
        alive: s.alive,
        deathTick: s.deathTick,
        deathCause: s.deathCause,
        survivalTicks: s.alive
          ? this.tick - s.spawnTick
          : (s.deathTick || this.tick) - s.spawnTick,
      }));
  }

  /**
   * Reset the engine for a new round.
   */
  reset() {
    this.snakes.clear();
    this.food = [];
    this.powerups = [];
    this.events = [];
    this.tick = 0;
    this._rng = this._createRng(Date.now());
  }
}

module.exports = GameEngine;
