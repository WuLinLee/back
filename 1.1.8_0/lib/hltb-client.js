/**
 * HowLongToBeat client: endpoint discovery + auth bootstrap + game search.
 *
 * HLTB does not expose a public API. Their Next.js site does this:
 *   1. POSTs to a rotating path like /api/<segments> (currently
 *      /api/search/site; it used to be a single word, e.g. /api/bleed).
 *   2. Before searching, GETs <path>/init to receive a short-lived token
 *      (fingerprinted to IP + UA + Referer). As of 2026-09 that's just
 *      { token }; older deployments also returned an hpKey/hpVal pair.
 *   3. Sends the search with an x-auth-token header (plus x-hp-key /
 *      x-hp-val and a top-level { [hpKey]: hpVal } body field when /init
 *      gave an hp pair). Referer must be howlongtobeat.com on both calls —
 *      background.js rewrites it via a DNR rule.
 *
 * Mirrors hltb-for-deck's approach. Discovered path + auth are cached via
 * HltbCache; on failure we invalidate and re-bootstrap (auth first, then
 * search path).
 */
(function attachHltbClient(global) {
  const HLTB_ORIGIN = "https://howlongtobeat.com";
  const HOMEPAGE_URL = HLTB_ORIGIN + "/";
  const DEFAULT_SEARCH_PATH = "/api/search/site";

  // hltb-for-deck uses an older Chrome UA as a workaround for HLTB's UA
  // sniffing. Chrome ignores Origin/Referer/User-Agent set via fetch headers,
  // but we send them anyway in case a future fetch implementation honors them.
  const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.113 Safari/537.36";

  function baseHeaders() {
    return {
      "Content-Type": "application/json",
      Origin: HLTB_ORIGIN,
      Referer: HOMEPAGE_URL,
      "User-Agent": USER_AGENT,
    };
  }

  function searchHeaders(auth) {
    const headers = {
      ...baseHeaders(),
      Authority: "howlongtobeat.com",
      "x-auth-token": auth.token,
    };
    if (auth.hpKey && auth.hpVal) {
      headers["x-hp-key"] = auth.hpKey;
      headers["x-hp-val"] = auth.hpVal;
    }
    return headers;
  }

  /**
   * GET text with browser-like headers. Throws on non-OK.
   * @param {string} url
   * @returns {Promise<string>}
   */
  async function fetchText(url) {
    const res = await fetch(url, {
      method: "GET",
      headers: baseHeaders(),
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return res.text();
  }

  /**
   * Pull all <script src> URLs from a homepage HTML, absolutized.
   * @param {string} html
   * @returns {string[]}
   */
  function extractScriptUrls(html) {
    const urls = [];
    const re = /<script\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        urls.push(new URL(m[2], HOMEPAGE_URL).toString());
      } catch {
        // skip malformed src
      }
    }
    return urls;
  }

  /**
   * Look inside a JS chunk for the search endpoint base path.
   * We require both `searchTerms` and `searchOptions` strings to be present
   * (so we know this is the right chunk). The path can have several segments
   * (currently `/api/search/site`), so we never truncate it: first we look
   * for a `/api/<path>/init` literal and strip the `/init` suffix, and only
   * if that fails do we fall back to the `fetch("/api/<path>", {method:
   * "POST"})` call.
   * @param {string} scriptText
   * @returns {string|null} e.g. "/api/search/site"
   */
  function extractSearchPathFromScript(scriptText) {
    if (
      !scriptText.includes("searchTerms") ||
      !scriptText.includes("searchOptions")
    ) {
      return null;
    }

    // Strong signal: the /init bootstrap URL names the search path directly.
    const initRe = /["'`]\/api\/((?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+)\/init\b/g;
    let m;
    while ((m = initRe.exec(scriptText)) !== null) {
      if (m[1]) return `/api/${m[1]}`;
    }

    // Fallback: the search POST itself.
    const pattern =
      /fetch\s*\(\s*["'`](\/api\/[a-zA-Z0-9_/-]+)[^"'`]*["'`]\s*,\s*\{[^}]*method:\s*["'`]POST["'`]/gi;
    let match;
    while ((match = pattern.exec(scriptText)) !== null) {
      const candidate = match[1].replace(/\/+$/, "");
      if (candidate && candidate !== "/api") return candidate;
    }
    return null;
  }

  /**
   * Discover the current HLTB search path by parsing homepage + its scripts.
   * Falls back to DEFAULT_SEARCH_PATH if discovery yields nothing.
   * @returns {Promise<string>}
   */
  async function discoverSearchPath() {
    let html;
    try {
      html = await fetchText(HOMEPAGE_URL);
    } catch {
      return DEFAULT_SEARCH_PATH;
    }

    const scripts = extractScriptUrls(html);
    for (const src of scripts) {
      let u;
      try {
        u = new URL(src);
      } catch {
        continue;
      }
      if (u.origin !== HLTB_ORIGIN || !u.pathname.endsWith(".js")) continue;
      let body;
      try {
        body = await fetchText(u.toString());
      } catch {
        continue;
      }
      const found = extractSearchPathFromScript(body);
      if (found) return found;
    }
    return DEFAULT_SEARCH_PATH;
  }

  /**
   * Parse an /init response into { token, hpKey, hpVal }.
   * Only `token` is required: as of 2026-09 HLTB's /init returns just
   * `{ token }` and the site sends only `x-auth-token`. Older deployments
   * also returned an hp pair; when present we still honor it. The hp field
   * names are not stable — we identify them by looking for any string field
   * whose *name* contains "key" or "val". The search body then includes
   * `[hpKey]: hpVal` as a top-level field (hpKey is the *value* read from
   * the *-key field, which HLTB expects echoed back as a body field name).
   * @param {unknown} data
   * @returns {{token: string, hpKey: string|null, hpVal: string|null}|null}
   */
  function parseAuth(data) {
    if (!data || typeof data !== "object") return null;
    const token = typeof data.token === "string" ? data.token : null;
    let hpKey = null;
    let hpVal = null;
    for (const [name, value] of Object.entries(data)) {
      if (typeof value !== "string") continue;
      const lower = name.toLowerCase();
      if (!hpKey && lower.includes("key")) hpKey = value;
      else if (!hpVal && lower.includes("val")) hpVal = value;
    }
    if (!token) return null;
    // A half-present pair is useless; drop it rather than send garbage.
    if (!hpKey || !hpVal) return { token, hpKey: null, hpVal: null };
    return { token, hpKey, hpVal };
  }

  /**
   * Fetch fresh search auth (token + hp pair) for a given search path.
   * @param {string} searchPath - e.g. "/api/search/site"
   * @returns {Promise<{token: string, hpKey: string, hpVal: string}>}
   * @throws {Error} On HTTP error or malformed response.
   */
  async function fetchAuth(searchPath) {
    const url = `${HLTB_ORIGIN}${searchPath}/init?t=${Date.now()}`;
    const res = await fetch(url, {
      method: "GET",
      headers: baseHeaders(),
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`HLTB: /init ${searchPath} -> ${res.status}`);
      throw new Error(`auth_http_${res.status}`);
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      console.error("HLTB: /init returned non-JSON", e);
      throw new Error("auth_json_parse");
    }
    const auth = parseAuth(json);
    if (!auth) {
      console.error("HLTB: /init missing token field", json);
      throw new Error("auth_parse_failed");
    }
    return auth;
  }

  /**
   * Build the search request body. Includes the hp pair (when /init gave one)
   * as a top-level field keyed by hpKey (validated against the x-hp-* headers).
   * @param {string} title
   * @param {{hpKey: string, hpVal: string}} auth
   * @returns {object}
   */
  function buildSearchBody(
    title,
    auth,
    { stripAll = false, modifier = "hide_dlc" } = {}
  ) {
    let cleaned = title.replace(/[™®©]/g, "").replace(/[‘’ʼ]/g, "'");
    if (stripAll) {
      cleaned = cleaned.replace(/['`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ");
    }
    const terms = cleaned
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const body = {
      searchType: "games",
      searchTerms: terms,
      searchPage: 1,
      // hltb-for-deck uses size 20 and works; anything larger (we tried 30)
      // makes HLTB return a literal empty {} body, killing every query.
      size: 20,
      searchOptions: {
        games: {
          userId: 0,
          platform: "",
          sortCategory: "name",
          rangeCategory: "main",
          rangeTime: { min: 0, max: 0 },
          gameplay: {
            perspective: "",
            flow: "",
            genre: "",
            difficulty: "",
          },
          modifier,
        },
        users: {},
        filter: "",
        sort: 0,
        randomizer: 0,
      },
    };
    if (auth.hpKey && auth.hpVal) body[auth.hpKey] = auth.hpVal;
    return body;
  }

  /**
   * POST the search to HLTB.
   * @param {string} searchPath
   * @param {{token: string, hpKey: string, hpVal: string}} auth
   * @param {object} body
   * @returns {Promise<object>}
   */
  async function postSearch(searchPath, auth, body) {
    const res = await fetch(HLTB_ORIGIN + searchPath, {
      method: "POST",
      headers: searchHeaders(auth),
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`search_http_${res.status}`);
    return res.json();
  }

  async function loadBootstrap() {
    const cached = await global.HltbCache.getEndpoint();
    if (!cached) return { searchPath: null, auth: null };
    return {
      searchPath: cached.searchPath || null,
      auth: cached.auth && cached.auth.token ? cached.auth : null,
    };
  }

  async function saveBootstrap(searchPath, auth) {
    await global.HltbCache.setEndpoint({ searchPath, auth });
  }

  /**
   * Ensure both a search path and a fresh auth token. Re-discovers the search
   * path if the /init call fails (path may have rotated).
   * @param {{searchPath: string|null, auth: object|null}} state
   * @returns {Promise<{searchPath: string, auth: object}>}
   */
  async function ensureAuth(state) {
    let searchPath = state.searchPath || (await discoverSearchPath());
    if (state.auth) {
      await saveBootstrap(searchPath, state.auth);
      return { searchPath, auth: state.auth };
    }
    try {
      const auth = await fetchAuth(searchPath);
      await saveBootstrap(searchPath, auth);
      return { searchPath, auth };
    } catch (_first) {
      // /init failed — search path may have rotated. Re-discover and retry.
      searchPath = await discoverSearchPath();
      const auth = await fetchAuth(searchPath);
      await saveBootstrap(searchPath, auth);
      return { searchPath, auth };
    }
  }

  /**
   * Run one search against HLTB with auth-retry semantics. If the POST
   * fails (likely stale auth) we re-mint and retry; if that fails too we
   * re-bootstrap path+auth and retry once more. Returns the raw response
   * data plus the search body that was last used (terms may matter for
   * diagnostics).
   * @param {{searchPath: string, auth: object}} state - Mutated on auth refresh.
   * @param {string} title
   * @param {object} opts - Forwarded to buildSearchBody.
   * @returns {Promise<{results: object[], body: object}>}
   */
  async function executeSearch(state, title, opts) {
    let body = buildSearchBody(title, state.auth, opts);
    try {
      const json = await postSearch(state.searchPath, state.auth, body);
      return { results: pickResults(json), body, raw: json };
    } catch (_e1) {
      // Auth may be stale. Re-mint with the same path and retry.
      try {
        const auth = await fetchAuth(state.searchPath);
        await saveBootstrap(state.searchPath, auth);
        state.auth = auth;
        body = buildSearchBody(title, state.auth, opts);
        const json = await postSearch(state.searchPath, state.auth, body);
        return { results: pickResults(json), body, raw: json };
      } catch (_e2) {
        // Path may have rotated too. Full re-bootstrap.
        const fresh = await ensureAuth({ searchPath: null, auth: null });
        state.searchPath = fresh.searchPath;
        state.auth = fresh.auth;
        body = buildSearchBody(title, state.auth, opts);
        const json = await postSearch(state.searchPath, state.auth, body);
        return { results: pickResults(json), body, raw: json };
      }
    }
  }

  function pickResults(json) {
    return Array.isArray(json && json.data) ? json.data : [];
  }

  /**
   * Search HLTB for a game by title.
   *
   * Three-pass strategy:
   *   1. Apostrophe-preserving normalization (HLTB indexes "Assassin's").
   *   2. Strip-all fallback if pass 1 returns 0 — collapses every
   *      non-letter / non-number, including apostrophes ("Assassins").
   *   3. Broadening fallback if both above return 0: drop the trailing
   *      word. Some recently-added games' subtitles aren't yet indexed by
   *      HLTB ("Assassin's Creed Shadows" → 0 results), but searching the
   *      franchise root ("Assassin's Creed") returns the full list and
   *      the matcher's exact-name tier picks the right entry from there.
   *
   * @param {string} title
   * @param {{modifier?: string}} [options] - `modifier` overrides the default
   *   "hide_dlc" filter; pass "" when looking up a DLC, whose entry HLTB
   *   would otherwise filter out.
   * @returns {Promise<{results: object[], terms: string[]}>}
   */
  async function search(title, options = {}) {
    let state = await loadBootstrap();
    state = await ensureAuth(state);

    // Pre-normalize once: strip ™/®/©, convert curly apostrophes (U+2019
    // etc.) to ASCII. HLTB's search uses ASCII apostrophes ("assassin's"
    // matches, the curly U+2019 form doesn't). The user verified this
    // manually on howlongtobeat.com.
    const base = title.replace(/[™®©]/g, "").replace(/[‘’ʼ]/g, "'").trim();
    const words = base.split(/\s+/).filter(Boolean);

    const shared =
      typeof options.modifier === "string" ? { modifier: options.modifier } : {};
    const passes = [
      { title: base, opts: { ...shared } },                 // 1. ASCII apos, orig case
      { title: base.toLowerCase(), opts: { ...shared } },   // 2. ASCII apos, lowercase
      { title: base, opts: { ...shared, stripAll: true } }, // 3. strip all punct
    ];
    if (words.length >= 3) {
      // 4 & 5: broaden by dropping the last word. Some recently-added
      // games have un-indexed subtitles; searching the franchise root
      // returns the full list and the matcher's exact-name tier finds
      // the right entry from there.
      const broader = words.slice(0, -1).join(" ");
      passes.push({ title: broader, opts: { ...shared } });
      passes.push({ title: broader.toLowerCase(), opts: { ...shared } });
    }

    const attempts = [];
    for (const pass of passes) {
      const { results, body, raw } = await executeSearch(state, pass.title, pass.opts);
      // Capture a short preview of the raw response too so we can tell
      // whether HLTB returned a literally-empty `data: []` or some other
      // shape (error envelope, captcha, etc.) we're misinterpreting.
      attempts.push({
        terms: body.searchTerms,
        count: results.length,
        rawKeys: raw && typeof raw === "object" ? Object.keys(raw) : null,
        rawPreview: raw ? JSON.stringify(raw).slice(0, 300) : null,
      });
      if (results.length > 0) {
        return { results, terms: body.searchTerms, attempts };
      }
    }

    const last = attempts[attempts.length - 1];
    return {
      results: [],
      terms: last ? last.terms : [],
      attempts,
    };
  }

  global.HltbClient = { search, discoverSearchPath };
})(typeof globalThis !== "undefined" ? globalThis : self);
