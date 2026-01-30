// X Following Cleaner - Popup Script
// By Damian Hernaez

// DOM Elements
const inactiveDaysInput = document.getElementById('inactiveDays');
const statusIcon = document.getElementById('statusIcon');
const statusMessage = document.getElementById('statusMessage');
const statusDetail = document.getElementById('statusDetail');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressCurrent = document.getElementById('progressCurrent');
const progressTotal = document.getElementById('progressTotal');
const inactiveBadge = document.getElementById('inactiveBadge');
const inactiveFoundCount = document.getElementById('inactiveFoundCount');
const currentAccount = document.getElementById('currentAccount');
const currentAccountName = document.getElementById('currentAccountName');
const scanBtn = document.getElementById('scanBtn');
const stopBtn = document.getElementById('stopBtn');
const resultsSection = document.getElementById('resultsSection');
const accountsList = document.getElementById('accountsList');
const inactiveCount = document.getElementById('inactiveCount');
const selectedCount = document.getElementById('selectedCount');
const selectAllBtn = document.getElementById('selectAllBtn');
const deselectAllBtn = document.getElementById('deselectAllBtn');
const unfollowSelectedBtn = document.getElementById('unfollowSelectedBtn');
const confirmModal = document.getElementById('confirmModal');
const confirmCount = document.getElementById('confirmCount');
const confirmYes = document.getElementById('confirmYes');
const confirmNo = document.getElementById('confirmNo');
const clearBtn = document.getElementById('clearBtn');

// Time warning modal elements
const timeWarningModal = document.getElementById('timeWarningModal');
const estimatedTimeEl = document.getElementById('estimatedTime');
const startScanConfirm = document.getElementById('startScanConfirm');
const cancelScan = document.getElementById('cancelScan');

// ETA elements
const etaDisplay = document.getElementById('etaDisplay');
const etaTime = document.getElementById('etaTime');

// State
let isScanning = false;
let isUnfollowing = false;
let inactiveAccounts = [];
let currentTabId = null;

// Timing tracking for ETA
let scanStartTime = null;
let lastCheckTimes = []; // Track last N check times for rolling average
const MAX_TIME_SAMPLES = 10;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  console.log('🧹 Popup loaded');

  // Load saved settings and check for ongoing scan
  const settings = await chrome.storage.local.get(['inactiveDays', 'scanResults', 'scanState']);
  if (settings.inactiveDays) {
    inactiveDaysInput.value = settings.inactiveDays;
  }

  // Check if there's an ongoing or paused scan - restore UI state
  if (settings.scanState) {
    const state = settings.scanState;
    const isPaused = state.currentIndex > 0 && state.currentIndex < state.accounts.length;

    // Show progress UI
    progressContainer.style.display = 'block';
    const percent = state.accounts.length > 0 ? (state.currentIndex / state.accounts.length) * 100 : 0;
    progressFill.style.width = `${percent}%`;
    progressCurrent.textContent = state.currentIndex;
    progressTotal.textContent = state.accounts.length;

    // Show inactive count
    if (state.inactive && state.inactive.length > 0) {
      inactiveBadge.style.display = 'inline-block';
      inactiveFoundCount.textContent = state.inactive.length;

      // Also load results for review
      inactiveAccounts = state.inactive;
      displayResults();
    }

    if (isPaused) {
      // Scan was paused - show Resume button
      scanBtn.textContent = '▶️ Resume';
      scanBtn.disabled = false;
      stopBtn.disabled = true;
      const remaining = state.accounts.length - state.currentIndex;
      updateStatus('⏸️', `Paused - ${state.inactive?.length || 0} inactive found`, `${remaining} accounts remaining`, 'stopped');
    } else {
      // Scan is actively running
      isScanning = true;
      scanBtn.disabled = true;
      stopBtn.disabled = false;
      const progressPct = Math.round((state.currentIndex / state.accounts.length) * 100);
      updateStatus('🔍', `[${progressPct}%] Scanning...`, `Checked ${state.currentIndex} of ${state.accounts.length} accounts`, 'scanning');

      // Show ETA
      if (state.startTime && state.currentIndex > 0) {
        const elapsed = (Date.now() - state.startTime) / 1000;
        const avgPerAccount = elapsed / state.currentIndex;
        const remaining = state.accounts.length - state.currentIndex;
        const etaSeconds = remaining * avgPerAccount;
        etaDisplay.style.display = 'block';
        etaTime.textContent = formatDuration(etaSeconds);
      }
    }
  }
  // Load cached results if no active scan
  else if (settings.scanResults && settings.scanResults.length > 0) {
    inactiveAccounts = settings.scanResults;
    displayResults();
  }

  // Check if we're on X.com and inject script if needed
  await initializeTab();
});

// Save settings when changed
inactiveDaysInput.addEventListener('change', async () => {
  const days = parseInt(inactiveDaysInput.value) || 30;
  await chrome.storage.local.set({ inactiveDays: days });
});

// Initialize tab and ensure content script is loaded
async function initializeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab.id;

    if (!tab.url || (!tab.url.includes('x.com') && !tab.url.includes('twitter.com'))) {
      updateStatus('⚠️', 'Not on X.com', 'Please navigate to x.com first', 'warning');
      scanBtn.disabled = true;
      return;
    }

    // Try to ping the content script
    try {
      await sendMessageToTab({ action: 'ping' });
      console.log('✅ Content script is ready');
      updateStatus('✅', 'Ready to scan', 'Click "Start Scan" to begin', 'ready');
      scanBtn.disabled = false;
    } catch (err) {
      console.log('⚠️ Content script not responding, injecting...');
      // Content script not loaded - inject it
      await injectContentScript(tab.id);
    }
  } catch (error) {
    console.error('Error initializing tab:', error);
    updateStatus('❌', 'Error', 'Could not connect to page', 'error');
    scanBtn.disabled = true;
  }
}

// Inject content script programmatically
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content/content.js']
    });
    console.log('✅ Content script injected');

    // Wait a bit for it to initialize
    await new Promise(r => setTimeout(r, 500));

    // Verify it's working
    try {
      await sendMessageToTab({ action: 'ping' });
      updateStatus('✅', 'Ready to scan', 'Click "Start Scan" to begin', 'ready');
      scanBtn.disabled = false;
    } catch (e) {
      throw new Error('Script injected but not responding');
    }
  } catch (error) {
    console.error('Failed to inject content script:', error);
    updateStatus('❌', 'Connection failed', 'Please refresh the X.com page', 'error');
    scanBtn.disabled = true;
  }
}

// Send message to content script with promise wrapper
function sendMessageToTab(message) {
  return new Promise((resolve, reject) => {
    if (!currentTabId) {
      reject(new Error('No tab ID'));
      return;
    }

    chrome.tabs.sendMessage(currentTabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Connection failed'));
      } else {
        resolve(response);
      }
    });
  });
}

// Update status display
function updateStatus(icon, message, detail, state = 'default') {
  statusIcon.textContent = icon;
  statusIcon.className = 'status-icon' + (state === 'scanning' ? ' scanning' : '');
  statusMessage.textContent = message;
  statusDetail.textContent = detail;
}

// Format time duration nicely
function formatDuration(seconds) {
  if (seconds < 60) return `~${Math.ceil(seconds)} seconds`;
  if (seconds < 3600) {
    const mins = Math.ceil(seconds / 60);
    return `~${mins} minute${mins !== 1 ? 's' : ''}`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.ceil((seconds % 3600) / 60);
  if (mins === 0) return `~${hours} hour${hours !== 1 ? 's' : ''}`;
  return `~${hours}h ${mins}m`;
}

// Show time warning modal
async function showTimeWarning() {
  // GraphQL API mode is much faster: ~1.5 seconds per account
  const estimatedSeconds = 1.5;

  // Try to get a rough estimate from the page
  try {
    const response = await sendMessageToTab({ action: 'ping' });
    // Show estimate for API mode
    estimatedTimeEl.textContent = 'Depends on following count';
    estimatedTimeEl.innerHTML = '<span style="font-size: 14px; color: #8899a6;">~1-2 seconds per account (API mode)<br>Example: 500 accounts ≈ 10-15 minutes</span>';
  } catch (e) {
    estimatedTimeEl.textContent = 'Unknown';
  }

  timeWarningModal.style.display = 'flex';
}

// Resume an existing paused scan
async function resumeExistingScan(scanState) {
  isScanning = true;
  scanBtn.disabled = true;
  stopBtn.disabled = false;

  const remaining = scanState.accounts.length - scanState.currentIndex;
  updateStatus('🔍', `Resuming scan...`, `${remaining} accounts remaining`, 'scanning');

  progressContainer.style.display = 'block';
  const percent = (scanState.currentIndex / scanState.accounts.length) * 100;
  progressFill.style.width = `${percent}%`;
  progressCurrent.textContent = scanState.currentIndex;
  progressTotal.textContent = scanState.accounts.length;

  if (scanState.inactive && scanState.inactive.length > 0) {
    inactiveBadge.style.display = 'inline-block';
    inactiveFoundCount.textContent = scanState.inactive.length;
  }

  try {
    await sendMessageToTab({ action: 'resumeScan' });
    console.log('✅ Scan resumed');
  } catch (error) {
    console.error('Error resuming scan:', error);
    updateStatus('❌', 'Resume failed', 'Please refresh the X.com page', 'error');
    resetScanState();
  }
}

// Start Scan - check for resume or show warning
scanBtn.addEventListener('click', async () => {
  if (isScanning) return;

  // Check if there's a paused scan to resume
  const data = await chrome.storage.local.get(['scanState']);
  if (data.scanState && data.scanState.currentIndex > 0) {
    // Resume existing scan
    resumeExistingScan(data.scanState);
  } else {
    // Start new scan
    showTimeWarning();
  }
});

// Cancel scan from warning modal
cancelScan.addEventListener('click', () => {
  timeWarningModal.style.display = 'none';
});

// Confirm start scan from warning modal
startScanConfirm.addEventListener('click', async () => {
  timeWarningModal.style.display = 'none';
  startActualScan();
});

// Actually start the scan
async function startActualScan() {
  if (isScanning) return;

  isScanning = true;
  scanBtn.textContent = '🔍 Start Scan';
  scanBtn.disabled = true;
  stopBtn.disabled = false;
  resultsSection.style.display = 'none';
  inactiveAccounts = [];

  // Reset timing tracking
  scanStartTime = Date.now();
  lastCheckTimes = [];

  const inactiveDays = parseInt(inactiveDaysInput.value) || 30;

  // Show progress UI
  updateStatus('🔍', 'Starting scan...', 'Connecting to X.com', 'scanning');
  progressContainer.style.display = 'block';
  progressFill.style.width = '0%';
  progressCurrent.textContent = '0';
  progressTotal.textContent = '0';
  inactiveBadge.style.display = 'none';
  currentAccount.style.display = 'none';
  etaDisplay.style.display = 'none';

  try {
    // Store that we're scanning
    await chrome.storage.local.set({ scanInProgress: true, inactiveDays: inactiveDays });

    // Send message to content script
    await sendMessageToTab({
      action: 'startScan',
      inactiveDays: inactiveDays
    });

    console.log('✅ Scan started');
  } catch (error) {
    console.error('Error starting scan:', error);
    updateStatus('❌', 'Connection failed', 'Please refresh the X.com page and try again', 'error');
    resetScanState();
  }
}

// Stop Scan/Unfollow
stopBtn.addEventListener('click', async () => {
  try {
    const response = await sendMessageToTab({ action: 'stop' });

    // Get the current scan state to show progress
    const data = await chrome.storage.local.get(['scanState', 'scanResults']);
    const scanState = data.scanState;
    const results = data.scanResults || response?.partialResults || [];

    if (results.length > 0) {
      inactiveAccounts = results;
      const remaining = scanState ? scanState.accounts.length - scanState.currentIndex : 0;
      updateStatus('⏸️', `Paused - ${results.length} inactive found`, remaining > 0 ? `${remaining} accounts remaining` : 'Review results below', 'stopped');
      displayResults();

      // Show Resume button if there's more to scan
      if (remaining > 0) {
        scanBtn.textContent = '▶️ Resume';
      }
    } else {
      updateStatus('⏹️', 'Stopped', 'No inactive accounts found yet', 'stopped');
      scanBtn.textContent = '▶️ Resume';
    }

    resetScanState();
  } catch (error) {
    console.error('Error stopping:', error);
  }
});

// Clear all saved data
clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['scanState', 'scanResults', 'scanInProgress', 'scanIntent']);
  inactiveAccounts = [];
  resultsSection.style.display = 'none';
  progressContainer.style.display = 'none';
  currentAccount.style.display = 'none';
  etaDisplay.style.display = 'none';
  inactiveBadge.style.display = 'none';
  scanBtn.textContent = '🔍 Start Scan';
  updateStatus('✅', 'Ready to scan', 'Storage cleared - click "Start Scan" to begin', 'ready');
  resetScanState();
  console.log('🗑️ Storage cleared');
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('📨 Popup received:', message.type);

  switch (message.type) {
    case 'scanProgress':
      handleScanProgress(message);
      break;
    case 'scanComplete':
      handleScanComplete(message.results);
      break;
    case 'unfollowProgress':
      handleUnfollowProgress(message);
      break;
    case 'unfollowComplete':
      handleUnfollowComplete(message.unfollowed, message.usernames);
      break;
    case 'error':
      updateStatus('❌', 'Error', message.error, 'error');
      resetScanState();
      break;
  }

  return true;
});

// Track timing for ETA calculation
let lastProgressTime = null;
let lastProgressCurrent = 0;

// Handle scan progress updates
function handleScanProgress(data) {
  const { current, total, status, currentAccount: account, inactiveFound } = data;

  // Update status
  updateStatus('🔍', status || 'Scanning...', `Checked ${current} of ${total} accounts`, 'scanning');

  // Update progress bar
  if (total > 0) {
    const percent = (current / total) * 100;
    progressFill.style.width = `${percent}%`;
    progressCurrent.textContent = current;
    progressTotal.textContent = total;
    progressContainer.style.display = 'block';

    // Calculate ETA
    if (current > 0) {
      const now = Date.now();

      // Track time between progress updates
      if (lastProgressTime && current > lastProgressCurrent) {
        const timeDiff = (now - lastProgressTime) / 1000; // seconds
        const checksDone = current - lastProgressCurrent;
        const avgTimePerCheck = timeDiff / checksDone;

        // Add to rolling average
        lastCheckTimes.push(avgTimePerCheck);
        if (lastCheckTimes.length > MAX_TIME_SAMPLES) {
          lastCheckTimes.shift();
        }
      }

      lastProgressTime = now;
      lastProgressCurrent = current;

      // Calculate ETA based on rolling average or overall average
      let avgTimePerAccount;
      if (lastCheckTimes.length > 0) {
        // Use rolling average of recent checks
        avgTimePerAccount = lastCheckTimes.reduce((a, b) => a + b, 0) / lastCheckTimes.length;
      } else if (scanStartTime) {
        // Fall back to overall average
        const elapsedSeconds = (now - scanStartTime) / 1000;
        avgTimePerAccount = elapsedSeconds / current;
      } else {
        avgTimePerAccount = 3; // Default estimate
      }

      const remaining = total - current;
      const etaSeconds = remaining * avgTimePerAccount;

      // Show ETA
      etaDisplay.style.display = 'block';
      etaTime.textContent = formatDuration(etaSeconds);
    }
  }

  // Update current account being checked
  if (account) {
    currentAccount.style.display = 'block';
    currentAccountName.textContent = '@' + account;
  }

  // Update inactive count badge
  if (inactiveFound !== undefined && inactiveFound > 0) {
    inactiveBadge.style.display = 'inline-block';
    inactiveFoundCount.textContent = inactiveFound;
  }
}

// Handle scan completion
function handleScanComplete(results) {
  inactiveAccounts = results || [];

  // Clear scan in progress flag
  chrome.storage.local.remove('scanInProgress');

  // Cache results
  chrome.storage.local.set({ scanResults: inactiveAccounts });

  resetScanState();
  scanBtn.textContent = '🔍 Start Scan';
  currentAccount.style.display = 'none';

  if (inactiveAccounts.length === 0) {
    updateStatus('🎉', 'All accounts active!', 'No inactive accounts found', 'success');
    progressContainer.style.display = 'none';
  } else {
    updateStatus('✅', `Found ${inactiveAccounts.length} inactive`, 'Review and select accounts to unfollow', 'complete');
    displayResults();
  }
}

// Display results in the list
function displayResults() {
  resultsSection.style.display = 'block';
  inactiveCount.textContent = inactiveAccounts.length;

  accountsList.innerHTML = '';

  inactiveAccounts.forEach((account, index) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `
      <input type="checkbox" id="account-${index}" data-index="${index}">
      <div class="account-info">
        <div class="account-name">${escapeHtml(account.name || account.username)}</div>
        <div class="account-handle">@${escapeHtml(account.username)}</div>
      </div>
      <div class="account-inactive">${escapeHtml(account.lastActive)}</div>
    `;
    accountsList.appendChild(item);
  });

  // Add checkbox listeners
  accountsList.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', updateSelectedCount);
  });

  updateSelectedCount();
}

// Update selected count
function updateSelectedCount() {
  const checkboxes = accountsList.querySelectorAll('input[type="checkbox"]:checked');
  const count = checkboxes.length;
  selectedCount.textContent = count;
  unfollowSelectedBtn.disabled = count === 0;
}

// Select/Deselect all
selectAllBtn.addEventListener('click', () => {
  accountsList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
  updateSelectedCount();
});

deselectAllBtn.addEventListener('click', () => {
  accountsList.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  updateSelectedCount();
});

// Unfollow selected
unfollowSelectedBtn.addEventListener('click', () => {
  const checkboxes = accountsList.querySelectorAll('input[type="checkbox"]:checked');
  if (checkboxes.length === 0) return;

  confirmCount.textContent = checkboxes.length;
  confirmModal.style.display = 'flex';
});

// Confirm unfollow
confirmYes.addEventListener('click', async () => {
  confirmModal.style.display = 'none';

  const checkboxes = accountsList.querySelectorAll('input[type="checkbox"]:checked');
  const selectedUsernames = [];

  checkboxes.forEach(cb => {
    const index = parseInt(cb.dataset.index);
    if (inactiveAccounts[index]) {
      selectedUsernames.push(inactiveAccounts[index].username);
    }
  });

  if (selectedUsernames.length === 0) return;

  isUnfollowing = true;
  scanBtn.disabled = true;
  stopBtn.disabled = false;
  unfollowSelectedBtn.disabled = true;

  updateStatus('🚫', 'Unfollowing...', `0 of ${selectedUsernames.length} completed`, 'scanning');
  progressContainer.style.display = 'block';
  progressFill.style.width = '0%';
  progressCurrent.textContent = '0';
  progressTotal.textContent = selectedUsernames.length;

  try {
    await sendMessageToTab({
      action: 'startUnfollow',
      usernames: selectedUsernames
    });
  } catch (error) {
    console.error('Error starting unfollow:', error);
    updateStatus('❌', 'Error', error.message, 'error');
    resetScanState();
  }
});

// Cancel unfollow
confirmNo.addEventListener('click', () => {
  confirmModal.style.display = 'none';
});

// Handle unfollow progress
function handleUnfollowProgress(data) {
  const { current, total, status } = data;
  const percent = (current / total) * 100;

  updateStatus('🚫', status || 'Unfollowing...', `${current} of ${total} completed`, 'scanning');
  progressFill.style.width = `${percent}%`;
  progressCurrent.textContent = current;
  progressTotal.textContent = total;
}

// Handle unfollow completion
function handleUnfollowComplete(count, usernames) {
  resetScanState();

  updateStatus('✅', `Unfollowed ${count} accounts`, 'Your following list is cleaner now!', 'success');

  // Remove unfollowed accounts from the list
  if (usernames && usernames.length > 0) {
    const unfollowedSet = new Set(usernames);
    inactiveAccounts = inactiveAccounts.filter(acc => !unfollowedSet.has(acc.username));

    // Update cache
    chrome.storage.local.set({ scanResults: inactiveAccounts });

    // Refresh display
    if (inactiveAccounts.length > 0) {
      displayResults();
    } else {
      resultsSection.style.display = 'none';
      progressContainer.style.display = 'none';
    }
  }
}

// Reset state
function resetScanState() {
  isScanning = false;
  isUnfollowing = false;
  scanBtn.disabled = false;
  stopBtn.disabled = true;
  // Don't reset button text here - let callers decide
}

// Utility: Escape HTML
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Keep popup alive and refresh state from storage
setInterval(async () => {
  if (isScanning || isUnfollowing) {
    try {
      await sendMessageToTab({ action: 'ping' });
    } catch (e) {
      // Ignore ping errors
    }
  }

  // Refresh state from storage to keep UI updated
  const data = await chrome.storage.local.get(['scanState']);
  if (data.scanState) {
    const state = data.scanState;

    // Update UI if we're scanning
    if (!isScanning) {
      isScanning = true;
      scanBtn.disabled = true;
      stopBtn.disabled = false;
    }

    progressContainer.style.display = 'block';
    const percent = state.accounts.length > 0 ? (state.currentIndex / state.accounts.length) * 100 : 0;
    progressFill.style.width = `${percent}%`;
    progressCurrent.textContent = state.currentIndex;
    progressTotal.textContent = state.accounts.length;

    // Show inactive count
    if (state.inactive && state.inactive.length > 0) {
      inactiveBadge.style.display = 'inline-block';
      inactiveFoundCount.textContent = state.inactive.length;
    }

    // Update status
    const progressPct = Math.round((state.currentIndex / state.accounts.length) * 100);
    const currentAcc = state.accounts[state.currentIndex]?.username || '...';
    updateStatus('🔍', `[${progressPct}%] Checking @${currentAcc}...`, `Checked ${state.currentIndex} of ${state.accounts.length} accounts`, 'scanning');

    // Show current account
    currentAccount.style.display = 'block';
    currentAccountName.textContent = '@' + currentAcc;

    // Update ETA
    if (state.startTime && state.currentIndex > 0) {
      const elapsed = (Date.now() - state.startTime) / 1000;
      const avgPerAccount = elapsed / state.currentIndex;
      const remaining = state.accounts.length - state.currentIndex;
      const etaSeconds = remaining * avgPerAccount;
      etaDisplay.style.display = 'block';
      etaTime.textContent = formatDuration(etaSeconds);
    }

    // Check if scan completed
    if (state.currentIndex >= state.accounts.length) {
      inactiveAccounts = state.inactive || [];
      chrome.storage.local.set({ scanResults: inactiveAccounts });
      chrome.storage.local.remove(['scanState']);
      resetScanState();
      currentAccount.style.display = 'none';
      if (inactiveAccounts.length > 0) {
        updateStatus('✅', `Found ${inactiveAccounts.length} inactive`, 'Review and select accounts to unfollow', 'complete');
        displayResults();
      } else {
        updateStatus('🎉', 'All accounts active!', 'No inactive accounts found', 'success');
        progressContainer.style.display = 'none';
      }
    }
  } else if (isScanning) {
    // Scan was stopped or completed externally
    const results = await chrome.storage.local.get(['scanResults']);
    if (results.scanResults && results.scanResults.length > 0) {
      inactiveAccounts = results.scanResults;
      displayResults();
    }
    resetScanState();
  }
}, 1000);

console.log('🧹 Popup script ready');
