# Poker Platform

A real-time poker platform with a Go backend, React frontend, and CFR-trained bot personalities. The project combines table state, live play, and training tooling in one repo.

## Repo layout

- `frontend/`: React + Vite client
- `backend/`: Go realtime backend (mimicking Phoenix Socket protocol)
- `training/`: OpenSpiel-based bot training scripts

## Highlights

- Realtime table play over WebSockets
- Multiple bot styles derived from CFR training output
- Docker-first local development flow
- PostgreSQL for user persistence
- GORM for database management

## Quick start

```bash
make up
```

Local development:

```bash
cd frontend && bun install && bun run dev
cd backend && go mod download && go run cmd/server/main.go
```

Retrain bots:

```bash
make training-retrain
make training-retrain-holdem
```

## Backend Checks

To format, lint, and test the backend:

```bash
make backend-check
```

Requires `golangci-lint` to be installed for linting.

## Stress testing

The repo now includes a k6-based multiplayer stress harness under `load/` that simulates one websocket-connected human per VU. Each table captain clears the table, fills the remaining seats with backend bots, and keeps hands cycling so you can measure mixed human-plus-bot load.

Quick start:

```bash
make stress-stack-up
make stress-low
make stress-thousands
```

Artifacts land in `tmp/stress-runs/` with a `metadata.json` and k6 `summary.json` for each run. Override the default layout with environment variables such as `BASE_URL`, `HUMANS_PER_TABLE`, and `SESSION_SECONDS`.

More detail: `load/README.md`
