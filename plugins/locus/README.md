# Cultivagent collector for Locus

This is a read-only collector, not a Locus source patch. It reads Locus'
local `locus.db` `session_events` table and sends completed `usageUpdate`
events to Cultivagent as:

- `source_agent: "locus"`
- `provider: "locus"`
- `source_surface: "session_collector"`

## Install

1. Configure Cultivagent once:

   ```json
   {
     "endpoint": "https://your-server.example.com",
     "token": "<server token>",
     "username": "workstation"
   }
   ```

   Save it as `~/.cultivagent/config.json`, or set
   `CULTIVAGENT_ENDPOINT`, `CULTIVAGENT_TOKEN`, and optional
   `CULTIVAGENT_USERNAME`.

2. Run a dry check from the Cultivagent repo:

   ```bash
   node plugins/locus/session-collector.mjs --dry-run --json
   ```

3. Run one ingest pass:

   ```bash
   node plugins/locus/session-collector.mjs --json
   ```

For a periodic runner, use a shorter lookback window and the default state file
to avoid re-sending old sessions:

```bash
node plugins/locus/session-collector.mjs --lookback-minutes 180 --batch-size 20 --json
```

Use an explicit database when auto-discovery is not enough:

```bash
LOCUS_DB="D:/Apps/Locus/data/locus.db" node plugins/locus/session-collector.mjs --json
```

By default it only sends usage from runs whose `session_runs.status` is
`done`. Add `--include-incomplete` to also backfill running, cancelled, or
errored runs.

## Locus View launcher

A Locus View should only be a launcher/dashboard for a separate runner process:
Start launches a loop that runs this script periodically, Stop kills that runner,
and closing the View only stops the UI refresh timer. The View should not post
usage directly and should not duplicate endpoint/token settings; this collector
already reads the shared Cultivagent config.
