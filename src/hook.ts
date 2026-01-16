#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { PermissionRequest, UserQuestionRequest, HookOutput } from './types.js';
import { parseDuration, isScreenLocked } from './utils.js';
import { sendRequest, getRunningServerPid, waitForServer, getSocketPath } from './socket.js';

// Configuration
const LOCK_CHECK_INTERVAL = 500; // 500ms

// Parse command line arguments
function parseArgs(): { delay: number; notifyImmediatelyOnLock: boolean; testMode: boolean } {
  const args = process.argv.slice(2);
  let delay = 60 * 1000; // Default: 1 minute
  let notifyImmediatelyOnLock = true;
  let testMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--delay' && args[i + 1]) {
      delay = parseDuration(args[i + 1]);
      i++;
    } else if (args[i] === '--notify-immediately-on-lock') {
      const nextArg = args[i + 1];
      if (nextArg === 'false') {
        notifyImmediatelyOnLock = false;
        i++;
      } else if (nextArg === 'true') {
        notifyImmediatelyOnLock = true;
        i++;
      }
      // If no argument, default is true
    } else if (args[i] === '--test') {
      testMode = true;
    }
  }

  return { delay, notifyImmediatelyOnLock, testMode };
}

/**
 * Read request from stdin (can be PermissionRequest or UserQuestionRequest)
 */
async function readStdin(): Promise<PermissionRequest | UserQuestionRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      try {
        const data = Buffer.concat(chunks).toString('utf-8');
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Failed to parse stdin: ${error}`));
      }
    });

    process.stdin.on('error', reject);
  });
}

/**
 * Check if request is AskUserQuestion (notification only, non-blocking)
 */
function isAskUserQuestionRequest(request: PermissionRequest | UserQuestionRequest): boolean {
  if ('tool_name' in request && request.tool_name === 'AskUserQuestion') {
    return true;
  }
  return request.type === 'user_question';
}

/**
 * Wait for delay with screen lock check
 */
async function waitWithLockCheck(delay: number, checkLock: boolean): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < delay) {
    if (checkLock && isScreenLocked()) {
      return true; // Screen locked, should notify immediately
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_CHECK_INTERVAL));
  }

  return false; // Delay completed without lock
}

/**
 * Start server process if not running
 */
async function ensureServerRunning(): Promise<void> {
  if (getRunningServerPid()) {
    return; // Server already running
  }

  console.error('[Hook] Starting server...');

  // Get the path to server.js
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.join(__dirname, 'server.js');

  // Fork server process
  const serverProcess = spawn('node', [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  serverProcess.unref();

  // Wait for server to be ready
  const ready = await waitForServer(10000);
  if (!ready) {
    throw new Error('Server failed to start within 10 seconds');
  }

  console.error('[Hook] Server started');
}

/**
 * Send test notification
 */
async function sendTestNotification(): Promise<void> {
  await ensureServerRunning();

  const testRequest: PermissionRequest = {
    type: 'permission_request',
    session_id: 'test-session',
    tool_name: 'Test',
    tool_input: {
      command: 'echo "This is a test notification"',
      description: 'Test notification to verify Slack configuration',
    },
  };

  console.error('Sending test notification to Slack...');
  console.error(`Socket path: ${getSocketPath()}`);

  try {
    const response = await sendRequest(testRequest);
    console.error('Response received:', JSON.stringify(response));
    console.error('Test completed successfully!');
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

/**
 * Main hook logic
 */
async function main(): Promise<void> {
  const config = parseArgs();

  // Test mode
  if (config.testMode) {
    await sendTestNotification();
    process.exit(0);
  }

  // Read request from stdin
  const request = await readStdin();
  const isQuestion = isAskUserQuestionRequest(request);

  // Log the full request for debugging
  console.error(`[Hook] Received request: ${JSON.stringify(request, null, 2)}`);

  // For AskUserQuestion, send notification only (non-blocking)
  // Claude Code doesn't support receiving answers via hook, so just notify and allow
  if (isQuestion) {
    console.error('[Hook] AskUserQuestion detected - notification only mode');

    // Immediately allow - let Claude Code UI handle the answer
    const allowResponse = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Question notification sent to Slack',
      },
    };
    console.log(JSON.stringify(allowResponse));

    // Send notification to Slack via detached child process
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const notifyScript = path.join(__dirname, 'notify.js');

    // Spawn detached process to send notification
    const child = spawn('node', [notifyScript, JSON.stringify(request)], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Exit immediately
    process.exit(0);
  }

  // For permission requests, apply delay/lock check
  if (config.delay > 0) {
    const lockedDuringWait = await waitWithLockCheck(config.delay, config.notifyImmediatelyOnLock);

    if (lockedDuringWait) {
      console.error('[Hook] Screen locked, notifying immediately');
    } else {
      console.error(`[Hook] Delay completed (${config.delay}ms)`);
    }
  }

  // Ensure server is running
  await ensureServerRunning();

  // Send request via Unix socket and wait for response
  console.error('[Hook] Sending request to server...');
  const response: HookOutput = await sendRequest(request);
  console.error(`[Hook] Response received: ${JSON.stringify(response)}`);

  // Output result to stdout
  console.log(JSON.stringify(response));
}

main().catch((error) => {
  console.error('Hook error:', error);
  // On error, deny by default for safety
  console.log(JSON.stringify({ decision: 'deny' }));
  process.exit(1);
});
