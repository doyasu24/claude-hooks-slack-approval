#!/usr/bin/env node
/**
 * Detached notification script for AskUserQuestion
 * Sends notification to Slack without blocking the main hook process
 */
import { sendRequest, getRunningServerPid, waitForServer } from './socket.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

async function ensureServerRunning(): Promise<void> {
  if (getRunningServerPid()) {
    return;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.join(__dirname, 'server.js');

  const serverProcess = spawn('node', [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  serverProcess.unref();

  const ready = await waitForServer(10000);
  if (!ready) {
    throw new Error('Server failed to start');
  }
}

async function main(): Promise<void> {
  const requestJson = process.argv[2];
  if (!requestJson) {
    process.exit(1);
  }

  try {
    const request = JSON.parse(requestJson);
    await ensureServerRunning();
    await sendRequest(request);
  } catch (error) {
    console.error('[Notify] Error:', error);
  }

  process.exit(0);
}

main();
