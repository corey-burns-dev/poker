# Poker Platform

This repo is split into:

- `frontend/`: React + Vite client for the poker UI
- `backend/`: Elixir service that will host table state and realtime game traffic

## Run the stack

```bash
make up
```

Services:

- Frontend: http://localhost:3000
- Backend health: http://localhost:4000/api/health
- Backend table API: http://localhost:4000/api/tables/default
- Backend Phoenix socket: ws://localhost:4000/socket/websocket

## Other commands

```bash
make build
make down
make logs
make ps
```

## Local frontend without Docker

```bash
cd frontend
bun install
bun run dev
```
