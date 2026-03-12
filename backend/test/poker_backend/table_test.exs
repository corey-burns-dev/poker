defmodule PokerBackend.TableTest do
  use ExUnit.Case, async: false

  alias PokerBackend.Table

  defp unique_table_id do
    "table-" <> Integer.to_string(System.unique_integer([:positive, :monotonic]))
  end

  test "ensure_started returns the same pid under concurrent calls" do
    table_id = unique_table_id()

    results =
      1..16
      |> Task.async_stream(fn _ -> Table.ensure_started(table_id) end,
        max_concurrency: 16,
        ordered: false,
        timeout: 5_000
      )
      |> Enum.to_list()

    pids =
      Enum.map(results, fn
        {:ok, {:ok, pid}} -> pid
      end)

    assert length(pids) == 16
    assert [_pid] = Enum.uniq(pids)
  end

  test "disconnecting the acting player forces a fold and resolves the hand" do
    table_id = unique_table_id()
    {:ok, _pid} = Table.ensure_started(table_id)
    {:ok, _state} = Table.action(table_id, "clear_table", %{})
    {:ok, _state} = Table.action(table_id, "add_bot", %{"seat" => 1})

    {:ok, seated_state} =
      Table.action(table_id, "join_game", %{
        "player_id" => "hero",
        "player_name" => "Hero",
        "seat" => 4
      })

    assert Enum.any?(seated_state.players, &(&1.player_id == "hero" and &1.seat == 4))

    {:ok, _joined_state} = Table.join(table_id, "hero", "Hero")
    {:ok, started_state} = Table.action(table_id, "next_hand", %{"player_id" => "hero"})

    assert started_state.hand_state.acting_seat == 4

    {:ok, disconnected_state} = Table.leave(table_id, "hero")

    assert disconnected_state.game_state == "waiting_for_hand"
    assert disconnected_state.hand_state.status == "complete"
    assert disconnected_state.hand_state.hand_result.heading == "Seat 1 wins by fold"
  end

  test "contribute only adds the chips actually paid when a player is all in" do
    table_id = unique_table_id()
    {:ok, pid} = Table.ensure_started(table_id)
    {:ok, _state} = Table.action(table_id, "next_hand", %{})

    :sys.replace_state(pid, fn state ->
      players =
        Enum.map(state.players, fn player ->
          case player.seat do
            1 ->
              player
              |> Map.put(:status, "ACTIVE")
              |> Map.put(:stack, 15)
              |> Map.put(:bet_this_street, 0)
              |> Map.put(:contributed_this_hand, 0)

            2 ->
              player
              |> Map.put(:status, "ACTIVE")
              |> Map.put(:stack, 200)
              |> Map.put(:bet_this_street, 20)
              |> Map.put(:contributed_this_hand, 20)

            _ ->
              player
              |> Map.put(:status, "FOLDED")
              |> Map.put(:bet_this_street, 0)
              |> Map.put(:contributed_this_hand, 0)
          end
        end)

      hand_state =
        state.hand_state
        |> Map.put(:status, "in_progress")
        |> Map.put(:stage, "preflop")
        |> Map.put(:pot, 30)
        |> Map.put(:current_bet, 20)
        |> Map.put(:minimum_raise, 20)
        |> Map.put(:acting_seat, 1)
        |> Map.put(:acted_seats, [])

      state
      |> Map.put(:players, players)
      |> Map.put(:game_state, "hand_in_progress")
      |> Map.put(:hand_state, hand_state)
      |> Map.put(:auto_tick_scheduled, false)
    end)

    {:ok, state} = Table.action(table_id, "call", %{})
    seat_one = Enum.find(state.players, &(&1.seat == 1))

    assert seat_one.stack == 0
    assert seat_one.bet_this_street == 15
    assert seat_one.contributed_this_hand == 15
    assert seat_one.status == "ALL_IN"
    assert state.hand_state.pot == 45
  end

  test "auto progress errors do not crash and reset the table" do
    table_id = unique_table_id()
    {:ok, pid} = Table.ensure_started(table_id)

    :sys.replace_state(pid, fn state ->
      players =
        Enum.map(state.players, fn player ->
          case player.seat do
            1 ->
              player
              |> Map.put(:status, "ACTIVE")
              |> Map.put(:hole_cards, ["bad", "Js"])

            2 ->
              player
              |> Map.put(:status, "ACTIVE")
              |> Map.put(:hole_cards, ["Ah", "Ad"])

            _ ->
              player
              |> Map.put(:status, "FOLDED")
              |> Map.put(:hole_cards, [nil, nil])
          end
        end)

      hand_state =
        state.hand_state
        |> Map.put(:status, "in_progress")
        |> Map.put(:stage, "flop")
        |> Map.put(:acting_seat, 1)
        |> Map.put(:current_bet, 0)
        |> Map.put(:community_cards, ["As", "Kd", "Qh"])
        |> Map.put(:action_log, ["forced bad auto-progress state"])

      state
      |> Map.put(:players, players)
      |> Map.put(:game_state, "hand_in_progress")
      |> Map.put(:last_event, "forced_bad_state")
      |> Map.put(:hand_state, hand_state)
      |> Map.put(:auto_tick_scheduled, false)
    end)

    send(pid, :auto_progress)
    Process.sleep(50)

    state = Table.state(table_id)

    assert Process.alive?(pid)
    assert state.last_event == "forced_bad_state"
    assert state.hand_state.stage == "flop"
    assert state.hand_state.action_log == ["forced bad auto-progress state"]
  end

  test "all-in streets run out once and end at showdown with a full board" do
    table_id = unique_table_id()
    {:ok, pid} = Table.ensure_started(table_id)

    :sys.replace_state(pid, fn state ->
      players =
        Enum.map(state.players, fn player ->
          case player.seat do
            1 ->
              player
              |> Map.put(:status, "ALL_IN")
              |> Map.put(:stack, 0)
              |> Map.put(:bet_this_street, 20)
              |> Map.put(:contributed_this_hand, 20)
              |> Map.put(:hole_cards, ["As", "Ad"])

            2 ->
              player
              |> Map.put(:status, "ACTIVE")
              |> Map.put(:stack, 180)
              |> Map.put(:bet_this_street, 20)
              |> Map.put(:contributed_this_hand, 20)
              |> Map.put(:hole_cards, ["Ks", "Kd"])

            _ ->
              player
              |> Map.put(:status, "FOLDED")
              |> Map.put(:bet_this_street, 0)
              |> Map.put(:contributed_this_hand, 0)
              |> Map.put(:hole_cards, [nil, nil])
          end
        end)

      hand_state =
        state.hand_state
        |> Map.put(:status, "in_progress")
        |> Map.put(:stage, "preflop")
        |> Map.put(:pot, 40)
        |> Map.put(:current_bet, 20)
        |> Map.put(:minimum_raise, 20)
        |> Map.put(:acting_seat, 2)
        |> Map.put(:acted_seats, [1])
        |> Map.put(:community_cards, [])
        |> Map.put(:deck, ["2c", "3c", "4c", "5c", "6c", "7d", "8d"])

      state
      |> Map.put(:players, players)
      |> Map.put(:game_state, "hand_in_progress")
      |> Map.put(:hand_state, hand_state)
      |> Map.put(:auto_tick_scheduled, false)
    end)

    {:ok, showdown_state} = Table.action(table_id, "check", %{})

    assert showdown_state.game_state == "waiting_for_hand"
    assert showdown_state.hand_state.status == "complete"
    assert showdown_state.hand_state.stage == "showdown"
    assert showdown_state.hand_state.community_cards == ["2c", "3c", "4c", "5c", "6c"]
    assert length(showdown_state.hand_state.winner_seats) >= 1
  end

  test "runout resolves side pots correctly when one player covers multiple all-ins" do
    table_id = unique_table_id()
    {:ok, pid} = Table.ensure_started(table_id)

    :sys.replace_state(pid, fn state ->
      players =
        Enum.map(state.players, fn player ->
          case player.seat do
            1 ->
              player
              |> Map.put(:status, "ALL_IN")
              |> Map.put(:stack, 0)
              |> Map.put(:bet_this_street, 100)
              |> Map.put(:contributed_this_hand, 100)
              |> Map.put(:hole_cards, ["As", "Ah"])

            2 ->
              player
              |> Map.put(:status, "ALL_IN")
              |> Map.put(:stack, 0)
              |> Map.put(:bet_this_street, 200)
              |> Map.put(:contributed_this_hand, 200)
              |> Map.put(:hole_cards, ["Ks", "Kh"])

            3 ->
              player
              |> Map.put(:status, "ACTIVE")
              |> Map.put(:stack, 50)
              |> Map.put(:bet_this_street, 200)
              |> Map.put(:contributed_this_hand, 200)
              |> Map.put(:hole_cards, ["Qs", "Qh"])

            _ ->
              player
              |> Map.put(:status, "FOLDED")
              |> Map.put(:bet_this_street, 0)
              |> Map.put(:contributed_this_hand, 0)
              |> Map.put(:hole_cards, [nil, nil])
          end
        end)

      hand_state =
        state.hand_state
        |> Map.put(:status, "in_progress")
        |> Map.put(:stage, "preflop")
        |> Map.put(:pot, 500)
        |> Map.put(:current_bet, 200)
        |> Map.put(:minimum_raise, 20)
        |> Map.put(:acting_seat, 3)
        |> Map.put(:acted_seats, [1, 2])
        |> Map.put(:community_cards, [])
        |> Map.put(:deck, ["2c", "3d", "4h", "5s", "9c", "Jd", "Td"])

      state
      |> Map.put(:players, players)
      |> Map.put(:game_state, "hand_in_progress")
      |> Map.put(:hand_state, hand_state)
      |> Map.put(:auto_tick_scheduled, false)
    end)

    {:ok, showdown_state} = Table.action(table_id, "check", %{})

    assert showdown_state.hand_state.status == "complete"
    assert showdown_state.hand_state.community_cards == ["2c", "3d", "4h", "5s", "9c"]
    assert showdown_state.hand_state.winner_amounts == %{1 => 300, 2 => 200}
    assert Enum.map(showdown_state.hand_state.side_pots, & &1.amount) == [300, 200]

    seat_one = Enum.find(showdown_state.players, &(&1.seat == 1))
    seat_two = Enum.find(showdown_state.players, &(&1.seat == 2))
    seat_three = Enum.find(showdown_state.players, &(&1.seat == 3))

    assert seat_one.stack == 300
    assert seat_two.stack == 200
    assert seat_three.stack == 50
  end
end
