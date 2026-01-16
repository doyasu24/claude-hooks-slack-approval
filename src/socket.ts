import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { PermissionRequest, UserQuestionRequest, HookOutput } from './types.js';

// Socket configuration
const SOCKET_DIR = path.join(os.tmpdir(), 'claude-slack-approval');
const SOCKET_PATH = path.join(SOCKET_DIR, 'server.sock');
const PID_PATH = path.join(SOCKET_DIR, 'server.pid');

// Timeout for socket operations (5 minutes for manual approval)
const SOCKET_TIMEOUT = 5 * 60 * 1000;

/**
 * Ensure socket directory exists with proper permissions
 */
export function ensureSocketDir(): void {
  if (!fs.existsSync(SOCKET_DIR)) {
    fs.mkdirSync(SOCKET_DIR, { mode: 0o700, recursive: true });
  }
}

/**
 * Get the socket path
 */
export function getSocketPath(): string {
  return SOCKET_PATH;
}

/**
 * Get the PID file path
 */
export function getPidPath(): string {
  return PID_PATH;
}

/**
 * Check if server is running and return its PID
 */
export function getRunningServerPid(): number | null {
  if (!fs.existsSync(PID_PATH)) {
    return null;
  }

  try {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);

    // Check if process is actually running
    process.kill(pid, 0);
    return pid;
  } catch {
    // Process not running or PID file invalid, clean up
    cleanupSocket();
    return null;
  }
}

/**
 * Write PID file
 */
export function writePidFile(pid: number): void {
  ensureSocketDir();
  fs.writeFileSync(PID_PATH, pid.toString(), { mode: 0o600 });
}

/**
 * Clean up socket and PID files
 */
export function cleanupSocket(): void {
  try {
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
  } catch {
    // Ignore errors
  }

  try {
    if (fs.existsSync(PID_PATH)) {
      fs.unlinkSync(PID_PATH);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Send request to server via Unix socket and wait for response
 */
export async function sendRequest(
  request: PermissionRequest | UserQuestionRequest
): Promise<HookOutput> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);

    let responseData = '';
    let resolved = false;

    // Set timeout for the entire operation
    socket.setTimeout(SOCKET_TIMEOUT);

    socket.on('connect', () => {
      // Send request as newline-delimited JSON
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      responseData += data.toString();

      // Check for complete message (newline-terminated)
      const newlineIndex = responseData.indexOf('\n');
      if (newlineIndex !== -1) {
        const message = responseData.substring(0, newlineIndex);
        resolved = true;

        try {
          const response = JSON.parse(message) as HookOutput;
          socket.end();
          resolve(response);
        } catch (error) {
          socket.end();
          reject(new Error(`Failed to parse response: ${error}`));
        }
      }
    });

    socket.on('timeout', () => {
      if (!resolved) {
        socket.destroy();
        reject(new Error('Socket timeout waiting for approval'));
      }
    });

    socket.on('error', (error) => {
      if (!resolved) {
        reject(new Error(`Socket error: ${error.message}`));
      }
    });

    socket.on('close', () => {
      if (!resolved) {
        reject(new Error('Socket closed before receiving response'));
      }
    });
  });
}

/**
 * Create Unix socket server
 */
export function createSocketServer(
  onRequest: (
    request: PermissionRequest | UserQuestionRequest,
    socket: net.Socket
  ) => Promise<void>
): net.Server {
  ensureSocketDir();

  // Clean up existing socket file
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  const server = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();

      // Check for complete message (newline-terminated)
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const message = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);

        try {
          const request = JSON.parse(message) as PermissionRequest | UserQuestionRequest;
          await onRequest(request, socket);
        } catch (error) {
          console.error('Failed to process request:', error);
          socket.write(JSON.stringify({ decision: 'deny' }) + '\n');
          socket.end();
        }
      }
    });

    socket.on('error', (error) => {
      console.error('Socket error:', error.message);
    });
  });

  server.listen(SOCKET_PATH, () => {
    // Set socket file permissions
    fs.chmodSync(SOCKET_PATH, 0o600);
    console.error(`[${new Date().toISOString()}] Unix socket server listening at ${SOCKET_PATH}`);
  });

  return server;
}

/**
 * Wait for server to be ready (socket file exists and is connectable)
 */
export async function waitForServer(maxWaitMs: number = 10000): Promise<boolean> {
  const startTime = Date.now();
  const checkInterval = 100;

  while (Date.now() - startTime < maxWaitMs) {
    if (fs.existsSync(SOCKET_PATH)) {
      // Try to connect
      try {
        await new Promise<void>((resolve, reject) => {
          const testSocket = net.createConnection(SOCKET_PATH);
          testSocket.on('connect', () => {
            testSocket.end();
            resolve();
          });
          testSocket.on('error', reject);
          testSocket.setTimeout(1000, () => {
            testSocket.destroy();
            reject(new Error('Connection timeout'));
          });
        });
        return true;
      } catch {
        // Not ready yet
      }
    }

    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  return false;
}
