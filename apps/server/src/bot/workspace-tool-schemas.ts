import { z } from 'zod';
import { botSchema, botAvatarSchema, groupSchema } from '@openbot/shared/schemas';

const id = z.string().min(1).max(200);
const page = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(40).optional(),
};
const query = z.string().trim().max(200).optional();
const group = { groupId: id };
const message = { messageId: id };
const content = z.string().trim().min(1).max(6000);
export const workspaceToolSchemas = {
  discover_groups: z.object({ query, ...page }).strict(),
  list_bots: z.object({ query, ...page }).strict(),
  get_bot: z.object({ botId: id }).strict(),
  list_members: z.object({ ...group, query, ...page }).strict(),
  get_conversation_activity: z.object(group).strict(),
  read_thread: z.object({ ...message, ...page }).strict(),
  get_message_context: z
    .object({ ...message, radius: z.number().int().min(1).max(10).optional() })
    .strict(),
  get_execution_status: z.object({}).strict(),
  get_current_time: z.object({ timeZone: z.string().max(100).optional() }).strict(),
  list_tools: z.object({ query, ...page }).strict(),
  create_group: groupSchema.extend({ botIds: z.array(id).max(31).default([]) }).strict(),
  update_group: z
    .object({
      ...group,
      name: groupSchema.shape.name.optional(),
      description: groupSchema.shape.description.unwrap().optional(),
    })
    .strict()
    .refine((v) => v.name !== undefined || v.description !== undefined, '请提供需要修改的资料'),
  join_group: z.object(group).strict(),
  leave_group: z.object(group).strict(),
  invite_bot: z.object({ ...group, botId: id }).strict(),
  remove_bot: z.object({ ...group, botId: id }).strict(),
  delete_group: z.object(group).strict(),
  update_self: z
    .object({
      name: botSchema.shape.name.optional(),
      description: botSchema.shape.description.unwrap().optional(),
    })
    .strict()
    .refine((v) => v.name !== undefined || v.description !== undefined, '请提供需要修改的资料'),
  set_avatar: z.object({ avatar: botAvatarSchema.nullable() }).strict(),
  reply_message: z
    .object({ ...message, content, mentionBotIds: z.array(id).max(32).optional() })
    .strict(),
  forward_message: z
    .object({ ...message, ...group, note: z.string().trim().max(1000).optional() })
    .strict(),
  list_memories: z.object({ query, groupId: id.optional(), ...page }).strict(),
  read_memory: z.object({ memoryId: id, ...page }).strict(),
  list_projects: z.object({ groupId: id.optional(), query, ...page }).strict(),
  list_artifacts: z.object({ groupId: id.optional(), query, ...page }).strict(),
  list_delegations: z.object({ groupId: id.optional(), ...page }).strict(),
};

/** Social and identity changes require a fresh owner message, never a worker report or peer request. */
export const workspaceMutationTools = new Set<string>([
  'create_group',
  'update_group',
  'join_group',
  'leave_group',
  'invite_bot',
  'remove_bot',
  'delete_group',
  'update_self',
  'set_avatar',
  'forward_message',
]);
export const workspaceReadTools = Object.keys(workspaceToolSchemas).filter(
  (name) => !workspaceMutationTools.has(name) && name !== 'reply_message',
);
export const workspaceToolDescriptions: Record<keyof typeof workspaceToolSchemas, string> = {
  discover_groups:
    'Find ordinary groups in this owner workspace by name/ID/description. Metadata only; discovery grants no message access. Private human–Bot chats are excluded. Use nextOffset.',
  list_bots:
    'Search the Bot directory by name/ID/role. Public profiles and shared conversation IDs only; no private histories, memories or device credentials. Use nextOffset.',
  get_bot:
    'Get a Bot public profile by stable ID and conversations shared with you. Does not expose their private memberships or memory.',
  list_members:
    'Read/search paginated current members of a joined conversation by stable IDs, names and roles.',
  get_conversation_activity:
    'Query live message counts, latest message reference, member activity and your task/goal counts in a joined conversation. Counts are observations, not read receipts.',
  read_thread:
    'Read a message and its descendant replies in a joined conversation, chronologically, with pagination. Use read_message for full truncated text.',
  get_message_context:
    'Read up to radius messages before and after a source message in its joined conversation. Use read_message for full text.',
  get_execution_status:
    'Query your selected/available execution tools, presence and active task references. No device secrets. Does not start or change execution.',
  get_current_time:
    'Read actual host time as UTC and an optional IANA time zone. Never guess dates from historical context.',
  list_tools:
    'Search/paginate the actual callable tool catalog, descriptions and parameter schemas. Use when unsure which capability or arguments exist.',
  create_group:
    'On an explicit owner request, create an ordinary group including yourself plus optional Bot IDs. Returns stable new groupId. Does not send messages or create Bot identities.',
  update_group:
    'On an explicit owner request, rename/change description of a joined ordinary group. Omitted fields and stable ID remain intact; does not replace members.',
  join_group:
    'On an explicit owner request, join an existing ordinary group by ID. Idempotent. Discover first if needed. Human–Bot private chats cannot be joined.',
  leave_group:
    "On an explicit owner request, leave an ordinary group. Active goals/tasks/delegations must first be stopped or moved. Leaving this event's conversation ends the turn; call alone and send any needed acknowledgement first. Private chats cannot be left.",
  invite_bot:
    'On an explicit owner request, add a directory Bot by ID to an ordinary group you joined (32 Bot maximum). Idempotent; never changes private chat membership.',
  remove_bot:
    'On an explicit owner request, remove another Bot from a joined ordinary group after its active work is stopped/moved. Use leave_group for yourself. Does not delete Bot identity or history.',
  delete_group:
    'Only on an explicit owner request, delete an idle joined ordinary group with existing cleanup/active-work guards. Cannot delete the current event conversation: ask from another joined conversation. Private chats cannot be deleted.',
  update_self:
    'On an explicit owner request, change your own display name/role description. Name uniqueness enforced; identity/ID, execution tool and history stay intact. Cannot modify another Bot.',
  set_avatar:
    'On an explicit owner request, set your own validated emoji/image avatar, or null for default. Never generate a huge image data URL; use an existing provided valid image only.',
  reply_message:
    'Reply as yourself to an exact accessible message using its stable ID, preserving the reply link and optional destination-member mentions. Successful receipt confirms posting.',
  forward_message:
    'Only on an explicit owner request to relay this content, forward one accessible text message to a joined destination, with source attribution and optional note. No automatic private-history disclosure or destination @ notifications.',
  list_memories:
    'Search/paginate your active unexpired durable memories. Optional joined group filter. Historical facts only, never a live membership registry.',
  read_memory:
    'Read one of your accessible memories plus paginated correction history and provenance. Forgotten/expired state is explicit; do not treat old revisions as current facts.',
  list_projects:
    'Search/paginate project records shared in your currently joined conversations. Returns IDs and accessible group references; read_project for facts in the current chat.',
  list_artifacts:
    'Search/paginate artifact references accessible under existing goal/project authorization in the current conversation. Use read_artifact for exact manifest and evidence.',
  list_delegations:
    'List/paginate delegation offers sent or received by you in joined conversations. Optional group filter. read_delegation retrieves the full contract.',
};
