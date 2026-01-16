import { App } from '@slack/bolt';
import type { Socket } from 'node:net';
import type { PermissionRequest, UserQuestionRequest, Question, PendingRequest, HookOutput, PermissionRequestOutput, PreToolUseOutput } from './types.js';
import { formatToolInput, getToolDescription, createRequestHash, generateRequestId } from './utils.js';
import { createSocketServer, writePidFile, cleanupSocket } from './socket.js';

// Configuration
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
// SLACK_CHANNEL_ID: Channel ID (C...) or User ID (U...) for DM
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || process.env.SLACK_USER_ID;
// User ID for mentions (optional, uses SLACK_USER_ID if set)
const SLACK_MENTION_USER_ID = process.env.SLACK_USER_ID;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN || !SLACK_CHANNEL_ID) {
  console.error('Missing required environment variables:');
  if (!SLACK_BOT_TOKEN) console.error('  - SLACK_BOT_TOKEN');
  if (!SLACK_APP_TOKEN) console.error('  - SLACK_APP_TOKEN');
  if (!SLACK_CHANNEL_ID) console.error('  - SLACK_CHANNEL_ID or SLACK_USER_ID');
  process.exit(1);
}

// Pending requests store
const pendingRequests = new Map<string, PendingRequest>();

// Slack message ts to requestId lookup (for reactions and thread replies)
const tsToPendingId = new Map<string, string>();

// Session-based approval cache: sessionId -> Set of approved request hashes
const sessionApprovals = new Map<string, Set<string>>();

// Deduplication: request hash -> pending request ID (to prevent duplicate Slack messages)
const recentRequestHashes = new Map<string, { requestId: string; timestamp: number }>();
const DEDUP_WINDOW_MS = 30000; // 30 seconds deduplication window

// Initialize Slack Bolt App with Socket Mode
const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SlackBlocks = any[];

/**
 * Build approval request blocks for Slack message
 */
function buildApprovalBlocks(
  requestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  includeButtons: boolean
): SlackBlocks {
  const description = getToolDescription(toolInput);
  const formattedInput = formatToolInput(toolName, toolInput);
  const mention = SLACK_MENTION_USER_ID ? `<@${SLACK_MENTION_USER_ID}> ` : '';

  const blocks: SlackBlocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${mention}*🔔 Claude Code Approval Request*`,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Tool:*\n${toolName}`,
        },
        {
          type: 'mrkdwn',
          text: `*Session:*\n\`${sessionId.substring(0, 8)}...\``,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Command/Input:*\n\`\`\`${formattedInput.substring(0, 2900)}\`\`\``,
      },
    },
  ];

  if (description) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Description:*\n${description}`,
      },
    });
  }

  if (includeButtons) {
    blocks.push({
      type: 'actions',
      block_id: `approval_${requestId}`,
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '✅ Approve',
            emoji: true,
          },
          style: 'primary',
          action_id: 'approve',
          value: requestId,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '❌ Deny',
            emoji: true,
          },
          style: 'danger',
          action_id: 'deny',
          value: requestId,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build result blocks for Slack message (after approval/denial)
 */
function buildResultBlocks(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  action: 'approved' | 'denied',
  userId: string
): SlackBlocks {
  const emoji = action === 'approved' ? '✅' : '❌';
  const status = action === 'approved' ? 'Approved' : 'Denied';

  const description = getToolDescription(toolInput);
  const formattedInput = formatToolInput(toolName, toolInput);

  const blocks: SlackBlocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Claude Code Request ${status}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Tool:*\n${toolName}`,
        },
        {
          type: 'mrkdwn',
          text: `*Session:*\n\`${sessionId.substring(0, 8)}...\``,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Command/Input:*\n\`\`\`${formattedInput.substring(0, 2900)}\`\`\``,
      },
    },
  ];

  if (description) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Description:*\n${description}`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${status} by <@${userId}> at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
      },
    ],
  });

  return blocks;
}

/**
 * Build question notification blocks for Slack message (notification only, no buttons)
 */
function buildQuestionNotificationBlocks(sessionId: string, questions: Question[]): SlackBlocks {
  const mention = SLACK_MENTION_USER_ID ? `<@${SLACK_MENTION_USER_ID}> ` : '';
  const blocks: SlackBlocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${mention}*❓ Claude Code Question*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Session:* \`${sessionId.substring(0, 8)}...\``,
      },
    },
  ];

  // Add each question (no buttons - notification only)
  questions.forEach((q) => {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${q.header ? `[${q.header}] ` : ''}${q.question}*`,
      },
    });

    // Show options as text list
    if (q.options.length > 0) {
      const optionsList = q.options.map((opt) => `• ${opt.label}${opt.description ? `: ${opt.description}` : ''}`).join('\n');
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: optionsList }],
      });
    }
  });

  // Add note that answer should be given in Claude Code
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_💡 Claude Codeで回答してください_' }],
  });

  return blocks;
}

/**
 * Build answered question blocks
 */
function buildAnsweredQuestionBlocks(
  sessionId: string,
  questions: Question[],
  answers: Record<string, string | string[]>,
  userId: string
): SlackBlocks {
  const blocks: SlackBlocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '✅ Claude Code Question Answered',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Session:* \`${sessionId.substring(0, 8)}...\``,
      },
    },
  ];

  // Show questions and answers
  questions.forEach((q, qIndex) => {
    const answer = answers[qIndex.toString()];
    const answerText = Array.isArray(answer) ? answer.join(', ') : answer || 'No answer';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Q: ${q.question}*\nA: ${answerText}`,
      },
    });
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Answered by <@${userId}> at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
      },
    ],
  });

  return blocks;
}

/**
 * Build timeout blocks for Slack message
 */
function buildTimeoutBlocks(pending: PendingRequest): SlackBlocks {
  const request = pending.request;
  const sessionId = request.session_id;

  if (pending.isQuestion) {
    const questions = getQuestions(request);
    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '⏱️ Claude Code Question Timed Out',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Session:* \`${sessionId.substring(0, 8)}...\``,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Question:* ${questions[0]?.question || 'Unknown'}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `⏱️ Connection closed at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
          },
        ],
      },
    ];
  }

  // Permission request timeout
  const permRequest = request as PermissionRequest;
  const formattedInput = formatToolInput(permRequest.tool_name, permRequest.tool_input);

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '⏱️ Claude Code Request Timed Out',
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Tool:*\n${permRequest.tool_name}`,
        },
        {
          type: 'mrkdwn',
          text: `*Session:*\n\`${sessionId.substring(0, 8)}...\``,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Command/Input:*\n\`\`\`${formattedInput.substring(0, 2900)}\`\`\``,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `⏱️ Connection closed at <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
        },
      ],
    },
  ];
}

/**
 * Build hook output in the correct format for Claude Code
 */
function buildHookOutput(pending: PendingRequest, decision: 'allow' | 'deny', answers?: Record<string, string | string[]>): HookOutput {
  if (pending.isQuestion) {
    // PreToolUse hook format (for AskUserQuestion)
    const output: PreToolUseOutput = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: decision === 'allow' ? 'Approved via Slack' : 'Denied via Slack',
      },
    };

    // If we have answers, add them to updatedInput
    if (answers && decision === 'allow') {
      const request = pending.request as PermissionRequest;
      const toolInput = request.tool_input as { questions?: Question[]; answers?: Record<string, string | string[]> };
      const questions = toolInput.questions || [];

      // Convert indexed answers to question-keyed answers
      // AskUserQuestion expects { "full question text": "selected label" }
      const questionKeyedAnswers: Record<string, string> = {};
      for (const [idx, answer] of Object.entries(answers)) {
        const question = questions[parseInt(idx, 10)];
        if (question) {
          // Use the full question text as key (this is what Claude Code expects)
          const key = question.question;
          // Convert array to comma-separated string for multi-select
          questionKeyedAnswers[key] = Array.isArray(answer) ? answer.join(', ') : answer;
        }
      }

      output.hookSpecificOutput.updatedInput = {
        ...toolInput,
        answers: questionKeyedAnswers,
      };
    }

    return output;
  }

  // PermissionRequest hook format
  const output: PermissionRequestOutput = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: decision,
      },
    },
  };

  if (decision === 'deny') {
    output.hookSpecificOutput.decision.message = 'Denied via Slack';
  }

  return output;
}

/**
 * Send response to hook via socket
 */
function sendResponse(pending: PendingRequest, decision: 'allow' | 'deny', answers?: Record<string, string | string[]>): void {
  const response = buildHookOutput(pending, decision, answers);
  const responseStr = JSON.stringify(response) + '\n';

  // Send to primary socket
  if (pending.socket) {
    try {
      console.log(`[${new Date().toISOString()}] Sending response: ${JSON.stringify(response)}`);
      pending.socket.write(responseStr);
      pending.socket.end();
    } catch (error) {
      console.error('Failed to send response to socket:', error);
    }
  } else {
    console.log(`[${new Date().toISOString()}] Primary socket already closed for: ${pending.id}`);
  }

  // Send to additional sockets (from duplicate requests)
  if (pending.additionalSockets) {
    for (const socket of pending.additionalSockets) {
      try {
        console.log(`[${new Date().toISOString()}] Sending response to additional socket for: ${pending.id}`);
        socket.write(responseStr);
        socket.end();
      } catch (error) {
        console.error('Failed to send response to additional socket:', error);
      }
    }
  }

  // Cleanup maps
  if (pending.slackTs) {
    tsToPendingId.delete(pending.slackTs);
  }
  pendingRequests.delete(pending.id);
}

/**
 * Check if request is a user question
 */
function isQuestionRequest(request: PermissionRequest | UserQuestionRequest): boolean {
  if ('tool_name' in request && request.tool_name === 'AskUserQuestion') {
    return true;
  }
  return request.type === 'user_question';
}

/**
 * Get questions from request
 */
function getQuestions(request: PermissionRequest | UserQuestionRequest): Question[] {
  if ('questions' in request) {
    return request.questions;
  }
  if ('tool_input' in request) {
    const toolInput = request.tool_input as { questions?: Question[] };
    return toolInput.questions || [];
  }
  return [];
}

// Handle approval button click
slackApp.action('approve', async ({ body, ack, action }) => {
  await ack();

  if (!('value' in action) || typeof action.value !== 'string') return;

  const requestId = action.value;
  const pending = pendingRequests.get(requestId);

  if (!pending) {
    console.error(`Pending request not found: ${requestId}`);
    return;
  }

  const userId = body.user?.id || 'unknown';
  const request = pending.request as PermissionRequest;

  // Cache approval for this session
  const hash = createRequestHash(request.tool_name, request.tool_input);
  if (!sessionApprovals.has(request.session_id)) {
    sessionApprovals.set(request.session_id, new Set());
  }
  sessionApprovals.get(request.session_id)!.add(hash);

  // Update Slack message
  if (pending.slackTs && pending.slackChannel) {
    const blocks = buildResultBlocks(request.tool_name, request.tool_input, request.session_id, 'approved', userId);
    await slackApp.client.chat.update({
      channel: pending.slackChannel,
      ts: pending.slackTs,
      text: '✅ Claude Code Request Approved',
      blocks,
    });
  }

  // Send response to hook
  sendResponse(pending, 'allow');

  console.log(`[${new Date().toISOString()}] Approved: ${request.tool_name} (${requestId})`);
});

// Handle deny button click
slackApp.action('deny', async ({ body, ack, action }) => {
  await ack();

  if (!('value' in action) || typeof action.value !== 'string') return;

  const requestId = action.value;
  const pending = pendingRequests.get(requestId);

  if (!pending) {
    console.error(`Pending request not found: ${requestId}`);
    return;
  }

  const userId = body.user?.id || 'unknown';
  const request = pending.request as PermissionRequest;

  // Update Slack message
  if (pending.slackTs && pending.slackChannel) {
    const blocks = buildResultBlocks(request.tool_name, request.tool_input, request.session_id, 'denied', userId);
    await slackApp.client.chat.update({
      channel: pending.slackChannel,
      ts: pending.slackTs,
      text: '❌ Claude Code Request Denied',
      blocks,
    });
  }

  // Send response to hook
  sendResponse(pending, 'deny');

  console.log(`[${new Date().toISOString()}] Denied: ${request.tool_name} (${requestId})`);
});

// Handle emoji reaction (for Apple Watch support)
slackApp.event('reaction_added', async ({ event }) => {
  // Get requestId from message ts
  const messageTs = event.item.ts;
  const requestId = tsToPendingId.get(messageTs);

  if (!requestId) return;

  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  // Skip questions - they need specific answers, not just approve/deny
  if (pending.isQuestion) {
    console.log(`[${new Date().toISOString()}] Reaction ignored for question: ${requestId}`);
    return;
  }

  const request = pending.request as PermissionRequest;
  const userId = event.user;
  const reaction = event.reaction;

  // Check for approval reactions
  if (['+1', 'thumbsup', 'white_check_mark', 'heavy_check_mark'].includes(reaction)) {
    // Cache approval for this session
    const hash = createRequestHash(request.tool_name, request.tool_input);
    if (!sessionApprovals.has(request.session_id)) {
      sessionApprovals.set(request.session_id, new Set());
    }
    sessionApprovals.get(request.session_id)!.add(hash);

    // Update Slack message
    if (pending.slackTs && pending.slackChannel) {
      const blocks = buildResultBlocks(request.tool_name, request.tool_input, request.session_id, 'approved', userId);
      await slackApp.client.chat.update({
        channel: pending.slackChannel,
        ts: pending.slackTs,
        text: '✅ Claude Code Request Approved',
        blocks,
      });
    }

    sendResponse(pending, 'allow');
    console.log(`[${new Date().toISOString()}] Approved via reaction: ${request.tool_name} (${requestId})`);
  }
  // Check for denial reactions
  else if (['-1', 'thumbsdown', 'x', 'no_entry'].includes(reaction)) {
    // Update Slack message
    if (pending.slackTs && pending.slackChannel) {
      const blocks = buildResultBlocks(request.tool_name, request.tool_input, request.session_id, 'denied', userId);
      await slackApp.client.chat.update({
        channel: pending.slackChannel,
        ts: pending.slackTs,
        text: '❌ Claude Code Request Denied',
        blocks,
      });
    }

    sendResponse(pending, 'deny');
    console.log(`[${new Date().toISOString()}] Denied via reaction: ${request.tool_name} (${requestId})`);
  }
});

// Handle text reply (for Apple Watch support)
// Supports both thread replies and direct channel messages
// Using app.message() for better DM support in Bolt
slackApp.message(async ({ message }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgEvent = message as any;

  console.log(`[${new Date().toISOString()}] Message event received: channel=${msgEvent.channel}, text="${msgEvent.text}", thread_ts=${msgEvent.thread_ts}, subtype=${msgEvent.subtype}, bot_id=${msgEvent.bot_id}`);

  // Skip bot messages and message edits
  if (msgEvent.subtype || msgEvent.bot_id) {
    console.log(`[${new Date().toISOString()}] Skipping: subtype or bot message`);
    return;
  }

  // Log pending state for debugging
  console.log(`[${new Date().toISOString()}] Pending requests: ${Array.from(pendingRequests.entries()).map(([id, p]) => `${id}:${p.slackChannel}`).join(', ')}`);
  console.log(`[${new Date().toISOString()}] tsToPendingId: ${Array.from(tsToPendingId.entries()).map(([ts, id]) => `${ts}:${id}`).join(', ')}`);

  // Try to find pending request - first check thread_ts, then find most recent pending
  let requestId: string | undefined;

  if (msgEvent.thread_ts) {
    // Thread reply - look up by thread_ts
    requestId = tsToPendingId.get(msgEvent.thread_ts);
    console.log(`[${new Date().toISOString()}] Thread reply lookup: ${requestId}`);
  } else {
    // Direct channel message (Apple Watch) - find most recent pending request in this channel
    // Search directly in pendingRequests (not tsToPendingId) to find any pending request for this channel
    for (const [id, p] of pendingRequests.entries()) {
      console.log(`[${new Date().toISOString()}] Checking pending ${id}: channel=${p.slackChannel}, msgChannel=${msgEvent.channel}, match=${p.slackChannel === msgEvent.channel}`);
      if (p.slackChannel === msgEvent.channel && !p.isQuestion) {
        requestId = id;
        break; // Use the first one found
      }
    }
    console.log(`[${new Date().toISOString()}] Direct message lookup: ${requestId}`);
  }

  if (!requestId) {
    console.log(`[${new Date().toISOString()}] No matching pending request found`);
    return;
  }

  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  // Skip questions - they need specific answers
  if (pending.isQuestion) {
    console.log(`[${new Date().toISOString()}] Thread reply ignored for question: ${requestId}`);
    return;
  }

  const request = pending.request as PermissionRequest;
  const userId = msgEvent.user;
  const text = msgEvent.text?.toLowerCase().trim();

  // Check for approval text
  if (['ok', 'approve', 'yes', 'y', 'allow', 'go'].includes(text)) {
    // Cache approval for this session
    const hash = createRequestHash(request.tool_name, request.tool_input);
    if (!sessionApprovals.has(request.session_id)) {
      sessionApprovals.set(request.session_id, new Set());
    }
    sessionApprovals.get(request.session_id)!.add(hash);

    // Update Slack message
    if (pending.slackTs && pending.slackChannel) {
      const blocks = buildResultBlocks(request.tool_name, request.tool_input, request.session_id, 'approved', userId);
      await slackApp.client.chat.update({
        channel: pending.slackChannel,
        ts: pending.slackTs,
        text: '✅ Claude Code Request Approved',
        blocks,
      });
    }

    sendResponse(pending, 'allow');
    console.log(`[${new Date().toISOString()}] Approved via reply: ${request.tool_name} (${requestId})`);
  }
  // Check for denial text
  else if (['no', 'deny', 'reject', 'n', 'stop', 'cancel'].includes(text)) {
    // Update Slack message
    if (pending.slackTs && pending.slackChannel) {
      const blocks = buildResultBlocks(request.tool_name, request.tool_input, request.session_id, 'denied', userId);
      await slackApp.client.chat.update({
        channel: pending.slackChannel,
        ts: pending.slackTs,
        text: '❌ Claude Code Request Denied',
        blocks,
      });
    }

    sendResponse(pending, 'deny');
    console.log(`[${new Date().toISOString()}] Denied via reply: ${request.tool_name} (${requestId})`);
  }
});

// Handle question option button clicks
slackApp.action(/^question_\d+_(\d+|other)$/, async ({ body, ack, action, client }) => {
  await ack();

  if (!('value' in action) || typeof action.value !== 'string') return;

  const data = JSON.parse(action.value) as {
    requestId: string;
    questionIndex: number;
    optionIndex: number;
    label: string;
  };

  const pending = pendingRequests.get(data.requestId);
  if (!pending) {
    console.error(`Pending request not found: ${data.requestId}`);
    return;
  }

  const userId = body.user?.id || 'unknown';
  const questions = getQuestions(pending.request);

  // Handle "Other" option - open modal for custom input
  if (data.optionIndex === -1) {
    await client.views.open({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'question_other_submit',
        private_metadata: JSON.stringify({ requestId: data.requestId, questionIndex: data.questionIndex }),
        title: {
          type: 'plain_text',
          text: 'Custom Answer',
        },
        submit: {
          type: 'plain_text',
          text: 'Submit',
        },
        blocks: [
          {
            type: 'input',
            block_id: 'custom_answer_block',
            element: {
              type: 'plain_text_input',
              action_id: 'custom_answer',
              placeholder: {
                type: 'plain_text',
                text: 'Enter your answer...',
              },
            },
            label: {
              type: 'plain_text',
              text: questions[data.questionIndex].question,
            },
          },
        ],
      },
    });
    return;
  }

  // Initialize answers if not exists
  if (!pending.answers) {
    pending.answers = {};
  }

  const question = questions[data.questionIndex];

  if (question.multiSelect) {
    // For multiSelect, toggle the option
    const currentAnswers = (pending.answers[data.questionIndex.toString()] as string[]) || [];
    const index = currentAnswers.indexOf(data.label);
    if (index === -1) {
      currentAnswers.push(data.label);
    } else {
      currentAnswers.splice(index, 1);
    }
    pending.answers[data.questionIndex.toString()] = currentAnswers;
  } else {
    // For single select, set the answer
    pending.answers[data.questionIndex.toString()] = data.label;
  }

  // Check if all questions are answered
  const allAnswered = questions.every((q, idx) => {
    const answer = pending.answers?.[idx.toString()];
    if (q.multiSelect) {
      return Array.isArray(answer) && answer.length > 0;
    }
    return answer !== undefined && answer !== '';
  });

  if (allAnswered && !questions.some((q) => q.multiSelect)) {
    // Update Slack message
    if (pending.slackTs && pending.slackChannel) {
      const blocks = buildAnsweredQuestionBlocks(pending.request.session_id, questions, pending.answers, userId);
      await slackApp.client.chat.update({
        channel: pending.slackChannel,
        ts: pending.slackTs,
        text: '✅ Claude Code Question Answered',
        blocks,
      });
    }

    // Send response to hook
    sendResponse(pending, 'allow', pending.answers);

    console.log(`[${new Date().toISOString()}] Question answered: ${data.requestId}`);
  }
});

// Handle modal submission for custom "Other" answer
slackApp.view('question_other_submit', async ({ ack, body, view }) => {
  await ack();

  const metadata = JSON.parse(view.private_metadata) as { requestId: string; questionIndex: number };
  const pending = pendingRequests.get(metadata.requestId);

  if (!pending) {
    console.error(`Pending request not found: ${metadata.requestId}`);
    return;
  }

  const customAnswer = view.state.values.custom_answer_block.custom_answer.value || '';
  const userId = body.user?.id || 'unknown';
  const questions = getQuestions(pending.request);

  if (!pending.answers) {
    pending.answers = {};
  }

  pending.answers[metadata.questionIndex.toString()] = customAnswer;

  // Check if all questions answered
  const allAnswered = questions.every((_, idx) => {
    const answer = pending.answers?.[idx.toString()];
    return answer !== undefined && answer !== '';
  });

  if (allAnswered) {
    // Update Slack message
    if (pending.slackTs && pending.slackChannel) {
      const blocks = buildAnsweredQuestionBlocks(pending.request.session_id, questions, pending.answers, userId);
      await slackApp.client.chat.update({
        channel: pending.slackChannel,
        ts: pending.slackTs,
        text: '✅ Claude Code Question Answered',
        blocks,
      });
    }

    // Send response to hook
    sendResponse(pending, 'allow', pending.answers);

    console.log(`[${new Date().toISOString()}] Question answered with custom input: ${metadata.requestId}`);
  }
});

// Handle multiSelect confirmation button
slackApp.action(/^confirm_multiselect_\d+$/, async ({ body, ack, action }) => {
  await ack();

  if (!('value' in action) || typeof action.value !== 'string') return;

  const data = JSON.parse(action.value) as { requestId: string };
  const pending = pendingRequests.get(data.requestId);

  if (!pending) {
    console.error(`Pending request not found: ${data.requestId}`);
    return;
  }

  const userId = body.user?.id || 'unknown';
  const questions = getQuestions(pending.request);

  // Update Slack message
  if (pending.slackTs && pending.slackChannel && pending.answers) {
    const blocks = buildAnsweredQuestionBlocks(pending.request.session_id, questions, pending.answers, userId);
    await slackApp.client.chat.update({
      channel: pending.slackChannel,
      ts: pending.slackTs,
      text: '✅ Claude Code Question Answered',
      blocks,
    });
  }

  // Send response to hook
  sendResponse(pending, 'allow', pending.answers || {});

  console.log(`[${new Date().toISOString()}] MultiSelect question confirmed: ${data.requestId}`);
});

/**
 * Handle incoming request from hook via socket
 */
async function handleRequest(request: PermissionRequest | UserQuestionRequest, socket: Socket): Promise<void> {
  const sessionId = request.session_id;
  const isQuestion = isQuestionRequest(request);

  // Create hash for deduplication
  let dedupHash: string;
  if (isQuestion) {
    const questions = getQuestions(request);
    dedupHash = `q:${sessionId}:${JSON.stringify(questions.map(q => q.question))}`;
  } else {
    const permRequest = request as PermissionRequest;
    dedupHash = `p:${sessionId}:${createRequestHash(permRequest.tool_name, permRequest.tool_input)}`;
  }

  // Check for duplicate request within dedup window
  const now = Date.now();
  const existing = recentRequestHashes.get(dedupHash);
  if (existing && now - existing.timestamp < DEDUP_WINDOW_MS) {
    const existingPending = pendingRequests.get(existing.requestId);
    if (existingPending) {
      console.log(`[${new Date().toISOString()}] Duplicate request detected, attaching to existing: ${existing.requestId}`);
      // Attach this socket to the existing pending request
      // When the existing request is resolved, we'll also respond to this socket
      const originalSocket = existingPending.socket;
      existingPending.socket = null; // Clear single socket reference
      if (!existingPending.additionalSockets) {
        existingPending.additionalSockets = [];
      }
      if (originalSocket) {
        existingPending.additionalSockets.push(originalSocket);
      }
      existingPending.additionalSockets.push(socket);
      return;
    }
  }

  const requestId = generateRequestId();

  // Store hash for deduplication
  recentRequestHashes.set(dedupHash, { requestId, timestamp: now });

  console.log(`[${new Date().toISOString()}] New ${isQuestion ? 'question' : 'request'}: ${requestId}`);

  // For permission requests, check session cache first
  if (!isQuestion) {
    const permRequest = request as PermissionRequest;
    const hash = createRequestHash(permRequest.tool_name, permRequest.tool_input);
    const sessionCache = sessionApprovals.get(sessionId);

    if (sessionCache?.has(hash)) {
      console.log(`[${new Date().toISOString()}] Cache hit: ${permRequest.tool_name} (session: ${sessionId.substring(0, 8)})`);
      const cacheResponse: PermissionRequestOutput = {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
          },
        },
      };
      socket.write(JSON.stringify(cacheResponse) + '\n');
      socket.end();
      return;
    }
  }

  // Store pending request with socket reference
  const pending: PendingRequest = {
    id: requestId,
    socket,
    request,
    createdAt: Date.now(),
    isQuestion,
  };

  pendingRequests.set(requestId, pending);

  // Send to Slack
  try {
    let result;

    if (isQuestion) {
      const questions = getQuestions(request);
      if (questions.length === 0) {
        // No questions, respond immediately with allow
        const emptyResponse: PreToolUseOutput = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'No questions to answer',
          },
        };
        socket.write(JSON.stringify(emptyResponse) + '\n');
        socket.end();
        pendingRequests.delete(requestId);
        return;
      }

      const blocks = buildQuestionNotificationBlocks(sessionId, questions);
      const mention = SLACK_MENTION_USER_ID ? `<@${SLACK_MENTION_USER_ID}> ` : '';
      // Include question text for mobile notifications
      const questionPreview = questions[0]?.question || 'Question';
      result = await slackApp.client.chat.postMessage({
        channel: SLACK_CHANNEL_ID!,
        text: `${mention}❓ ${questionPreview}`,
        blocks,
      });
    } else {
      const permRequest = request as PermissionRequest;
      const blocks = buildApprovalBlocks(requestId, permRequest.tool_name, permRequest.tool_input, sessionId, true);
      const mention = SLACK_MENTION_USER_ID ? `<@${SLACK_MENTION_USER_ID}> ` : '';
      // Include command preview for mobile notifications
      const commandPreview = formatToolInput(permRequest.tool_name, permRequest.tool_input).substring(0, 100);
      result = await slackApp.client.chat.postMessage({
        channel: SLACK_CHANNEL_ID!,
        text: `${mention}🔔 ${permRequest.tool_name}: ${commandPreview}`,
        blocks,
      });
    }

    pending.slackTs = result.ts;
    // Use result.channel for DM - it returns the actual DM channel ID
    pending.slackChannel = result.channel!;
    // Register for reaction/reply lookup
    if (result.ts) {
      tsToPendingId.set(result.ts, requestId);
    }
  } catch (error) {
    console.error('Failed to send Slack message:', error);
    // Use the pending object to determine correct error format
    const errorResponse = buildHookOutput(pending, 'deny');
    socket.write(JSON.stringify(errorResponse) + '\n');
    socket.end();
    pendingRequests.delete(requestId);
  }

  // Handle socket disconnect - update Slack message to show timeout
  // Note: If sendResponse was called, the pending request is already deleted
  socket.on('close', async () => {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      // Already handled by sendResponse, this is a normal close
      console.log(`[${new Date().toISOString()}] Socket closed (handled): ${requestId}`);
      return;
    }

    // Socket closed before response was sent (timeout)
    console.log(`[${new Date().toISOString()}] Socket closed (timeout): ${requestId}`);
    if (pending.slackTs && pending.slackChannel) {
      try {
        await slackApp.client.chat.update({
          channel: pending.slackChannel,
          ts: pending.slackTs,
          text: '⏱️ Claude Code Request Timed Out',
          blocks: buildTimeoutBlocks(pending),
        });
      } catch (error) {
        console.error('Failed to update Slack message on timeout:', error);
      }
    }
    pendingRequests.delete(requestId);
  });

  socket.on('error', (err) => {
    console.log(`[${new Date().toISOString()}] Socket error for: ${requestId}: ${err.message}`);
  });
}

// Cleanup old requests periodically (older than 2 hours)
setInterval(() => {
  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000;

  for (const [id, pending] of pendingRequests) {
    if (now - pending.createdAt > twoHours) {
      console.log(`[${new Date().toISOString()}] Cleaning up stale request: ${id}`);
      try {
        pending.socket?.end();
        pending.additionalSockets?.forEach(s => s.end());
      } catch {
        // Ignore
      }
      pendingRequests.delete(id);
    }
  }

  // Cleanup old deduplication hashes
  for (const [hash, data] of recentRequestHashes) {
    if (now - data.timestamp > DEDUP_WINDOW_MS) {
      recentRequestHashes.delete(hash);
    }
  }
}, 60 * 1000);

// Start server
async function start(): Promise<void> {
  // Write PID file
  writePidFile(process.pid);

  // Start Slack Socket Mode
  await slackApp.start();
  console.log(`[${new Date().toISOString()}] Slack Socket Mode connected`);

  // Start Unix socket server
  const socketServer = createSocketServer(handleRequest);

  console.log(`[${new Date().toISOString()}] Channel: ${SLACK_CHANNEL_ID}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');

    // Close all pending sockets
    for (const pending of pendingRequests.values()) {
      try {
        pending.socket?.end();
      } catch {
        // Ignore
      }
    }

    await slackApp.stop();
    socketServer.close();
    cleanupSocket();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  cleanupSocket();
  process.exit(1);
});
