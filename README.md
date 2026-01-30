# 🧹 X Following Cleaner

A **free, open-source** Chrome extension to mass unfollow inactive accounts on X.com (Twitter).

Created by **Damian Hernaez** ([@hernaez](https://x.com/hernaez))

Built with [Claude Code Opus](https://claude.ai/code) 🤖

## Features

- 🔍 **Scan Following List** - Automatically scrolls through your entire following list
- 📅 **Configurable Threshold** - Set your own inactivity period (default: 30 days)
- 📊 **Live Progress** - Real-time feedback while scanning
- ⏱️ **Smart ETA** - Dynamic time estimates that update based on actual scan speed
- ✅ **Bulk Unfollow** - Select and unfollow multiple accounts at once
- 🛡️ **Rate Limiting** - Built-in delays to avoid X restrictions
- 💾 **Resume Support** - Progress is saved if you need to stop and continue later
- 🆓 **100% Free** - No paid tiers, no data collection

## Installation

### From Source (Developer Mode)

1. **Download** this repository (Code → Download ZIP) and unzip it
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the `x-following-cleaner` folder
6. Pin the extension to your toolbar for easy access

## Usage

1. **Navigate to [x.com](https://x.com)** and log in to your account
2. **Click the extension icon** in your browser toolbar
3. **Set your threshold** - number of days of inactivity (default: 30)
4. **Click "Start Scan"** - the extension will:
   - Navigate to your following page
   - Scroll to load all accounts
   - Check each account's last post date
   - Show live progress with current account being checked
5. **Review results** - see all inactive accounts with last activity date
6. **Select accounts** to unfollow (use "Select All" or individual checkboxes)
7. **Click "Unfollow Selected"** and confirm

## How It Works

1. The extension scrolls through your Following list to collect all accounts
2. For each account, it navigates to their profile to accurately read their most recent post date
3. Accounts that haven't posted within your threshold are flagged as inactive
4. Progress is saved automatically - you can stop and resume later
5. When unfollowing, there's a 3-second delay between each action to avoid rate limits

### ⏱️ Time Estimates

Because each account needs to be visited individually to accurately check activity:
- **~3 seconds per account** (average)
- **500 accounts** ≈ 25 minutes
- **1000 accounts** ≈ 50 minutes

The extension shows a real-time ETA that updates based on actual scan speed. You can leave the tab running in the background while it works.

## Safety

- ⏱️ **Rate Limited**: 3-second delay between unfollows
- 📋 **X's Limit**: ~400 unfollows per day max
- 🔒 **Privacy**: All data stays in your browser - nothing sent to external servers
- 🔑 **No Password**: Uses your existing logged-in session

## Troubleshooting

**"Not on X.com"**
- Make sure you're on x.com or twitter.com and logged in

**Scan seems stuck**
- The extension checks each account individually, which takes time
- Check the browser console (F12) for detailed logs

**Can't unfollow**
- If you've hit X's rate limit, wait a few hours
- Refresh the page and try again

## Contributing

Contributions welcome! Feel free to:
- Report bugs via Issues
- Submit Pull Requests
- Suggest features

## License

MIT License - see [LICENSE](LICENSE)

## Disclaimer

Use at your own risk. The author is not responsible for any account restrictions. Always follow X's Terms of Service.

---

⭐ **If you find this useful, please star the repo!**

🐛 Found a bug? [Open an issue](https://github.com/hernaez/x-following-cleaner/issues)
