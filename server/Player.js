// Player.js — Player state management for Snake Arena
const crypto = require("crypto");
const { INITIAL_SNAKE_LENGTH, OPPOSITE, DIRECTIONS } = require("./constants");

class Player {
  constructor(ws, username, pattern, color) {
    this.id = crypto.randomUUID();
    this.sessionToken = crypto.randomBytes(24).toString("hex");
    this.ws = ws;
    this.username = (username || "Anonymous").substring(0, 20);
    this.pattern = pattern || "classic";
    this.color = color || "#3A4DFF";
    this.roomId = null;
    this.isRoomCreator = false;

    // Game state
    this.alive = false;
    this.score = 0;
    this.kills = 0;
    this.spectating = false;

    // Connection state
    this.connected = true;
    this.disconnectTimer = null;
    this.lastPing = Date.now();
  }

  /**
   * Send a JSON message to this player's WebSocket
   */
  send(data) {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (e) {
        console.error(
          `[Player] Send failed for ${this.username} (${this.id}), type=${data?.type}:`,
          e.message,
        );
        this.connected = false;
      }
    } else {
      console.warn(
        `[Player] Cannot send type=${data?.type} to ${this.username} (${this.id}): ` +
          `ws=${this.ws ? "exists" : "null"}, readyState=${this.ws?.readyState ?? "N/A"}`,
      );
    }
  }

  /**
   * Update profile info
   */
  updateProfile(username, pattern, color) {
    if (username) this.username = username.substring(0, 20);
    if (pattern) this.pattern = pattern;
    if (color) this.color = color;
  }

  /**
   * Handle disconnect — marks player as disconnected
   */
  onDisconnect() {
    this.connected = false;
    this.ws = null;
  }

  /**
   * Handle reconnect — restores the WebSocket
   */
  onReconnect(ws) {
    this.ws = ws;
    this.connected = true;
    this.lastPing = Date.now();
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  /**
   * Reset game stats for a new round
   */
  reset() {
    this.alive = false;
    this.score = 0;
    this.kills = 0;
    this.spectating = false;
  }

  /**
   * Serialize public info for room/lobby display
   */
  toPublic() {
    return {
      id: this.id,
      username: this.username,
      pattern: this.pattern,
      color: this.color,
      score: this.score,
      alive: this.alive,
      kills: this.kills,
      connected: this.connected,
      isRoomCreator: this.isRoomCreator,
      spectating: this.spectating,
    };
  }
}

module.exports = Player;
