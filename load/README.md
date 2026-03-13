# Poker Stress Harness

This directory holds the k6 setup for driving large numbers of simulated poker players through the WebSocket channel and table action API.

## Model

- One k6 VU represents one simulated human player.
- Players are grouped into tables using `HUMANS_PER_TABLE` seats per table.
- The first player on each table becomes the captain:
  - clears the table,
  - fills the remaining seats with backend bots,
  - starts the next hand whenever the table is idle.
- Every player keeps a websocket open to `/socket/websocket?vsn=2.0.0` and submits actions only when their seat is acting.

With the default `HUMANS_PER_TABLE=2`, each table runs `2` simulated humans plus `6` backend bots.

## Commands

```bash
make stress-stack-up
make stress-low
make stress-medium
make stress-high
make stress-extreme
make stress-insane
make stress-thousands
make stress-stack-down
```

If `k6` is not installed locally, the `Makefile` falls back to `grafana/k6:0.49.0` in Docker.

## Profiles

- `low`: 24 concurrent humans
- `medium`: 96 concurrent humans
- `high`: 320 concurrent humans
- `extreme`: 640 concurrent humans
- `insane`: 1200 concurrent humans
- `stress-thousands`: alias for `stress-insane`

The default session length is `180` seconds. The lower-load profiles use a longer final ramp-down stage so users who join near the end of ramp-up still have enough wall-clock time to finish one full session instead of being force-interrupted at scenario shutdown.

## Environment knobs

Override these per run:

```bash
BASE_URL=http://127.0.0.1:4000 \
HUMANS_PER_TABLE=4 \
SESSION_SECONDS=240 \
RUN_SEED=resume-demo \
TABLE_PREFIX=resume \
make stress-high
```

- `BASE_URL`: backend root URL used for HTTP bootstrap and websocket derivation
- `HUMANS_PER_TABLE`: number of k6-controlled seats per table
- `SESSION_SECONDS`: how long each VU keeps its socket open
- `RUN_SEED`: stable suffix for table and player IDs
- `TABLE_PREFIX`: table name prefix

## Artifacts

Each run writes to `tmp/stress-runs/<timestamp>-<profile>/`:

- `metadata.json`: profile plus runtime settings
- `summary.json`: native k6 summary export
