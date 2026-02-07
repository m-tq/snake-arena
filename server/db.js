// db.js — SQLite persistent database for Snake Arena (better-sqlite3)
// Stores: player profiles, player stats, game history, global leaderboard
// Drop-in replacement for the old JSON-based db — same exported API
// Auto-migrates existing JSON data on first run

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

// ─── Configuration ───────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "snake_arena.db");

// Old JSON files (for migration)
const OLD_PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const OLD_STATS_FILE = path.join(DATA_DIR, "stats.json");
const OLD_HISTORY_FILE = path.join(DATA_DIR, "history.json");

const MAX_HISTORY_ENTRIES = 500;

let db = null;
let initialized = false;

// ─── Prepared statements (lazily assigned after init) ────────────────────────
let stmts = {};

// ═════════════════════════════════════════════════════════════════════════════
//  Initialization
// ═════════════════════════════════════════════════════════════════════════════

function init() {
  if (initialized) return;

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log("[DB] Created data directory:", DATA_DIR);
  }

  // Open / create the SQLite database
  db = new Database(DB_PATH);

  // Performance pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -8000"); // 8 MB
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Create tables
  _createSchema();

  // Prepare statements
  _prepareStatements();

  // Migrate from old JSON files if they exist and DB is empty
  _migrateFromJSON();

  initialized = true;

  const playerCount = getPlayerCount();
  const statsCount = _countStats();
  const historyCount = getGameCount();
  console.log(
    `[DB] SQLite ready: ${playerCount} players, ${statsCount} stat records, ${historyCount} game history entries`,
  );
}

function _createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id          TEXT PRIMARY KEY,
      username    TEXT NOT NULL DEFAULT 'Anonymous',
      color       TEXT NOT NULL DEFAULT '#3A4DFF',
      pattern     TEXT NOT NULL DEFAULT 'classic',
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stats (
      player_id        TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      games_played     INTEGER NOT NULL DEFAULT 0,
      games_won        INTEGER NOT NULL DEFAULT 0,
      total_score      INTEGER NOT NULL DEFAULT 0,
      total_kills      INTEGER NOT NULL DEFAULT 0,
      total_deaths     INTEGER NOT NULL DEFAULT 0,
      highest_score    INTEGER NOT NULL DEFAULT 0,
      longest_snake    INTEGER NOT NULL DEFAULT 0,
      total_food_eaten INTEGER NOT NULL DEFAULT 0,
      total_playtime_ms INTEGER NOT NULL DEFAULT 0,
      best_rank        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS games (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      room_name         TEXT,
      game_mode         TEXT,
      grid_size         TEXT,
      player_count      INTEGER NOT NULL DEFAULT 0,
      winner_id         TEXT,
      winner_name       TEXT,
      duration_seconds  INTEGER NOT NULL DEFAULT 0,
      played_at         INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_players (
      game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id   TEXT NOT NULL,
      username    TEXT NOT NULL DEFAULT '???',
      rank        INTEGER NOT NULL DEFAULT 0,
      score       INTEGER NOT NULL DEFAULT 0,
      kills       INTEGER NOT NULL DEFAULT 0,
      length      INTEGER NOT NULL DEFAULT 0,
      alive       INTEGER NOT NULL DEFAULT 0,
      death_cause TEXT,
      PRIMARY KEY (game_id, player_id)
    );

    CREATE INDEX IF NOT EXISTS idx_games_played_at ON games(played_at);
    CREATE INDEX IF NOT EXISTS idx_game_players_player ON game_players(player_id);
    CREATE INDEX IF NOT EXISTS idx_stats_total_score ON stats(total_score);
    CREATE INDEX IF NOT EXISTS idx_stats_games_won ON stats(games_won);
    CREATE INDEX IF NOT EXISTS idx_stats_total_kills ON stats(total_kills);
    CREATE INDEX IF NOT EXISTS idx_stats_highest_score ON stats(highest_score);
    CREATE INDEX IF NOT EXISTS idx_stats_games_played ON stats(games_played);
    CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen);
  `);
}

function _prepareStatements() {
  stmts = {
    // Players
    getPlayer: db.prepare("SELECT * FROM players WHERE id = ?"),
    insertPlayer: db.prepare(
      `INSERT INTO players (id, username, color, pattern, created_at, last_seen)
       VALUES (@id, @username, @color, @pattern, @created_at, @last_seen)`,
    ),
    updatePlayer: db.prepare(
      `UPDATE players SET username = @username, color = @color, pattern = @pattern, last_seen = @last_seen
       WHERE id = @id`,
    ),
    countPlayers: db.prepare("SELECT COUNT(*) AS cnt FROM players"),
    allPlayers: db.prepare("SELECT * FROM players"),

    // Stats
    getStats: db.prepare("SELECT * FROM stats WHERE player_id = ?"),
    insertStats: db.prepare(
      `INSERT INTO stats (player_id, games_played, games_won, total_score, total_kills,
        total_deaths, highest_score, longest_snake, total_food_eaten, total_playtime_ms, best_rank)
       VALUES (@player_id, @games_played, @games_won, @total_score, @total_kills,
        @total_deaths, @highest_score, @longest_snake, @total_food_eaten, @total_playtime_ms, @best_rank)`,
    ),
    updateStats: db.prepare(
      `UPDATE stats SET
        games_played = @games_played,
        games_won = @games_won,
        total_score = @total_score,
        total_kills = @total_kills,
        total_deaths = @total_deaths,
        highest_score = @highest_score,
        longest_snake = @longest_snake,
        total_food_eaten = @total_food_eaten,
        total_playtime_ms = @total_playtime_ms,
        best_rank = @best_rank
       WHERE player_id = @player_id`,
    ),
    countStats: db.prepare("SELECT COUNT(*) AS cnt FROM stats"),

    // Games
    insertGame: db.prepare(
      `INSERT INTO games (room_name, game_mode, grid_size, player_count, winner_id, winner_name, duration_seconds, played_at)
       VALUES (@room_name, @game_mode, @grid_size, @player_count, @winner_id, @winner_name, @duration_seconds, @played_at)`,
    ),
    insertGamePlayer: db.prepare(
      `INSERT INTO game_players (game_id, player_id, username, rank, score, kills, length, alive, death_cause)
       VALUES (@game_id, @player_id, @username, @rank, @score, @kills, @length, @alive, @death_cause)`,
    ),
    recentGames: db.prepare(
      "SELECT * FROM games ORDER BY played_at DESC LIMIT ?",
    ),
    playerGames: db.prepare(
      `SELECT g.* FROM games g
       INNER JOIN game_players gp ON gp.game_id = g.id
       WHERE gp.player_id = ?
       ORDER BY g.played_at DESC
       LIMIT ?`,
    ),
    gamePlayers: db.prepare(
      "SELECT * FROM game_players WHERE game_id = ? ORDER BY rank ASC",
    ),
    countGames: db.prepare("SELECT COUNT(*) AS cnt FROM games"),

    // Leaderboard — dynamic sort is handled in code, we fetch all non-zero stats
    leaderboardBase: db.prepare(
      `SELECT s.*, p.username, p.color, p.pattern
       FROM stats s
       INNER JOIN players p ON p.id = s.player_id
       WHERE s.games_played > 0`,
    ),

    // Leaderboard summaries
    globalSummary: db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM players) AS total_players,
         (SELECT COUNT(*) FROM games) AS total_games,
         COALESCE((SELECT SUM(total_kills) FROM stats), 0) AS total_kills,
         COALESCE((SELECT SUM(total_score) FROM stats), 0) AS total_score,
         COALESCE((SELECT SUM(games_played) FROM stats), 0) AS total_games_played`,
    ),

    // History trimming
    oldestGameIds: db.prepare(
      `SELECT id FROM games ORDER BY played_at ASC LIMIT ?`,
    ),
    deleteGamePlayers: db.prepare("DELETE FROM game_players WHERE game_id = ?"),
    deleteGame: db.prepare("DELETE FROM games WHERE id = ?"),

    // Touch player last_seen
    touchPlayer: db.prepare("UPDATE players SET last_seen = ? WHERE id = ?"),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  JSON Migration
// ═════════════════════════════════════════════════════════════════════════════

function _migrateFromJSON() {
  const playerCount = getPlayerCount();
  if (playerCount > 0) {
    // DB already has data, skip migration
    return;
  }

  let migrated = false;

  // Migrate players
  if (fs.existsSync(OLD_PLAYERS_FILE)) {
    try {
      const raw = fs.readFileSync(OLD_PLAYERS_FILE, "utf-8");
      const players = JSON.parse(raw);
      const insertMany = db.transaction((entries) => {
        for (const [id, p] of entries) {
          stmts.insertPlayer.run({
            id: id,
            username: p.username || "Anonymous",
            color: p.color || "#3A4DFF",
            pattern: p.pattern || "classic",
            created_at: p.createdAt || Date.now(),
            last_seen: p.lastSeen || Date.now(),
          });
        }
      });
      const entries = Object.entries(players);
      if (entries.length > 0) {
        insertMany(entries);
        console.log(`[DB] Migrated ${entries.length} players from JSON`);
        migrated = true;
      }
    } catch (err) {
      console.error("[DB] Error migrating players:", err.message);
    }
  }

  // Migrate stats
  if (fs.existsSync(OLD_STATS_FILE)) {
    try {
      const raw = fs.readFileSync(OLD_STATS_FILE, "utf-8");
      const allStats = JSON.parse(raw);
      const insertMany = db.transaction((entries) => {
        for (const [playerId, s] of entries) {
          // Only insert stats for players that exist
          const player = stmts.getPlayer.get(playerId);
          if (!player) continue;

          stmts.insertStats.run({
            player_id: playerId,
            games_played: s.gamesPlayed || 0,
            games_won: s.gamesWon || 0,
            total_score: s.totalScore || 0,
            total_kills: s.totalKills || 0,
            total_deaths: s.totalDeaths || 0,
            highest_score: s.highestScore || 0,
            longest_snake: s.longestSnake || 0,
            total_food_eaten: s.totalFoodEaten || 0,
            total_playtime_ms: s.totalPlaytimeMs || 0,
            best_rank: s.bestRank || 0,
          });
        }
      });
      const entries = Object.entries(allStats);
      if (entries.length > 0) {
        insertMany(entries);
        console.log(`[DB] Migrated ${entries.length} stat records from JSON`);
        migrated = true;
      }
    } catch (err) {
      console.error("[DB] Error migrating stats:", err.message);
    }
  }

  // Migrate game history
  if (fs.existsSync(OLD_HISTORY_FILE)) {
    try {
      const raw = fs.readFileSync(OLD_HISTORY_FILE, "utf-8");
      const history = JSON.parse(raw);
      if (Array.isArray(history) && history.length > 0) {
        const insertMany = db.transaction((games) => {
          for (const g of games) {
            const info = stmts.insertGame.run({
              room_name: g.roomName || "Unknown",
              game_mode: g.gameMode || "last_standing",
              grid_size: g.gridSize || "medium",
              player_count: g.playerCount || 0,
              winner_id: g.winnerId || null,
              winner_name: g.winnerName || null,
              duration_seconds: g.durationSeconds || 0,
              played_at: g.playedAt || Date.now(),
            });
            const gameId = info.lastInsertRowid;

            if (Array.isArray(g.players)) {
              for (const p of g.players) {
                stmts.insertGamePlayer.run({
                  game_id: gameId,
                  player_id: p.playerId || p.id || "unknown",
                  username: p.username || "???",
                  rank: p.rank || 0,
                  score: p.score || 0,
                  kills: p.kills || 0,
                  length: p.length || 0,
                  alive: p.alive ? 1 : 0,
                  death_cause: p.deathCause || null,
                });
              }
            }
          }
        });
        insertMany(history);
        console.log(
          `[DB] Migrated ${history.length} game history entries from JSON`,
        );
        migrated = true;
      }
    } catch (err) {
      console.error("[DB] Error migrating history:", err.message);
    }
  }

  if (migrated) {
    // Rename old JSON files so they aren't re-migrated
    const rename = (f) => {
      if (fs.existsSync(f)) {
        try {
          fs.renameSync(f, f + ".migrated");
        } catch {
          // ignore
        }
      }
    };
    rename(OLD_PLAYERS_FILE);
    rename(OLD_STATS_FILE);
    rename(OLD_HISTORY_FILE);
    console.log(
      "[DB] JSON → SQLite migration complete, old files renamed to .migrated",
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Player Profiles
// ═════════════════════════════════════════════════════════════════════════════

function getPlayer(playerId) {
  const row = stmts.getPlayer.get(playerId);
  if (!row) return null;
  return _rowToPlayer(row);
}

function upsertPlayer(playerId, username, color, pattern) {
  const now = Date.now();
  const existing = stmts.getPlayer.get(playerId);

  if (existing) {
    const params = {
      id: playerId,
      username: username || existing.username,
      color: color || existing.color,
      pattern: pattern || existing.pattern,
      last_seen: now,
    };
    stmts.updatePlayer.run(params);

    return _rowToPlayer({ ...existing, ...params });
  }

  // New player
  const player = {
    id: playerId,
    username: username || "Anonymous",
    color: color || "#3A4DFF",
    pattern: pattern || "classic",
    created_at: now,
    last_seen: now,
  };
  stmts.insertPlayer.run(player);

  // Initialize empty stats
  const existingStats = stmts.getStats.get(playerId);
  if (!existingStats) {
    stmts.insertStats.run({
      player_id: playerId,
      games_played: 0,
      games_won: 0,
      total_score: 0,
      total_kills: 0,
      total_deaths: 0,
      highest_score: 0,
      longest_snake: 0,
      total_food_eaten: 0,
      total_playtime_ms: 0,
      best_rank: 0,
    });
  }

  return _rowToPlayer(player);
}

function hasPlayer(playerId) {
  const row = stmts.getPlayer.get(playerId);
  return !!row;
}

function getAllPlayers() {
  const rows = stmts.allPlayers.all();
  return rows.map(_rowToPlayer);
}

function getPlayerCount() {
  const row = stmts.countPlayers.get();
  return row ? row.cnt : 0;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Player Stats
// ═════════════════════════════════════════════════════════════════════════════

function getStats(playerId) {
  const row = stmts.getStats.get(playerId);
  if (!row) return null;
  return _rowToStats(row);
}

function getPlayerWithStats(playerId) {
  const playerRow = stmts.getPlayer.get(playerId);
  if (!playerRow) return null;

  const statsRow = stmts.getStats.get(playerId);
  const player = _rowToPlayer(playerRow);
  const stats = statsRow ? _rowToStats(statsRow) : _emptyStats(playerId);

  return {
    ...player,
    stats: { ...stats },
  };
}

function recordPlayerGameResult(playerId, result) {
  let row = stmts.getStats.get(playerId);

  if (!row) {
    // Create empty stats row first
    stmts.insertStats.run({
      player_id: playerId,
      games_played: 0,
      games_won: 0,
      total_score: 0,
      total_kills: 0,
      total_deaths: 0,
      highest_score: 0,
      longest_snake: 0,
      total_food_eaten: 0,
      total_playtime_ms: 0,
      best_rank: 0,
    });
    row = stmts.getStats.get(playerId);
  }

  const gamesPlayed = row.games_played + 1;
  const gamesWon = row.games_won + (result.won ? 1 : 0);
  const totalScore = row.total_score + (result.score || 0);
  const totalKills = row.total_kills + (result.kills || 0);
  const totalDeaths = row.total_deaths + (!result.alive ? 1 : 0);
  const highestScore = Math.max(row.highest_score, result.score || 0);
  const longestSnake = Math.max(row.longest_snake, result.length || 0);
  const totalFoodEaten = row.total_food_eaten + (result.foodEaten || 0);
  const totalPlaytimeMs = row.total_playtime_ms + (result.durationMs || 0);
  let bestRank = row.best_rank;
  if (result.rank && (bestRank === 0 || result.rank < bestRank)) {
    bestRank = result.rank;
  }

  stmts.updateStats.run({
    player_id: playerId,
    games_played: gamesPlayed,
    games_won: gamesWon,
    total_score: totalScore,
    total_kills: totalKills,
    total_deaths: totalDeaths,
    highest_score: highestScore,
    longest_snake: longestSnake,
    total_food_eaten: totalFoodEaten,
    total_playtime_ms: totalPlaytimeMs,
    best_rank: bestRank,
  });

  // Touch player last_seen
  stmts.touchPlayer.run(Date.now(), playerId);
}

// ═════════════════════════════════════════════════════════════════════════════
//  Game History
// ═════════════════════════════════════════════════════════════════════════════

const _recordGameTx = null; // assigned lazily

function recordGame(gameData) {
  const doRecord = db.transaction((data) => {
    const info = stmts.insertGame.run({
      room_name: data.roomName || "Unknown",
      game_mode: data.gameMode || "last_standing",
      grid_size: data.gridSize || "medium",
      player_count: data.playerCount || 0,
      winner_id: data.winnerId || null,
      winner_name: data.winnerName || null,
      duration_seconds: data.durationSeconds || 0,
      played_at: Date.now(),
    });

    const gameId = Number(info.lastInsertRowid);

    const players = data.players || [];
    for (const p of players) {
      stmts.insertGamePlayer.run({
        game_id: gameId,
        player_id: p.playerId || p.id || "unknown",
        username: p.username || "???",
        rank: p.rank || 0,
        score: p.score || 0,
        kills: p.kills || 0,
        length: p.length || 0,
        alive: p.alive ? 1 : 0,
        death_cause: p.deathCause || null,
      });
    }

    // Trim old history if exceeding max
    _trimHistory();

    return {
      id: gameId,
      roomName: data.roomName || "Unknown",
      gameMode: data.gameMode || "last_standing",
      gridSize: data.gridSize || "medium",
      playerCount: data.playerCount || 0,
      winnerId: data.winnerId || null,
      winnerName: data.winnerName || null,
      durationSeconds: data.durationSeconds || 0,
      playedAt: Date.now(),
      players: players.map((p) => ({
        playerId: p.playerId || p.id,
        username: p.username || "???",
        rank: p.rank || 0,
        score: p.score || 0,
        kills: p.kills || 0,
        length: p.length || 0,
        alive: !!p.alive,
        deathCause: p.deathCause || null,
      })),
    };
  });

  return doRecord(gameData);
}

function getRecentGames(limit) {
  limit = limit || 20;
  const rows = stmts.recentGames.all(limit);
  return rows.map((row) => {
    const players = stmts.gamePlayers.all(row.id);
    return _rowToGame(row, players);
  });
}

function getPlayerGames(playerId, limit) {
  limit = limit || 20;
  const rows = stmts.playerGames.all(playerId, limit);
  return rows.map((row) => {
    const players = stmts.gamePlayers.all(row.id);
    return _rowToGame(row, players);
  });
}

function getGameCount() {
  const row = stmts.countGames.get();
  return row ? row.cnt : 0;
}

function _trimHistory() {
  const countRow = stmts.countGames.get();
  const total = countRow ? countRow.cnt : 0;

  if (total <= MAX_HISTORY_ENTRIES) return;

  const excess = total - MAX_HISTORY_ENTRIES;
  const oldGames = stmts.oldestGameIds.all(excess);

  for (const g of oldGames) {
    stmts.deleteGamePlayers.run(g.id);
    stmts.deleteGame.run(g.id);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Global Leaderboard
// ═════════════════════════════════════════════════════════════════════════════

function getGlobalLeaderboard(sortBy, limit) {
  sortBy = sortBy || "totalScore";
  limit = limit || 20;

  // Map camelCase sort fields to their DB column equivalent for value extraction
  const fieldMap = {
    totalScore: "total_score",
    gamesWon: "games_won",
    totalKills: "total_kills",
    highestScore: "highest_score",
    longestSnake: "longest_snake",
    gamesPlayed: "games_played",
  };

  const dbField = fieldMap[sortBy];
  if (!dbField) {
    // Fallback
    sortBy = "totalScore";
  }

  const rows = stmts.leaderboardBase.all();

  // Build entries
  const entries = rows.map((row) => {
    const stats = {
      gamesPlayed: row.games_played,
      gamesWon: row.games_won,
      totalScore: row.total_score,
      totalKills: row.total_kills,
      totalDeaths: row.total_deaths,
      highestScore: row.highest_score,
      longestSnake: row.longest_snake,
    };

    return {
      playerId: row.player_id,
      username: row.username,
      color: row.color,
      pattern: row.pattern,
      value: stats[sortBy] || 0,
      stats,
    };
  });

  // Sort descending by value
  entries.sort((a, b) => b.value - a.value);

  // Take top N and add ranks
  return entries.slice(0, limit).map((e, i) => ({
    rank: i + 1,
    ...e,
  }));
}

function getGlobalSummary() {
  const row = stmts.globalSummary.get();
  return {
    totalPlayers: row ? row.total_players : 0,
    totalGames: row ? row.total_games : 0,
    totalKills: row ? row.total_kills : 0,
    totalScore: row ? row.total_score : 0,
    totalGamesPlayed: row ? row.total_games_played : 0,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Persistence — saveAll / flush / shutdown (SQLite handles this natively)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * No-op for SQLite — writes are immediate.
 * Kept for API compatibility with the rest of the codebase.
 */
function saveAll() {
  // SQLite in WAL mode auto-persists; checkpoint if desired
  if (db) {
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      // ignore
    }
  }
}

/**
 * Force a WAL checkpoint to ensure all data is flushed to the main DB file.
 */
function flush() {
  if (db) {
    try {
      db.pragma("wal_checkpoint(FULL)");
    } catch {
      // ignore
    }
  }
}

/**
 * Shutdown the database: checkpoint WAL and close the connection.
 */
function shutdown() {
  if (db) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    } catch (err) {
      console.error("[DB] Error during shutdown:", err.message);
    }
    db = null;
  }
  initialized = false;
  console.log("[DB] Shutdown complete");
}

// ═════════════════════════════════════════════════════════════════════════════
//  Internal Helpers
// ═════════════════════════════════════════════════════════════════════════════

function _rowToPlayer(row) {
  return {
    id: row.id,
    username: row.username,
    color: row.color,
    pattern: row.pattern,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

function _rowToStats(row) {
  return {
    playerId: row.player_id,
    gamesPlayed: row.games_played,
    gamesWon: row.games_won,
    totalScore: row.total_score,
    totalKills: row.total_kills,
    totalDeaths: row.total_deaths,
    highestScore: row.highest_score,
    longestSnake: row.longest_snake,
    totalFoodEaten: row.total_food_eaten,
    totalPlaytimeMs: row.total_playtime_ms,
    bestRank: row.best_rank,
  };
}

function _rowToGame(gameRow, playerRows) {
  return {
    id: gameRow.id,
    roomName: gameRow.room_name,
    gameMode: gameRow.game_mode,
    gridSize: gameRow.grid_size,
    playerCount: gameRow.player_count,
    winnerId: gameRow.winner_id,
    winnerName: gameRow.winner_name,
    durationSeconds: gameRow.duration_seconds,
    playedAt: gameRow.played_at,
    players: (playerRows || []).map((p) => ({
      playerId: p.player_id,
      username: p.username,
      rank: p.rank,
      score: p.score,
      kills: p.kills,
      length: p.length,
      alive: !!p.alive,
      deathCause: p.death_cause,
    })),
  };
}

function _emptyStats(playerId) {
  return {
    playerId,
    gamesPlayed: 0,
    gamesWon: 0,
    totalScore: 0,
    totalKills: 0,
    totalDeaths: 0,
    highestScore: 0,
    longestSnake: 0,
    totalFoodEaten: 0,
    totalPlaytimeMs: 0,
    bestRank: 0,
  };
}

function _countStats() {
  const row = stmts.countStats.get();
  return row ? row.cnt : 0;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Exports — same interface as the old JSON db
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Lifecycle
  init,
  saveAll,
  flush,
  shutdown,

  // Players
  getPlayer,
  upsertPlayer,
  hasPlayer,
  getAllPlayers,
  getPlayerCount,

  // Stats
  getStats,
  getPlayerWithStats,
  recordPlayerGameResult,

  // Game History
  recordGame,
  getRecentGames,
  getPlayerGames,
  getGameCount,

  // Leaderboard
  getGlobalLeaderboard,
  getGlobalSummary,
};
