export const DYSON_CONSTANTS = {
  token_per_cloud: 100,
  structure_token_cost: 10_000_000,
  emit_rate: 10,
  shot_duration_seconds: 9.6, // 单段 180° 仿抛物线总时长
  max_batch_shots: 100, // 大批 usage 用加权粒子表达，单批视觉发射最长 10 秒
  batch_window_seconds: 10,
  max_active_shots: 200,
  agent_active_timeout_seconds: 300,
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
  const contributions = [];
  for (const event of events) {
    const beforeClouds = Math.floor(tokenCursor / constants.token_per_cloud);
    tokenCursor += usageTotal(event);
    const cloudCount = Math.floor(tokenCursor / constants.token_per_cloud) - beforeClouds;
    if (cloudCount <= 0) continue;
    contributions.push({ event, cloudCount, eventMs: dateMs(event.occurred_at) ?? nowMs });
  }

  const groups = [];
  const windowMs = constants.batch_window_seconds * 1000;
  for (const contribution of contributions) {
    const group = groups.at(-1);
    if (group && contribution.eventMs < group.windowEndMs) {
      group.cloudCount += contribution.cloudCount;
      continue;
    }
    groups.push({
      event: contribution.event,
      cloudCount: contribution.cloudCount,
      eventMs: contribution.eventMs,
      windowEndMs: contribution.eventMs + windowMs,
    });
  }

  for (const group of groups) {
    const startedMs = Math.max(group.eventMs, batchCursorMs || group.eventMs);
    const batchId = `${group.event.event_id}:${key}`;
    const batch = batchState({
      batch_id: batchId,
      event_id: group.event.event_id,
      agent_key: key,
      source_agent: group.event.source_agent,
      started_ms: startedMs,
      cloud_count: group.cloudCount,
      shot_count: Math.min(group.cloudCount, constants.max_batch_shots),
      emit_rate: constants.emit_rate,
      entry_seed: hash32(`${batchId}:entry`),
      launch_seed: hash32(`${batchId}:launch`),
    }, nowMs, constants);
    emittedClouds += batch.emitted_clouds;
    settledClouds += batch.settled_clouds;
    pendingClouds += batch.pending_clouds;
    if (launchPhasePriority(batch.phase) > launchPhasePriority(currentBatch?.phase)) currentBatch = batch;
    if (detailed) {
      batches.push(batch);
      activeShots.push(...batch.active_shots);
      if (activeShots.length > constants.max_active_shots) activeShots.splice(0, activeShots.length - constants.max_active_shots);
    }
    batchCursorMs = startedMs + (batch.shot_count / constants.emit_rate) * 1000;
  }

  const latest = events.at(-1) || {};
  const out = {
    agent_key: key,
    source_agent: latest.source_agent || agentRow?.source_agent || "unknown",
    host_id: latest.host_id || agentRow?.host_id || "unknown",
    workspace_id: latest.workspace_id || agentRow?.workspace_id || "default",
    session_id: latest.session_id || agentRow?.session_id || "unknown",
    status: effectiveAgentStatus(agentRow, latest, nowMs, constants.agent_active_timeout_seconds * 1000),
    summary: agentRow?.summary || { username: latest.username, meta: latest.meta || {} },
    total_tokens: tokenCursor,
    total_clouds: Math.floor(tokenCursor / constants.token_per_cloud),
    emitted_clouds: emittedClouds,
    settled_clouds: settledClouds,
    pending_clouds: pendingClouds,
    launch_state: currentBatch?.phase || "settled",
  };
  if (detailed) {
    out.current_batch = currentBatch;
    out.active_shots = activeShots;
    out.batches = batches;
  }
  return out;
}

function effectiveAgentStatus(agentRow, latest, nowMs, timeoutMs) {
  const rowMs = dateMs(agentRow?.last_event_at) ?? -Infinity;
  const eventMs = dateMs(latest?.occurred_at) ?? -Infinity;
  const fromRow = agentRow?.summary?.meta?.agent_status || agentRow?.status;
  const fromEvent = latest?.meta?.agent_status || latest?.status;
  const status = (rowMs >= eventMs ? fromRow : fromEvent) || "idle";
  if (["idle", "done", "error"].includes(status)) return status;
  return nowMs - Math.max(rowMs, eventMs) > timeoutMs ? "idle" : status;
}

function launchPhasePriority(phase) {
  return { settled: 0, queued: 1, coasting: 2, emitting: 3 }[phase] ?? 0;
}

function batchState(batch, nowMs, constants) {
  const flightMs = constants.shot_duration_seconds * 1000;
  const startedMs = batch.started_ms;
  const shotCount = batch.shot_count;
  const emittedShots = timedCount(nowMs - startedMs, batch.emit_rate, shotCount);
  const settledShots = Math.min(emittedShots, timedCount(nowMs - startedMs - flightMs, batch.emit_rate, shotCount));
  const emittedClouds = cloudsThroughShot(emittedShots, batch.cloud_count, shotCount);
  const settledClouds = cloudsThroughShot(settledShots, batch.cloud_count, shotCount);
  const activeShots = [];
  for (let index = settledShots; index < emittedShots; index += 1) {
    const emittedMs = startedMs + (index / batch.emit_rate) * 1000;
    const ageMs = nowMs - emittedMs;
    const cloudStart = cloudsThroughShot(index, batch.cloud_count, shotCount);
    const cloudEnd = cloudsThroughShot(index + 1, batch.cloud_count, shotCount);
    activeShots.push({
      batch_id: batch.batch_id,
      cloud_index: cloudStart,
      cloud_value: cloudEnd - cloudStart,
      shot_index: index,
      emitted_at: new Date(emittedMs).toISOString(),
      phase: "shot",
      progress: round(clamp(ageMs / (constants.shot_duration_seconds * 1000), 0, 1)),
    });
  }
  const phase = nowMs < startedMs
    ? "queued"
    : emittedShots < shotCount
      ? "emitting"
      : activeShots.length
        ? "coasting"
        : "settled";
  return {
    batch_id: batch.batch_id,
    event_id: batch.event_id,
    agent_key: batch.agent_key,
    source_agent: batch.source_agent,
    started_at: new Date(startedMs).toISOString(),
    finished_at: new Date(startedMs + (shotCount / batch.emit_rate) * 1000).toISOString(),
    cloud_count: batch.cloud_count,
    shot_count: shotCount,
    emitted_shots: emittedShots,
    settled_shots: settledShots,
    emitted_clouds: emittedClouds,
    settled_clouds: settledClouds,
    pending_clouds: batch.cloud_count - emittedClouds,
    emit_rate: batch.emit_rate,
    entry_seed: batch.entry_seed,
    launch_seed: batch.launch_seed,
    phase,
    active_shots: activeShots,
  };
}

function timedCount(elapsedMs, rate, count) {
  if (elapsedMs < 0) return 0;
  return clamp(Math.floor((elapsedMs / 1000) * rate) + 1, 0, count);
}

function cloudsThroughShot(shots, clouds, shotCount) {
  return Math.floor((shots * clouds) / shotCount);
}

function agentKey(event) {
  return [event.source_agent, event.host_id].join(":");
}

function usageTotal(event) {
  const u = event.usage || {};
  const components = Number(u.input_tokens || 0) + Number(u.output_tokens || 0) + Number(u.cache_read_tokens || 0) + Number(u.cache_write_tokens || 0);
  return components || Number(u.total_tokens || 0);
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
