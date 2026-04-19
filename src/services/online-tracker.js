/**
 * Tracks online users with a sliding time window.
 */
import { ONLINE_THRESHOLD_MS } from '../constants.js';

const onlineUsers = new Map();

export function trackUser(username) {
  onlineUsers.set(username, Date.now());
}

export function getOnlineUserCount() {
  const now = Date.now();
  for (const [u, t] of onlineUsers) {
    if (now - t > ONLINE_THRESHOLD_MS) onlineUsers.delete(u);
  }
  return onlineUsers.size;
}

export function pruneOfflineUsers() {
  const now = Date.now();
  for (const [u, t] of onlineUsers) {
    if (now - t > ONLINE_THRESHOLD_MS) onlineUsers.delete(u);
  }
}
