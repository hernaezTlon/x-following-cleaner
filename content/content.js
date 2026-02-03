// X Following Cleaner - Content Script
// By Damian Hernaez
// Using GraphQL API for fast scanning

(function() {
  'use strict';

  console.log('🧹 X Following Cleaner: Content script loaded (GraphQL mode)');

  const helpers = globalThis.XFollowingCleanerHelpers || {};
  const shouldRetryGraphqlError = helpers.shouldRetryGraphqlError || function(message) {
    const text = String(message || '').toLowerCase();
    if (!text) return false;
    if (text.includes('rate') || text.includes('429')) return false;
    return text.includes('query') || text.includes('unknown') || text.includes('unspecified') || text.includes('operation');
  };
  const isRateLimitError = helpers.isRateLimitError || function(message) {
    const text = String(message || '').toLowerCase();
    return text.includes('429') || text.includes('rate');
  };
  const safeJsonParse = helpers.safeJsonParse || (async (response) => {
    if (!response || typeof response.json !== 'function') {
      return { ok: false, data: null, error: new Error('no_json_method') };
    }
    try {
      const data = await response.json();
      return { ok: true, data, error: null };
    } catch (error) {
      return { ok: false, data: null, error };
    }
  });
  const safeFetchText = helpers.safeFetchText || (async (fetchFn, url, options) => {
    try {
      const response = await fetchFn(url, options);
      const text = await response.text();
      return { ok: response.ok, status: response.status, text, response };
    } catch (error) {
      return { ok: false, status: 0, text: '', error };
    }
  });

  let isRunning = false;
  let shouldStop = false;

  // Rate limiting for API calls (much faster than page loads)
  const DELAY_BETWEEN_API_CALLS = 1000; // 1 second between API calls
  const MAX_CONSECUTIVE_FAILURES = 10;
  const FAILURE_COOLDOWN = 30000; // 30 second cooldown

  // X.com GraphQL configuration
  const DEFAULT_GRAPHQL_QUERY_IDS = {
    UserByScreenName: 'xc8f1g7BYqr6VTzTbvNLGw',
    UserTweets: 'E3opETHurmVJflFsUBVuUQ'
  };
  const GRAPHQL_USER_OPERATIONS = ['UserByScreenName', 'UserByScreenNameV2'];
  const GRAPHQL_TWEET_OPERATIONS = ['UserTweets', 'UserTweetsAndReplies'];
  let graphqlQueryIds = { ...DEFAULT_GRAPHQL_QUERY_IDS };
  let graphqlUserOperation = 'UserByScreenName';
  let graphqlTweetsOperation = 'UserTweets';
  let graphqlQueryRefreshInFlight = null;
  let graphqlQueryLastRefreshAt = 0;
  const GRAPHQL_REFRESH_MIN_INTERVAL_MS = 30000;
  let graphqlUserOperationUnavailable = false;
  let graphqlUserFallbackLogged = false;

  const UNFOLLOW_SAVE_EVERY = 5;
  const UNFOLLOW_SAVE_INTERVAL_MS = 5000;
  let lastUnfollowSave = 0;
  let lastUnfollowIndexSaved = 0;

  // Cache for auth tokens
  let authCache = null;

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // CODEX: Wrap async work to avoid top-level await inside the listener.
    (async () => {
      console.log('📨 Received:', message.action);

      if (message.action === 'startScan') {
        if (isRunning) {
          sendResponse({ status: 'already_running' });
          return;
        }
        startScan(message.inactiveDays || 30);
        sendResponse({ status: 'started' });
        return;
      }
      if (message.action === 'startUnfollow') {
        if (isRunning) {
          sendResponse({ status: 'already_running' });
          return;
        }
        startUnfollow(message.usernames);
        sendResponse({ status: 'started' });
        return;
      }
      if (message.action === 'retrySkipped') {
        if (isRunning) {
          sendResponse({ status: 'already_running' });
          return;
        }
        startRetrySkipped(message.accounts, message.inactiveDays || 30);
        sendResponse({ status: 'started' });
        return;
      }
      if (message.action === 'stop') {
        shouldStop = true;

        // Save partial results before stopping (don't remove scanState so we can resume)
        const data = await chrome.storage.local.get(['scanState']);
        if (data.scanState) {
          data.scanState.status = 'paused';
          data.scanState.pausedAt = Date.now();
          await chrome.storage.local.set({ scanState: data.scanState });
          if (data.scanState.inactive) {
            await chrome.storage.local.set({
              scanResults: data.scanState.inactive,
              scanSkipped: data.scanState.skipped || []
            });
            console.log(`⏸️ Paused with ${data.scanState.inactive.length} results saved`);
          }
        }
        // Save unfollow progress if running
        const unfollowData = await chrome.storage.local.get(['unfollowState']);
        if (unfollowData.unfollowState) {
          unfollowData.unfollowState.status = 'paused';
          unfollowData.unfollowState.pausedAt = Date.now();
          await chrome.storage.local.set({ unfollowState: unfollowData.unfollowState });
        }
        sendResponse({ status: 'stopped', partialResults: data.scanState?.inactive || [] });
        return;
      }
      if (message.action === 'ping') {
        sendResponse({ status: 'alive' });
        return;
      }
      if (message.action === 'resumeScan') {
        resumeScanFromStorage();
        sendResponse({ status: 'resuming' });
        return;
      }

      sendResponse({ status: 'unknown_action' });
    })().catch((error) => {
      console.error('Message handling error:', error);
      try {
        sendResponse({ status: 'error', error: error.message || 'unknown_error' });
      } catch (e) {
        // Ignore sendResponse errors if channel is closed
      }
    });
    return true;
  });

  // Send message to popup
  function sendMsg(data) {
    console.log('📤 Sending:', data.type);
    chrome.runtime.sendMessage(data).catch(() => {});
  }

  // Get logged-in username from page
  function getMyUsername() {
    const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    if (link) return link.getAttribute('href')?.replace('/', '') || null;
    return null;
  }

  // Extract authentication tokens from the page
  function getAuthTokens() {
    if (authCache) return authCache;

    // Get CSRF token from cookies
    const cookies = document.cookie.split(';').map(c => c.trim());
    const ctCookie = cookies.find(c => c.startsWith('ct0='));
    const csrfToken = ctCookie ? ctCookie.split('=')[1] : null;

    // Get bearer token from React props or use the known public bearer
    // X.com uses a consistent bearer token for logged-in API calls
    const bearerToken = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

    if (!csrfToken) {
      console.error('Could not find CSRF token');
      return null;
    }

    authCache = { csrfToken, bearerToken };
    return authCache;
  }

  function buildGraphqlEndpoint(operationName) {
    const queryId = graphqlQueryIds[operationName];
    if (!queryId) return null;
    return `${queryId}/${operationName}`;
  }

  // CODEX: Refresh GraphQL query IDs by parsing the client-web bundle.
  async function refreshGraphqlQueryIds() {
    if (graphqlQueryRefreshInFlight) return graphqlQueryRefreshInFlight;

    graphqlQueryRefreshInFlight = (async () => {
      try {
        const now = Date.now();
        if (now - graphqlQueryLastRefreshAt < GRAPHQL_REFRESH_MIN_INTERVAL_MS) {
          return false;
        }
        graphqlQueryLastRefreshAt = now;

        const scriptUrls = getClientWebScriptUrls();
        if (scriptUrls.length === 0) {
          console.log('Could not locate client-web scripts to refresh GraphQL query IDs');
          return false;
        }

        let userById = null;
        let userByOp = graphqlUserOperation;
        let tweetsId = null;
        let tweetsOp = graphqlTweetsOperation;
        let fetchedAny = false;

        for (const scriptUrl of scriptUrls) {
          const result = await safeFetchText(fetch, scriptUrl, { credentials: 'include' });
          if (!result.ok || !result.text) {
            continue;
          }
          fetchedAny = true;
          const text = result.text;
          if (!userById) {
            for (const op of GRAPHQL_USER_OPERATIONS) {
              const found = extractQueryId(text, op);
              if (found) {
                userById = found;
                userByOp = op;
                break;
              }
            }
          }
          if (!userById) {
            const inferredOp = extractOperationWithVariable(text, 'screen_name');
            if (inferredOp) {
              const found = extractQueryId(text, inferredOp);
              if (found) {
                userById = found;
                userByOp = inferredOp;
              }
            }
          }
          if (!tweetsId) {
            tweetsId = extractQueryId(text, graphqlTweetsOperation);
          }
          if (!tweetsId) {
            for (const op of GRAPHQL_TWEET_OPERATIONS) {
              const found = extractQueryId(text, op);
              if (found) {
                tweetsId = found;
                tweetsOp = op;
                break;
              }
            }
          }

          if (userById && tweetsId) {
            break;
          }
        }

        if (!fetchedAny) {
          console.log('Failed to refresh GraphQL query IDs (no scripts fetched)');
          return false;
        }

        if (userById) {
          graphqlQueryIds[userByOp] = userById;
          graphqlUserOperation = userByOp;
        }
        if (tweetsId) {
          graphqlQueryIds[tweetsOp] = tweetsId;
          graphqlTweetsOperation = tweetsOp;
        }

        if (userById || tweetsId) {
          console.log('🔄 Refreshed GraphQL query IDs', {
            userByOperation: graphqlUserOperation,
            userByQueryId: graphqlQueryIds[graphqlUserOperation],
            tweetsOperation: graphqlTweetsOperation,
            tweetsQueryId: graphqlQueryIds[graphqlTweetsOperation]
          });
        }

        return Boolean(userById || tweetsId);
      } catch (error) {
        console.log('Failed to refresh GraphQL query IDs', error);
        return false;
      } finally {
        graphqlQueryRefreshInFlight = null;
      }
    })();

    return graphqlQueryRefreshInFlight;
  }

  // Make GraphQL API request
  async function graphqlRequest(operationName, variables, features = {}, attempt = 0) {
    const auth = getAuthTokens();
    if (!auth) throw new Error('Not authenticated');

    const endpoint = buildGraphqlEndpoint(operationName);
    if (!endpoint) throw new Error(`Missing query ID for ${operationName}`);

    const defaultFeatures = {
      rweb_tipjar_consumption_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      articles_preview_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      rweb_video_timestamps_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_enhance_cards_enabled: false,
      ...features
    };

    const url = new URL(`https://x.com/i/api/graphql/${endpoint}`);
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('features', JSON.stringify(defaultFeatures));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${auth.bearerToken}`,
        'X-Csrf-Token': auth.csrfToken,
        'Content-Type': 'application/json',
        'X-Twitter-Active-User': 'yes',
        'X-Twitter-Auth-Type': 'OAuth2Session',
        'X-Twitter-Client-Language': 'en'
      },
      credentials: 'include'
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 404 && attempt === 0) {
        // CODEX: Query IDs likely changed; refresh and retry once.
        const refreshed = await refreshGraphqlQueryIds();
        if (refreshed) {
          return graphqlRequest(operationName, variables, features, attempt + 1);
        }
      }
      if (response.status === 404) {
        console.warn('API Error:', response.status, text);
      } else {
        console.error('API Error:', response.status, text);
      }
      throw new Error(`API error: ${response.status}`);
    }

    const parsed = await safeJsonParse(response);
    if (!parsed.ok) {
      throw new Error('bad_json');
    }

    const json = parsed.data;
    if (json?.errors?.length) {
      const codes = json.errors.map(err => err.code || err.message).filter(Boolean).join(', ');
      const message = codes || 'graphql_error';

      if (attempt === 0 && shouldRetryGraphqlError(message)) {
        const refreshed = await refreshGraphqlQueryIds();
        if (refreshed) {
          return graphqlRequest(operationName, variables, features, attempt + 1);
        }
      }

      throw new Error(`API error: ${message}`);
    }

    return json;
  }

  // Get user ID from screen name
  async function getUserId(account) {
    const screenName = typeof account === 'string' ? account : account?.username;
    const cachedUserId = typeof account === 'string' ? null : account?.userId;
    if (cachedUserId) return cachedUserId;

    if (graphqlUserOperationUnavailable) {
      return getUserIdViaRest(screenName);
    }

    try {
      const data = await graphqlRequest(graphqlUserOperation, {
        screen_name: screenName,
        withSafetyModeUserFields: true
      });

      const restId = data?.data?.user?.result?.rest_id || null;
      if (restId && account && typeof account === 'object') {
        account.userId = restId;
      }
      return restId;
    } catch (e) {
      const msg = e?.message || '';
      if (msg.includes('404')) {
        console.warn(`Failed to get user ID for @${screenName}:`, e);
        graphqlUserOperationUnavailable = true;
        if (!graphqlUserFallbackLogged) {
          graphqlUserFallbackLogged = true;
          console.warn('GraphQL user lookup returned 404. Falling back to REST user lookup.');
        }
      } else {
        console.error(`Failed to get user ID for @${screenName}:`, e);
      }
      const restId = await getUserIdViaRest(screenName);
      if (restId && account && typeof account === 'object') {
        account.userId = restId;
      }
      return restId;
    }
  }

  // Get last tweet date for a user via API
  async function getLastTweetDateAPI(account) {
    const screenName = typeof account === 'string' ? account : account?.username;
    try {
      // First get the user ID
      const userId = await getUserId(account);
      if (!userId) {
        console.log(`  @${screenName}: Could not get user ID`);
        return { success: false, date: null, reason: 'no_user_id' };
      }

      // Now get their tweets
      const data = await graphqlRequest(graphqlTweetsOperation, {
        userId: userId,
        count: 5,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: false,
        withVoice: false,
        withV2Timeline: true
      });

      // Parse the timeline to find tweets
      const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];

      for (const instruction of instructions) {
        if (instruction.type === 'TimelineAddEntries') {
          for (const entry of instruction.entries || []) {
            const content = entry.content;
            if (content?.entryType === 'TimelineTimelineItem') {
              const tweet = content?.itemContent?.tweet_results?.result;
              if (tweet) {
                // Get created_at from tweet or legacy
                const createdAt = tweet.legacy?.created_at || tweet.core?.user_results?.result?.legacy?.created_at;
                if (createdAt) {
                  const date = new Date(createdAt);
                  if (!isNaN(date.getTime())) {
                    return { success: true, date: date, reason: null };
                  }
                }
              }
            }
          }
        }
      }

      // No tweets found
      return { success: true, date: null, reason: 'no_tweets' };

    } catch (e) {
      console.error(`Failed to get tweets for @${screenName}:`, e);

      // Attempt REST timeline fallback if GraphQL fails.
      try {
        const userId = typeof account === 'string' ? null : account?.userId;
        if (userId) {
          const restResult = await getLastTweetDateViaRest(userId);
          if (restResult.success) {
            return restResult;
          }
        }
      } catch (restError) {
        console.warn('REST timeline fallback failed', restError);
      }

      // Check for rate limiting
      const message = e?.message || '';
      if (isRateLimitError(message)) {
        return { success: false, date: null, reason: 'rate_limited' };
      }

      return { success: false, date: null, reason: 'api_error' };
    }
  }

  const SCANSTATE_SAVE_EVERY = 5;
  const SCANSTATE_SAVE_INTERVAL_MS = 5000;
  let lastScanStateSave = 0;
  let lastScanStateIndexSaved = 0;

  // CODEX: Reduce storage writes and add a single place to persist scanState safely.
  async function saveScanState(scanState, force = false) {
    const now = Date.now();
    if (
      force ||
      scanState.currentIndex === 0 ||
      scanState.currentIndex >= scanState.accounts.length ||
      scanState.currentIndex - lastScanStateIndexSaved >= SCANSTATE_SAVE_EVERY ||
      now - lastScanStateSave >= SCANSTATE_SAVE_INTERVAL_MS
    ) {
      try {
        await chrome.storage.local.set({ scanState });
        lastScanStateSave = now;
        lastScanStateIndexSaved = scanState.currentIndex;
      } catch (error) {
        console.log('Failed to persist scan state', error);
      }
    }
  }

  async function saveUnfollowState(unfollowState, force = false) {
    const now = Date.now();
    if (
      force ||
      unfollowState.currentIndex === 0 ||
      unfollowState.currentIndex >= unfollowState.accounts.length ||
      unfollowState.currentIndex - lastUnfollowIndexSaved >= UNFOLLOW_SAVE_EVERY ||
      now - lastUnfollowSave >= UNFOLLOW_SAVE_INTERVAL_MS
    ) {
      try {
        await chrome.storage.local.set({ unfollowState });
        lastUnfollowSave = now;
        lastUnfollowIndexSaved = unfollowState.currentIndex;
      } catch (error) {
        console.log('Failed to persist unfollow state', error);
      }
    }
  }

  async function recordUnfollowDebug(entry) {
    try {
      const data = await chrome.storage.local.get(['unfollowDebug']);
      const list = Array.isArray(data.unfollowDebug) ? data.unfollowDebug : [];
      const record = {
        time: Date.now(),
        username: entry.username,
        method: entry.method,
        success: Boolean(entry.success),
        reason: entry.reason || null
      };
      list.push(record);
      const trimmed = list.slice(-50);
      await chrome.storage.local.set({ unfollowDebug: trimmed });
      sendMsg({ type: 'unfollowDebug', entry: record });
    } catch (error) {
      // ignore debug failures
    }
  }

  // Start the scan - collect accounts first
  async function startScan(inactiveDays) {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;

    console.log('🔍 Starting scan (GraphQL mode), threshold:', inactiveDays, 'days');

    const myUsername = getMyUsername();
    console.log('👤 Logged in as:', myUsername);

    if (!myUsername) {
      sendMsg({ type: 'error', error: 'Could not detect username. Please log in to X.com.' });
      isRunning = false;
      return;
    }

    // Check authentication
    const auth = getAuthTokens();
    if (!auth) {
      sendMsg({ type: 'error', error: 'Could not get authentication tokens. Please refresh the page.' });
      isRunning = false;
      return;
    }

    // Navigate to following page if needed
    if (!window.location.pathname.includes('/following')) {
      await chrome.storage.local.set({
        scanIntent: { inactiveDays, myUsername }
      });
      sendMsg({ type: 'scanProgress', current: 0, total: 0, status: 'Opening following list...' });
      window.location.href = `https://x.com/${myUsername}/following`;
      return;
    }

    // CODEX: Prefer REST API to fetch following list (more reliable than DOM scrolling).
    sendMsg({ type: 'scanProgress', current: 0, total: 0, status: '📥 Fetching following list...' });
    let accounts = [];
    const restResult = await fetchFollowingAccountsViaRest(myUsername);
    if (restResult.success && restResult.accounts.length > 0) {
      accounts = restResult.accounts;
    } else {
      sendMsg({ type: 'scanProgress', current: 0, total: 0, status: '📜 Collecting accounts from page...' });
      // CODEX: Give the following list time to render and ensure user cells exist before collecting.
      await waitForUserCells();
      accounts = await collectAccounts();
    }
    console.log('✅ Collected', accounts.length, 'accounts');

    if (accounts.length === 0) {
      sendMsg({ type: 'scanComplete', results: [] });
      isRunning = false;
      return;
    }

    // CODEX: Cache a lightweight username->userId index for unfollow.
    await saveFollowingIndex(accounts);

    // Initialize scan state
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - inactiveDays);

    const scanState = {
      accounts: accounts,
      currentIndex: 0,
      inactive: [],
      active: [],
      skipped: [],
      inactiveDays: inactiveDays,
      cutoffTimestamp: cutoffDate.getTime(),
      myUsername: myUsername,
      startTime: Date.now(),
      consecutiveFailures: 0,
      mode: 'graphql',
      status: 'running',
      lastHeartbeat: Date.now()
    };

    await saveScanState(scanState, true);

    sendMsg({ type: 'scanProgress', current: 0, total: accounts.length, status: '🚀 Starting fast API scan...' });

    // Start checking via API
    await scanViaAPI(scanState);
  }

  // CODEX: Retry previously skipped accounts using existing inactive results.
  async function startRetrySkipped(accounts, inactiveDays) {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;

    const auth = getAuthTokens();
    if (!auth) {
      sendMsg({ type: 'error', error: 'Could not get authentication tokens. Please refresh the page.' });
      isRunning = false;
      return;
    }

    const stored = await chrome.storage.local.get(['scanResults', 'scanSkipped']);
    const existingInactive = Array.isArray(stored.scanResults) ? stored.scanResults : [];
    const inactiveSet = new Set(existingInactive.map(acc => acc.username?.toLowerCase()).filter(Boolean));

    const skippedList = Array.isArray(accounts) && accounts.length > 0 ? accounts : (stored.scanSkipped || []);
    let retryAccounts = normalizeAccounts(skippedList);
    let followingIndex = await loadFollowingIndex();
    if (followingIndex.size === 0) {
      const myUsername = getMyUsername();
      if (myUsername) {
        const restResult = await fetchFollowingAccountsViaRest(myUsername);
        if (restResult.success && restResult.accounts.length > 0) {
          await saveFollowingIndex(restResult.accounts);
          followingIndex = await loadFollowingIndex();
        }
      }
    }
    retryAccounts = retryAccounts.map(account => {
      if (!account.userId) {
        const entry = followingIndex.get(account.username.toLowerCase());
        if (entry?.userId) {
          return { ...account, userId: entry.userId };
        }
      }
      return account;
    });
    retryAccounts = retryAccounts.filter(acc => !inactiveSet.has(acc.username.toLowerCase()));

    if (retryAccounts.length === 0) {
      sendMsg({ type: 'error', error: 'No skipped accounts to retry.' });
      isRunning = false;
      return;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - inactiveDays);

    const scanState = {
      accounts: retryAccounts,
      currentIndex: 0,
      inactive: existingInactive,
      active: [],
      skipped: [],
      inactiveDays: inactiveDays,
      cutoffTimestamp: cutoffDate.getTime(),
      myUsername: null,
      startTime: Date.now(),
      consecutiveFailures: 0,
      mode: 'retry_skipped',
      status: 'running',
      lastHeartbeat: Date.now()
    };

    await saveScanState(scanState, true);
    sendMsg({
      type: 'scanProgress',
      current: 0,
      total: retryAccounts.length,
      status: '🔁 Retrying skipped accounts...'
    });

    await scanViaAPI(scanState);
  }

  // Resume scan from storage
  async function resumeScanFromStorage() {
    // CODEX: Avoid duplicate scan loops.
    if (isRunning) {
      console.log('Resume requested but scan is already running');
      return;
    }
    const data = await chrome.storage.local.get(['scanState', 'scanIntent']);

    // Check if we should start a new scan
    if (data.scanIntent && window.location.pathname.includes('/following')) {
      const { inactiveDays } = data.scanIntent;
      await chrome.storage.local.remove(['scanIntent']);
      startScan(inactiveDays);
      return;
    }

    // Resume existing scan
    if (data.scanState) {
      console.log('🔄 Resuming scan at index', data.scanState.currentIndex);
      isRunning = true;
      shouldStop = false;
      data.scanState.status = 'running';
      data.scanState.lastHeartbeat = Date.now();
      data.scanState.pausedAt = null;
      await saveScanState(data.scanState, true);
      await scanViaAPI(data.scanState);
    }
  }

  // Main API scanning loop
  async function scanViaAPI(scanState) {
    const cutoffDate = new Date(scanState.cutoffTimestamp);
    scanState.status = 'running';
    const inactiveSet = new Set(
      (scanState.inactive || [])
        .map(acc => acc?.username?.toLowerCase())
        .filter(Boolean)
    );

    while (scanState.currentIndex < scanState.accounts.length && !shouldStop) {
      const acc = scanState.accounts[scanState.currentIndex];
      const progress = Math.round(((scanState.currentIndex + 1) / scanState.accounts.length) * 100);
      scanState.lastHeartbeat = Date.now();

      sendMsg({
        type: 'scanProgress',
        current: scanState.currentIndex + 1,
        total: scanState.accounts.length,
        status: `[${progress}%] Checking @${acc.username}...`,
        currentAccount: acc.username,
        inactiveFound: scanState.inactive.length,
        skippedFound: scanState.skipped.length
      });

      // Get last tweet date via API
      try {
        const result = await getLastTweetDateAPI(acc);

        if (result.success) {
          scanState.consecutiveFailures = 0;

          const lastPost = result.date;
          console.log(`  @${acc.username}:`, lastPost ? lastPost.toISOString() : 'no posts');

          if (!lastPost || lastPost < cutoffDate) {
            const days = lastPost ? Math.floor((Date.now() - lastPost) / 86400000) : null;
            const key = acc.username.toLowerCase();
            if (!inactiveSet.has(key)) {
              inactiveSet.add(key);
            scanState.inactive.push({
              username: acc.username,
              name: acc.name,
              userId: acc.userId || null,
              lastActive: lastPost ? formatDate(lastPost) : 'No recent posts',
              daysInactive: days
            });
            }
            console.log(`  ❌ Inactive: @${acc.username}`);
          } else {
            scanState.active.push(acc.username);
            console.log(`  ✅ Active: @${acc.username}`);
          }
        } else {
          // API call failed
          scanState.consecutiveFailures++;
          console.log(`  ⚠️ Failed: @${acc.username} (${result.reason})`);

          if (result.reason === 'rate_limited') {
            // Rate limited - need longer cooldown
            sendMsg({
              type: 'scanProgress',
              current: scanState.currentIndex,
              total: scanState.accounts.length,
              status: `⏸️ Rate limited! Waiting 30s...`,
              currentAccount: acc.username,
              inactiveFound: scanState.inactive.length,
              skippedFound: scanState.skipped.length
            });
            await sleep(FAILURE_COOLDOWN);
            scanState.consecutiveFailures = 0;
            // Don't increment index - retry this account
            await saveScanState(scanState, true);
            continue;
          }

          // Other failure - skip this account
          scanState.skipped.push({
            username: acc.username,
            name: acc.name,
            userId: acc.userId || null,
            reason: result.reason || 'unknown'
          });

          if (scanState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            sendMsg({
              type: 'scanProgress',
              current: scanState.currentIndex,
              total: scanState.accounts.length,
              status: `⏸️ Too many failures. Waiting 30s...`,
              currentAccount: acc.username,
              inactiveFound: scanState.inactive.length,
              skippedFound: scanState.skipped.length
            });
            await sleep(FAILURE_COOLDOWN);
            scanState.consecutiveFailures = 0;
          }
        }
      } catch (error) {
        // CODEX: Never allow a per-account failure to halt the scan loop.
        console.error('Unexpected scan error:', error);
        scanState.skipped.push({
          username: acc.username,
          name: acc.name,
          userId: acc.userId || null,
          reason: 'exception'
        });
      }

      scanState.currentIndex++;
      await saveScanState(scanState);

      // Small delay between requests
      if (scanState.currentIndex < scanState.accounts.length) {
        await sleep(DELAY_BETWEEN_API_CALLS);
      }
    }

    // Scan complete
    if (!shouldStop) {
      console.log('🏁 Scan complete!');
      const skippedCount = scanState.skipped?.length || 0;
      let statusMsg = `✅ Found ${scanState.inactive.length} inactive accounts`;
      if (skippedCount > 0) {
        statusMsg += ` (${skippedCount} couldn't be checked)`;
      }
      sendMsg({
        type: 'scanProgress',
        current: scanState.accounts.length,
        total: scanState.accounts.length,
        status: statusMsg,
        inactiveFound: scanState.inactive.length,
        skippedFound: scanState.skipped.length
      });

      // IMPORTANT: Save results to storage BEFORE removing scanState
      // This ensures results persist even if popup wasn't open
      await chrome.storage.local.set({ scanResults: scanState.inactive, scanSkipped: scanState.skipped });
      console.log(`💾 Saved ${scanState.inactive.length} results to storage`);

      sendMsg({ type: 'scanComplete', results: scanState.inactive, skipped: scanState.skipped });
      await chrome.storage.local.remove(['scanState']);
    } else {
      // CODEX: Mark scan as paused if we exited early.
      scanState.status = 'paused';
      scanState.pausedAt = Date.now();
      await saveScanState(scanState, true);
    }

    isRunning = false;
  }

  // Collect accounts from the following page
  async function collectAccounts() {
    const accounts = [];
    const seen = new Set();
    let lastCount = 0;
    let noNewCount = 0;
    let noMoveCount = 0;
    const scrollContainer = getScrollContainer();
    const maxIterations = 400;
    const noNewThreshold = 8;
    const noMoveThreshold = 5;

    for (let i = 0; i < maxIterations && !shouldStop; i++) {
      document.querySelectorAll('[data-testid="UserCell"]').forEach(cell => {
        const link = Array.from(cell.querySelectorAll('a[href^="/"]')).find(a => {
          const h = a.getAttribute('href');
          return h && /^\/[^\/]+$/.test(h) && !['home','explore','notifications','messages','settings','i'].includes(h.slice(1));
        });
        if (link) {
          const username = link.getAttribute('href').slice(1);
          if (!seen.has(username.toLowerCase())) {
            seen.add(username.toLowerCase());
            const name = cell.querySelector('span')?.textContent || username;
            const userId = extractUserIdFromCell(cell);
            accounts.push({ username, name, userId });
          }
        }
      });

      if (i % 5 === 0) {
        sendMsg({ type: 'scanProgress', current: 0, total: 0, status: `📜 Loading... (${accounts.length} found)` });
      }

      // CODEX: Scroll the container that actually holds the following list.
      const moved = scrollFollowingList(scrollContainer);
      await sleep(700);

      if (accounts.length === lastCount) noNewCount++;
      else { noNewCount = 0; lastCount = accounts.length; }

      if (!moved) noMoveCount++;
      else noMoveCount = 0;

      if (noNewCount >= noNewThreshold && noMoveCount >= noMoveThreshold) {
        break;
      }
    }

    if (scrollContainer) {
      scrollContainer.scrollTo(0, 0);
    } else {
      window.scrollTo(0, 0);
    }
    return accounts;
  }

  // Unfollow accounts
  async function startUnfollow(usernames) {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;

    let list = normalizeAccounts(usernames);
    let followingIndex = await loadFollowingIndex();
    if (followingIndex.size === 0) {
      const myUsername = getMyUsername();
      if (myUsername) {
        const restResult = await fetchFollowingAccountsViaRest(myUsername);
        if (restResult.success && restResult.accounts.length > 0) {
          await saveFollowingIndex(restResult.accounts);
          followingIndex = await loadFollowingIndex();
        }
      }
    }
    list = list.map(account => {
      if (!account.userId) {
        const entry = followingIndex.get(account.username.toLowerCase());
        if (entry?.userId) {
          return { ...account, userId: entry.userId };
        }
      }
      return account;
    });
    if (list.length === 0) {
      sendMsg({ type: 'unfollowComplete', unfollowed: 0, usernames: [], skipped: [] });
      isRunning = false;
      return;
    }

    const state = {
      accounts: list,
      currentIndex: 0,
      done: [],
      skipped: [],
      status: 'running',
      startTime: Date.now()
    };

    await saveUnfollowState(state, true);

    const ready = await ensureFollowingPage();
    if (!ready) {
      // Page will reload; resume from storage.
      isRunning = false;
      return;
    }

    await runUnfollow(state);
  }

  // CODEX: Resume unfollow from storage if available.
  async function resumeUnfollowFromStorage() {
    if (isRunning) return;
    const data = await chrome.storage.local.get(['unfollowState']);
    if (!data.unfollowState) return;

    const state = data.unfollowState;
    if (!state.accounts || state.accounts.length === 0) {
      await chrome.storage.local.remove('unfollowState');
      return;
    }

    state.status = 'running';
    await saveUnfollowState(state, true);
    const ready = await ensureFollowingPage();
    if (!ready) return;
    await runUnfollow(state);
  }

  // CODEX: Ensure we are on the following page for DOM fallback.
  async function ensureFollowingPage() {
    if (window.location.pathname.includes('/following')) {
      return true;
    }

    const myUsername = getMyUsername();
    if (!myUsername) {
      sendMsg({ type: 'error', error: 'Could not detect username. Please log in to X.com.' });
      try {
        await chrome.storage.local.remove('unfollowState');
      } catch (error) {
        // ignore
      }
      return false;
    }

    window.location.href = `https://x.com/${myUsername}/following`;
    return false;
  }

  async function runUnfollow(state) {
    isRunning = true;
    shouldStop = false;

    const unfollowDelay = await getUnfollowDelay();

    for (let i = state.currentIndex; i < state.accounts.length && !shouldStop; i++) {
      const account = state.accounts[i];
      state.currentIndex = i;
      sendMsg({ type: 'unfollowProgress', current: i + 1, total: state.accounts.length, status: `Unfollowing @${account.username}...` });

      let attempts = 0;
      let unfollowed = false;
      while (attempts < 3 && !unfollowed && !shouldStop) {
        attempts += 1;
        const result = await unfollowViaRest(account);
        await recordUnfollowDebug({
          username: account.username,
          method: 'rest',
          success: result.success,
          reason: result.reason
        });

        if (result.success) {
          state.done.push(account.username);
          unfollowed = true;
          break;
        }

        if (result.reason === 'rate_limited') {
          sendMsg({
            type: 'unfollowProgress',
            current: i + 1,
            total: state.accounts.length,
            status: 'Rate limited. Waiting 60s...'
          });
          await sleep(60000);
          continue;
        }

        // Try DOM fallback for any non-rate-limited REST failure.
        const domResult = await unfollowViaDom(account);
        await recordUnfollowDebug({
          username: account.username,
          method: 'dom',
          success: domResult.success,
          reason: domResult.reason
        });
        if (domResult.success) {
          state.done.push(account.username);
          unfollowed = true;
          break;
        }
        state.skipped.push({
          username: account.username,
          name: account.name,
          reason: domResult.reason || result.reason || 'unfollow_failed'
        });
        break;
      }

      await saveUnfollowState(state);

      if (i < state.accounts.length - 1 && !shouldStop) {
        sendMsg({ type: 'unfollowProgress', current: i + 1, total: state.accounts.length, status: 'Waiting...' });
        await sleep(unfollowDelay);
      }
    }

    if (state.skipped.length > 0) {
      console.log(`⚠️ Skipped ${state.skipped.length} accounts during unfollow`);
    }

    await chrome.storage.local.remove('unfollowState');
    sendMsg({ type: 'unfollowComplete', unfollowed: state.done.length, usernames: state.done, skipped: state.skipped });
    isRunning = false;
  }

  // Helpers
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function formatDate(d) {
    const days = Math.floor((Date.now() - d) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 30) return Math.floor(days / 7) + ' weeks ago';
    if (days < 365) return Math.floor(days / 30) + ' months ago';
    return Math.floor(days / 365) + ' years ago';
  }

  // CODEX: Normalize account lists to a consistent shape.
  function normalizeAccounts(list) {
    const normalized = [];
    const seen = new Set();
    (list || []).forEach(item => {
      const username = typeof item === 'string' ? item : item?.username;
      if (!username) return;
      const key = username.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      normalized.push({
        username,
        name: typeof item === 'object' && item?.name ? item.name : username,
        userId: typeof item === 'object' ? item?.userId || null : null
      });
    });
    return normalized;
  }

  async function saveFollowingIndex(accounts) {
    try {
      const index = (accounts || [])
        .filter(acc => acc?.username)
        .map(acc => ({
          username: acc.username,
          userId: acc.userId || null,
          name: acc.name || acc.username
        }));
      await chrome.storage.local.set({ followingIndex: index });
    } catch (error) {
      console.log('Failed to save following index', error);
    }
  }

  async function loadFollowingIndex() {
    try {
      const data = await chrome.storage.local.get(['followingIndex']);
      const list = Array.isArray(data.followingIndex) ? data.followingIndex : [];
      const map = new Map();
      list.forEach(entry => {
        if (entry?.username) {
          map.set(entry.username.toLowerCase(), entry);
        }
      });
      return map;
    } catch (error) {
      return new Map();
    }
  }

  // CODEX: Fetch delay between unfollow actions (defaults to 3s).
  async function getUnfollowDelay() {
    try {
      const data = await chrome.storage.local.get(['unfollowDelay']);
      const delay = parseInt(data.unfollowDelay, 10);
      if (!Number.isFinite(delay) || delay < 1000) return 3000;
      return delay;
    } catch (error) {
      return 3000;
    }
  }

  // CODEX: Locate candidate client-web scripts to extract GraphQL query IDs.
  function getClientWebScriptUrls() {
    const urls = new Set();
    const isCandidate = (src) =>
      src &&
      src.includes('abs.twimg.com/responsive-web') &&
      src.endsWith('.js');

    Array.from(document.scripts || []).forEach(script => {
      if (isCandidate(script.src)) urls.add(script.src);
    });

    Array.from(document.querySelectorAll('link[rel="preload"][as="script"]')).forEach(link => {
      if (isCandidate(link.href)) urls.add(link.href);
    });

    const perf = performance.getEntriesByType?.('resource') || [];
    perf.forEach(entry => {
      if (isCandidate(entry.name)) urls.add(entry.name);
    });

    return Array.from(urls);
  }

  // CODEX: Extract a GraphQL query ID from the client-web bundle.
  function extractQueryId(bundleText, operationName) {
    if (!bundleText || !operationName) return null;

    const patterns = [
      new RegExp(`"${operationName}"\\s*:\\s*\\{"queryId"\\s*:\\s*"([A-Za-z0-9_-]+)"`),
      new RegExp(`'${operationName}'\\s*:\\s*\\{"queryId"\\s*:\\s*'([A-Za-z0-9_-]+)'`),
      new RegExp(`operationName\\s*:\\s*"${operationName}"[^}]*?queryId\\s*:\\s*"([A-Za-z0-9_-]+)"`),
      new RegExp(`operationName\\s*:\\s*'${operationName}'[^}]*?queryId\\s*:\\s*'([A-Za-z0-9_-]+)'`),
      new RegExp(`"${operationName}".{0,150}?"queryId"\\s*:\\s*"([A-Za-z0-9_-]+)"`),
      new RegExp(`'${operationName}'.{0,150}?'queryId'\\s*:\\s*'([A-Za-z0-9_-]+)'`)
    ];

    for (const pattern of patterns) {
      const match = bundleText.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  // CODEX: Guess the operation name that includes a given variable (best-effort).
  function extractOperationWithVariable(bundleText, variableName) {
    if (!bundleText || !variableName) return null;
    const patterns = [
      new RegExp(`operationName\\s*:\\s*"([^"]+)"[^}]{0,200}${variableName}`),
      new RegExp(`operationName\\s*:\\s*'([^']+)'[^}]{0,200}${variableName}`),
      new RegExp(`"operationName"\\s*:\\s*"([^"]+)"[^}]{0,200}"${variableName}"`),
      new RegExp(`'operationName'\\s*:\\s*'([^']+)'[^}]{0,200}'${variableName}'`)
    ];

    for (const pattern of patterns) {
      const match = bundleText.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  // CODEX: Find the scroll container that actually grows as we load user cells.
  function getScrollContainer() {
    const firstCell = document.querySelector('[data-testid="UserCell"]');
    if (firstCell) {
      let node = firstCell.parentElement;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight >= node.clientHeight) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return document.scrollingElement || document.documentElement || document.body;
  }

  // CODEX: Fallback to REST timeline if GraphQL tweet query fails.
  async function getLastTweetDateViaRest(userId) {
    try {
      const auth = getAuthTokens();
      if (!auth) return { success: false, date: null, reason: 'no_auth' };

      const url = new URL('https://x.com/i/api/1.1/statuses/user_timeline.json');
      url.searchParams.set('user_id', String(userId));
      url.searchParams.set('count', '5');
      url.searchParams.set('tweet_mode', 'extended');
      url.searchParams.set('include_rts', '1');
      url.searchParams.set('exclude_replies', '0');

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${auth.bearerToken}`,
          'X-Csrf-Token': auth.csrfToken,
          'Content-Type': 'application/json',
          'X-Twitter-Active-User': 'yes',
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Client-Language': 'en'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        if (response.status === 429) {
          return { success: false, date: null, reason: 'rate_limited' };
        }
        return { success: false, date: null, reason: 'rest_error' };
      }

      const parsed = await safeJsonParse(response);
      if (!parsed.ok) {
        return { success: false, date: null, reason: 'bad_json' };
      }
      const data = parsed.data;
      if (!Array.isArray(data) || data.length === 0) {
        return { success: true, date: null, reason: 'no_tweets' };
      }

      const createdAt = data[0]?.created_at;
      if (createdAt) {
        const date = new Date(createdAt);
        if (!isNaN(date.getTime())) {
          return { success: true, date, reason: null };
        }
      }

      return { success: true, date: null, reason: 'no_tweets' };
    } catch (error) {
      console.warn('REST timeline lookup failed', error);
      return { success: false, date: null, reason: 'rest_error' };
    }
  }

  // CODEX: Attempt to read a user ID from the DOM cell (if present).
  function extractUserIdFromCell(cell) {
    if (!cell) return null;
    const direct = cell.getAttribute('data-user-id') || cell.getAttribute('data-userid') || cell.dataset?.userId;
    if (direct) return String(direct);

    const candidate = cell.querySelector('[data-user-id], [data-userid], [data-item-id]');
    if (candidate) {
      const value =
        candidate.getAttribute('data-user-id') ||
        candidate.getAttribute('data-userid') ||
        candidate.getAttribute('data-item-id');
      if (value) return String(value);
    }

    return null;
  }

  // CODEX: Unfollow via REST API to avoid DOM dependencies.
  async function unfollowViaRest(account) {
    try {
      const auth = getAuthTokens();
      if (!auth) return { success: false, reason: 'no_auth' };

      const userId = account.userId || await getUserId(account);
      if (!userId) {
        return { success: false, reason: 'no_user_id' };
      }

      const body = new URLSearchParams();
      body.set('user_id', String(userId));
      body.set('screen_name', account.username);

      const response = await fetch('https://x.com/i/api/1.1/friendships/destroy.json', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.bearerToken}`,
          'X-Csrf-Token': auth.csrfToken,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twitter-Active-User': 'yes',
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Client-Language': 'en'
        },
        body: body.toString(),
        credentials: 'include'
      });

      if (response.status === 429) {
        return { success: false, reason: 'rate_limited' };
      }

      if (!response.ok) {
        return { success: false, reason: `http_${response.status}` };
      }

      const parsed = await safeJsonParse(response);
      if (!parsed.ok) {
        return { success: false, reason: 'bad_json' };
      }

      if (parsed.data?.errors?.length) {
        const message = parsed.data.errors.map(err => err.message || err.code).filter(Boolean).join(', ');
        return { success: false, reason: message || 'api_error' };
      }

      const data = parsed.data || {};
      if (typeof data.following === 'boolean') {
        return data.following ? { success: false, reason: 'still_following' } : { success: true };
      }
      if (data?.relationship?.source?.following === false) {
        return { success: true };
      }

      return { success: false, reason: 'unknown_response' };
    } catch (error) {
      return { success: false, reason: 'exception' };
    }
  }

  // CODEX: DOM fallback when REST unfollow is inconclusive.
  async function unfollowViaDom(account) {
    if (!window.location.pathname.includes('/following')) {
      return { success: false, reason: 'not_on_following' };
    }
    await waitForUserCells();

    const cell = await findUserCellByUsername(account.username);
    if (!cell) return { success: false, reason: 'not_found' };

    const btn = cell.querySelector('[data-testid$="-unfollow"]') ||
               Array.from(cell.querySelectorAll('[role="button"]')).find(b => /^Following/.test(b.textContent));
    if (!btn) return { success: false, reason: 'no_button' };

    btn.click();
    await sleep(400);
    const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (confirm) {
      confirm.click();
      await sleep(400);
      return { success: true };
    }

    return { success: false, reason: 'no_confirm' };
  }

  // CODEX: Fallback to the internal REST endpoint if GraphQL query IDs fail.
  async function getUserIdViaRest(screenName) {
    try {
      const auth = getAuthTokens();
      if (!auth) return null;

      const url = new URL('https://x.com/i/api/1.1/users/show.json');
      url.searchParams.set('screen_name', screenName);

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${auth.bearerToken}`,
          'X-Csrf-Token': auth.csrfToken,
          'Content-Type': 'application/json',
          'X-Twitter-Active-User': 'yes',
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Client-Language': 'en'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        return null;
      }

      const parsed = await safeJsonParse(response);
      if (!parsed.ok) {
        return null;
      }
      const data = parsed.data;
      return data?.id_str || (data?.id ? String(data.id) : null);
    } catch (error) {
      console.warn('REST user lookup failed', error);
      return null;
    }
  }

  // CODEX: Scroll the list and report if we actually moved.
  function scrollFollowingList(container) {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    const lastCell = cells[cells.length - 1];

    if (container && container !== document.body && container !== document.documentElement && container !== document.scrollingElement) {
      const beforeTop = container.scrollTop;
      if (lastCell) {
        lastCell.scrollIntoView({ block: 'end' });
      } else {
        container.scrollTop = beforeTop + Math.max(container.clientHeight * 0.9, 400);
      }
      const afterTop = container.scrollTop;
      return afterTop > beforeTop;
    }

    const beforeTop = window.scrollY;
    if (lastCell) {
      lastCell.scrollIntoView({ block: 'end' });
    } else {
      window.scrollBy(0, window.innerHeight * 0.9);
    }
    const afterTop = window.scrollY;
    return afterTop > beforeTop;
  }

  // CODEX: Fetch the following list via REST API for reliability.
  async function fetchFollowingAccountsViaRest(screenName) {
    try {
      const auth = getAuthTokens();
      if (!auth) return { success: false, accounts: [], reason: 'no_auth' };

      let cursor = '-1';
      const accounts = [];
      let page = 0;

      while (cursor !== '0' && !shouldStop && page < 50) {
        const url = new URL('https://x.com/i/api/1.1/friends/list.json');
        url.searchParams.set('count', '200');
        url.searchParams.set('cursor', cursor);
        url.searchParams.set('skip_status', '1');
        url.searchParams.set('include_user_entities', '0');
        url.searchParams.set('screen_name', screenName);

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${auth.bearerToken}`,
            'X-Csrf-Token': auth.csrfToken,
            'Content-Type': 'application/json',
            'X-Twitter-Active-User': 'yes',
            'X-Twitter-Auth-Type': 'OAuth2Session',
            'X-Twitter-Client-Language': 'en'
          },
          credentials: 'include'
        });

        if (!response.ok) {
          return { success: false, accounts, status: response.status };
        }

        const parsed = await safeJsonParse(response);
        if (!parsed.ok) {
          return { success: false, accounts, status: response.status, reason: 'bad_json' };
        }
        const data = parsed.data;
        const users = Array.isArray(data?.users) ? data.users : [];
        for (const user of users) {
          if (!user?.screen_name) continue;
          accounts.push({
            username: user.screen_name,
            name: user.name || user.screen_name,
            userId: user.id_str || (user.id ? String(user.id) : null)
          });
        }

        cursor = data?.next_cursor_str || String(data?.next_cursor || 0);
        page += 1;

        if (page % 2 === 0) {
          sendMsg({ type: 'scanProgress', current: 0, total: 0, status: `📥 Fetching following list... (${accounts.length})` });
        }
      }

      return { success: accounts.length > 0, accounts };
    } catch (error) {
      console.warn('REST following list fetch failed', error);
      return { success: false, accounts: [], reason: 'rest_error' };
    }
  }

  // CODEX: Wait until the following list renders at least one user cell.
  async function waitForUserCells(timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (document.querySelector('[data-testid="UserCell"]')) {
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  // CODEX: Try to locate a user cell by scrolling the list for a limited number of attempts.
  async function findUserCellByUsername(username, maxScrolls = 60) {
    const scrollContainer = getScrollContainer();
    await waitForUserCells();

    for (let pass = 0; pass < 2 && !shouldStop; pass++) {
      let noMoveCount = 0;

      for (let i = 0; i < maxScrolls && !shouldStop; i++) {
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        for (const cell of cells) {
          if (cell.querySelector(`a[href="/${username}"]`)) {
            return cell;
          }
        }

        const moved = scrollFollowingList(scrollContainer);
        await sleep(500);
        if (!moved) noMoveCount += 1;
        else noMoveCount = 0;

        if (noMoveCount >= 3) break;
      }

      // Try once more from the top in case the user was above the current scroll.
      if (scrollContainer && scrollContainer !== document.body) {
        scrollContainer.scrollTo(0, 0);
      } else {
        window.scrollTo(0, 0);
      }
      await sleep(500);
    }

    return null;
  }

  // Auto-resume scan on page load
  async function checkForResume() {
    await sleep(500);
    const data = await chrome.storage.local.get(['scanState', 'scanIntent', 'unfollowState']);

    if (data.scanIntent && window.location.pathname.includes('/following')) {
      const { inactiveDays } = data.scanIntent;
      await chrome.storage.local.remove(['scanIntent']);
      startScan(inactiveDays);
      return;
    }

    if (data.scanState) {
      // CODEX: Only auto-resume if the scan was running.
      if (data.scanState.status === 'running') {
        console.log('🔄 Resuming scan at index', data.scanState.currentIndex);
        resumeScanFromStorage();
      }
    }

    if (data.unfollowState && data.unfollowState.status === 'running') {
      console.log('🔄 Resuming unfollow at index', data.unfollowState.currentIndex);
      resumeUnfollowFromStorage();
    }
  }

  checkForResume();

  console.log('🧹 X Following Cleaner: Ready! (GraphQL mode - 5x faster)');
})();
