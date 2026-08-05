// Play logging: the browser writes straight to Supabase.
//
// No Netlify Function in the path, deliberately. A function would cost compute
// and a web request per play against the Netlify credit budget; going direct
// costs nothing there. supabase-js is skipped for the same reason -- it is
// ~40 KB gzipped, which would undo much of what content-hashing the data files
// just saved. This is one fetch against PostgREST.
//
// The publishable key below is public by design and ships in the bundle. It is
// safe because the database grants it exactly one privilege: EXECUTE on
// log_play(). It cannot read anything, and it cannot touch the tables
// directly. See supabase/schema.sql.

const URL = 'https://pjhprpvmzwqqkfdhavmp.supabase.co/rest/v1/rpc/log_play';
const KEY = 'sb_publishable_OaQ2V_PP6rzek7iHPTw7BA_PVLsPkvf';

const CLIENT_KEY = 'r75:client';
const QUEUE_KEY = 'r75:logq';
const MAX_QUEUED = 40;

/** A stable anonymous id, so repeat players can be counted without anyone
 *  being identified. Nothing else about the player is stored. */
function clientId() {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch {
    // Private mode: still log, just without cross-session continuity.
    return crypto.randomUUID();
  }
}

const readQueue = () => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
};

const writeQueue = (q) => {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUED))); } catch { /* full */ }
};

/**
 * Post one payload. Returns true if the server accepted it.
 *
 * keepalive lets the request outlive the page, which matters because the most
 * important write happens on the results screen -- exactly where people close
 * the tab. sendBeacon would not work here: it cannot set the apikey header.
 */
async function post(payload) {
  const res = await fetch(URL, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ payload }),
  });
  return res.ok;
}

/**
 * Send a payload, and if it fails put it in a queue to retry next visit.
 *
 * Logging must never be able to break the game, so every path here swallows
 * its errors. A dropped play is a hole in the data; a thrown one would be a
 * hole in someone's season.
 */
export async function logPlay(payload) {
  const body = { ...payload, client_id: clientId() };
  try {
    if (await post(body)) return true;
  } catch { /* offline, blocked, project paused */ }
  const q = readQueue();
  q.push(body);
  writeQueue(q);
  return false;
}

/** Retry anything a previous session could not deliver. Called once on boot. */
export async function flushQueue() {
  const q = readQueue();
  if (!q.length) return;
  const left = [];
  for (const payload of q) {
    try {
      if (!await post(payload)) left.push(payload);
    } catch { left.push(payload); }
  }
  writeQueue(left);
}

/** The pool file's content hash: which dataset a play was drafted from. */
export function dataVersion(poolUrl) {
  const m = /-([A-Za-z0-9_-]+)\.json/.exec(poolUrl || '');
  return m ? m[1] : null;
}
