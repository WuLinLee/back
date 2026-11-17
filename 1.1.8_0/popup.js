/**
 * Popup logic: shows cache size and lets the user clear the cache.
 */

const t = (key, args) =>
  (globalThis.HltbI18n && globalThis.HltbI18n.t(key, args)) || key;

document.querySelectorAll("[data-i18n]").forEach((el) => {
  el.textContent = t(el.dataset.i18n);
});

const cacheSizeEl = document.querySelector('[data-slot="cache-size"]');
const clearBtn = document.querySelector('[data-slot="clear"]');
const toastEl = document.querySelector('[data-slot="toast"]');

/**
 * Ask the service worker for cache stats and render them.
 * @returns {Promise<void>}
 */
function refreshStats() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "HLTB_CACHE_STATS" }, (response) => {
      const count = response && typeof response.count === "number" ? response.count : 0;
      cacheSizeEl.textContent = t("popup_cache_size", [count]);
      resolve();
    });
  });
}

/**
 * Show a transient toast message in the popup.
 * @param {string} messageKey - i18n key for the toast content.
 */
function showToast(messageKey) {
  toastEl.textContent = t(messageKey);
  toastEl.hidden = false;
  setTimeout(() => {
    toastEl.hidden = true;
  }, 2500);
}

clearBtn.addEventListener("click", () => {
  clearBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "HLTB_CLEAR_CACHE" }, async () => {
    await refreshStats();
    showToast("popup_cleared");
    clearBtn.disabled = false;
  });
});

refreshStats();
