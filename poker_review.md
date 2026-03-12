# Poker App — Deep Code Review
> Pre-stress-test audit · March 2026

---

## Summary

This is genuinely well-architected for a self-hosted multiplayer poker platform. The Elixir/Phoenix GenServer model is a natural fit for per-table state, the load test harness is thoughtfully designed, the CFR bot AI is a nice touch, and the frontend/backend separation is clean. The issues I found are real but none are fundamental design mistakes — they're the kind of correctness gaps and time bombs that only show up under concurrent load, which is exactly what you're about to run. I've organized findings by severity.

---

## 🔴 Critical — Will cause incorrect game state or crashes under load

### 1. DB writes inside the GenServer call path block the entire table

**Location:** `table.ex` → `conclude_foldout/2`, `conclude_showdown/1`

```elixir
for player <- players, not player.is_bot and is_integer(player.player_id) do
  user = Accounts.get_user!(player.player_id)
  Accounts.update_user_balance(user, player.stack)
end
```

Every hand completion runs synchronous Postgres queries inside the GenServer `handle_call`. During stress with many tables, this blocks that table's process until Postgres responds, stalls the bot tick chain, and can cascade into message queue buildup. Under `high`/`extreme` profiles this will cause visible lag spikes and potentially timeout cascades.

**Fix:** Cast to a separate task:

```elixir
Task.Supervisor.start_child(PokerBackend.TaskSupervisor, fn ->
  for player <- players, not player.is_bot and is_integer(player.player_id) do
    case Accounts.get_user(player.player_id) do
      nil -> :skip
      user -> Accounts.update_user_balance(user, player.stack)
    end
  end
end)
```

Add `{Task.Supervisor, name: PokerBackend.TaskSupervisor}` to `application.ex`. Also change `get_user!` to `get_user` here — a user deleted mid-hand shouldn't crash a table.

---

### 2. `get_user!` in `apply_action("join_game")` can crash the GenServer

**Location:** `table.ex` → `apply_action("join_game", ...)`

```elixir
user =
  if is_integer(player_id) do
    try do
      Accounts.get_user!(player_id)
    rescue
      _ -> nil
    end
  else
    nil
  end
```

The `try/rescue` is there as a bandaid, but `get_user!` raises `Ecto.NoResultsError` which is a struct, not a standard exception — if `Repo` raises a connection error instead (likely under load), the rescue catches it silently and `db_balance` becomes nil, silently resetting the player to `@starting_stack`. This is data-loss territory.

**Fix:** Use `Accounts.get_user/1` (non-raising) if you add it, or at minimum rescue `Ecto.NoResultsError` specifically.

---

### 3. Pot arithmetic can diverge during all-in scenarios

**Location:** `table.ex` → `contribute/3`

```elixir
|> update_in(
  [:hand_state, :pot],
  &(&1 + min(get_player!(state.players, seat).stack, max(amount, 0)))
)
```

This reads `state.players` (before the update) to compute the contribution, but the player's stack was already modified by `update_player` in the same pipeline. Elixir pipelines are sequential but the `&(&1 + ...)` closure captures the pre-update `state.players`. So the pot is incremented by the amount that was requested, not the amount that was actually deducted from the player's stack. When a player is nearly-all-in, these diverge.

**Fix:** Compute `paid = min(player.stack, max(amount, 0))` once, use it for both the player update and the pot increment.

```elixir
defp contribute(state, seat, amount) do
  player = get_player!(state.players, seat)
  paid = min(player.stack, max(amount, 0))
  
  state
  |> update_player(seat, fn p ->
    p
    |> Map.put(:stack, p.stack - paid)
    |> Map.put(:bet_this_street, p.bet_this_street + paid)
    |> Map.put(:contributed_this_hand, p.contributed_this_hand + paid)
    |> maybe_all_in()
  end)
  |> update_in([:hand_state, :pot], &(&1 + paid))
end
```

---

### 4. Race between `ensure_started` and duplicate table creation

**Location:** `table.ex` → `ensure_started/1`, `table_controller.ex`

```elixir
def ensure_started(table_id) do
  case Registry.lookup(PokerBackend.TableRegistry, table_id) do
    [] ->
      spec = {__MODULE__, table_id: table_id}
      DynamicSupervisor.start_child(PokerBackend.TableSupervisor, spec)
    [{pid, _value}] ->
      {:ok, pid}
  end
end
```

There is a TOCTOU race: two simultaneous HTTP requests for the same table_id both see `[]` from the registry, both call `DynamicSupervisor.start_child`. The second one gets `{:error, {:already_started, pid}}` — which is not pattern-matched. The controller does `{:ok, _pid} = Table.ensure_started(table_id)`, so this **will crash the controller process** with a match error.

This is likely to trigger during stress when the captain VU and player VUs all hit the server at the same moment.

**Fix:**
```elixir
def ensure_started(table_id) do
  case Registry.lookup(PokerBackend.TableRegistry, table_id) do
    [{pid, _}] -> {:ok, pid}
    [] ->
      case DynamicSupervisor.start_child(PokerBackend.TableSupervisor, {__MODULE__, table_id: table_id}) do
        {:ok, pid} -> {:ok, pid}
        {:error, {:already_started, pid}} -> {:ok, pid}
        error -> error
      end
  end
end
```

---

## 🟠 High — Behavioral bugs that will show up in testing

### 5. `auto_tick_scheduled` flag is never reset on timeout/error

**Location:** `table.ex` → `handle_info(:auto_progress, ...)`

```elixir
def handle_info(:auto_progress, state) do
  base_state = Map.put(state, :auto_tick_scheduled, false)
  next_state = auto_progress(base_state) |> maybe_schedule_auto_progress()
  ...
end
```

This is correct for the happy path. But if `auto_progress` raises (e.g. from `get_player!` with a bad seat, or a match error in bot logic), the GenServer will crash and restart with a fresh state — losing the in-progress hand. The OTP restart resets `auto_tick_scheduled` to `false` (from `initial_state`), so the timer logic recovers, but the hand and all player stacks are lost.

**Fix:** Wrap `auto_progress` in a `try/rescue` block that logs the error and returns the current state unchanged, preventing crashes from eating game state.

---

### 6. Disconnected player folded, then immediately rejoins as a bot

**Location:** `table.ex` → `handle_disconnect` → `maybe_fold_disconnected_actor` → `prune_disconnected_players`

The disconnect flow: player disconnects → `will_play_next_hand` set to false → if it's their turn, `apply_action("fold")` is called → `prune_disconnected_players` runs at hand end and replaces disconnected humans with bots.

The issue: `maybe_fold_disconnected_actor` calls `apply_action(state, "fold", %{})`. But `apply_action("fold", %{})` goes through `process_hand_action` → `authorized_action?`. Since the payload is `%{}`, `normalize_player_id(%{})` returns `nil`. The player has a non-nil `player_id`. So `authorized_action?` checks `player.player_id == nil` → `false`. The fold is rejected with `"unauthorized_player_action"`.

**Result:** A disconnected player who is the acting seat can permanently stall a hand — no fold fires, auto-tick never advances because it's not a bot turn, bots never move, hand is stuck.

**Fix:** In `maybe_fold_disconnected_actor`, pass the player_id in the payload:
```elixir
apply_action(state, "fold", %{"player_id" => player.player_id})
```

---

### 7. `street_complete?` can return `true` prematurely when all players are all-in

**Location:** `table.ex` → `street_complete?/1`

```elixir
defp street_complete?(state) do
  contenders = Enum.filter(state.players, &(&1.status in ["ACTIVE", "ALL_IN"]))
  actionable = Enum.filter(state.players, &(&1.status == "ACTIVE"))

  contenders != [] and
    Enum.all?(contenders, fn player ->
      player.bet_this_street == state.hand_state.current_bet or player.status == "ALL_IN"
    end) and
    Enum.all?(actionable, &Enum.member?(state.hand_state.acted_seats, &1.seat))
end
```

When all remaining players are ALL_IN (zero ACTIVE players), `actionable` is `[]` and `Enum.all?([], ...)` returns `true`. The condition becomes: `contenders != [] and true and true` = `true`. This is actually correct behavior — if everyone is all-in, the street should auto-complete. But the problem is this fires during the same street where the last player just went all-in. On the very action that causes the last all-in, `advance_after_action` checks `street_complete?` before the board is run out, and it will try to advance every street in one recursive call stack. This can lead to calling `advance_street_or_showdown` multiple times recursively, potentially dealing community cards from an already-exhausted deck slice.

**Fix:** Add a guard: if the current street had a bet/raise that just put the last player all-in, ensure `advance_after_action` yields to a single `advance_street_or_showdown` call, not a chain. Alternatively, verify the deck has enough cards before each deal in `deal_community_cards` (it currently doesn't).

---

### 8. `winner_amounts` map keys are integers, but frontend looks them up as strings

**Location:** `table.ex` → `conclude_showdown/1`; `PhoenixPokerGame.ts`

In `table.ex`:
```elixir
winner_amounts = %{winner_seat => pot}  # keys are integers
```

In `PhoenixPokerGame.ts`:
```typescript
table.hand_state.winner_amounts?.[String(seat)]  // looks up with string key
```

When JSON is serialized, Elixir map keys that are integers become JSON object keys (which are always strings). Phoenix's JSON encoder (Jason) converts `%{1 => 500}` to `{"1": 500}`. The frontend then does `winner_amounts["1"]` which should work. However in `side_pots`, `winner_amounts` is built differently and there's `Map.fetch!(winner_amounts, seat)` on the Elixir side where `seat` is an integer. Test this path explicitly — a split-pot all-in scenario may surface a key-type mismatch depending on how Jason serializes nested maps.

---

### 9. Action log is trimmed to last 16 entries — timing-sensitive data lost

**Location:** `table.ex`
```elixir
defp append_log(entries, line), do: entries |> Kernel.++([line]) |> Enum.take(-16)
```

During stress with fast bot play, the log can roll over mid-hand. The frontend's sound engine (`PhoenixPokerGame.ts`) detects new log entries by comparing lengths:
```typescript
const newLogs = table.hand_state.action_log.slice(prevLogLen)
```

If the log wraps (e.g. previous length was 14, state is received with length 16 but 5 new entries were appended and 3 old ones dropped), `slice(14)` returns 2 entries instead of 5 — sounds and UI events are silently dropped. Under load with slow WebSocket delivery, multiple state updates can be batched and the client misses actions.

**Fix:** Increase to `-32` or `-50`. It's a trivial memory cost per table. Alternatively, add a monotonic log sequence number so the frontend can detect gaps.

---

## 🟡 Medium — Quality of life / correctness improvements

### 10. No rate limiting on the `/api/tables/:id/actions` endpoint

The HTTP action endpoint has no authentication requirement and no rate limiting. The stress script uses it for bot-filling and hand-starting. In production, any client can POST arbitrary actions to any table. A malicious client could spam `next_hand` or `clear_table` on every table. 

**Recommendation:** Add a basic rate-limit plug (e.g. `PlugAttack` or a simple ETS-backed counter), or require session authentication for mutating actions. At minimum, the `clear_table` and `add_bot` actions should require some form of authorization.

---

### 11. Double `addEventListener("message")` and `addEventListener("error")` in `usePhoenixTable.ts`

**Location:** `frontend/src/hooks/usePhoenixTable.ts`

Both handlers are registered twice on the same socket (once around line 140, again around line 166). The second registration means every `table_event` message updates `backendTable` twice and every socket error fires `setBackendState` twice. Under React 18 concurrent mode this may cause double renders on every incoming message.

**Fix:** Remove the second block of `addEventListener("message", ...)` and `addEventListener("error", ...)` — they are exact duplicates.

---

### 12. `sendAction` in `usePhoenixTable` uses HTTP POST, not the WebSocket

This is intentional by design (the stress script also uses HTTP for actions), but it means:
- Every player action makes an HTTP round trip AND receives a WebSocket broadcast
- The HTTP response returns the new state, which is set via `setBackendTable`
- Then the WebSocket broadcast also fires `setBackendTable` with the same state

This double-update is harmless but wasteful. Under load, the HTTP response and the WS broadcast can arrive out of order, causing a brief state flicker. If you're keeping this hybrid approach, consider not updating state from the HTTP response (trust the WS broadcast as the single source of truth).

---

### 13. `UserSocket` has no authentication — anyone can open a channel

**Location:** `user_socket.ex`
```elixir
def connect(_params, socket, _connect_info), do: {:ok, socket}
```

The WebSocket accepts all connections. For the current design (tables are public, guest players are allowed) this is fine. But when you add real-money mechanics, this should validate a token. Flag for later.

---

### 14. Hand evaluator runs C(7,5) = 21 combinations correctly but allocates heavily

**Location:** `hand_evaluator.ex`

The evaluator creates 21 5-card combos per call via recursive list comprehension and maps over all of them. With 8 players × ~4 streets × many tables, this adds up. Not a bug, but worth noting that at high bot-play concurrency (multiple tables running simultaneously), this is one of the hotter code paths. A lookup-table approach would be faster if you hit CPU limits.

---

### 15. `normalize_amount` silently returns 0 for missing/invalid amounts

**Location:** `table.ex`
```elixir
defp normalize_amount(_payload), do: 0
```

If a bot accidentally constructs a raise payload with the amount as a float string like `"1500.0"`, `Integer.parse("1500.0")` returns `{1500, ".0"}` (with remainder), which currently works. But `"1500.5"` would also parse to `{1500, ".5"}` — truncating the intended amount silently. For stress testing this is fine since amounts are always integers, but worth a note.

---

## 🔵 Observations & Pre-stress Recommendations

### Load test: captain VU creates a race with player VUs

In `poker_stress.js`, the captain calls `clear_table` then `add_bot` for each bot seat, then sleeps `SETUP_STAGGER_MS`. Non-captain VUs sleep `(seatOffset + 1) * SETUP_STAGGER_MS` before joining. With `SETUP_STAGGER_MS=1400` and up to 7 non-captain seats, a VU at seat 8 sleeps 11.2 seconds. If the hand auto-starts before all humans join (which `auto_start_next_hand?` will do if only bots are ready), humans miss the first hand and sit out.

This is probably fine for load testing but worth knowing if you're measuring `poker_join_latency` — latecomers will show high latency.

### `maybe_schedule_auto_progress` is called after every state change

This is correct and elegantly simple, but each `Process.send_after` creates a timer message. The guard `auto_tick_scheduled: true` prevents stacking. However during very rapid action sequences (bot storms), the guard can get out of sync if a message is processed after the timer fires but before the scheduled tick arrives. Under normal conditions this resolves itself, but it's worth watching the queue depth metric during `insane` profile runs.

### Table state is never persisted — server restart loses all hands

Tables are pure in-memory GenServers. A backend restart loses all active games. This is probably acceptable for now, but mention it in documentation so players aren't surprised.

### The `contribute/3` pot calculation double-counts bets already moved to pot

The `hand_state.pot` starts at `@small_blind + @big_blind` after blinds. `bet_this_street` is used for call calculation. At street end, bets are cleared but the pot is NOT incremented by the cleared bets — it was already incremented incrementally via `contribute`. This is correct, but the frontend's `potBase` calculation subtracts committed bets from the pot to show the "pot before current bets" — this can briefly show a negative or incorrect pot value when all players check (no bets), since `committedBets` sums `bet_this_street` which are all zero after streets clear. Verify the pot display during all-check streets.

---

## Quick Fix Priority

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 4 | `ensure_started` race → controller crash | Crash under load | 5 min |
| 6 | Disconnected actor fold blocked → stalled hand | Hand deadlock | 5 min |
| 3 | Pot arithmetic divergence in all-in | Wrong chip counts | 10 min |
| 1 | DB writes blocking GenServer | Latency under load | 20 min |
| 11 | Double event listeners | Double renders | 2 min |
| 2 | `get_user!` crash risk | Rare GenServer crash | 5 min |
| 5 | `auto_progress` crash drops hand | Rare hand loss | 15 min |

Issues 4 and 6 are the most likely to surface during stress testing. I'd fix those before running anything above `medium` profile.
