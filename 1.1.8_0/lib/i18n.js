/**
 * Tiny wrapper around chrome.i18n.getMessage with positional substitutions.
 *
 * Used by both the content script and the service worker. Exposed on
 * globalThis so it works without ES modules in MV3 service workers.
 */
(function attachI18n(global) {
  /**
   * Get a localized message by key, with optional substitution values.
   * @param {string} key - Message key as defined in _locales/<lang>/messages.json.
   * @param {(string|number)[]} [substitutions] - Values to interpolate into placeholders.
   * @returns {string} Localized message, or the key itself if no translation is found.
   */
  function t(key, substitutions) {
    if (typeof chrome === "undefined" || !chrome.i18n) return key;
    const args = substitutions
      ? substitutions.map((value) => String(value))
      : undefined;
    const message = chrome.i18n.getMessage(key, args);
    return message || key;
  }

  global.HltbI18n = { t };
})(typeof globalThis !== "undefined" ? globalThis : self);
