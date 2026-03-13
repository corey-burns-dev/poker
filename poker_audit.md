# Poker Codebase — Full Security & Quality Audit
> Go/Gin Backend + React/Vite Frontend · March 2026

## Executive Summary

| CRITICAL | HIGH | MEDIUM | LOW | Top Priority |
|:---:|:---:|:---:|:---:|:---|
| 6 | 5 | 6 | 3 | Hole card exposure + WS identity spoofing must be fixed before any public access |

---

## Backend — Security

### [CRITICAL] [FIXED] WS identity spoofing — unauthenticated clients
**File:** `ws/hub.go:148–154`

When no valid JWT cookie is present, `playerID` is empty. The server then accepts the `player_id` field from the client's `join` payload and permanently adopts it for that connection. Any anonymous WebSocket client can claim to be user `5` (or any numeric ID) and join their seat, act at the table, and play hands as that user.

```go
// hub.go:148-154 — VULNERABLE
if c.playerID == "" {
    if id, ok := pMap["player_id"].(string); ok {
        c.playerID = id  // attacker-controlled
    }
}
```

**Fix:** Reject the WebSocket upgrade immediately when no valid cookie is present. Remove the payload fallback entirely.

```go
cookie, err := r.Cookie("_poker_key")
if err != nil {
    http.Error(w, "Unauthorized", http.StatusUnauthorized)
    return
}
claims, err := auth.ValidateToken(cookie.Value)
if err != nil {
    http.Error(w, "Unauthorized", http.StatusUnauthorized)
    return
}
playerID = fmt.Sprintf("%d", claims.UserID)
// Only upgrade after identity is confirmed
conn, err := upgrader.Upgrade(w, r, nil)
```

---

### [CRITICAL] [FIXED] Authenticated users can act as other players
**File:** `ws/hub.go:182–184`, `game/betting_engine.go:35–41`

`handleAction` only injects `c.playerID` into the payload when `player_id` is **absent**. An authenticated attacker sends `{"action":"fold","player_id":"VICTIM_ID"}` — the betting engine then validates `player_id` against the acting seat, and if the victim happens to be acting, the fold is accepted.

```go
// VULNERABLE — only sets player_id if not already present
if _, exists := pMap["player_id"]; !exists && c.playerID != "" {
    pMap["player_id"] = c.playerID
}
```

**Fix:** Always overwrite with the session identity. Never trust client-supplied `player_id`.

```go
// Always overwrite, unconditionally
if c.playerID != "" {
    pMap["player_id"] = c.playerID
}
```

---

### [CRITICAL] [FIXED] All players' hole cards broadcast to every subscriber
**File:** `game/table.go:41`, `ws/hub.go`, `api/handlers.go:50,78`

`GetState()` returns the raw `TableState` including real `HoleCards` for every player. The only masking is client-side in `PokerGameClient.ts:250–256`. Any API client or raw WebSocket consumer bypasses this trivially and sees all opponents' cards.

**Fix:** Create a per-viewer state projection on the backend before transmission.

```go
func (t *Table) GetStateFor(viewerID string) models.TableState {
    t.mu.RLock()
    defer t.mu.RUnlock()
    s := t.state // copy
    for i, p := range s.Players {
        if p.PlayerID == nil || *p.PlayerID != viewerID {
            if !p.ShowCards {
                s.Players[i].HoleCards = []string{"", ""}
            }
        }
    }
    return s
}
```

Use `GetStateFor(c.playerID)` in `listenToTable` and `handleJoin` instead of `GetState()`.

---

### [CRITICAL] [FIXED] No input validation on registration — bcrypt DoS
**File:** `api/handlers.go:88–115`

Empty email, empty username, and passwords longer than 72 bytes are all accepted without error. bcrypt silently truncates passwords beyond 72 bytes (silent data corruption). A 10 MB password body triggers expensive bcrypt work before any validation occurs — trivial CPU DoS.

**Fix:**

```go
func RegisterUser(c *gin.Context) {
    // ... bind JSON ...
    if strings.TrimSpace(req.User.Email) == "" {
        c.JSON(http.StatusBadRequest, gin.H{"error": "email required"}); return
    }
    if len(req.User.Username) < 3 || len(req.User.Username) > 30 {
        c.JSON(http.StatusBadRequest, gin.H{"error": "username must be 3–30 chars"}); return
    }
    if len(req.User.Password) == 0 || len(req.User.Password) > 72 {
        c.JSON(http.StatusBadRequest, gin.H{"error": "password must be 1–72 chars"}); return
    }
    // then bcrypt
}
```

---

### [HIGH] [FIXED] Unbounded table creation — goroutine/memory DoS
**File:** `game/registry.go:18–25`

Any request to `GET /api/tables/:table_id` or a WS join for an unknown table ID silently creates a new `Table` with a running `time.AfterFunc` goroutine. No authentication or rate limiting. An attacker floods arbitrary table IDs, creating unbounded goroutines and state until OOM.

**Fix:** Remove on-demand creation. Return 404 for unknown tables. Move creation behind an authenticated `POST /api/tables`.

```go
func (r *TableRegistry) GetTable(tableID string) (*Table, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    t, ok := r.tables[tableID]
    if !ok {
        return nil, errors.New("table not found")
    }
    return t, nil
}
```

---

### [HIGH] [FIXED] WebSocket CheckOrigin accepts all origins — CSWSH
**File:** `ws/hub.go:9–11`

```go
CheckOrigin: func(r *http.Request) bool { return true } // allows any origin
```

This enables Cross-Site WebSocket Hijacking from any domain. A malicious page can open a WS connection to your server using the victim's cookies.

**Fix:**

```go
CheckOrigin: func(r *http.Request) bool {
    allowed := strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",")
    origin := r.Header.Get("Origin")
    for _, a := range allowed {
        if strings.TrimSpace(a) == origin { return true }
    }
    return false
},
```

---

### [HIGH] [FIXED] Cookie SameSite is Lax, not Strict
**File:** `api/handlers.go:43–47`

The comment in `setAuthCookie` even says "SameSite should be strict" but uses `SameSiteLaxMode`. Lax allows the auth cookie on cross-site top-level navigations, widening CSRF exposure for mutation endpoints.

**Fix:**

```go
c.SetSameSite(http.SameSiteStrictMode)
```

---

### [HIGH] [FIXED] Re-join spawns duplicate `listenToTable` goroutines — leak
**File:** `ws/hub.go:170`

Every `join` on a topic unconditionally spawns `go c.listenToTable(t, topic)`. If the client reconnects or re-joins the same topic, a second goroutine is created. The old subscriber channel remains registered on the table. Both goroutines push duplicate events indefinitely. This is a goroutine and subscriber channel leak per re-join.

**Fix:** Track a cancel function per topic and cancel the previous listener before spawning a new one.

```go
type Client struct {
    conn      *websocket.Conn
    mu        sync.Mutex
    playerID  string
    topics    map[string]string
    listeners map[string]context.CancelFunc
}

// In handleJoin:
if cancel, ok := c.listeners[topic]; ok {
    cancel()
}
ctx, cancel := context.WithCancel(context.Background())
c.listeners[topic] = cancel
go c.listenToTable(ctx, t, topic)

// listenToTable:
func (c *Client) listenToTable(ctx context.Context, t *game.Table, topic string) {
    ch := t.Subscribe()
    defer t.Unsubscribe(ch)
    for {
        select {
        case <-ctx.Done():
            return
        case stateRaw, ok := <-ch:
            if !ok { return }
            c.push(topic, "table_event", map[string]interface{}{
                "type": "table_state", "state": stateRaw,
            })
        }
    }
}
```

---

### [MEDIUM] [FIXED] Admin actions unprotected — any player can clear tables
**File:** `game/table.go:125–131`

`clear_table` and `add_bot` are handled by `ApplyAction` with no role check. Any authenticated player can wipe the game state of any table.

**Fix:**

```go
case "clear_table", "add_bot":
    if !t.isOperator(playerID) {
        t.invalidAction("unauthorized"); return
    }
```

---

### [MEDIUM] [FIXED] `sendReply` silently discards write errors
**File:** `ws/hub.go:215–219`

```go
func (c *Client) sendReply(...) {
    // ...
    c.conn.WriteJSON(resp) // error discarded
}
```

A dead connection never gets cleaned up via `sendReply`. The goroutine lingers until the read loop eventually times out. Mirror the `push()` pattern and close on error.

---

### [LOW] [FIXED] Hardcoded DB credentials in fallback DSN
**File:** `db/db.go:6–12`

If `DATABASE_URL` is unset the app silently connects to `postgres:postgres@db:5432/poker_dev`. Remove the fallback entirely.

```go
dsn := os.Getenv("DATABASE_URL")
if dsn == "" {
    log.Fatal("DATABASE_URL environment variable must be set")
}
```

---

## Backend — Reliability

### [HIGH] [FIXED] Nil dereference panic in `concludeFoldout`
**File:** `game/betting_engine.go:275–280`

`winner` is assigned from the first player with `ACTIVE` or `ALL_IN` status. If `oneContenderLeft()` returns `true` but the player slice is in an inconsistent state, `winner` remains nil and `winner.Stack += pot` panics, crashing the table goroutine silently.

**Fix:**

```go
if winner == nil {
    t.invalidAction("no_winner_found")
    return
}
```

---

### [HIGH] [FIXED] Index out of range panic in `nextHandPositions`
**File:** `game/state_manager.go:329`

`nextSeatInList` returns `seats[0]` without checking `len(seats) > 0`. If `readySeats` is empty (all humans disconnected after `pruneDisconnected`), this panics.

**Fix:**

```go
func (t *Table) nextSeatInList(seats []int, current int) int {
    if len(seats) == 0 { return 1 }
    for _, s := range seats {
        if s > current { return s }
    }
    return seats[0]
}
```

---

### [MEDIUM] [FIXED] `push()` calls `conn.Close()` outside the write mutex — race condition
**File:** `ws/hub.go:225–230`

`push()` acquires `c.mu`, writes, releases it, then calls `c.conn.Close()` on error outside the lock. Another goroutine may be mid-write between the unlock and the close, causing a data race or double-close panic.

**Fix:**

```go
c.mu.Lock()
defer c.mu.Unlock()
if err := c.conn.WriteJSON(resp); err != nil {
    c.conn.Close()
}
```

---

### [MEDIUM] [FIXED] Table timer goroutine never stopped
**File:** `game/table.go:83–109`

`time.AfterFunc` goroutines are never stopped when a table is removed from the registry. The callback reschedules itself indefinitely.

**Fix:**

```go
func (t *Table) Stop() {
    t.mu.Lock()
    defer t.mu.Unlock()
    if t.autoTimer != nil {
        t.autoTimer.Stop()
    }
}
```

Call `t.Stop()` before removing a table from the registry.

---

### [LOW] [FIXED] `ActionLogSeq` desync with truncated log — missed sound events
**File:** `game/utils.go:19–27`

The log is capped at 48 entries by discarding from the front, but `ActionLogSeq` increments monotonically. The frontend computes `logDelta = nextLogSeq - prevLogSeq` and slices `action_log[len - logDelta:]`. When delta exceeds `len`, `logGap` fires and all sound events for that update are silently dropped.

**Fix:** Either freeze `ActionLogSeq` when the log is trimmed, or expose an absolute sequence offset so clients can compute the correct slice.

---

## Backend — Performance & Architecture

### [MEDIUM] [FIXED] O(n²) inner loops in `concludeShowdown`
**File:** `game/betting_engine.go:310–360`

For each contribution tier the code iterates all players twice and uses inner loops to find a player by seat. Negligible at 8 players, but fragile.

**Fix:** Build a `seatIndex map[int]int` once at the top of the function and use direct index access throughout.

---

### [MEDIUM] [FIXED] Global `db.DB` — no dependency injection
**File:** `db/db.go:4`, `api/handlers.go`

All handlers import `db.DB` directly, making unit tests require a real database. No interface to mock.

**Fix:**

```go
type Handler struct{ db *gorm.DB }
func NewHandler(db *gorm.DB) *Handler { return &Handler{db: db} }
func (h *Handler) RegisterUser(c *gin.Context) { /* use h.db */ }
```

---

### [MEDIUM] No layer boundaries in game package
**File:** `game/state_manager.go`, `game/betting_engine.go`, `game/table.go`

All game logic is methods on `*Table`, tangling timer/broadcast infrastructure with pure poker rules. Unit testing betting logic requires constructing full table state including timers and subscriber maps.

**Fix:** Extract `BettingEngine`, `ShowdownResolver`, and `PresenceTracker` as separate types. `Table` becomes an orchestrator only.

---

### [LOW] [FIXED] `/api/users/me` hits DB on every session restore
**File:** `api/handlers.go:143`

Called on every page load with no caching. Include `username` and `balance` in JWT claims at login time and serve `/me` from the token, only hitting the DB when the token is re-issued.

---

## Frontend — React / Vite

### [CRITICAL] [FIXED] Guest identity stored in localStorage and trusted by server
**File:** `hooks/usePokerTable.ts:43–56`

Guest `player_id` is generated client-side and stored in `localStorage`. Any user can open DevTools, set `localStorage["poker.player_id"]` to a numeric string matching another user's account ID, and connect to the WebSocket as that user (compounded by Backend Security #1).

**Fix:** Guest play should use a short-lived anonymous session issued by the server. For authenticated users, derive `playerId` entirely from the session cookie — never read it from `localStorage`.

---

### [HIGH] [FIXED] Card masking is frontend-only
**File:** `game/PokerGameClient.ts:250–256`

```ts
// This is the ONLY place opponent cards are masked
return "__back__";
```

Any client connecting directly to the WebSocket or HTTP API receives all players' real hole cards. This must be fixed on the backend (see Backend Security #3). The frontend masking can remain as a display concern but cannot be the sole control.

---

### [MEDIUM] [FIXED] No `AbortController` on in-flight requests
**File:** `hooks/usePokerTable.ts:162–170`

`loadBackendState()` fires `setBackendTable` / `setBackendHealth` after `await`. If the component unmounts while the request is in-flight, these setState calls fire on an unmounted component.

**Fix:**

```ts
const controller = new AbortController();

const loadBackendState = async () => {
    const [health, table] = await Promise.all([
        requestJson(healthUrl, { signal: controller.signal }),
        requestJson(tableUrl,  { signal: controller.signal }),
    ]);
    if (disposed) return;
    setBackendHealth(health);
    setBackendTable(table);
};

return () => {
    disposed = true;
    controller.abort();
    cleanup();
};
```

---

### [MEDIUM] Failed game actions don't re-sync state
**File:** `App.tsx:956`

When `sendAction` rejects, the UI shows a toast but does not re-fetch current table state. The player's UI can diverge from the server.

**Fix:**

```ts
} catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown failure";
    showGameMessage(`Action failed: ${reason}`);
    await loadBackendState(); // re-sync
}
```

---

### [MEDIUM] Stale `BACKEND_URL` in `sendAction` closure
**File:** `hooks/usePokerTable.ts:86–92`

`BACKEND_URL` is a module-level constant computed once at import time. During development with HMR or environment changes, the stale value is used silently. Move URL resolution inside the callback or use a `useRef`.

---

### [LOW] Dynamic import missing disposal guard
**File:** `App.tsx:1140`

```ts
void (async () => {
    const [{ PokerSoundEngine }, { Renderer }] = await Promise.all([...]);
    // no check if component is still mounted
})();
```

**Fix:** Add a `disposed` flag and check it before using the imported modules.

---

## Cross-Cutting

### [CRITICAL] Auth flow: WebSocket path has no enforced authentication

| # | Step | Path | Status | Gap |
|---|------|------|--------|-----|
| 1 | `POST /api/users/log-in` | `handlers.go:LoginUser` | ✅ OK | No rate limiting, no input length checks |
| 2 | Cookie returned | `setAuthCookie()` | ✅ OK | SameSite=Lax not Strict; Secure only in production |
| 3 | `GET /api/users/me` | `AuthMiddleware → GetMe` | ✅ OK | DB hit on every load; no token revocation |
| 4 | WS connect | `ws.HandleWebSocket` | ✅ OK | Connection rejected if cookie is invalid |
| 5 | WS `join` | `hub.go:handleJoin` | ✅ OK | `playerID` is from authenticated session |
| 6 | WS `action` event | `hub.go:handleAction` | ✅ OK | `player_id` is always overwritten by authenticated session |
| 7 | `POST /api/tables/:id/actions` | `AuthMiddleware → TableAction` | ✅ OK | userID correctly overwritten from JWT claims |

The HTTP action path (step 7) is safe. The WebSocket path — which is the primary game channel — is now secure.

---

### [HIGH] `player_name` and `table_id` have no length limits
**File:** `game/utils.go`, `game/registry.go`

A `player_name` of 10,000 characters is appended to every hand log entry and broadcast to all subscribers on every game action.

**Fix:**

```go
// In normalizePlayerName:
if len(s) > 30 { return s[:30] }

// Before registry lookup:
tableIDRe := regexp.MustCompile(`^[a-zA-Z0-9\-]{1,40}$`)
if !tableIDRe.MatchString(tableID) {
    return nil, errors.New("invalid table ID")
}
```

---

## Data Validation Coverage

| Field | Frontend | Backend | Falls Through | Risk |
|---|---|---|---|---|
| Email | None | None (uniqueIndex only) | Format, empty, length | Medium |
| Password | None | None (bcrypt truncates >72b) | Length bounds, empty | **High** |
| Username | None | None | Length, charset, empty | Medium |
| `player_name` (WS) | None | None | Unbounded length | Medium |
| `table_id` (URL) | None | None | Charset, length | Medium |
| bet/raise amount | Client hints | ✅ `betting_engine.go` | None — backend authoritative | Low |
| seat number | Dropdown | ✅ `seatUnavailable` | None | Low |
| `player_id` in WS action | Set by client | ❌ Not validated vs. session | Impersonation | **Critical** |

---

## Dependency Notes

| Package | Version | Note |
|---|---|---|
| `gorilla/websocket` | v1.5.3 | Current. `CheckOrigin` bypass is a config issue, not a library bug. |
| `gorm.io/gorm` | v1.31.1 | Current. `AutoMigrate` in production is fine early stage; replace with versioned migrations (goose/atlas) before scale. |
| `golang-jwt/jwt/v5` | v5.3.1 | Current. No token revocation — acceptable for 7-day tokens if logout clears the client cookie. |
| `react` | 19.2.4 | Current. `useEffectEvent` in `App.tsx` is still experimental in React 19 — monitor for API changes. |
| `go.mod` | go 1.26 | `math/rand` auto-seeds since 1.20; `rand.Shuffle` is safe. Ensure CI toolchain matches. |

No known critical CVEs in direct dependencies as of March 2026.

---

## Recommended Action Plan

### P0 — Before any public access
- Backend: Reject unauthenticated WebSocket connections (Security #1)
- Backend: Always overwrite `player_id` in WS actions from cookie identity (Security #2)
- Backend: Scrub opponent hole cards server-side before broadcast (Security #3)
- Backend: Add password length validation to prevent bcrypt DoS (Security #4)

### P1 — Before beta
- Backend: Gate table creation behind authentication; remove on-demand creation (Security #5)
- Backend: Fix CORS `CheckOrigin` to validate origin header (Security #6)
- Backend: Fix re-join goroutine leak with context-based listener cancellation (Security #8)
- Backend: Fix `concludeFoldout` nil-dereference panic (Reliability #1)
- Backend: Fix `nextHandPositions` empty-slice panic (Reliability #2)
- Frontend: Remove localStorage-based player identity for authenticated users (Frontend #1)

### P2 — Code quality
- Backend: Fix `heroOutcome` to use actual viewer seat, not hardcoded seat 1
- Backend: Change SameSite cookie to Strict (Security #7)
- Backend: Add admin gating to `clear_table` / `add_bot` actions (Security #9)
- Frontend: Add `AbortController` to `usePokerTable` fetch calls (Frontend #4)
- Frontend: Re-sync state after failed game actions (Frontend #5)
- Backend: Add `player_name` and `table_id` length validation (Cross-cutting #2)
- Backend: Add DB dependency injection instead of global var (Architecture)
