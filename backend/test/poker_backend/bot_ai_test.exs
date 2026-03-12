defmodule PokerBackend.BotAiTest do
  use ExUnit.Case, async: false

  alias PokerBackend.Table

  defp unique_table_id do
    "bot-ai-" <> Integer.to_string(System.unique_integer([:positive, :monotonic]))
  end

  defp start_table do
    table_id = unique_table_id()
    {:ok, pid} = Table.ensure_started(table_id)
    {:ok, _state} = Table.action(table_id, "next_hand", %{})
    {table_id, pid}
  end

  defp force_preflop_spot(pid, seat, hole_cards) do
    :sys.replace_state(pid, fn state ->
      players =
        Enum.map(state.players, fn player ->
          cond do
            player.seat == seat ->
              player
              |> Map.put(:status, "ACTIVE")
              |> Map.put(:stack, 5_000)
              |> Map.put(:bet_this_street, 0)
              |> Map.put(:contributed_this_hand, 0)
              |> Map.put(:hole_cards, hole_cards)

            true ->
              player
              |> Map.put(:status, "ACTIVE")
              |> Map.put(:stack, 5_000)
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
        |> Map.put(:acting_seat, seat)
        |> Map.put(:community_cards, [])
        |> Map.put(:acted_seats, [])
        |> Map.put(:action_log, ["Forced preflop spot for seat #{seat}."])

      state
      |> Map.put(:game_state, "hand_in_progress")
      |> Map.put(:players, players)
      |> Map.put(:hand_state, hand_state)
      |> Map.put(:auto_tick_scheduled, false)
    end)
  end

  defp run_bot_turn(pid, table_id) do
    send(pid, :auto_progress)
    Table.state(table_id)
  end

  defp seed_bot_rng(pid, seed) do
    :sys.replace_state(pid, fn state ->
      :rand.seed(:exsss, seed)
      state
    end)
  end

  test "boots with at least four distinct bot styles" do
    table_id = unique_table_id()
    {:ok, _pid} = Table.ensure_started(table_id)

    styles =
      table_id
      |> Table.state()
      |> Map.fetch!(:players)
      |> Enum.map(& &1.bot_style)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()

    assert length(styles) >= 3
    assert "tight" in styles
    assert "balanced" in styles
    assert "aggressive" in styles
  end

  test "calling stations flat spots that lag bots raise" do
    {table_id, pid} = start_table()
    force_preflop_spot(pid, 2, ["Js", "Jd"])
    seed_bot_rng(pid, {1, 1, 1})

    calling_station_state = run_bot_turn(pid, table_id)

    assert calling_station_state.last_event == "Seat 2 calls 20."
    assert calling_station_state.hand_state.current_bet == 20

    {table_id, pid} = start_table()
    force_preflop_spot(pid, 4, ["Js", "Jd"])
    seed_bot_rng(pid, {1, 1, 2})

    lag_state = run_bot_turn(pid, table_id)

    assert lag_state.last_event =~ "Seat 4 raises to"
    assert lag_state.hand_state.current_bet > 20
  end

  test "nit bots fold marginal hands that calling stations continue with" do
    {table_id, pid} = start_table()
    force_preflop_spot(pid, 2, ["As", "9d"])
    seed_bot_rng(pid, {1, 1, 1})

    calling_station_state = run_bot_turn(pid, table_id)
    assert calling_station_state.last_event == "Seat 2 calls 20."

    {table_id, pid} = start_table()
    force_preflop_spot(pid, 7, ["As", "9d"])
    seed_bot_rng(pid, {1, 1, 7})

    nit_state = run_bot_turn(pid, table_id)

    assert nit_state.last_event == "Seat 7 folds."
    assert nit_state.hand_state.acting_seat != 7
  end
end
