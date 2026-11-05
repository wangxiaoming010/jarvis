// Explicit real-Claude check: only approves a known write in a temporary directory.
// Uses the existing local login; native sessions remain in the CLI's own history.
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { ClaudeExecution } from '../../apps/bridge/src/claude.ts';

const directory = await realpath(await mkdtemp(join(tmpdir(), 'openbot-native-smoke-')));
const output = join(directory, 'native-answer.txt');
let questions = 0;
let approvals = 0;
let callbackError;
const job = {
  task: {
    id: 'native-verification',
    groupId: 'verification',
    botId: 'claude',
    input: `Verify the native interaction connection. First use AskUserQuestion once to ask "Which label should I save?" with exactly two options: alpha and beta. Wait for the answer. Then use Write to save only that selected label, with no newline, to the absolute path ${output}. Do not use Bash, do not read any files, and do not write anywhere else. The host will review the Write request. Finish by stating which label was saved. Do not generate a dynamic UI card.`,
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    correlationId: 'verification',
    round: 1,
  },
  leaseId: 'verification-lease',
  bot: {
    id: 'claude',
    ownerId: 'verification',
    name: 'NativeVerification',
    description: 'Verify only the explicitly requested native interactions.',
    provider: 'claude-code',
    status: 'working',
    bridgeId: 'verification',
    createdAt: '',
  },
  group: {
    id: 'verification',
    name: 'Isolated verification',
    description: '',
    botIds: ['claude'],
    createdAt: '',
  },
  members: [],
  messages: [],
  session: null,
  sourceMessageId: 'verification',
};
const execution = new ClaudeExecution(
  process.env.OPENBOT_CLAUDE_PATH ?? 'claude',
  job,
  {
    session: () => {},
    progress: () => {},
    approval: () => {},
    interaction: (id, request) => {
      try {
        if (request.kind === 'question') {
          console.log('Received native question; returning the verification answer.');
          assert.equal(++questions, 1, 'Expected one native question');
          assert.equal(request.questions.length, 1);
          assert.ok(request.questions[0].options.some((option) => option.label === 'beta'));
          execution.respond(id, {
            decision: 'accept',
            answers: { [request.questions[0].id]: ['beta'] },
          });
        } else {
          const { tool, input } = request.details ?? {};
          assert.equal(tool, 'Write', 'Only the isolated Write operation can be approved');
          assert.equal(resolve(directory, input.file_path), output);
          assert.equal(input.content, 'beta');
          approvals++;
          console.log('Received the exact isolated Write request; returning approval.');
          execution.respond(id, { decision: 'accept' });
        }
      } catch (error) {
        callbackError = error;
        execution.respond(id, { decision: 'decline' });
        void execution.cancel();
      }
    },
  },
  { timeoutMs: 120000 },
);
try {
  const result = await execution.run();
  if (callbackError) throw callbackError;
  assert.equal(result.status, 'completed', result.error ?? 'Native execution did not complete');
  assert.equal(questions, 1, 'Claude did not issue the native question');
  assert.equal(approvals, 1, 'Claude did not wait for native Write approval');
  assert.equal(await readFile(output, 'utf8'), 'beta');
  console.log(
    JSON.stringify({
      realClaude: true,
      nativeQuestion: true,
      originalProcessResumed: true,
      exactWriteApproval: true,
      verifiedFileContent: true,
      isolatedDirectory: true,
    }),
  );
} finally {
  await execution.dispose();
  await rm(directory, { recursive: true, force: true });
}
