# Poker Backend

Phoenix backend for the online poker service.

## Endpoints

- `GET /api/health`
- `GET /api/tables/:table_id`
- Phoenix channel socket: `/socket`
- Topic: `table:<table_id>`

## Run

```bash
mix deps.get
mix phx.server
```
