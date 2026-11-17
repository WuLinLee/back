/**
 * Service worker: handles HLTB_LOOKUP messages from the content script.
 *
 * Responsibilities:
 *   - Check the per-appid cache and return immediately on hit.
 *   - On miss, call the HLTB client, run the matcher, and cache the result.
 *   - Handle CLEAR_CACHE and CACHE_STATS messages from the popup.
 *
 * Service workers in MV3 have no DOM and no ES module support out of the
 * box, so we use importScripts() to pull in shared library code.
 */

importScripts(
  "lib/cache.js",
  "lib/matcher.js",
  "lib/hltb-client.js"
);

// HLTB rejects requests with a chrome-extension:// Origin header. We can't
// override Origin/Referer via fetch() (Chrome silently drops them), so we use
// a declarativeNetRequest dynamic rule to rewrite them at the network layer.
const HLTB_HEADER_RULE_ID = 1;

async function ensureHltbHeaderRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [HLTB_HEADER_RULE_ID],
      addRules: [
        {
          id: HLTB_HEADER_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              {
                header: "Origin",
                operation: "set",
                value: "https://howlongtobeat.com",
              },
              {
                header: "Referer",
                operation: "set",
                value: "https://howlongtobeat.com/",
              },
            ],
          },
          condition: {
            urlFilter: "||howlongtobeat.com/",
            resourceTypes: ["xmlhttprequest"],
          },
        },
      ],
    });
  } catch (e) {
    console.error("HLTB: failed to install DNR rule", e);
  }
}

chrome.runtime.onInstalled.addListener(() => ensureHltbHeaderRules());
chrome.runtime.onStartup.addListener(() => ensureHltbHeaderRules());
// Also run on every SW wake-up in case dynamic rules got dropped somehow.
ensureHltbHeaderRules();

/**
 * Build the trimmed data shape we cache and return to the content script.
 * @param {object} entry - Raw HLTB result entry.
 * @param {"appid"|"exact"|"year"|"fuzzy"} matchType
 * @returns {object}
 */
function shapeGameData(entry, matchType) {
  return {
    hltbId: entry.game_id,
    name: entry.game_name,
    compMain: Number(entry.comp_main) || 0,
    compPlus: Number(entry.comp_plus) || 0,
    comp100: Number(entry.comp_100) || 0,
    compAll: Number(entry.comp_all) || 0,
    matchType,
  };
}

/**
 * Look up HLTB data for a Steam game, using cache when possible.
 * @param {string} appid
 * @param {string} title
 * @param {{year?: number|null, isDlc?: boolean, fallback?: {appid: string, title: string, year?: number|null}|null}} [opts]
 *   DLC pages search with HLTB's DLC filter off (HLTB usually has its own
 *   entry for a DLC) and fall back to the parent game when it doesn't.
 * @returns {Promise<{ok: true, data: object}|{ok: false, error: string}>}
 */
async function lookup(appid, title, opts = {}) {
  if (!appid || !title) {
    return { ok: false, error: "bad_request" };
  }
  const isDlc = !!opts.isDlc;
  const fallback = opts.fallback || null;
  const year = Number.isInteger(opts.year) ? opts.year : null;

  const cached = await HltbCache.getGame(appid);
  if (cached) {
    if (cached.matchType === "none") {
      // Negative cache: surface as the proper no_match error instead of
      // returning empty stats. The shorter NO_MATCH_TTL means future visits
      // will retry within a day, so matcher improvements can take effect.
      console.log(
        `HLTB: serving CACHED no_match for "${title}" (appid=${appid}). ` +
          `Clear cache via popup to force a fresh lookup.`
      );
      return { ok: false, error: "no_match", cached: true };
    }
    return { ok: true, data: cached, cached: true };
  }

  let results;
  let terms;
  let attempts;
  try {
    ({ results, terms, attempts } = await HltbClient.search(
      title,
      isDlc ? { modifier: "" } : {}
    ));
  } catch (e) {
    const msg = String(e && e.message);
    // auth_* = couldn't bootstrap into HLTB's API (path rotated, /init
    // returning HTML, etc.). Surface that as the "endpoint" category so the
    // user gets a more actionable message than a generic network error.
    if (msg.startsWith("auth_")) {
      return { ok: false, error: "endpoint" };
    }
    return { ok: false, error: "network" };
  }

  const matched = HltbMatcher.match(results, appid, title, year);
  if (!matched) {
    // Diagnostic: only when there's nothing to match, log what HLTB
    // returned so we can tell whether the search itself failed
    // (results.length === 0) or whether HLTB returned candidates but
    // matcher rejected them.
    // Pre-stringify so this stays readable even when chrome's errors page
    // collapses objects to [object Object] on copy.
    const attemptsStr = JSON.stringify(
      attempts || [{ terms, count: results.length }],
      null,
      2
    );
    const candidatesStr = JSON.stringify(
      results.slice(0, 10).map((r) => ({
        id: r.game_id,
        name: r.game_name,
        steam: r.profile_steam,
      }))
    );
    console.log(
      `HLTB: no match for "${title}" (appid=${appid}).\n` +
        `Attempts:\n${attemptsStr}\n` +
        `Top candidates: ${candidatesStr}`
    );
    // DLC that HLTB doesn't track separately: show the parent game's times
    // rather than nothing, and cache them under the DLC's appid too so the
    // next visit doesn't repeat the failed DLC search.
    if (fallback && fallback.appid && fallback.title) {
      console.log(
        `HLTB: no DLC entry for "${title}" — falling back to base game ` +
          `"${fallback.title}" (appid=${fallback.appid}).`
      );
      const base = await lookup(String(fallback.appid), String(fallback.title));
      if (base.ok) await HltbCache.setGame(appid, base.data);
      return base;
    }
    // Cache the "no match" outcome with a shorter TTL (NO_MATCH_TTL_MS, 1d)
    // so matcher improvements can take effect within a day rather than a
    // week, while still avoiding repeated HLTB hits for games it lacks.
    const empty = { hltbId: null, name: null, compMain: 0, compPlus: 0, comp100: 0, compAll: 0, matchType: "none" };
    await HltbCache.setGame(appid, empty, HltbCache.NO_MATCH_TTL_MS);
    return { ok: false, error: "no_match" };
  }

  // Diagnostic: a "fuzzy" match with high Levenshtein distance probably
  // means HLTB returned candidates but none were a great fit — the answer
  // we picked may be the wrong game. Surface that so we can debug.
  if (matched.matchType === "fuzzy" && matched.distance > 5) {
    const candidatesStr = JSON.stringify(
      results.slice(0, 5).map((r) => ({
        id: r.game_id,
        name: r.game_name,
        steam: r.profile_steam,
      }))
    );
    console.log(
      `HLTB: weak fuzzy match for "${title}" (appid=${appid}): ` +
        `picked "${matched.entry.game_name}" (id=${matched.entry.game_id}, ` +
        `distance=${matched.distance}). Top 5 candidates: ${candidatesStr}`
    );
  }

  const data = shapeGameData(matched.entry, matched.matchType);
  await HltbCache.setGame(appid, data);
  return { ok: true, data };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "HLTB_LOOKUP") {
    lookup(String(message.appid || ""), String(message.title || ""), {
      year: Number.isInteger(message.year) ? message.year : null,
      isDlc: !!message.isDlc,
      fallback: message.fallback || null,
    }).then(sendResponse);
    return true; // keep the message channel open for async response
  }

  if (message.type === "HLTB_CLEAR_CACHE") {
    HltbCache.clearAll().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "HLTB_CACHE_STATS") {
    HltbCache.countGames().then((count) => sendResponse({ ok: true, count }));
    return true;
  }

  return false;
});
