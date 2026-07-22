-- 0002: daily_usage 补 provider / error_count 列（纳入主键）+ 从 events 回填；events 加 occurred_at 索引
-- 背景：usage 聚合端点此前对 events 做 SELECT * LIMIT 20000 再在 Worker 里 JSON.parse + reduce，
-- 导致单请求拉回近 2/3 张表，触发 Cloudflare Worker 1102（exceeded resource limits）。
-- 改造后聚合查询走 daily_usage（行数从 3 万级降到百级），provider 维度按需归并。

-- 1. events: 加 occurred_at 单列索引（usage/logs 的时间过滤此前走全表扫描）
CREATE INDEX IF NOT EXISTS events_occurred_at_idx ON events(occurred_at);

-- 2. daily_usage: 重建表，补 provider（纳入主键）与 error_count（供 success_rate）
CREATE TABLE IF NOT EXISTS daily_usage_v2 (
  day TEXT NOT NULL,
  source_agent TEXT NOT NULL,
  host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'unknown',
  input_tokens REAL NOT NULL DEFAULT 0,
  output_tokens REAL NOT NULL DEFAULT 0,
  cache_read_tokens REAL NOT NULL DEFAULT 0,
  cache_write_tokens REAL NOT NULL DEFAULT 0,
  total_tokens REAL NOT NULL DEFAULT 0,
  cost_usd REAL,
  error_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, source_agent, host_id, workspace_id, model, provider)
);

-- 3. 从 events 回填（仅含 usage 事件，与 isUsageEvent 逻辑一致：accounting !== false 且任一 token > 0）
INSERT INTO daily_usage_v2 (
  day, source_agent, host_id, workspace_id, model, provider,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, cost_usd, error_count, event_count
)
SELECT
  day, source_agent, host_id, workspace_id, model,
  COALESCE(NULLIF(provider, ''), 'unknown'),
  SUM(COALESCE(CAST(json_extract(usage_json, '$.input_tokens') AS REAL), 0)),
  SUM(COALESCE(CAST(json_extract(usage_json, '$.output_tokens') AS REAL), 0)),
  SUM(COALESCE(CAST(json_extract(usage_json, '$.cache_read_tokens') AS REAL), 0)),
  SUM(COALESCE(CAST(json_extract(usage_json, '$.cache_write_tokens') AS REAL), 0)),
  SUM(COALESCE(CAST(json_extract(usage_json, '$.total_tokens') AS REAL), 0)),
  SUM(COALESCE(CAST(json_extract(usage_json, '$.cost_usd') AS REAL), 0)),
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
  COUNT(*)
FROM events
WHERE (json_extract(meta_json, '$.accounting') IS NULL OR json_extract(meta_json, '$.accounting') != 0)
  AND (
    COALESCE(CAST(json_extract(usage_json, '$.input_tokens') AS REAL), 0) +
    COALESCE(CAST(json_extract(usage_json, '$.output_tokens') AS REAL), 0) +
    COALESCE(CAST(json_extract(usage_json, '$.cache_read_tokens') AS REAL), 0) +
    COALESCE(CAST(json_extract(usage_json, '$.cache_write_tokens') AS REAL), 0) +
    COALESCE(CAST(json_extract(usage_json, '$.total_tokens') AS REAL), 0)
  ) > 0
GROUP BY day, source_agent, host_id, workspace_id, model, provider;

DROP TABLE daily_usage;
ALTER TABLE daily_usage_v2 RENAME TO daily_usage;
