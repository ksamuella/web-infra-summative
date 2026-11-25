'use strict';

const { validateWireUser } = require('./validate');

/**
 * Replicates user accounts between the web servers.
 *
 * Each server keeps its own SQLite file. When a user registers or changes settings, the
 * server pushes the record to its peers; every 30 s each server also pulls from its peers
 * to catch anything it missed (for example after a restart). Conflicts: last write wins.
 * Requests are authenticated with a shared secret in the X-Sync-Secret header.
 */
function createSync({ store, peers, secret, fetchImpl = fetch, log = console }) {
  const headers = { 'content-type': 'application/json', 'x-sync-secret': secret };

  async function pushUsers(users) {
    const results = await Promise.allSettled(peers.map(async (peer) => {
      const res = await fetchImpl(`${peer}/internal/sync`, {
        method: 'POST', headers, body: JSON.stringify({ users }), signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }));
    results.forEach((r, i) => {
      if (r.status === 'rejected') log.warn(`[sync] push to ${peers[i]} failed: ${r.reason.message}`);
    });
  }

  async function pullAll() {
    let applied = 0;
    for (const peer of peers) {
      try {
        const res = await fetchImpl(`${peer}/internal/users`, { headers, signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        for (const raw of Array.isArray(body.users) ? body.users : []) {
          const user = validateWireUser(raw);
          if (user && store.upsertReplicated(user)) applied += 1;
        }
      } catch (err) {
        log.warn(`[sync] pull from ${peer} failed: ${err.message}`);
      }
    }
    return applied;
  }

  let timer = null;
  function start(intervalMs = 30000) {
    if (!peers.length || timer) return;
    pullAll();
    timer = setInterval(pullAll, intervalMs);
    timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { peers, pushUsers, pullAll, start, stop };
}

module.exports = { createSync };
