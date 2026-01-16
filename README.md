# Claude Code Slack Approval

Approve Claude Code PermissionRequests via Slack. Notify after timeout, or immediately when screen is locked.

Also notifies when Claude asks questions (AskUserQuestion), though answers must be provided in Claude Code directly (see [Limitations](#limitations)).

## Requirements

- macOS
- Node.js 22+
- Claude Code CLI
- Slack App (Bot Token, App-Level Token)

## Setup

### 1. Create Slack App

1. Go to [Slack API](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Set App name and workspace

#### Enable Socket Mode

1. Go to "Socket Mode" in the left sidebar
2. Enable Socket Mode
3. Create an App-Level Token with `connections:write` scope
4. Save the token (starts with `xapp-`)

#### Enable Interactivity

1. Go to "Interactivity & Shortcuts" in the left sidebar
2. Toggle "Interactivity" to **On**
3. (No Request URL needed for Socket Mode)

#### Required Permissions (Bot Token Scopes)

Go to "OAuth & Permissions" and add these scopes:

- `chat:write` - Send messages
- `chat:write.public` - Post to public channels (optional, for public channels only)
- `im:write` - Send DMs (required for DM notifications)
- `reactions:read` - Read reactions (for Apple Watch support)

#### Event Subscriptions (for Apple Watch support)

To enable approval via emoji reactions or thread replies:

1. Go to "Event Subscriptions" in the left sidebar
2. Enable Events
3. Subscribe to bot events:
   - `reaction_added` - For emoji reaction approvals
   - `message.im` - For thread reply approvals (DM)
   - `message.channels` - For thread reply approvals (channels)

#### Install App

1. Go to "Install App"
2. Click "Install to Workspace"
3. Save the Bot Token (starts with `xoxb-`)

### 2. Install and Build

```bash
npm install
npm run build
```

### 3. Set Environment Variables

The server requires Slack credentials. Set them in your shell profile (e.g., `~/.zshrc`):

```bash
export SLACK_BOT_TOKEN="xoxb-xxxx-xxxx-xxxx"
export SLACK_APP_TOKEN="xapp-xxxx-xxxx-xxxx"

# For channel notifications:
export SLACK_CHANNEL_ID="C01XXXXXXXX"

# Or for DM notifications (use your Slack User ID):
export SLACK_USER_ID="U01XXXXXXXX"
```

**Finding your User ID:** Click your profile in Slack → "Profile" → "⋮" menu → "Copy member ID"

**Note:** The server is automatically started by the hook when needed. You don't need to manually start it.

### 4. Configure Claude Code Hook

Create `~/.claude/settings.json` (or `.claude/settings.json` in your project root):

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/claude-hooks-slack-approval/dist/hook.js --delay 1m --notify-immediately-on-lock",
            "timeout": 86400
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/claude-hooks-slack-approval/dist/hook.js",
            "timeout": 86400
          }
        ]
      }
    ]
  }
}
```

`timeout` is required — the [default is 60 seconds](https://code.claude.com/docs/en/hooks#hook-execution-details), which is too short for approval workflows. The hook waits indefinitely for Slack response, so set a long timeout (e.g., 86400 seconds = 24 hours).

**Note:** For `AskUserQuestion` hooks, `--delay` and `--notify-immediately-on-lock` options are ignored. Questions are always sent to Slack immediately as notifications only (answers must be provided in Claude Code terminal).

## Command Line Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `--delay <duration>` | Send Slack notification after specified duration | `1m` |
| `--notify-immediately-on-lock` | Send Slack notification immediately when screen is locked (ignores `--delay`) | `true` |
| `--test` | Send a test notification to Slack and exit (for verifying configuration) | - |

### Duration Format (ISO 8601)

```bash
--delay 30s      # 30 seconds
--delay 1m30s    # 1 minute 30 seconds
--delay 5m       # 5 minutes
--delay 1h       # 1 hour
```

### Examples

```bash
# Default: notify to Slack after 1 minute, or immediately if screen locked
node dist/hook.js

# Notify to Slack after 5 minutes, or immediately if screen locked
node dist/hook.js --delay 5m

# Always notify to Slack after 1 minute (ignore screen lock state)
node dist/hook.js --notify-immediately-on-lock false

# Always notify to Slack immediately (no delay)
node dist/hook.js --delay 0

# Test Slack connection (verify configuration)
node dist/hook.js --test
```

## Features

### PermissionRequest (Tool Approval)

When Claude Code requests permission to run a tool (e.g., Bash command, file write), a notification is sent to Slack with Approve/Deny buttons.

### Apple Watch Support

Since Slack's interactive buttons don't work on Apple Watch, you can approve/deny requests using:

**Emoji Reactions:**
- 👍 or ✅ → Approve
- 👎 or ❌ → Deny

**Thread Replies:**
- "ok", "yes", "y", "approve", "allow", "go" → Approve
- "no", "n", "deny", "reject", "stop", "cancel" → Deny

Note: Emoji reactions and thread replies only work for PermissionRequest (tool approvals), not for AskUserQuestion (which requires selecting specific options).

### AskUserQuestion (Notification Only)

When Claude Code asks a question via `AskUserQuestion` tool, a notification is sent to Slack showing the question and available options. **However, you must answer the question directly in the Claude Code terminal**, not via Slack.

This is a notification-only feature to alert you when Claude is waiting for input.

> **Why can't I answer via Slack?**
> Claude Code's hook system currently doesn't support injecting answers to `AskUserQuestion` via `updatedInput`. This is a known limitation. See [GitHub Issue #15872](https://github.com/anthropics/claude-code/issues/15872) for the feature request.

## Session Management

- Approvals are managed per session
- If the same operation (exact match) is requested again within the same session, it executes without re-approval
- Approval history is cleared when the session ends

### Approval Matching

Uses exact matching. The following are treated as separate approvals:

```bash
# Each requires separate approval
npm install lodash
npm install express
npm install
```

## Troubleshooting

### Slack notifications not arriving

1. Verify `SLACK_BOT_TOKEN` is correct
2. Ensure Bot is invited to the channel
3. Verify `SLACK_CHANNEL_ID` is correct

### Approval buttons not working

1. Check if server is running: `ps aux | grep 'node.*server.js'`
2. Verify `SLACK_APP_TOKEN` is correct
3. Check server logs (look for Unix socket at `/tmp/claude-slack-approval/`)
4. Verify Interactivity is enabled in Slack App settings

### Timing out

1. Ensure `timeout` in settings.json is long enough (default: 3600000ms = 1 hour)

### PC lock detection not working

- Only works on macOS
- May require security permissions in System Preferences

---

## Technical Details

### Architecture

The hook communicates with a background server via Unix socket. The server uses Slack Socket Mode for real-time button interactions.

```
┌──────────────┐         ┌──────────────┐                 ┌─────────────┐
│ Claude Code  │──stdin─▶│   hook.ts    │═══════════════▶│   Server    │
│              │         │              │  Unix Socket    │  (daemon)   │
│              │         │              │  (持続接続)      │             │
│              │         │              │◀═══════════════│             │
│              │◀─stdout─│              │  応答を直接返す  │             │
└──────────────┘         └──────────────┘                 └──────┬──────┘
   allow/deny                                                    │
                                                       WebSocket │ (Socket Mode)
                                                                 ▼
                                                          ┌─────────────┐
                                                          │   Slack     │
                                                          │  Channel    │
                                                          │[Approve/Deny]│
                                                          └─────────────┘
```

**Key improvement:** The hook maintains a persistent Unix socket connection to the server. When the user clicks Approve/Deny in Slack, the response is sent directly through the socket—no polling required.

### Approval Flow

#### Slack Message Example

```
┌─────────────────────────────────────────────┐
│ 🔔 Claude Code Approval Request             │
├─────────────────────────────────────────────┤
│ Tool: Bash                                  │
│ Session: abc123                             │
│                                             │
│ Command:                                    │
│ ┌─────────────────────────────────────────┐ │
│ │ rm -rf ./temp                           │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ Description: Delete temporary files         │
│                                             │
│ [✅ Approve]  [❌ Deny]                      │
└─────────────────────────────────────────────┘
```

#### After Button Click

1. User clicks "Approve" or "Deny" button
2. Slack sends action via WebSocket (Socket Mode) to local server
3. Server sends response directly through Unix socket to hook
4. Slack message updates (shows result status)
5. hook.ts outputs result to stdout
6. Claude Code receives `allow` or `deny`

### Question Flow (Notification Only)

#### Slack Message Example

```
┌─────────────────────────────────────────────┐
│ ❓ Claude Code Question                      │
├─────────────────────────────────────────────┤
│ Session: abc123                             │
│                                             │
│ [Auth] Which authentication method?         │
│                                             │
│ • JWT: Stateless token-based auth           │
│ • OAuth: Third-party authentication         │
│ • Session: Server-side session management   │
│                                             │
│ 💡 Answer in Claude Code terminal           │
└─────────────────────────────────────────────┘
```

#### Flow

1. Claude Code asks a question via `AskUserQuestion` tool
2. Notification is sent to Slack (question and options displayed)
3. **User answers directly in Claude Code terminal** (not via Slack)
4. Claude Code receives the answer and continues

## Limitations

### AskUserQuestion answers cannot be provided via Slack

Due to Claude Code's hook architecture, answers to `AskUserQuestion` cannot be injected via hooks. The `PreToolUse` hook's `updatedInput` mechanism modifies tool inputs, but `answers` are treated as outputs that must come from user interaction in the terminal.

**Current behavior:**
- Questions are notified to Slack (notification only)
- Users must answer in Claude Code terminal directly

**Tracking:** [GitHub Issue #15872](https://github.com/anthropics/claude-code/issues/15872) - Feature request for better hook support for AskUserQuestion

## License

MIT
