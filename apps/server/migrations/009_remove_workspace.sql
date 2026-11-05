ALTER TABLE groups DROP COLUMN workspace_id;
ALTER TABLE bots DROP COLUMN workspace_id;
DROP TABLE workspace;
INSERT INTO schema_migrations(version) VALUES(9);
