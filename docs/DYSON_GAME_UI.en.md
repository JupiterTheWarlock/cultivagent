# Dyson Game UI Design

> [English](./DYSON_GAME_UI.en.md) · [中文](./DYSON_GAME_UI.md)

This file records the product and visual requirements for the Cultivagent gamified status panel. It is the implementation and acceptance spec, not a marketplace plugin design.

## Goal

Cultivagent needs a gamified panel to inspect agent status, token consumption, and the hook-driven state machine.

The first scene is a Dyson sphere system:

- The star represents Cultivagent's overall activity today.
- Dyson clouds represent today's token consumption.
- Each agent is a planet orbiting the star.
- Agents fire Dyson clouds toward the cloud ring near the star via surface turrets/factories.
- Hook events drive the agent state machine; the state machine drives planets, factories, turrets, light effects, and UI feedback.

Engineering must be modular and swappable: the Dyson scene can later be replaced by another game scene. This is not a marketplace plugin, nor an external plugin system — it is an internal display-module architecture inside the Cultivagent server.

## Data Model

The data foundation comes from hook / OTel / adapter records. Raw hooks are not directly the product state; they must first be normalized into the canonical loop events and agent status described in [LOOP_EVENTS.md](./LOOP_EVENTS.md).

Tokens come only from completed model requests or official usage surfaces — never fabricated from lifecycle hooks.

Current Dyson conversion:

- `100 tokens = 1 Dyson cloud`
- `10,000,000 tokens = 1 Dyson structure block`
- A 10k-token test request should produce `100` pending clouds.
- The pending pool accumulates per agent.
- The default emit rate is `10 clouds/s` until the current pending pool drains.
- No constant-rate auto-emission when there is no request.

After a page refresh or redeploy, the server-stored token, agent, status, structure, and batch data must not be lost. In-flight particles are not stored individually, but the same launch chain must be rebuildable from the server's batch, timestamp, rate, and entry seed.

## Server-Side Dyson State

The Dyson scene must not invent its own truth. The client only renders what the server provides:

- Today's total tokens, total Dyson clouds, free clouds, structure blocks.
- Per-agent state-machine state, accumulated clouds, pending clouds, current batch.
- Current batch `batch_id`, `started_at`, `cloud_count`, `emitted_clouds`, `emit_rate`, `entry_seed`, `launch_seed`.
- The server's current time `server_now`, which the client uses to rebuild how far the current batch has emitted and the position/trail of in-flight particles.

The minimal implementation prefers computing `GET /api/dyson/state?day=YYYY-MM-DD` from the existing `events` + `agent_state`, without adding a background tick process. Batches are generated from usage events: `event_id + agent_key` determines the batch ID and random seed; a given agent's batches fire in order, and the next batch waits until the previous one finishes emitting at its rate.

Only add a persistent table when you need pause, manual replay, cross-day continuation, or batch-geometry correction — e.g. `dyson_batches(day, agent_key, batch_id, event_id, cloud_count, started_at, emit_rate, entry_seed, launch_seed)`. Do not store particles individually; particles are derived from `batch + index + server_now`.

## Module Boundary

The Dyson UI is an internal game view of the Cultivagent dashboard.

Requirements:

- Reachable from both the Node local service and the Worker deployment, e.g. `/dyson`.
- The Three.js renderer is responsible only for presentation, not for token-accounting truth.
- A data adapter layer turns the server API / hook summary into game state.
- A game renderer maps game state onto the Three.js scene.
- Other game renderers may be added later, but only Dyson is built now.

Non-goals:

- Not integrated into the plugin marketplace.
- Not an agent-callable tool.
- Not MCP.
- No premature complex framework for "many possible future games."

## Scene Layout

The star sits at the center.

The Dyson cloud ring is near the star, analogous to Mercury/Venus orbital range — never as far out as an Oort cloud. The ring's outer radius is the inner boundary of planet orbits: even the closest planet must be outside the cloud ring's outer radius.

Planet requirements:

- One planet per agent.
- Planets orbit the star.
- Planet orbital direction must match the cloud ring's orbital direction.
- Planets must not deviate far from the ecliptic — only a slight tilt is allowed.
- Planets can be spread out to ease mouse preview and selection.

Cloud ring requirements:

- The ring is a single ring-like, diffuse particle cloud.
- It must not become fixed dot-lines or orbit lines.
- A newly-orbiting cloud should pick a target point near and suited to the current particle distribution, so the whole still reads as a cloud.

## Launch Geometry

These are hard acceptance rules.

Turret mounting:

- The turret must be mounted on the planet surface.
- The turret axis must be perpendicular to the planet surface.
- The muzzle direction must be exactly aligned with the launch direction.
- The particle's initial velocity must be parallel to the turret axis.
- Particles must launch from directly in front of the muzzle — never from the side, inside the planet, at the turret base, or from a clipping position.

Batch rules:

- Each batch uses the same target point and launch angle until the pending pool drains.
- The turret direction aligns to the batch's launch angle.
- After the pending pool drains, the next batch picks a new target.

First flight segment:

- The first segment starts directly in front of the muzzle and reaches an orbital-entry point near the cloud-ring ecliptic.
- The first segment must be a straight (or visually straight) particle motion — no twisting.
- The first segment's ecliptic projection must be within `30°` of the cloud ring's tangent-velocity direction at the entry point.
- If the current ring rotates clockwise, the first segment must follow the clockwise tangent direction — no injecting against the flow.

Orbital entry point:

- The entry point is near the cloud-ring ecliptic.
- It sits close to the ring but should clear the ring's outer radius by a small margin before cutting into the cloud.

Second flight segment:

- After reaching the entry point, the particle enters second-stage thrust.
- The second-stage direction's ecliptic projection must also be within `30°` of the ring's tangent-velocity direction there.
- The second-stage thrust must travel in the prograde direction — not straight toward the center, not retrograde.
- If a straight line cannot reach the target, first adopt a common orbital radius, then move along the orbit to the target relatively quickly.

Cloud-entry presentation:

- Each emitted particle is a single particle with a short trail.
- The trail is not a continuously drawn long track line.
- Particles fade in and out.
- When a particle enters the ring, the ring's particle system spawns/reveals a cloud particle at the entry position.
- This reveal lerps, reading as a tangential orbital entry and joining the revolution.

## Dyson Clouds and Structures

Dyson clouds:

- One cloud = 100 tokens.
- Particle counts must tolerate large data.
- The ring's presentation target is millions of particles; as data keeps growing, structure condensation prevents unbounded growth.

Structure blocks:

- One structure block = 10,000,000 tokens.
- Structure blocks condense from Dyson clouds — they are not arbitrary orbit lines.
- The structure visually references the Dyson sphere from *Dyson Sphere Program*.
- Structures form around the star.
- Each structure block must face the star.
- Structure blocks must be adjacent and flush — not scattered.
- The overall topology can be soccer-ball / honeycomb style.
- Each structure's center must be hollow, forming a honeycomb-like cell.
- Thin lines / orbit lines around the star must not masquerade as structure.

## State-Machine Presentation

State comes from the hook-built agent state machine.

Base states follow [LOOP_EVENTS.md](./LOOP_EVENTS.md):

- `idle`
- `receiving_input`
- `loading_context`
- `thinking`
- `streaming`
- `tool_calling`
- `waiting_approval`
- `waiting_user`
- `compacting`
- `delegating`
- `finalizing`
- `done`
- `error`

Visual requirements:

- State must not be shown only via ugly text or a single-color ring.
- The planet surface should have factories, turrets, status lights, pulses, or moving parts.
- `thinking` can read as factory preheating / pulsing.
- `streaming` can read as a steady energy flow.
- `tool_calling` can read as factory highlight or multi-point activity.
- `waiting_approval` / `waiting_user` must convey a clear waiting / blocked feel.
- `error` must be visually distinct from normal high-activity states.

## Interaction

Mouse controls suit a spatial preview:

- Hover the star to show overall info and an agent-status summary.
- Hover a planet to show that agent's name, source agent, model/status, and token/cloud/pending data.
- Left-drag rotates the camera normally.
- Right-drag or a common gesture pans the camera.
- Middle / wheel zooms freely.
- Double-click or an explicit action resets the camera.

The debug panel must be retained:

- Select an agent.
- Enter a token count.
- Trigger one usage request, e.g. 10k tokens.
- Trigger a purely visual launch test.
- Trigger a structure-condensation test.
- Switch the agent state-machine state.
- Show the current test batch, pending cloud count, and emit rate.

## Acceptance Checklist

Launch acceptance:

- After a 10k-token request, the agent produces 100 pending clouds.
- Emit rate is about 10 clouds/s.
- No auto-emission without a request.
- The launch angle is fixed within a batch.
- Particles appear directly in front of the muzzle.
- Particle initial velocity is parallel to the turret axis.
- The first segment does not bend, clip, or appear from the side.
- The ecliptic projections of both segments are within 30° of the ring's tangent velocity.
- The particle's orbital-entry direction matches the ring's revolution direction.

Layout acceptance:

- Planets and the cloud ring revolve in the same direction.
- Planets stay close to the ecliptic.
- The closest planet remains outside the ring's outer radius.
- The Dyson cloud is a diffuse ring, not a fixed line array.

Structure acceptance:

- Structure blocks face the star.
- Structure blocks are adjacent and flush.
- Structure centers are hollow.
- Visually a honeycomb / soccer-ball shell — not scattered pieces or orbit lines.

Persistence acceptance:

- After refresh, historical token / cloud / structure / agent state is restored from the server.
- Refresh must not zero out accumulated data.
