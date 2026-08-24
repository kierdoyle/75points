// The one Supabase endpoint the game talks to, and the anonymous id it talks
// with.
//
// supabase-js is deliberately absent: it is ~40 KB gzipped, which would undo
// much of what content-hashing the data files saved. Everything here is one
// fetch against PostgREST.
//
// The publishable key is public by design and ships in the bundle. It is safe
// because the database grants it nothing but EXECUTE on a handful of
// SECURITY DEFINER functions -- it cannot read or write a single table
// directly. See supabase/schema.sql and supabase/rooms.sql.

export const SUPABASE_URL = 'https://pjhprpvmzwqqkfdhavmp.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_OaQ2V_PP6rzek7iHPTw7BA_PVLsPkvf';

const CLIENT_KEY = 'r75:client';

/**
 * A stable anonymous id. Identifies a seat in a draft room, and lets repeat
 * players be counted in the logs without anyone being identified.
 *
 * In development, ?client=<name> gives a tab its own identity, which is how
 * one browser can hold several seats in the same draft room.
 */
export function clientId() {
  try {
    let key = CLIENT_KEY;
    if (import.meta.env.DEV) {
      const tag = new URLSearchParams(window.location.search).get('client');
      if (tag) key = `${CLIENT_KEY}:${tag}`;
    }
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    // Private mode: still works, just without cross-session continuity.
    return crypto.randomUUID();
  }
}

export const rpcUrl = (fn) => `${SUPABASE_URL}/rest/v1/rpc/${fn}`;

export const rpcHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
});

/**
 * Call a database function and return its JSON result.
 *
 * Throws on transport or database errors, unlike the logging path -- a room
 * that cannot reach the server has to say so rather than carry on with a
 * stale board.
 */
export async function rpc(fn, body, { signal } = {}) {
  // Development only, and stripped from the production bundle: play a room
  // with no database behind it. See roommock.js.
  if (import.meta.env.DEV) {
    const { mockEnabled, mockRpc } = await import('./roommock.js');
    if (mockEnabled()) return mockRpc(fn, body);
  }
  const res = await fetch(rpcUrl(fn), {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${fn} failed (${res.status}) ${detail.slice(0, 200)}`);
  }
  return res.json();
}
