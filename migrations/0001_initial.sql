CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  source_agent TEXT NOT NULL,
  source_surface TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  day TEXT NOT NULL,
  username TEXT NOT NULL,
  host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms REAL,
  usage_json TEXT NOT NULL,
  meta_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_day_idx ON events(day);
CREATE INDEX IF NOT EXISTS events_agent_idx ON events(source_agent, occurred_at);
CREATE INDEX IF NOT EXISTS events_username_idx ON events(username, occurred_at);

CREATE TABLE IF NOT EXISTS daily_usage (
  day TEXT NOT NULL,
  source_agent TEXT NOT NULL,
  host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens REAL NOT NULL DEFAULT 0,
  output_tokens REAL NOT NULL DEFAULT 0,
  cache_read_tokens REAL NOT NULL DEFAULT 0,
  cache_write_tokens REAL NOT NULL DEFAULT 0,
  total_tokens REAL NOT NULL DEFAULT 0,
  cost_usd REAL,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, source_agent, host_id, workspace_id, model)
);

CREATE TABLE IF NOT EXISTS agent_state (
  agent_key TEXT PRIMARY KEY,
  source_agent TEXT NOT NULL,
  host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
