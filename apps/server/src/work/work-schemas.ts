import { z } from 'zod';
const text = z.string().trim().min(1).max(6000);
const taskId = z.string().min(1);
const criteria = z.array(z.string().trim().min(1).max(500)).min(1).max(12);
const date = z.string().datetime({ offset: true });
export const ownershipSchemas = {
  create_goal: z
    .object({
      title: text,
      criteria,
      projectId: taskId.optional(),
      delivery: z.enum(['accepted', 'applied']).optional(),
      verification: z.enum(['reviewed', 'content']).optional(),
    })
    .strict(),
  list_goals: z
    .object({ query: z.string().max(1000).optional(), offset: z.number().int().min(0).optional() })
    .strict(),
  read_goal: z.object({ goalId: taskId }).strict(),
  link_goal: z.object({ goalId: taskId }).strict(),
  plan_goal: z
    .object({
      goalId: taskId,
      nextAction: text.optional(),
      nextCheckAt: date.nullable().optional(),
      deadline: date.nullable().optional(),
      needsHuman: text.nullable().optional(),
      waitFor: z
        .array(
          z
            .object({
              kind: z.enum(['task', 'goal', 'delegation', 'fact', 'artifact', 'human', 'file']),
              id: taskId,
              state: taskId,
              afterVersion: z.number().int().min(-1).optional(),
            })
            .strict(),
        )
        .max(20)
        .optional(),
    })
    .strict(),
  revise_goal: z
    .object({ goalId: taskId, expectedVersion: z.number().int().min(1), criteria })
    .strict(),
  stop_goal: z.object({ goalId: taskId }).strict(),
  reopen_goal: z
    .object({ goalId: taskId, expectedVersion: z.number().int().min(1), instruction: text })
    .strict(),
  finish_goal: z
    .object({
      goalId: taskId,
      expectedVersion: z.number().int().min(1),
      evidence: z
        .array(
          z
            .object({
              criterion: text,
              source: z.enum(['artifact', 'delegation']),
              id: taskId,
              version: z.number().int().min(1),
            })
            .strict(),
        )
        .min(1)
        .max(12),
    })
    .strict(),
  delegate_goal: z
    .object({ goalId: taskId, botId: taskId, goal: text, criteria, expiresAt: date.optional() })
    .strict(),
  create_project: z.object({ name: text }).strict(),
  share_project: z.object({ projectId: taskId, groupId: taskId }).strict(),
  read_project: z.object({ projectId: taskId }).strict(),
  propose_project_fact: z
    .object({
      projectId: taskId,
      key: z.string().trim().min(1).max(100),
      content: text,
      kind: z.enum(['requirement', 'decision', 'interface']),
      expectedVersion: z.number().int().min(0),
    })
    .strict(),
  confirm_project_fact: z.object({ factId: taskId, version: z.number().int().min(1) }).strict(),
  register_artifact: z
    .object({
      goalId: taskId,
      taskId,
      title: text,
      kind: z.enum(['file', 'git', 'report']),
      locator: text,
      applicationPath: text.optional(),
      artifactId: taskId.optional(),
      expectedVersion: z.number().int().min(1).optional(),
    })
    .strict(),
  read_artifact: z
    .object({ artifactId: taskId, offset: z.number().int().min(0).optional() })
    .strict(),
  verify_artifact: z
    .object({
      artifactId: taskId,
      version: z.number().int().min(1),
      method: z.enum(['json', 'independent_run', 'human']),
      verifierRunId: taskId.optional(),
      quote: text.optional(),
    })
    .strict(),
  accept_artifact: z.object({ artifactId: taskId, version: z.number().int().min(1) }).strict(),
  record_application: z.object({ artifactId: taskId, version: z.number().int().min(1) }).strict(),
};
