import type { Bot } from '@openbot/shared';
import type { Element, Root, Text } from 'hast';

type MentionBot = Pick<Bot, 'id' | 'name'>;

export function splitMentions(content: string, bots: MentionBot[]) {
  const names = new Map(bots.map((bot) => [bot.name.toLowerCase(), bot.id]));
  const parts: { text: string; botId?: string }[] = [];
  let start = 0;
  // Match complete Bot names without turning email addresses or URL paths into mentions.
  for (const match of content.matchAll(/(?<![\p{L}\p{N}_/@.-])@([\p{L}\p{N}_-]+)/gu)) {
    const botId = names.get(match[1].toLowerCase());
    if (!botId) continue;
    if (match.index > start) parts.push({ text: content.slice(start, match.index) });
    parts.push({ text: match[0], botId });
    start = match.index + match[0].length;
  }
  if (start < content.length) parts.push({ text: content.slice(start) });
  return parts;
}

export function rehypeMentions(bots: MentionBot[]) {
  return (tree: Root) => {
    function visit(parent: Root | Element) {
      for (let index = parent.children.length - 1; index >= 0; index--) {
        const child = parent.children[index];
        if (child.type === 'element') {
          if (!['a', 'code', 'pre'].includes(child.tagName)) visit(child);
        } else if (child.type === 'text') {
          const parts = splitMentions(child.value, bots);
          if (!parts.some((part) => part.botId)) continue;
          const nodes: (Element | Text)[] = parts.map((part) =>
            part.botId
              ? {
                  type: 'element',
                  tagName: 'span',
                  properties: { className: ['chat-mention'], 'data-bot-id': part.botId },
                  children: [{ type: 'text', value: part.text }],
                }
              : { type: 'text', value: part.text },
          );
          parent.children.splice(index, 1, ...nodes);
        }
      }
    }
    visit(tree);
  };
}
