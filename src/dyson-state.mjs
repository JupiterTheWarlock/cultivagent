export const DYSON_CONSTANTS = {
  token_per_cloud: 100,
  structure_token_cost: 10_000_000,
  emit_rate: 10,
  shot_duration_seconds: 8.4,
  injection_duration_seconds: 1.2,
  max_active_shots: 200,
};

export function buildDysonState(events, agents = [], options = {}) {
  const nowMs = dateMs(options.now) ?? Date.now();
  const day = options.day || new Date(nowMs).toISOString().slice(0, 10);
  const constants = { ...DYSON_CONSTANTS };
  const agentRows = new Map(agents.map((agent) => [agent.agent_key, agent]));
  const grouped = new Map();
  const dayEvents = events
    .filter((event) => event.day === day && usageTotal(event) > 0 && event.meta?.accounting !== false)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  for (const event of dayEvents) {
    const key = agentKey(event);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  for (const agent of agents) {
    if (String(agent.last_event_at || "").slice(0, 10) !== day) continue;
    if (!grouped.has(agent.agent_key)) grouped.set(agent.agent_key, []);
  }

  const stateAgents = [...grouped.entries()].map(([key, rows]) => buildAgentState(key, rows, agentRows.get(key), nowMs, constants));
  const totals = stateAgents.reduce((sum, agent) => {
    sum.tokens += agent.total_tokens;
    sum.clouds += agent.total_clouds;
    sum.emitted_clouds += agent.emitted_clouds;
    sum.settled_clouds += agent.settled_clouds;
    sum.pending_clouds += agent.pending_clouds;
    return sum;
  }, { tokens: 0, clouds: 0, emitted_clouds: 0, settled_clouds: 0, pending_clouds: 0 });
  totals.structure_blocks = Math.floor(totals.clouds / (constants.structure_token_cost / constants.token_per_cloud));
  totals.free_clouds = Math.max(0, totals.clouds - totals.structure_blocks * (constants.structure_token_cost / constants.token_per_cloud));

  return {
    day,
    server_now: new Date(nowMs).toISOString(),
    constants,
    totals,
    agents: stateAgents.sort((a, b) => b.total_clouds - a.total_clouds || a.agent_key.localeCompare(b.agent_key)),
  };
}

function buildAgentState(key, events, agentRow, nowMs, constants) {
  let tokenCursor = 0;
  let batchCursorMs = 0;
  const batches = [];
  for (const event of events) {
    const beforeClouds = Math.floor(tokenCursor / constants.token_per_cloud);
    tokenCursor += usageTotal(event);
    const cloudCount = Math.floor(tokenCursor / constants.token_per_cloud) - beforeClouds;
    if (cloudCount <= 0) continue;

    const eventMs = dateMs(event.occurred_at) ?? nowMs;
    const startedMs = Math.max(eventMs, batchCursorMs || eventMs);
    const batchId = `${event.event_id}:${key}`;
    const batch = batchState({
      batch_id: batchId,
      event_id: event.event_id,
      agent_key: key,
      source_agent: event.source_agent,
      started_ms: startedMs,
      cloud_count: cloudCount,
      emit_rate: constants.emit_rate,
      entry_seed: hash32(`${batchId}:entry`),
      launch_seed: hash32(`${batchId}:launch`),
    }, nowMs, constants);
    batches.push(batch);
    batchCursorMs = startedMs + (cloudCount / constants.emit_rate) * 1000;
  }

  const latest = events.at(-1) || {};
  const activeShots = batches.flatMap((batch) => batch.active_shots).slice(-constants.max_active_shots);
  const currentBatch = batches.find((batch) => batch.started_at <= new Date(nowMs).toISOString() && batch.pending_clouds > 0) || null;
  return {
    agent_key: key,
    source_agent: latest.source_agent || agentRow?.source_agent || "unknown",
    host_id: latest.host_id || agentRow?.host_id || "unknown",
    workspace_id: latest.workspace_id || agentRow?.workspace_id || "default",
    session_id: latest.session_id || agentRow?.session_id || "unknown",
    status: agentRow?.summary?.meta?.agent_status || latest.meta?.agent_status || agentRow?.status || latest.status || "idle",
    summary: agentRow?.summary || { username: latest.username, meta: latest.meta || {} },
    total_tokens: tokenCursor,
    total_clouds: Math.floor(tokenCursor / constants.token_per_cloud),
    emitted_clouds: batches.reduce((sum, batch) => sum + batch.emitted_clouds, 0),
    settled_clouds: batches.reduce((sum, batch) => sum + batch.settled_clouds, 0),
    pending_clouds: batches.reduce((sum, batch) => sum + batch.pending_clouds, 0),
    current_batch: currentBatch,
    active_shots: activeShots,
    batches,
  };
}

function batchState(batch, nowMs, constants) {
  const flightMs = constants.shot_duration_seconds * 1000;
  const startedMs = batch.started_ms;
  const emittedClouds = clamp(Math.floor(((nowMs - startedMs) / 1000) * batch.emit_rate), 0, batch.cloud_count);
  const settledClouds = clamp(Math.floor(((nowMs - startedMs - flightMs) / 1000) * batch.emit_rate) + 1, 0, emittedClouds);
  const activeShots = [];
  for (let index = settledClouds; index < emittedClouds; index += 1) {
    const emittedMs = startedMs + (index / batch.emit_rate) * 1000;
    const ageMs = nowMs - emittedMs;
    activeShots.push({
      batch_id: batch.batch_id,
      cloud_index: index,
      emitted_at: new Date(emittedMs).toISOString(),
      phase: "shot",
      progress: round(clamp(ageMs / (constants.shot_duration_seconds * 1000), 0, 1)),
    });
  }
  return {
    batch_id: batch.batch_id,
    event_id: batch.event_id,
    agent_key: batch.agent_key,
    source_agent: batch.source_agent,
    started_at: new Date(startedMs).toISOString(),
    finished_at: new Date(startedMs + (batch.cloud_count / batch.emit_rate) * 1000).toISOString(),
    cloud_count: batch.cloud_count,
    emitted_clouds: emittedClouds,
    settled_clouds: settledClouds,
    pending_clouds: batch.cloud_count - emittedClouds,
    emit_rate: batch.emit_rate,
    entry_seed: batch.entry_seed,
    launch_seed: batch.launch_seed,
    active_shots: activeShots,
  };
}

function agentKey(event) {
  return [event.source_agent, event.host_id, event.workspace_id, event.session_id, event.agent_id || ""].join(":");
}

function usageTotal(event) {
  const u = event.usage || {};
  return Number(u.input_tokens || 0) + Number(u.output_tokens || 0) + Number(u.cache_read_tokens || 0) + Number(u.cache_write_tokens || 0);
}

function dateMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function hash32(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
