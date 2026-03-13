COMPOSE := docker compose
K6_DOCKER_IMAGE ?= grafana/k6:0.49.0
ARTIFACT_DIR ?= tmp/stress-runs
BASE_URL ?= http://127.0.0.1:4000
HUMANS_PER_TABLE ?= 2
SESSION_SECONDS ?= 180

.PHONY: up down build logs ps deploy deploy-down frontend-shell backend-shell frontend-install frontend-lint frontend-test frontend-build frontend-check backend-setup backend-compile backend-test backend-check check training-venv training-train training-train-leduc training-train-leduc-50k training-aggregate training-retrain training-train-holdem training-aggregate-holdem training-retrain-holdem stress-stack-up stress-stack-down stress-low stress-medium stress-high stress-extreme stress-insane stress-thousands

up:
	$(COMPOSE) up --build

down:
	$(COMPOSE) down

deploy:
	$(COMPOSE) -f docker-compose.deploy.yml up --build -d
	$(MAKE) create-db
	$(MAKE) migrate

create-db:
	$(COMPOSE) -f docker-compose.deploy.yml exec backend /app/bin/poker_backend eval "PokerBackend.Release.create_db"

migrate:
	$(COMPOSE) -f docker-compose.deploy.yml exec backend /app/bin/poker_backend eval "PokerBackend.Release.migrate"

deploy-down:
	$(COMPOSE) -f docker-compose.deploy.yml down

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

# OpenSpiel training (run from repo root; requires Python 3 and training/.venv)
training-venv:
	cd training && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

training-train:
	cd training && .venv/bin/python train_cfr.py

training-train-leduc:
	cd training && .venv/bin/python train_cfr.py --game leduc_poker --iterations 10000 -o policies/leduc.json

training-train-leduc-50k:
	cd training && .venv/bin/python train_cfr.py --game leduc_poker --iterations 50000 --exploitability-every 5000 -o policies/leduc.json

training-aggregate:
	cd training && .venv/bin/python aggregate_cfr.py

training-train-holdem:
	cd training && .venv/bin/python train_cfr.py --game holdem --iterations 10000 --exploitability-every 2000 -o policies/holdem.json

training-aggregate-holdem:
	cd training && .venv/bin/python aggregate_cfr.py --policy policies/holdem.json --output policies/cfr_table_holdem.json

# Full retrain + re-aggregate pipeline (run after changing iterations or game)
training-retrain: training-train-leduc-50k training-aggregate

training-retrain-holdem: training-train-holdem training-aggregate-holdem

check: frontend-check backend-check

stress-stack-up:
	PHX_CODE_RELOADER=false \
	PHX_DEBUG_ERRORS=false \
	PHX_LIVE_RELOAD=false \
	PHX_DEV_ROUTES=false \
	PHX_EXPENSIVE_RUNTIME_CHECKS=false \
	TABLE_ACTION_RATE_LIMIT_DISABLED=true \
	$(COMPOSE) up -d db backend
	@echo "Waiting for poker backend health on $(BASE_URL)/api/health..."
	@ATTEMPTS=0; \
	until curl -fsS "$(BASE_URL)/api/health" >/dev/null 2>&1; do \
		ATTEMPTS=$$((ATTEMPTS + 1)); \
		if [ $$ATTEMPTS -ge 60 ]; then \
			echo "Backend did not become healthy after 60 attempts."; \
			$(COMPOSE) logs backend; \
			exit 1; \
		fi; \
		sleep 2; \
	done
	@echo "Poker stress stack is ready."

stress-stack-down:
	$(COMPOSE) stop backend db

define run_stress_profile
	@echo "Running poker stress profile: $(1)"
	@mkdir -p "$(ARTIFACT_DIR)"
	@set -e; RUN_TS=$$(date -u +%Y%m%dT%H%M%SZ); \
	RUN_DIR="$(ARTIFACT_DIR)/$${RUN_TS}-$(1)"; \
	START_EPOCH=$$(date -u +%s); \
	mkdir -p "$$RUN_DIR"; \
	printf '{\n  "profile": "$(1)",\n  "base_url": "%s",\n  "humans_per_table": %s,\n  "session_seconds": %s,\n  "start_epoch": %s,\n  "start_utc": "%s"\n}\n' "$${BASE_URL:-$(BASE_URL)}" "$${HUMANS_PER_TABLE:-$(HUMANS_PER_TABLE)}" "$${SESSION_SECONDS:-$(SESSION_SECONDS)}" "$$START_EPOCH" "$$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$$RUN_DIR/metadata.json"; \
	if command -v k6 >/dev/null 2>&1; then \
		BASE_URL=$${BASE_URL:-$(BASE_URL)} HUMANS_PER_TABLE=$${HUMANS_PER_TABLE:-$(HUMANS_PER_TABLE)} SESSION_SECONDS=$${SESSION_SECONDS:-$(SESSION_SECONDS)} k6 run --config load/profiles/$(1).json --summary-export "$$RUN_DIR/summary.json" load/scripts/poker_stress.js; \
	else \
		echo "k6 not found locally; using Docker image $(K6_DOCKER_IMAGE)"; \
		docker run --rm -i --network host --user $$(id -u):$$(id -g) -v "$(shell pwd):/work" -w /work -e BASE_URL=$${BASE_URL:-$(BASE_URL)} -e HUMANS_PER_TABLE=$${HUMANS_PER_TABLE:-$(HUMANS_PER_TABLE)} -e SESSION_SECONDS=$${SESSION_SECONDS:-$(SESSION_SECONDS)} "$(K6_DOCKER_IMAGE)" run --config load/profiles/$(1).json --summary-export "$$RUN_DIR/summary.json" load/scripts/poker_stress.js; \
	fi; \
	END_EPOCH=$$(date -u +%s); \
	python3 -c "import json,sys,time; p=sys.argv[1]; e=int(sys.argv[2]); d=json.load(open(p, encoding='utf-8')); d['end_epoch']=e; d['end_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(e)); json.dump(d, open(p, 'w', encoding='utf-8'), indent=2)" "$$RUN_DIR/metadata.json" "$$END_EPOCH"; \
	echo "Stress profile $(1) complete: $$RUN_DIR"
endef

stress-low:
	$(call run_stress_profile,low)

stress-medium:
	$(call run_stress_profile,medium)

stress-high:
	$(call run_stress_profile,high)

stress-extreme:
	$(call run_stress_profile,extreme)

stress-insane:
	$(call run_stress_profile,insane)

stress-thousands: stress-insane
