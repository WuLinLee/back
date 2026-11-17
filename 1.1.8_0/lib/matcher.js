/**
 * Three-tier matcher for picking the right HLTB entry from search results.
 * Mirrors hltb-for-deck's approach: appid → exact normalized name → fuzzy.
 */
(function attachMatcher(global) {
  const ROMAN_MAP = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

  /**
   * Convert a roman numeral token to an arabic number string.
   * @param {string} token
   * @returns {string|null} Arabic numeral string, or null if not a valid roman.
   */
  function romanToArabic(token) {
    if (!/^[ivxlcdm]+$/i.test(token)) return null;
    const lower = token.toLowerCase();
    let total = 0;
    let prev = 0;
    for (let i = lower.length - 1; i >= 0; i--) {
      const value = ROMAN_MAP[lower[i]];
      if (!value) return null;
      if (value < prev) total -= value;
      else total += value;
      prev = value;
    }
    return total > 0 ? String(total) : null;
  }

  /**
   * Normalize a game title for matching: lowercase, replace any non-letter /
   * non-number with a space (handles all Unicode punctuation including ™, ®,
   * smart quotes, ideographic separators), collapse whitespace, then convert
   * roman numerals (VI → 6) so "Civilization VI" matches "Civilization 6".
   * @param {string} input
   * @returns {string}
   */
  function normalize(input) {
    if (!input) return "";
    let text = input.toLowerCase();
    text = text.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!text) return "";
    text = text
      .split(" ")
      .map((token) => {
        const arabic = romanToArabic(token);
        return arabic !== null ? arabic : token;
      })
      .join(" ");
    return text;
  }

  /**
   * Levenshtein edit distance between two strings.
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          curr[j - 1] + 1,
          prev[j] + 1,
          prev[j - 1] + cost
        );
      }
      [prev, curr] = [curr, prev];
    }
    return prev[b.length];
  }

  /**
   * Extract a release year from the fields used by HLTB search results.
   * `release_world` is HLTB's actual release-year field (confirmed against
   * hltb-for-deck's GameStatsData type); `game_name_date` is the year HLTB
   * appends to disambiguate same-named games (e.g. the "(2024)" shown next
   * to remakes) and is used as a fallback when release_world is 0/missing.
   * @param {object} entry
   * @returns {number|null}
   */
  function getYear(entry) {
    if (!entry || typeof entry !== "object") return null;
    for (const value of [entry.release_world, entry.game_name_date]) {
      const match = String(value || "").match(/\b(19|20)\d{2}\b/);
      if (match) return Number(match[0]);
    }
    return null;
  }

  /**
   * Pick the best matching HLTB entry for a given Steam game.
   * @param {object[]} results - Raw HLTB search result entries.
   * @param {string} appid - Steam appid as a string.
   * @param {string} title - Steam-page game title.
   * @param {number|null} year - Steam release year, when available.
   * @returns {{ entry: object, matchType: "appid"|"exact"|"year"|"fuzzy", distance?: number }|null}
   */
  function match(results, appid, title, year = null) {
    if (!Array.isArray(results) || results.length === 0) return null;

    // Tier 1: Steam appid match. HLTB exposes profile_steam on results that
    // are linked to a Steam app. Most reliable signal when present.
    const byAppid = results.find(
      (r) => r && String(r.profile_steam) === String(appid) && r.profile_steam
    );
    if (byAppid) return { entry: byAppid, matchType: "appid" };

    const normalizedTitle = normalize(title);
    if (!normalizedTitle) return null;

    // Tiers 2 & 3 in one ranking pass. Remakes are the reason this can't be
    // a `find()` on exact name: HLTB lists "Silent Hill 2" twice (2001 and
    // 2024) under identical names, so the first exact hit is a coin flip —
    // and it lands on the older entry, whose times are half the remake's.
    // Rank by: closest name, then the entry whose release year matches
    // Steam's, then popularity.
    const hasYear = Number.isInteger(year) && year >= 1900 && year <= 2100;
    let best = null;
    for (const r of results) {
      if (!r || !r.game_name) continue;
      const candidate = normalize(r.game_name);
      if (!candidate) continue;
      const distance = levenshtein(normalizedTitle, candidate);
      const entryYear = hasYear ? getYear(r) : null;
      // 2 = same year, 1 = off by one (PC ports and regional releases often
      // slip a year), 0 = different or unknown.
      let yearScore = 0;
      if (entryYear !== null) {
        const delta = Math.abs(entryYear - year);
        if (delta === 0) yearScore = 2;
        else if (delta === 1) yearScore = 1;
      }
      const popularity = Number(r.comp_all_count) || 0;
      const better =
        !best ||
        distance < best.distance ||
        (distance === best.distance &&
          (yearScore > best.yearScore ||
            (yearScore === best.yearScore && popularity > best.popularity)));
      if (better) best = { entry: r, distance, yearScore, popularity };
    }
    if (!best) return null;

    let matchType;
    if (best.yearScore === 2 && best.distance === 0) matchType = "year";
    else if (best.distance === 0) matchType = "exact";
    else matchType = "fuzzy";

    return { entry: best.entry, matchType, distance: best.distance };
  }

  global.HltbMatcher = { match, normalize, levenshtein, getYear };
})(typeof globalThis !== "undefined" ? globalThis : self);
