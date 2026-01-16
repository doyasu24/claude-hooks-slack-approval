import type { Socket } from 'node:net';

// Claude Code Permission Request types
export interface PermissionRequest {
  type: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id: string;
}

// Claude Code User Question types (from AskUserQuestion hook)
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface UserQuestionRequest {
  type: 'user_question';
  session_id: string;
  questions: Question[];
}

// Hook output (response to Claude Code)
// PermissionRequest hook format
export interface PermissionRequestOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: {
      behavior: 'allow' | 'deny';
      message?: string;  // Only for deny
    };
  };
}

// PreToolUse hook format (for AskUserQuestion)
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

export type HookOutput = PermissionRequestOutput | PreToolUseOutput;

// Pending request (socket + request data)
export interface PendingRequest {
  id: string;
  socket: Socket | null;  // null if socket was closed
  additionalSockets?: Socket[];  // For duplicate requests attached to the same pending request
  request: PermissionRequest | UserQuestionRequest;
  slackTs?: string;
  slackChannel?: string;
  createdAt: number;
  isQuestion: boolean;
  answers?: Record<string, string | string[]>;
}

// Hook configuration
export interface HookConfig {
  delay: number; // milliseconds
  notifyImmediatelyOnLock: boolean;
  testMode: boolean;
}
