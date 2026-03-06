COMPOSE := docker compose

.PHONY: up down build logs ps frontend-shell backend-shell frontend-install frontend-lint frontend-test frontend-build frontend-check backend-setup backend-compile backend-test backend-check check

up:
	$(COMPOSE) up --build

down:
	$(COMPOSE) down

build:
	$(COMPOSE) build

logs:
	$(COMPOSE) logs -f

ps:
	$(COMPOSE) ps

frontend-shell:
	$(COMPOSE) exec frontend bash

backend-shell:
	$(COMPOSE) exec backend bash

frontend-install:
	cd frontend && bun install

frontend-lint:
	$(COMPOSE) run --rm frontend bun run lint

frontend-test:
	$(COMPOSE) run --rm frontend bun run test

frontend-build:
	$(COMPOSE) run --rm frontend bun run build

frontend-check:
	$(COMPOSE) run --rm frontend bun run lint
	$(COMPOSE) run --rm frontend bun run test
	$(COMPOSE) run --rm frontend bun run build

backend-setup:
	$(COMPOSE) run --rm backend mix deps.get

backend-compile:
	$(COMPOSE) run --rm backend mix compile

backend-test:
	$(COMPOSE) run --rm -e MIX_ENV=test backend mix test

backend-check:
	$(COMPOSE) run --rm -e MIX_ENV=test backend mix compile --warnings-as-errors
	$(COMPOSE) run --rm -e MIX_ENV=test backend mix test

check: frontend-check backend-check
