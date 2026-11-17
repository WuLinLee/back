/**
 * Steam content script: extracts the current game's appid and title, asks
 * the service worker for HLTB data, and renders a thin strip directly below
 * the Steam app header (`.apphub_HomeHeaderContent`).
 *
 * Selectors are wrapped in fallbacks and a short MutationObserver wait so
 * that we degrade gracefully if Steam reshuffles the DOM.
 */

(function run() {
  if (window.__hltbExtensionLoaded) return;
  window.__hltbExtensionLoaded = true;

  const APPID_RE = /\/app\/(\d+)/;
  const PANEL_HOST_ID = "hltb-extension-root";
  const MUTATION_TIMEOUT_MS = 3000;

  const t = (key, args) =>
    (globalThis.HltbI18n && globalThis.HltbI18n.t(key, args)) || key;

  /**
   * Extract Steam appid from the current location.
   * @returns {string|null}
   */
  function getAppId() {
    const match = APPID_RE.exec(location.pathname);
    return match ? match[1] : null;
  }

  /**
   * Pull the game's display title from the Steam DOM. May be localized
   * (e.g. Ukrainian/Russian) — see resolveLookupTarget() for the canonical
   * English title used to query HLTB.
   * @returns {string|null}
   */
  function getGameTitle() {
    const selectors = [".apphub_AppName", "#appHubAppName", "div.apphub_AppName"];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }
    // Fallback: pull from the og:title meta tag.
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content.trim();
    return null;
  }

  /**
   * Pull the payload out of an /api/appdetails response.
   *
   * The response is keyed by an appid, but NOT necessarily the one we asked
   * for: Steam now answers with the store item's own id (appids=2124490 comes
   * back under "3097500"), so a plain `json[appid]` lookup silently misses on
   * every game. Match on the inner `steam_appid` instead, and accept a lone
   * entry as a last resort.
   * @param {object} json - Parsed appdetails response.
   * @param {string} appid - The appid we requested.
   * @returns {{success: boolean, data: object}|null}
   */
  function pickAppDetailsEntry(json, appid) {
    if (!json || typeof json !== "object") return null;
    const usable = Object.values(json).filter(
      (e) => e && e.success && e.data && typeof e.data === "object"
    );
    if (usable.length === 0) return null;
    const byAppid = usable.find(
      (e) => String(e.data.steam_appid) === String(appid)
    );
    if (byAppid) return byAppid;
    const direct = json[appid];
    if (direct && direct.success && direct.data) return direct;
    return usable.length === 1 ? usable[0] : null;
  }

  /**
   * Fetch the canonical English game info from Steam's public appdetails
   * endpoint. Steam pages display the title in the user's locale, which
   * causes HLTB lookup misses for localized titles (e.g. "Приватний
   * детектив МАУС" instead of the English name). The response also tells
   * us whether this page is a DLC and, if so, which base game it belongs
   * to. This is a same-origin GET from a content script on
   * store.steampowered.com, so no host permissions are needed.
   * @param {string} appid
   * @returns {Promise<{name: string|null, year: number|null, type: string|null, fullgame: {appid: string, name: string}|null}|null>}
   */
  async function fetchAppDetails(appid) {
    try {
      // `filters=basic` alone omits release_date entirely (Steam silently
      // drops the field, no error) — must list it explicitly to get the
      // release year needed for disambiguating same-named games.
      const res = await fetch(
        `/api/appdetails?appids=${encodeURIComponent(appid)}&l=english&filters=basic,release_date`,
        { credentials: "omit", cache: "default" }
      );
      if (!res.ok) return null;
      const json = await res.json();
      const entry = pickAppDetailsEntry(json, appid);
      if (!entry) return null;
      const data = entry.data;
      const full =
        data.fullgame && data.fullgame.appid && data.fullgame.name
          ? {
              appid: String(data.fullgame.appid),
              name: String(data.fullgame.name).trim(),
            }
          : null;
      return {
        name: data.name ? String(data.name).trim() : null,
        year:
          data.release_date &&
          typeof data.release_date.date === "string"
            ? Number(data.release_date.date.match(/\b(19|20)\d{2}\b/)?.[0]) || null
            : null,
        type: data.type ? String(data.type) : null,
        fullgame: full && full.name ? full : null,
      };
    } catch {
      // Network or rate-limit failure — caller falls back to localized title.
    }
    return null;
  }

  /**
   * Decide which game to ask HLTB about. HLTB usually has its own entry for
   * a DLC ("Mafia: The Old Country - Man of Honor"), so DLC pages are looked
   * up by their own English name — with the parent game kept as a fallback
   * for DLC that HLTB doesn't track separately.
   * @param {string} appid
   * @param {string} localizedTitle
   * @returns {Promise<{appid: string, title: string, year: number|null, isDlc: boolean, fallback: {appid: string, title: string, year: number|null}|null}>}
   */
  async function resolveLookupTarget(appid, localizedTitle) {
    const details = await fetchAppDetails(appid);
    const isDlc = !!(details && details.type === "dlc");
    return {
      appid,
      title: (details && details.name) || localizedTitle,
      year: (details && details.year) || null,
      isDlc,
      fallback:
        isDlc && details.fullgame
          ? {
              appid: details.fullgame.appid,
              title: details.fullgame.name,
              year: null,
            }
          : null,
    };
  }

  /**
   * Find the element we want to render *under*. The panel is inserted as the
   * next sibling, so it appears as a horizontal strip directly below.
   * Primary target is the app header block; fallbacks cover legacy layouts.
   * @returns {HTMLElement|null}
   */
  function findAnchor() {
    const candidates = [
      ".apphub_HomeHeaderContent",
      ".apphub_HeaderStandardTop",
      ".game_description_column",
      ".game_meta_data",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * Wait up to MUTATION_TIMEOUT_MS for a matching anchor to appear in the
   * DOM. Resolves with the element or null on timeout.
   * @returns {Promise<HTMLElement|null>}
   */
  function waitForAnchor() {
    const found = findAnchor();
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (el) => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      };
      const observer = new MutationObserver(() => {
        const el = findAnchor();
        if (el) finish(el);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => finish(null), MUTATION_TIMEOUT_MS);
    });
  }

  /**
   * Format a duration in seconds as "12.3 h", or the unknown placeholder.
   * @param {number} seconds
   * @returns {string}
   */
  function formatHours(seconds) {
    if (!seconds || seconds <= 0) return t("value_unknown");
    const hours = seconds / 3600;
    const rounded = hours < 10 ? hours.toFixed(1) : Math.round(hours).toString();
    return `${rounded} ${t("unit_hours_short")}`;
  }

  /**
   * Build the panel DOM inside a shadow root.
   * @param {ShadowRoot} root
   * @returns {{ setLoading: () => void, setError: (key: string) => void, setData: (data: object) => void }}
   */
  function buildPanel(root) {
    root.innerHTML = `
      <style>
        :host { all: initial; display: block; }
        .hltb-card {
          display: flex;
          align-items: center;
          gap: 16px;
          font-family: "Motiva Sans", Arial, sans-serif;
          color: #c7d5e0;
          background: linear-gradient(90deg, #16202d 0%, #1b2838 100%);
          border: 1px solid #2a3f5f;
          border-radius: 3px;
          padding: 8px 14px;
          margin: 8px 0 12px;
          font-size: 13px;
          line-height: 1.3;
          flex-wrap: wrap;
        }
        .hltb-card.is-error { opacity: 0.85; }
        .hltb-stats {
          display: flex;
          align-items: baseline;
          gap: 18px;
          flex: 1 1 auto;
          flex-wrap: wrap;
        }
        .hltb-stat {
          display: flex;
          align-items: baseline;
          gap: 6px;
          white-space: nowrap;
        }
        .hltb-stat-label {
          font-size: 11px;
          color: #8f98a0;
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }
        .hltb-stat-value {
          font-size: 14px;
          font-weight: 600;
          color: #ffffff;
        }
        /* Headline stat, mirroring the highlighted first tile on HLTB. */
        .hltb-stat--primary {
          align-items: center;
          background: rgba(103, 193, 245, 0.16);
          border-radius: 2px;
          padding: 4px 10px;
          margin: -4px 0;
        }
        .hltb-stat--primary .hltb-stat-label {
          color: #67c1f5;
          font-weight: 600;
          line-height: 1;
        }
        .hltb-stat--primary .hltb-stat-value {
          font-size: 15px;
          line-height: 1;
        }
        /* Mirrors Steam's native .btnv6_blue_hoverfade .btn_medium look. */
        .hltb-cta {
          display: inline-block;
          border-radius: 2px;
          border: none;
          padding: 1px;
          cursor: pointer;
          text-decoration: none !important;
          color: #67c1f5 !important;
          background: rgba(103, 193, 245, 0.2);
          flex: 0 0 auto;
          line-height: 0;
        }
        .hltb-cta > span {
          display: block;
          padding: 4px 12px;
          border-radius: 2px;
          font-size: 12px;
          line-height: 16px;
          font-weight: 400;
        }
        .hltb-cta:hover {
          color: #ffffff !important;
          background: linear-gradient(to right, #67c1f5 0%, #417a9b 60%);
        }
        .hltb-cta[hidden] { display: none; }
        .hltb-status {
          font-size: 12px;
          color: #8f98a0;
          flex: 1 1 auto;
        }
      </style>
      <div class="hltb-card" part="card">
        <div class="hltb-stats" data-slot="grid" hidden>
          <div class="hltb-stat hltb-stat--primary">
            <span class="hltb-stat-label" data-i18n="stat_hltb"></span>
            <span class="hltb-stat-value" data-slot="all">—</span>
          </div>
          <div class="hltb-stat">
            <span class="hltb-stat-label" data-i18n="stat_main"></span>
            <span class="hltb-stat-value" data-slot="main">—</span>
          </div>
          <div class="hltb-stat">
            <span class="hltb-stat-label" data-i18n="stat_main_sides"></span>
            <span class="hltb-stat-value" data-slot="plus">—</span>
          </div>
          <div class="hltb-stat">
            <span class="hltb-stat-label" data-i18n="stat_completionist"></span>
            <span class="hltb-stat-value" data-slot="100">—</span>
          </div>
        </div>
        <span class="hltb-status" data-slot="status"></span>
        <a class="hltb-cta" data-slot="cta" target="_blank" rel="noopener noreferrer" hidden><span data-slot="cta-text"></span></a>
      </div>
    `;

    root.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });

    const card = root.querySelector(".hltb-card");
    const status = root.querySelector('[data-slot="status"]');
    const grid = root.querySelector('[data-slot="grid"]');
    const cta = root.querySelector('[data-slot="cta"]');
    const ctaText = root.querySelector('[data-slot="cta-text"]');
    const slots = {
      main: root.querySelector('[data-slot="main"]'),
      plus: root.querySelector('[data-slot="plus"]'),
      100: root.querySelector('[data-slot="100"]'),
      all: root.querySelector('[data-slot="all"]'),
    };

    return {
      setLoading() {
        card.classList.remove("is-error");
        status.textContent = t("loading");
        grid.hidden = true;
        cta.hidden = true;
      },
      setError(messageKey) {
        card.classList.add("is-error");
        status.textContent = t(messageKey);
        grid.hidden = true;
        cta.hidden = true;
      },
      setData(data) {
        card.classList.remove("is-error");
        status.textContent = "";
        slots.main.textContent = formatHours(data.compMain);
        slots.plus.textContent = formatHours(data.compPlus);
        slots[100].textContent = formatHours(data.comp100);
        slots.all.textContent = formatHours(data.compAll);
        grid.hidden = false;
        if (data.hltbId) {
          ctaText.textContent = t("view_on_hltb");
          cta.href = `https://howlongtobeat.com/game/${encodeURIComponent(
            data.hltbId
          )}`;
          cta.hidden = false;
        } else {
          cta.hidden = true;
        }
      },
    };
  }

  /**
   * Insert the host element as the next sibling of the anchor, so the panel
   * renders as a horizontal strip directly below it. Falls back to appending
   * to <body> if the anchor has no parent.
   * @param {HTMLElement} anchor
   * @returns {HTMLElement} The host element wrapping the shadow root.
   */
  function mountHost(anchor) {
    const existing = document.getElementById(PANEL_HOST_ID);
    if (existing) existing.remove();
    const host = document.createElement("div");
    host.id = PANEL_HOST_ID;
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(host, anchor.nextSibling);
    } else {
      document.body.appendChild(host);
    }
    return host;
  }

  /**
   * Send a lookup request to the service worker.
   * @param {{appid: string, title: string, year: number|null, isDlc: boolean, fallback: object|null}} target
   * @returns {Promise<object>}
   */
  function requestLookup(target) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "HLTB_LOOKUP", ...target },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve({ ok: false, error: "network" });
            return;
          }
          resolve(response);
        }
      );
    });
  }

  async function main() {
    const appid = getAppId();
    if (!appid) return;
    const localizedTitle = getGameTitle();
    if (!localizedTitle) return;

    const anchor = await waitForAnchor();
    const host = mountHost(anchor);
    const shadow = host.attachShadow({ mode: "open" });
    const panel = buildPanel(shadow);

    panel.setLoading();
    // HLTB only knows the canonical English title, and DLC needs its own
    // search options — so resolve both through Steam's appdetails endpoint
    // before asking the service worker.
    const target = await resolveLookupTarget(appid, localizedTitle);
    const response = await requestLookup(target);
    if (response && response.ok) {
      panel.setData(response.data);
      return;
    }
    const errorKey =
      response && response.error === "no_match"
        ? "error_no_match"
        : response && response.error === "endpoint"
          ? "error_endpoint"
          : "error_network";
    panel.setError(errorKey);
  }

  main().catch((e) => {
    // Never break the host Steam page — log and swallow.
    console.error("HLTB: content script failed", e);
  });
})();
