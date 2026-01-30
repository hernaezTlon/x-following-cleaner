// X Following Cleaner - Background Service Worker
// By Damian Hernaez

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      inactiveDays: 30,
      unfollowDelay: 3000
    });
    console.log('🧹 X Following Cleaner installed');
  }
});

// Forward messages between content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('📨 Background received:', message.type || message.action);
  return true;
});

console.log('🧹 X Following Cleaner service worker loaded');
