// network.js — WebSocket client wrapper
// Features: auto-reconnect, message queue, event emitter pattern, ping tracking

(function () {
  "use strict";

  const RECONNECT_BASE_DELAY = 1000;
  const RECONNECT_MAX_DELAY = 15000;
  const PING_INTERVAL = 5000;

  class Network {
    constructor() {
      this.ws = null;
      this.url = null;
      this.connected = false;
      this.reconnecting = false;
      this.intentionalClose = false;

      // Event listeners: type -> Set<callback>
      this._listeners = {};

      // Queued messages to send once connected
      this._queue = [];

      // Reconnect state
      this._reconnectAttempts = 0;
      this._reconnectTimer = null;

      // Ping tracking
      this._pingInterval = null;
      this._lastPingSent = 0;
      this._latency = 0; // ms

      // Player identity (for reconnection)
      this._playerId = null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Connection
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Connect to the WebSocket server.
     * @param {string} [url] – ws:// or wss:// URL. Auto-detected if omitted.
     */
    connect(url) {
      if (
        this.ws &&
        (this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      this.intentionalClose = false;

      if (url) {
        this.url = url;
      } else if (!this.url) {
        // Auto-detect based on current page
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        this.url = `${proto}//${window.location.host}/ws`;
      }

      console.log(`[Network] Connecting to ${this.url}...`);

      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        console.error("[Network] Failed to create WebSocket:", err);
        this._scheduleReconnect();
        return;
      }

      const ws = this.ws;
      this.ws.onopen = (event) => this._onOpen(event, ws);
      this.ws.onmessage = (event) => this._onMessage(event, ws);
      this.ws.onclose = (event) => this._onClose(event, ws);
      this.ws.onerror = (event) => this._onError(event, ws);
    }

    /**
     * Disconnect intentionally (no auto-reconnect).
     */
    disconnect() {
      this.intentionalClose = true;
      this._clearTimers();

      if (this.ws) {
        this.ws.close(1000, "Client disconnect");
        this.ws = null;
      }

      this.connected = false;
      this.reconnecting = false;
      this._reconnectAttempts = 0;
    }

    reconnect() {
      this.intentionalClose = false;
      this._clearTimers();

      if (this.ws) {
        try {
          this.ws.close(4001, "Reconnecting");
        } catch {}
        this.ws = null;
      }

      this.connected = false;
      this.reconnecting = false;
      this._reconnectAttempts = 0;
      this._scheduleReconnect();
    }

    /**
     * Send a message object (auto-serialized to JSON).
     * If not connected, the message is queued and sent when the connection opens.
     * @param {object} data
     */
    send(data) {
      if (!data) return;

      const json = typeof data === "string" ? data : JSON.stringify(data);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          // Log outgoing messages (except high-frequency ones)
          if (
            data &&
            data.type &&
            data.type !== "ping" &&
            data.type !== "input"
          ) {
            console.log(`[Network] → ${data.type}`);
          }
          this.ws.send(json);
        } catch (err) {
          console.error("[Network] Send error:", err);
          this._queue.push(json);
        }
      } else {
        // Queue for later
        if (data && data.type) {
          console.warn(
            `[Network] Queued (ws ${this.ws ? "readyState=" + this.ws.readyState : "null"}): ${data.type}`,
          );
        }
        this._queue.push(json);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Event Emitter
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Subscribe to a message type.
     * @param {string} type – message type or special events: 'open', 'close', 'error', 'reconnecting'
     * @param {function} callback
     * @returns {function} unsubscribe function
     */
    on(type, callback) {
      if (!this._listeners[type]) {
        this._listeners[type] = new Set();
      }
      this._listeners[type].add(callback);

      // Return unsubscribe function
      return () => {
        this._listeners[type]?.delete(callback);
      };
    }

    /**
     * Subscribe to a message type, but only fire once.
     * @param {string} type
     * @param {function} callback
     */
    once(type, callback) {
      const unsub = this.on(type, (data) => {
        unsub();
        callback(data);
      });
      return unsub;
    }

    /**
     * Remove all listeners for a given type, or all listeners if no type given.
     * @param {string} [type]
     */
    off(type) {
      if (type) {
        delete this._listeners[type];
      } else {
        this._listeners = {};
      }
    }

    /**
     * Emit an event to all listeners of the given type.
     * @param {string} type
     * @param {*} data
     */
    _emit(type, data) {
      const listeners = this._listeners[type];
      if (listeners) {
        for (const cb of listeners) {
          try {
            cb(data);
          } catch (err) {
            console.error(`[Network] Listener error for "${type}":`, err);
          }
        }
      }

      // Also emit a wildcard '*' event with { type, data }
      const wildcardListeners = this._listeners["*"];
      if (wildcardListeners) {
        for (const cb of wildcardListeners) {
          try {
            cb({ type, data });
          } catch (err) {
            console.error("[Network] Wildcard listener error:", err);
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Getters
    // ═══════════════════════════════════════════════════════════════════════════

    get latency() {
      return this._latency;
    }

    get playerId() {
      return this._playerId;
    }

    set playerId(id) {
      this._playerId = id;
    }

    get isConnected() {
      return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    get state() {
      if (!this.ws) return "disconnected";
      switch (this.ws.readyState) {
        case WebSocket.CONNECTING:
          return "connecting";
        case WebSocket.OPEN:
          return "connected";
        case WebSocket.CLOSING:
          return "closing";
        case WebSocket.CLOSED:
          return "disconnected";
        default:
          return "unknown";
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal handlers
    // ═══════════════════════════════════════════════════════════════════════════

    _onOpen(event, ws) {
      if (ws !== this.ws) return;
      const wasReconnect = this._reconnectAttempts > 0;
      console.log(`[Network] Connected${wasReconnect ? " (reconnect)" : ""}`);
      this.connected = true;
      this.reconnecting = false;
      this._reconnectAttempts = 0;

      // Start ping interval
      this._startPing();

      // Clear stale queued messages on reconnect to prevent
      // old set_profile / get_rooms etc. from interfering with new session
      if (wasReconnect && this._queue.length > 0) {
        console.warn(
          `[Network] Clearing ${this._queue.length} stale queued message(s)`,
        );
        this._queue = [];
      }

      // Flush any remaining queued messages
      this._flushQueue();

      this._emit("open", { reconnected: wasReconnect });
    }

    _onMessage(event, ws) {
      if (ws !== this.ws) return;
      const data = event.data;
      if (typeof data === "string") {
        this._handleMessageText(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        const text = new TextDecoder("utf-8").decode(data);
        this._handleMessageText(text);
        return;
      }
      if (data instanceof Blob) {
        data
          .text()
          .then((text) => this._handleMessageText(text))
          .catch(() => {
            console.warn("[Network] Received unreadable Blob message");
          });
        return;
      }
      console.warn("[Network] Received unsupported message type:", data);
    }

    _handleMessageText(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        console.warn("[Network] Received non-JSON message:", text);
        return;
      }

      if (!msg || !msg.type) {
        console.warn("[Network] Received message without type:", msg);
        return;
      }

      if (msg.type !== "pong") {
        console.log(
          `[Network] ← ${msg.type}` +
            (msg.playerId ? ` (pid=${msg.playerId})` : ""),
        );
      }

      if (msg.type === "pong") {
        if (this._lastPingSent > 0) {
          this._latency = Date.now() - this._lastPingSent;
        }
        this._emit("pong", { latency: this._latency, ts: msg.ts });
        return;
      }

      if (msg.type === "profile_set" && msg.playerId) {
        this._playerId = msg.playerId;
      }

      this._emit(msg.type, msg);
    }

    _onClose(event, ws) {
      if (ws !== this.ws) return;
      console.log(
        `[Network] Disconnected (code=${event.code}, reason="${event.reason || "none"}")`,
      );

      this.connected = false;
      this._clearTimers();

      this._emit("close", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      // Auto-reconnect unless intentional close or server shutdown
      if (!this.intentionalClose && event.code !== 1000) {
        this._scheduleReconnect();
      }
    }

    _onError(event, ws) {
      if (ws !== this.ws) return;
      console.error("[Network] WebSocket error:", event);
      // Emit as "ws_error" so it doesn't collide with server {type:"error"} messages
      this._emit("ws_error", { error: event });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Auto-reconnect
    // ═══════════════════════════════════════════════════════════════════════════

    _scheduleReconnect() {
      if (this.intentionalClose) return;
      if (this._reconnectTimer) return;

      this._reconnectAttempts++;
      this.reconnecting = true;

      // Exponential backoff with jitter
      const baseDelay = Math.min(
        RECONNECT_BASE_DELAY * Math.pow(1.5, this._reconnectAttempts - 1),
        RECONNECT_MAX_DELAY,
      );
      const jitter = Math.random() * 0.3 * baseDelay;
      const delay = Math.round(baseDelay + jitter);

      console.log(
        `[Network] Reconnecting in ${delay}ms (attempt #${this._reconnectAttempts})...`,
      );

      this._emit("reconnecting", {
        attempt: this._reconnectAttempts,
        delay,
      });

      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.connect();
      }, delay);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Ping / Latency
    // ═══════════════════════════════════════════════════════════════════════════

    _startPing() {
      this._clearPing();

      if (this.isConnected) {
        this._lastPingSent = Date.now();
        this.send({ type: "ping" });
      }

      this._pingInterval = setInterval(() => {
        if (this.isConnected) {
          this._lastPingSent = Date.now();
          this.send({ type: "ping" });
        }
      }, PING_INTERVAL);
    }

    _clearPing() {
      if (this._pingInterval) {
        clearInterval(this._pingInterval);
        this._pingInterval = null;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Queue
    // ═══════════════════════════════════════════════════════════════════════════

    _flushQueue() {
      while (this._queue.length > 0 && this.isConnected) {
        const msg = this._queue.shift();
        try {
          this.ws.send(msg);
        } catch (err) {
          console.error("[Network] Queue flush error:", err);
          this._queue.unshift(msg); // Put it back
          break;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Cleanup
    // ═══════════════════════════════════════════════════════════════════════════

    _clearTimers() {
      this._clearPing();
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
    }

    /**
     * Full cleanup — disconnect and remove all listeners.
     */
    destroy() {
      this.disconnect();
      this._listeners = {};
      this._queue = [];
      this._playerId = null;
      this._latency = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Export as global singleton
  // ═══════════════════════════════════════════════════════════════════════════

  window.Network = new Network();
})();
