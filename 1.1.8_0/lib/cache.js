/**
 * chrome.storage.local cache helpers with per-entry TTL.
 *
 * Entry shape: { data: any, timestamp: number }. TTL is checked on read.
 * Exposed via globalThis.HltbCache so the service worker can importScripts it.
 */
(function attachCache(global) {
  // Bumped to v2 when the matcher learned to disambiguate same-named games
  // by release year: entries cached before that may point at the wrong
  // edition (the 2001 "Silent Hill 2" on the 2024 remake's page), so the new
  // prefix retires them instead of serving them for another week.
  const GAME_KEY_PREFIX = "hltb_game_v2_";
  // Every game key ever used, current and legacy — clearing and counting
  // scan on this so v1 leftovers don't linger in storage forever.
  const GAME_KEY_SCAN_PREFIX = "hltb_game_";
  const ENDPOINT_KEY = "hltb_endpoint";
  const GAME_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — real matches
  // Negative cache (no HLTB match found). Shorter TTL so matcher
  // improvements take effect on the next visit, not 7 days later.
  const NO_MATCH_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
  // Bootstrap entry holds both the rotating search path AND the short-lived
  // search auth (token + hp pair). The path lasts hours/days, the auth
  // probably less — 30 min keeps both fresh enough without re-discovering on
  // every page load. On any 4xx the client invalidates and re-bootstraps.
  const ENDPOINT_TTL_MS = 30 * 60 * 1000;

  /**
   * Read a value from chrome.storage.local.
   * @param {string} key
   * @returns {Promise<any|undefined>}
   */
  function rawGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (items) => resolve(items[key]));
    });
  }

  /**
   * Write a value to chrome.storage.local.
   * @param {string} key
   * @param {any} value
   * @returns {Promise<void>}
   */
  function rawSet(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    });
  }

  /**
   * Pick the TTL for an entry. Negative-cache entries (matchType "none")
   * expire faster than real matches, so matcher improvements aren't blocked
   * for a week. We honor a per-entry `ttl` field for entries written by the
   * new code, and auto-detect by matchType for legacy entries.
   * @param {object} entry
   * @returns {number} TTL in ms.
   */
  function ttlFor(entry) {
    if (typeof entry.ttl === "number") return entry.ttl;
    const isNegative = entry.data && entry.data.matchType === "none";
    return isNegative ? NO_MATCH_TTL_MS : GAME_TTL_MS;
  }

  /**
   * Get cached game data for a Steam appid, respecting TTL.
   * @param {string} appid
   * @returns {Promise<object|null>} Cached data or null if missing/expired.
   */
  async function getGame(appid) {
    const entry = await rawGet(GAME_KEY_PREFIX + appid);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > ttlFor(entry)) return null;
    return entry.data;
  }

  /**
   * Store game data in cache.
   * @param {string} appid
   * @param {object} data
   * @param {number} [ttlMs] - Optional TTL override (defaults to GAME_TTL_MS).
   * @returns {Promise<void>}
   */
  async function setGame(appid, data, ttlMs) {
    await rawSet(GAME_KEY_PREFIX + appid, {
      data,
      timestamp: Date.now(),
      ttl: typeof ttlMs === "number" ? ttlMs : GAME_TTL_MS,
    });
  }

  /**
   * Get cached HLTB endpoint discovery result, respecting TTL.
   * @returns {Promise<object|null>}
   */
  async function getEndpoint() {
    const entry = await rawGet(ENDPOINT_KEY);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > ENDPOINT_TTL_MS) return null;
    return entry.data;
  }

  /**
   * Cache HLTB endpoint discovery result.
   * @param {object} data
   * @returns {Promise<void>}
   */
  async function setEndpoint(data) {
    await rawSet(ENDPOINT_KEY, { data, timestamp: Date.now() });
  }

  /**
   * Clear all extension-owned cache entries (games + endpoint bootstrap).
   * @returns {Promise<void>}
   */
  function clearAll() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        const keys = Object.keys(items).filter(
          (k) => k.startsWith(GAME_KEY_SCAN_PREFIX) || k === ENDPOINT_KEY
        );
        if (keys.length === 0) {
          resolve();
          return;
        }
        chrome.storage.local.remove(keys, () => resolve());
      });
    });
  }

  /**
   * Count cached games (excluding the endpoint bootstrap entry).
   * @returns {Promise<number>}
   */
  function countGames() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => {
        const count = Object.keys(items).filter((k) =>
          k.startsWith(GAME_KEY_SCAN_PREFIX)
        ).length;
        resolve(count);
      });
    });
  }

  global.HltbCache = {
    getGame,
    setGame,
    getEndpoint,
    setEndpoint,
    clearAll,
    countGames,
    GAME_TTL_MS,
    NO_MATCH_TTL_MS,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
