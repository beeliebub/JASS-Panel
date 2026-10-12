-- The panel's first schema. Forward-only: a later change is a new numbered file, never an edit to this one.
-- Timestamps are ISO 8601 text in UTC. JSON columns are validated by the code on write and again on read.

-- One row per game server. The directory is the operator's: removing a row never deletes it, so the directory is unique
-- and the panel refuses to adopt one that another row already uses.
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  directory TEXT NOT NULL UNIQUE,
  start_command TEXT NOT NULL,
  memory_preset TEXT,
  log_path TEXT NOT NULL DEFAULT 'logs/latest.log',
  autostart INTEGER NOT NULL DEFAULT 0 CHECK (autostart IN (0, 1)),
  update_on_start INTEGER NOT NULL DEFAULT 0 CHECK (update_on_start IN (0, 1)),
  unit_digest TEXT,
  socket_digest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A grant is (user, server or '*', capability). Panel-wide capabilities are stored with '*' and imply nothing on any server.
-- The user id is the website's User.id; the panel never invents identities.
CREATE TABLE grants (
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, server_id, capability)
);
CREATE INDEX grants_by_user ON grants (user_id);

-- Names shown on the access screen. Never consulted when deciding access.
CREATE TABLE known_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  last_seen TEXT NOT NULL
);

-- Scheduled actions. A firing re-checks its creator through the website, so the creator's id is all that is stored about them.
CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'stop', 'restart', 'backup', 'command')),
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  payload TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  creator_id TEXT NOT NULL,
  last_run_at TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL
);

-- Only successful archives are rows; a failed backup is recorded in the audit log instead.
CREATE TABLE backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  creator_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'scheduled'))
);

-- A GitHub release source for a server's plugins. The token is a secret: it is never returned by the API.
CREATE TABLE plugin_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  asset_prefix TEXT NOT NULL,
  plugin_dir TEXT NOT NULL,
  token TEXT
);

-- Panel-wide settings: backup directory and retention, the Discord webhook (a secret), and similar.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Who did what. A row is written in the same transaction as the change it records. Details never contain a secret.
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  user_label TEXT,
  server_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  outcome TEXT NOT NULL
);
CREATE INDEX audit_by_server ON audit (server_id);
