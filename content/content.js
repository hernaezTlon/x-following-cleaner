// X Following Cleaner - Content Script
// By Damian Hernaez
// Using GraphQL API for fast scanning

(function() {
  'use strict';

  console.log('🧹 X Following Cleaner: Content script loaded (GraphQL mode)');

  let isRunning = false;
  let shouldStop = false;

  // Rate limiting for API calls (much faster than page loads)
  const DELAY_BETWEEN_API_CALLS = 1000; // 1 second between API calls
  const MAX_CONSECUTIVE_FAILURES = 10;
  const FAILURE_COOLDOWN = 30000; // 30 second cooldown

  // X.com GraphQL configuration
  const GRAPHQL_USER_BY_SCREEN_NAME = 'xc8f1g7BYqr6VTzTbvNLGw/UserByScreenName';
  const GRAPHQL_USER_TWEETS = 'E3opETHurmVJflFsUBVuUQ/UserTweets';

  // Cache for auth tokens
  let authCache = null;

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('📨 Received:', message.action);

    if (message.action === 'startScan') {
      startScan(message.inactiveDays || 30);
      sendResponse({ status: 'started' });
    } else if (message.action === 'startUnfollow') {
      startUnfollow(message.usernames);
      sendResponse({ status: 'started' });
    } else if (message.action === 'stop') {
      shouldStop = true;
      isRunning = false;
      // Save partial results before stopping (don't remove scanState so we can resume)
      const data = await chrome.storage.local.get(['scanState']);
      if (data.scanState && data.scanState.inactive) {
        await chrome.storage.local.set({ scanResults: data.scanState.inactive });
        console.log(`⏸️ Paused with ${data.scanState.inactive.length} results saved`);
      }
      sendResponse({ status: 'stopped', partialResults: data.scanState?.inactive || [] });
    } else if (message.action === 'ping') {
      sendResponse({ status: 'alive' });
    } else if (message.action === 'resumeScan') {
      resumeScanFromStorage();
      sendResponse({ status: 'resuming' });
    }
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

  // Make GraphQL API request
  async function graphqlRequest(endpoint, variables, features = {}) {
    const auth = getAuthTokens();
    if (!auth) throw new Error('Not authenticated');

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
      console.error('API Error:', response.status, text);
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  }

  // Get user ID from screen name
  async function getUserId(screenName) {
    try {
      const data = await graphqlRequest(GRAPHQL_USER_BY_SCREEN_NAME, {
        screen_name: screenName,
        withSafetyModeUserFields: true
      });

      return data?.data?.user?.result?.rest_id || null;
    } catch (e) {
      console.error(`Failed to get user ID for @${screenName}:`, e);
      return null;
    }
  }

  // Get last tweet date for a user via API
  async function getLastTweetDateAPI(screenName) {
    try {
      // First get the user ID
      const userId = await getUserId(screenName);
      if (!userId) {
        console.log(`  @${screenName}: Could not get user ID`);
        return { success: false, date: null, reason: 'no_user_id' };
      }

      // Now get their tweets
      const data = await graphqlRequest(GRAPHQL_USER_TWEETS, {
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

      // Check for rate limiting
      if (e.message.includes('429') || e.message.includes('rate')) {
        return { success: false, date: null, reason: 'rate_limited' };
      }

      return { success: false, date: null, reason: 'api_error' };
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

    sendMsg({ type: 'scanProgress', current: 0, total: 0, status: '📜 Collecting accounts...' });
    await sleep(1500);

    // Collect accounts by scrolling
    const accounts = await collectAccounts();
    console.log('✅ Collected', accounts.length, 'accounts');

    if (accounts.length === 0) {
      sendMsg({ type: 'scanComplete', results: [] });
      isRunning = false;
      return;
    }

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
      mode: 'graphql'
    };

    await chrome.storage.local.set({ scanState });

    sendMsg({ type: 'scanProgress', current: 0, total: accounts.length, status: '🚀 Starting fast API scan...' });

    // Start checking via API
    await scanViaAPI(scanState);
  }

  // Resume scan from storage
  async function resumeScanFromStorage() {
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
      await scanViaAPI(data.scanState);
    }
  }

  // Main API scanning loop
  async function scanViaAPI(scanState) {
    const cutoffDate = new Date(scanState.cutoffTimestamp);

    while (scanState.currentIndex < scanState.accounts.length && !shouldStop) {
      const acc = scanState.accounts[scanState.currentIndex];
      const progress = Math.round(((scanState.currentIndex + 1) / scanState.accounts.length) * 100);

      sendMsg({
        type: 'scanProgress',
        current: scanState.currentIndex + 1,
        total: scanState.accounts.length,
        status: `[${progress}%] Checking @${acc.username}...`,
        currentAccount: acc.username,
        inactiveFound: scanState.inactive.length
      });

      // Get last tweet date via API
      const result = await getLastTweetDateAPI(acc.username);

      if (result.success) {
        scanState.consecutiveFailures = 0;

        const lastPost = result.date;
        console.log(`  @${acc.username}:`, lastPost ? lastPost.toISOString() : 'no posts');

        if (!lastPost || lastPost < cutoffDate) {
          const days = lastPost ? Math.floor((Date.now() - lastPost) / 86400000) : null;
          scanState.inactive.push({
            username: acc.username,
            name: acc.name,
            lastActive: lastPost ? formatDate(lastPost) : 'No recent posts',
            daysInactive: days
          });
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
            inactiveFound: scanState.inactive.length
          });
          await sleep(FAILURE_COOLDOWN);
          scanState.consecutiveFailures = 0;
          // Don't increment index - retry this account
          await chrome.storage.local.set({ scanState });
          continue;
        }

        // Other failure - skip this account
        scanState.skipped.push(acc.username);

        if (scanState.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          sendMsg({
            type: 'scanProgress',
            current: scanState.currentIndex,
            total: scanState.accounts.length,
            status: `⏸️ Too many failures. Waiting 30s...`,
            currentAccount: acc.username,
            inactiveFound: scanState.inactive.length
          });
          await sleep(FAILURE_COOLDOWN);
          scanState.consecutiveFailures = 0;
        }
      }

      scanState.currentIndex++;
      await chrome.storage.local.set({ scanState });

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
        status: statusMsg
      });

      // IMPORTANT: Save results to storage BEFORE removing scanState
      // This ensures results persist even if popup wasn't open
      await chrome.storage.local.set({ scanResults: scanState.inactive });
      console.log(`💾 Saved ${scanState.inactive.length} results to storage`);

      sendMsg({ type: 'scanComplete', results: scanState.inactive });
      await chrome.storage.local.remove(['scanState']);
    }

    isRunning = false;
  }

  // Collect accounts from the following page
  async function collectAccounts() {
    const accounts = [];
    const seen = new Set();
    let lastHeight = 0;
    let stableCount = 0;

    for (let i = 0; i < 100 && stableCount < 3 && !shouldStop; i++) {
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
            accounts.push({ username, name });
          }
        }
      });

      if (i % 5 === 0) {
        sendMsg({ type: 'scanProgress', current: 0, total: 0, status: `📜 Loading... (${accounts.length} found)` });
      }

      window.scrollTo(0, document.body.scrollHeight);
      await sleep(600);

      const h = document.body.scrollHeight;
      if (h === lastHeight) stableCount++;
      else { stableCount = 0; lastHeight = h; }
    }

    window.scrollTo(0, 0);
    return accounts;
  }

  // Unfollow accounts
  async function startUnfollow(usernames) {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;

    const done = [];

    for (let i = 0; i < usernames.length && !shouldStop; i++) {
      const username = usernames[i];
      sendMsg({ type: 'unfollowProgress', current: i + 1, total: usernames.length, status: `Unfollowing @${username}...` });

      // Find and click the unfollow button
      const cells = document.querySelectorAll('[data-testid="UserCell"]');
      for (const cell of cells) {
        if (cell.querySelector(`a[href="/${username}"]`)) {
          const btn = cell.querySelector('[data-testid$="-unfollow"]') ||
                     Array.from(cell.querySelectorAll('[role="button"]')).find(b => /^Following/.test(b.textContent));
          if (btn) {
            btn.click();
            await sleep(400);
            const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
            if (confirm) { confirm.click(); await sleep(400); done.push(username); }
          }
          break;
        }
      }

      if (i < usernames.length - 1) {
        sendMsg({ type: 'unfollowProgress', current: i + 1, total: usernames.length, status: 'Waiting...' });
        await sleep(2500);
      }
    }

    sendMsg({ type: 'unfollowComplete', unfollowed: done.length, usernames: done });
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

  // Auto-resume scan on page load
  async function checkForResume() {
    await sleep(500);
    const data = await chrome.storage.local.get(['scanState', 'scanIntent']);

    if (data.scanIntent && window.location.pathname.includes('/following')) {
      const { inactiveDays } = data.scanIntent;
      await chrome.storage.local.remove(['scanIntent']);
      startScan(inactiveDays);
      return;
    }

    if (data.scanState) {
      console.log('🔄 Resuming scan at index', data.scanState.currentIndex);
      resumeScanFromStorage();
    }
  }

  checkForResume();

  console.log('🧹 X Following Cleaner: Ready! (GraphQL mode - 5x faster)');
})();
