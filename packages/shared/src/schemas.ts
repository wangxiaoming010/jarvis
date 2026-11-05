import { z } from 'zod';
export const nativeRequestSchema = z
  .object({
    kind: z.enum(['question', 'permission', 'command', 'file', 'tool']),
    title: z.string().min(1).max(200),
    reason: z.string().max(4000).optional(),
    command: z.string().max(16000).optional(),
    cwd: z.string().max(4096).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    allowSession: z.boolean().optional(),
    questions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            header: z.string().max(200),
            question: z.string().min(1).max(6000),
            options: z
              .array(
                z
                  .object({ label: z.string().min(1).max(1000), description: z.string().max(4000) })
                  .strict(),
              )
              .max(20)
              .optional(),
            multiSelect: z.boolean().optional(),
            allowOther: z.boolean().optional(),
            isSecret: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.kind === 'question' &&
      (!value.questions?.length ||
        new Set(value.questions.map((q) => q.id)).size !== value.questions.length)
    )
      ctx.addIssue({ code: 'custom', message: '原生问题格式不正确' });
    if (JSON.stringify(value).length > 60000)
      ctx.addIssue({ code: 'custom', message: '原生请求内容过长' });
  });
export const nativeReplySchema = z
  .object({
    decision: z.enum(['accept', 'decline']),
    scope: z.enum(['once', 'session']).optional(),
    answers: z
      .record(
        z.string().min(1).max(200),
        z.array(z.string().trim().min(1).max(12000)).min(1).max(20),
      )
      .optional(),
  })
  .strict();
export const groupSchema = z.object({
  name: z.string().trim().min(1, '请填写群组名称').max(48, '群组名称不能超过 48 个字符'),
  description: z.string().trim().max(240, '群组描述不能超过 240 个字符').default(''),
  botIds: z.array(z.string()).max(32).default([]),
});
export const botAvatarSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('emoji'),
      value: z
        .string()
        .trim()
        .min(1)
        .max(32)
        .refine(
          (value) =>
            Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value))
              .length === 1 &&
            /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\d#*]\uFE0F?\u20E3/u.test(value),
          '请选择或输入一个 emoji',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      value: z
        .string()
        .max(90000, '头像图片过大，请重新上传')
        .refine((value) => {
          const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
          if (!match) return false;
          try {
            const bytes = atob(match[2]);
            if (match[1] === 'jpeg') return bytes.startsWith('\xff\xd8\xff');
            if (match[1] === 'png') return bytes.startsWith('\x89PNG\r\n\x1a\n');
            return bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
          } catch {
            return false;
          }
        }, '请上传 JPG、PNG 或 WebP 图片'),
    })
    .strict(),
]);
export const botAvatarUpdateSchema = z.object({ avatar: botAvatarSchema.nullable() }).strict();
export const botSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '请填写 Bot 名称')
    .max(32, 'Bot 名称不能超过 32 个字符')
    .regex(/^[\p{L}\p{N}_-]{1,32}$/u, '名称仅支持文字、数字、下划线和连字符'),
  description: z.string().trim().max(240, '职责描述不能超过 240 个字符').default(''),
  provider: z.enum(['claude-code', 'codex']),
  avatar: botAvatarSchema.nullable().default(null),
});
export const messageSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string(),
  content: z.string().trim().min(1, '消息不能为空').max(16000, '消息不能超过 16000 个字符'),
  mentions: z.array(z.string()).max(32).default([]),
  replyTo: z.string().nullable().default(null),
});
