-- Remove only the untouched old starter group. User-created groups and history remain intact.
DELETE FROM groups
WHERE id = 'group_general'
  AND name = '开始协作'
  AND NOT EXISTS (SELECT 1 FROM group_bots WHERE group_id = groups.id)
  AND NOT EXISTS (SELECT 1 FROM messages WHERE group_id = groups.id)
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE group_id = groups.id)
  AND NOT EXISTS (SELECT 1 FROM agent_sessions WHERE group_id = groups.id)
  AND NOT EXISTS (SELECT 1 FROM ui_documents WHERE group_id = groups.id)
  AND NOT EXISTS (SELECT 1 FROM dialogue_inbox WHERE group_id = groups.id)
  AND NOT EXISTS (SELECT 1 FROM conversation_memory WHERE group_id = groups.id)
  AND NOT EXISTS (SELECT 1 FROM bot_memory WHERE group_id = groups.id)
  AND NOT EXISTS (SELECT 1 FROM direct_chats WHERE group_id = groups.id);
INSERT OR IGNORE INTO schema_migrations(version) VALUES(11);
