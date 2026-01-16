import { execSync } from 'node:child_process';

/**
 * Parse ISO 8601 duration string to milliseconds
 * Supports: 30s, 1m, 1m30s, 5m, 1h, 1h30m, etc.
 */
export function parseDuration(duration: string): number {
  if (duration === '0') return 0;

  const regex = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = duration.match(regex);

  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use format like 30s, 1m, 5m, 1h`);
  }

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Check if macOS screen is locked
 */
export function isScreenLocked(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }

  try {
    // Check if screen saver or lock screen is active
    const result = execSync(
      'python3 -c "import Quartz; print(Quartz.CGSessionCopyCurrentDictionary())"',
      { encoding: 'utf-8', timeout: 5000 }
    );

    // CGSSessionScreenIsLocked key indicates lock state
    return result.includes("'CGSSessionScreenIsLocked': 1");
  } catch {
    // Alternative method using ioreg
    try {
      const result = execSync(
        'ioreg -n Root -d1 -a | grep -i "CGSSessionScreenIsLocked"',
        { encoding: 'utf-8', timeout: 5000 }
      );
      return result.includes('true');
    } catch {
      return false;
    }
  }
}

/**
 * Generate unique request ID
 */
export function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a hash for tool request (for session-based caching)
 */
export function createRequestHash(toolName: string, toolInput: Record<string, unknown>): string {
  const inputStr = JSON.stringify(toolInput, Object.keys(toolInput).sort());
  return `${toolName}:${inputStr}`;
}

/**
 * Format tool input for display in Slack message
 */
export function formatToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  // For Bash tool, show command
  if (toolName === 'Bash' && toolInput.command) {
    return String(toolInput.command);
  }

  // For Write tool, show file path
  if (toolName === 'Write' && toolInput.file_path) {
    const content = toolInput.content ? String(toolInput.content).substring(0, 500) : '';
    return `File: ${toolInput.file_path}\n\n${content}${content.length >= 500 ? '...' : ''}`;
  }

  // For Edit tool, show file and changes
  if (toolName === 'Edit' && toolInput.file_path) {
    return `File: ${toolInput.file_path}\nOld: ${toolInput.old_string}\nNew: ${toolInput.new_string}`;
  }

  // Default: JSON format
  return JSON.stringify(toolInput, null, 2);
}

/**
 * Get description from tool input if available
 */
export function getToolDescription(toolInput: Record<string, unknown>): string | undefined {
  if (typeof toolInput.description === 'string') {
    return toolInput.description;
  }
  return undefined;
}
