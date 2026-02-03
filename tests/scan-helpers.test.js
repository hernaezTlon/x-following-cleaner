const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../content/scan-helpers');

test('safeJsonParse returns data on valid JSON', async () => {
  const response = {
    json: async () => ({ ok: true })
  };

  const result = await helpers.safeJsonParse(response);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { ok: true });
});

test('safeJsonParse handles JSON parse errors', async () => {
  const response = {
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    }
  };

  const result = await helpers.safeJsonParse(response);
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.ok(result.error instanceof Error);
});

test('safeJsonParse handles missing json method', async () => {
  const result = await helpers.safeJsonParse(null);
  assert.equal(result.ok, false);
});

test('safeFetchText returns error when fetch throws', async () => {
  const fetchFn = async () => {
    throw new TypeError('Failed to fetch');
  };

  const result = await helpers.safeFetchText(fetchFn, 'https://example.com');
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.ok(result.error instanceof Error);
});

test('shouldRetryGraphqlError flags query errors', () => {
  assert.equal(helpers.shouldRetryGraphqlError('Query: Unspecified'), true);
  assert.equal(helpers.shouldRetryGraphqlError('Unknown operation'), true);
  assert.equal(helpers.shouldRetryGraphqlError('Rate limit exceeded'), false);
});

test('isRateLimitError detects 429 and rate keywords', () => {
  assert.equal(helpers.isRateLimitError('API error: 429'), true);
  assert.equal(helpers.isRateLimitError('Rate limit exceeded'), true);
  assert.equal(helpers.isRateLimitError('Other error'), false);
});
