'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { sanitizeSettings } = require('./validate');

/**
 * User storage on SQLite (built into Node 22).
 * Every query is a prepared statement with bound parameters, so user input is never
 * concatenated into SQL (this is what prevents SQL injection).
 */
function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    username   TEXT PRIMARY KEY,
    pw_hash    TEXT NOT NULL,
    settings   TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  const q = {
    get: db.prepare('SELECT username, pw_hash, settings, created_at, updated_at FROM users WHERE username = ?'),
    insert: db.prepare('INSERT INTO users (username, pw_hash, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    updateSettings: db.prepare('UPDATE users SET settings = ?, updated_at = ? WHERE username = ?'),
    replace: db.prepare('UPDATE users SET pw_hash = ?, settings = ?, created_at = ?, updated_at = ? WHERE username = ?'),
    all: db.prepare('SELECT username, pw_hash, settings, created_at, updated_at FROM users ORDER BY username'),
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
  };

  function toUser(row) {
    if (!row) return null;
    let settings = {};
    try {
      settings = JSON.parse(row.settings);
    } catch { /* fall back to defaults */ }
    return {
      username: row.username,
      pwHash: row.pw_hash,
      settings: sanitizeSettings(settings),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    getUser: (username) => toUser(q.get.get(username)),
    listUsers: () => q.all.all().map(toUser),
    countUsers: () => Number(q.count.get().n),

    /** Returns false if the username already exists. */
    createUser({ username, pwHash, settings, now = Date.now() }) {
      try {
        q.insert.run(username, pwHash, JSON.stringify(sanitizeSettings(settings)), now, now);
        return true;
      } catch (err) {
        if (/UNIQUE|constraint/i.test(String(err.message))) return false;
        throw err;
      }
    },

    updateSettings(username, settings, now = Date.now()) {
      const existing = q.get.get(username);
      if (!existing) return null;
      const updatedAt = Math.max(now, existing.updated_at + 1);
      q.updateSettings.run(JSON.stringify(sanitizeSettings(settings)), updatedAt, username);
      return toUser(q.get.get(username));
    },

    /** Apply a record from a peer server (last write wins). Returns true if applied. */
    upsertReplicated(user) {
      const existing = q.get.get(user.username);
      if (!existing) {
        q.insert.run(user.username, user.pwHash, JSON.stringify(user.settings), user.createdAt, user.updatedAt);
        return true;
      }
      if (user.updatedAt > existing.updated_at) {
        q.replace.run(user.pwHash, JSON.stringify(user.settings), user.createdAt, user.updatedAt, user.username);
        return true;
      }
      return false;
    },

    close: () => db.close(),
  };
}

module.exports = { openStore };
