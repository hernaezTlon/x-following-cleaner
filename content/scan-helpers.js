// Helper utilities shared by content scripts and tests.
(function(root, factory) {
  const helpers = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
  }
  if (root) {
    root.XFollowingCleanerHelpers = helpers;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function shouldRetryGraphqlError(message) {
    const text = String(message || '').toLowerCase();
    if (!text) return false;
    if (text.includes('rate') || text.includes('429')) return false;
    return text.includes('query') || text.includes('unknown') || text.includes('unspecified') || text.includes('operation');
  }

  function isRateLimitError(message) {
    const text = String(message || '').toLowerCase();
    return text.includes('429') || text.includes('rate');
  }

  async function safeJsonParse(response) {
    if (!response || typeof response.json !== 'function') {
      return { ok: false, data: null, error: new Error('no_json_method') };
    }
    try {
      const data = await response.json();
      return { ok: true, data, error: null };
    } catch (error) {
      return { ok: false, data: null, error };
    }
  }

  async function safeFetchText(fetchFn, url, options) {
    try {
      const response = await fetchFn(url, options);
      const text = await response.text();
      return { ok: response.ok, status: response.status, text, response };
    } catch (error) {
      return { ok: false, status: 0, text: '', error };
    }
  }

  return {
    shouldRetryGraphqlError,
    isRateLimitError,
    safeJsonParse,
    safeFetchText
  };
});
