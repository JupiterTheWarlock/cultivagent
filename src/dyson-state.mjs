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
  const startMs = dateMs(options.start);
  const endMs = dateMs(options.end);
  const hasRange = startMs != null || endMs != null;
  const day = options.day || new Date(startMs ?? nowMs).toISOString().slice(0, 10);
  const constants = { ...DYSON_CONSTANTS };
  const agentRows = new Map();
  for (const agent of agents) {
    const key = agentKey(agent);
    if (!agentRows.has(key)) agentRows.set(key, agent);
  }
  const grouped = new Map();
  const dayEvents = events
    .filter((event) => {
      const ms = dateMs(event.occurred_at);
      const inRange = hasRange
        ? ms != null && (startMs == null || ms >= startMs) && (endMs == null || ms <= endMs)
        : event.day === day;
      return inRange && usageTotal(event) > 0 && event.meta?.accounting !== false;
    })
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  for (const event of dayEvents) {
    const key = agentKey(event);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }

  const detailed = options.detail === true;
  const stateAgents = [...grouped.entries()].map(([key, rows]) => buildAgentState(key, rows, agentRows.get(key), nowMs, constants, detailed));
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
    range: {
      start: new Date(startMs ?? Date.parse(`${day}T00:00:00.000Z`)).toISOString(),
      end: new Date(endMs ?? Date.parse(`${day}T23:59:59.999Z`)).toISOString(),
    },
    server_now: new Date(nowMs).toISOString(),
    constants,
    totals,
    agents: stateAgents.sort((a, b) => b.total_clouds - a.total_clouds || a.agent_key.localeCompare(b.agent_key)),
  };
}

function buildAgentState(key, events, agentRow, nowMs, constants, detailed = false) {
  let tokenCursor = 0;
  let batchCursorMs = 0;
  let emittedClouds = 0;
  let settledClouds = 0;
  let pendingClouds = 0;
  let currentBatch = null;
  const activeShots = [];
  const batches = [];
  const nowIso = new Date(nowMs).toISOString();
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
    emittedClouds += batch.emitted_clouds;
    settledClouds += batch.settled_clouds;
    pendingClouds += batch.pending_clouds;
    if (detailed) {
      batches.push(batch);
      if (!currentBatch && batch.started_at <= nowIso && batch.pending_clouds > 0) currentBatch = batch;
      activeShots.push(...batch.active_shots);
      if (activeShots.length > constants.max_active_shots) activeShots.splice(0, activeShots.length - constants.max_active_shots);
    }
    batchCursorMs = startedMs + (cloudCount / constants.emit_rate) * 1000;
  }

  const latest = events.at(-1) || {};
  const out = {
    agent_key: key,
    source_agent: latest.source_agent || agentRow?.source_agent || "unknown",
    host_id: latest.host_id || agentRow?.host_id || "unknown",
    workspace_id: latest.workspace_id || agentRow?.workspace_id || "default",
    session_id: latest.session_id || agentRow?.session_id || "unknown",
    status: agentRow?.summary?.meta?.agent_status || latest.meta?.agent_status || agentRow?.status || latest.status || "idle",
    summary: agentRow?.summary || { username: latest.username, meta: latest.meta || {} },
    total_tokens: tokenCursor,
    total_clouds: Math.floor(tokenCursor / constants.token_per_cloud),
    emitted_clouds: emittedClouds,
    settled_clouds: settledClouds,
    pending_clouds: pendingClouds,
  };
  if (detailed) {
    out.current_batch = currentBatch;
    out.active_shots = activeShots;
    out.batches = batches;
  }
  return out;
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
  return [event.source_agent, event.host_id].join(":");
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
