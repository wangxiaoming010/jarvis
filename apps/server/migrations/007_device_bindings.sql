DROP TABLE IF EXISTS bot_bindings;
ALTER TABLE task_specs DROP COLUMN working_directory;
INSERT OR IGNORE INTO schema_migrations(version) VALUES(7);
