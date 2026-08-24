// Play logging: the browser writes straight to Supabase.
//
// No Netlify Function in the path, deliberately. A function would cost compute
// and a web request per play against the Netlify credit budget; going direct
// costs nothing there. The endpoint, the key and the anonymous id are shared
// with the draft rooms -- see supabase.js for why they are safe in a bundle.

import { clientId, rpcUrl, rpcHeaders } from './supabase.js';

const URL = rpcUrl('log_play');

const QUEUE_KEY = 'r75:logq';
const MAX_QUEUED = 40;

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
    headers: rpcHeaders(),
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
