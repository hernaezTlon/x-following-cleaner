// X Following Cleaner - Content Script
// By Damian Hernaez

(function() {
  'use strict';

  console.log('🧹 X Following Cleaner: Content script loaded');

  let isRunning = false;
  let shouldStop = false;

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
      chrome.storage.local.remove(['scanState']);
      sendResponse({ status: 'stopped' });
    } else if (message.action === 'ping') {
      sendResponse({ status: 'alive' });
    } else if (message.action === 'resumeScan') {
      resumeScan();
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

  // Check if we're on a profile page and get the username
  function getProfileUsername() {
    const match = window.location.pathname.match(/^\/([^\/]+)\/?$/);
    if (match && !['home', 'explore', 'notifications', 'messages', 'settings', 'i', 'search'].includes(match[1])) {
      return match[1];
    }
    return null;
  }

  // Start the scan - collect accounts first
  async function startScan(inactiveDays) {
    if (isRunning) return;
    isRunning = true;
    shouldStop = false;

    console.log('🔍 Starting scan, threshold:', inactiveDays, 'days');

    const myUsername = getMyUsername();
    console.log('👤 Logged in as:', myUsername);

    if (!myUsername) {
      sendMsg({ type: 'error', error: 'Could not detect username. Please log in to X.com.' });
      isRunning = false;
      return;
    }

    // Navigate to following page if needed
    if (!window.location.pathname.includes('/following')) {
      // Save scan intent
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
      inactiveDays: inactiveDays,
      cutoffTimestamp: cutoffDate.getTime(),
      myUsername: myUsername,
      startTime: Date.now()
    };

    await chrome.storage.local.set({ scanState });

    sendMsg({ type: 'scanProgress', current: 0, total: accounts.length, status: '🔍 Starting profile checks...' });

    // Start checking profiles by navigation
    await checkNextProfile(scanState);
  }

  // Resume scan after page navigation
  async function resumeScan() {
    const data = await chrome.storage.local.get(['scanState']);
    if (!data.scanState) {
      console.log('No scan state to resume');
      return;
    }

    const scanState = data.scanState;
    isRunning = true;
    shouldStop = false;

    // Check if we're on a profile page - need to read the last post date
    const profileUsername = getProfileUsername();
    if (profileUsername && scanState.accounts[scanState.currentIndex]?.username === profileUsername) {
      // We're on the right profile - read the last post date
      await sleep(1500); // Wait for tweets to load

      const lastPost = await readLastPostFromDOM();
      const acc = scanState.accounts[scanState.currentIndex];

      console.log(`  @${acc.username}:`, lastPost ? lastPost.toISOString() : 'no posts found');

      const cutoffDate = new Date(scanState.cutoffTimestamp);
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

      scanState.currentIndex++;
      await chrome.storage.local.set({ scanState });
    }

    // Continue to next profile or finish
    await checkNextProfile(scanState);
  }

  // Check next profile in the queue
  async function checkNextProfile(scanState) {
    if (shouldStop) {
      sendMsg({ type: 'scanProgress', current: scanState.currentIndex, total: scanState.accounts.length, status: '⏹️ Stopped' });
      isRunning = false;
      return;
    }

    // Check if we're done
    if (scanState.currentIndex >= scanState.accounts.length) {
      console.log('🏁 Scan complete!');
      sendMsg({
        type: 'scanProgress',
        current: scanState.accounts.length,
        total: scanState.accounts.length,
        status: `✅ Found ${scanState.inactive.length} inactive accounts`
      });
      sendMsg({ type: 'scanComplete', results: scanState.inactive });
      await chrome.storage.local.remove(['scanState']);
      isRunning = false;
      return;
    }

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

    // Navigate to the profile
    window.location.href = `https://x.com/${acc.username}`;
  }

  // Read last post date from current page DOM
  async function readLastPostFromDOM() {
    // Wait for content to load
    let attempts = 0;
    while (attempts < 15) {
      // Look for tweet time elements
      const timeElements = document.querySelectorAll('article time[datetime]');
      const dates = [];

      timeElements.forEach(el => {
        const dt = el.getAttribute('datetime');
        if (dt) {
          const date = new Date(dt);
          // Filter reasonable dates (not join date which would be very old)
          if (!isNaN(date.getTime()) && date > new Date('2020-01-01')) {
            dates.push(date);
          }
        }
      });

      if (dates.length > 0) {
        dates.sort((a, b) => b - a);
        return dates[0]; // Most recent
      }

      // Check for "no tweets" indicators
      const pageText = document.body?.textContent || '';
      if (pageText.includes("hasn't posted") || pageText.includes("These are protected")) {
        return null;
      }

      await sleep(400);
      attempts++;
    }

    return null;
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
          if (!seen.has(username)) {
            seen.add(username);
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

  // Auto-resume scan on page load if there's a scan in progress
  async function checkForResume() {
    await sleep(500);
    const data = await chrome.storage.local.get(['scanState', 'scanIntent']);

    // Check if we should start a new scan (navigated to following page)
    if (data.scanIntent && window.location.pathname.includes('/following')) {
      const { inactiveDays } = data.scanIntent;
      await chrome.storage.local.remove(['scanIntent']);
      startScan(inactiveDays);
      return;
    }

    // Check if we should resume an existing scan
    if (data.scanState) {
      console.log('🔄 Resuming scan at index', data.scanState.currentIndex);
      resumeScan();
    }
  }

  // Check for resume on load
  checkForResume();

  console.log('🧹 X Following Cleaner: Ready!');
})();
