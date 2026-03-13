# Code Audit Implementation Plan

This document tracks the progress of improvements based on the deep code audit.

## 🛡️ 1. Security & Authentication
- [x] Replace plaintext email cookie (`_poker_key`) with a secure JWT or session-backed system.
- [x] Implement `HttpOnly`, `Secure`, and `SameSite` flags for all cookies.
- [x] Add token validation middleware for protected routes.

## 🏗️ 2. Architectural Refactoring
- [x] Decouple `backend/internal/game/table.go` (The "God Object").
    - [x] Extract `BettingEngine` (wagers, side pots, all-ins).
    - [x] Extract `BotEngine` (decision-making logic).
    - [x] Extract `StateManager` (table states, transitions, timers).
    - [x] Better integrate `HandEvaluator`.

## 🤖 3. Bot Logic & Maintainability
- [x] Externalize bot profiles and CFR tables from source code to JSON/YAML or Database.
- [x] Implement dynamic loading of bot strategies.

## ⚡ 4. Concurrency & Performance
- [x] Audit `autoTimer` locking sequence to prevent potential race conditions.
- [x] Optimize WebSocket `broadcast`: Pre-encode state once to avoid redundant JSON marshaling.

## 🧪 5. Testing & Validation
- [x] Add unit tests for complex betting edge cases (multiple all-ins, side pot splits).
- [ ] Execute and validate load tests from `load/scripts/poker_stress.js`.
- [x] Ensure CI/CD pipeline (`.github/workflows/ci.yml`) passes all new tests.
