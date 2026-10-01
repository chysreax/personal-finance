/**
 * Conflict-free merge of two replicas. Every record carries `updatedAt` and
 * deletes are tombstones, so merging is a per-record last-writer-wins union —
 * commutative, associative and idempotent (a state-based LWW-element-set).
 * Two devices editing different records offline never lose each other's work.
 */
import { COLLECTIONS } from './schema.js';

const TOMBSTONE_TTL = 120 * 86_400_000;

/** Deterministic tie-break so every replica picks the same winner. */
function newer(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (a.deleted !== b.deleted) return a.deleted; // delete wins ties
  return JSON.stringify(a) > JSON.stringify(b);
}

/**
 * @param {object} local
 * @param {object} remote
 * @returns {{data: object, stats: {localWins: number, remoteWins: number, conflicts: number}}}
 *   localWins > 0 means remote is missing something we have → push required.
 */
export function mergeData(local, remote) {
  const stats = { localWins: 0, remoteWins: 0, conflicts: 0 };
  const data = { schema: local.schema };
  for (const c of COLLECTIONS) {
    const map = new Map();
    for (const r of remote[c] || []) map.set(r.id, r);
    for (const l of local[c] || []) {
      const r = map.get(l.id);
      if (!r) {
        map.set(l.id, l);
        stats.localWins++;
      } else if (r === l || (r.updatedAt === l.updatedAt && JSON.stringify(r) === JSON.stringify(l))) {
        // identical
      } else if (newer(l, r)) {
        map.set(l.id, l);
        stats.localWins++;
        stats.conflicts++;
      } else {
        stats.remoteWins++;
        stats.conflicts++;
      }
    }
    const localIds = new Set((local[c] || []).map((x) => x.id));
    for (const r of remote[c] || []) if (!localIds.has(r.id)) stats.remoteWins++;
    data[c] = [...map.values()];
  }
  const ls = local.settings || {};
  const rs = remote.settings || {};
  if ((ls.updatedAt || 0) > (rs.updatedAt || 0)) {
    data.settings = ls;
    stats.localWins++;
  } else {
    data.settings = rs.updatedAt !== undefined ? rs : ls;
    if ((rs.updatedAt || 0) > (ls.updatedAt || 0)) stats.remoteWins++;
  }
  return { data, stats };
}

/** Drop tombstones old enough that every active device has seen them. */
export function pruneTombstones(data, now = Date.now()) {
  const out = { ...data };
  for (const c of COLLECTIONS) {
    out[c] = (data[c] || []).filter((r) => !r.deleted || now - r.updatedAt < TOMBSTONE_TTL);
  }
  return out;
}
