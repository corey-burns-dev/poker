defmodule PokerBackendWeb.TableControllerTest do
  use PokerBackendWeb.ConnCase, async: false

  defp unique_table_id do
    "table-" <> Integer.to_string(System.unique_integer([:positive, :monotonic]))
  end

  defp fetch_table(table_id) do
    build_conn()
    |> get(~p"/api/tables/#{table_id}")
    |> json_response(200)
  end

  defp action(table_id, action, params \\ %{}) do
    build_conn()
    |> post(~p"/api/tables/#{table_id}/actions?action=#{action}", params)
    |> json_response(200)
  end

  test "rejects illegal actions and preserves turn state" do
    table_id = unique_table_id()
    _ = fetch_table(table_id)

    state = action(table_id, "next_hand")
    assert state["hand_state"]["acting_seat"] == 5

    rejected_check = action(table_id, "check")
    assert rejected_check["last_event"] =~ "invalid_check_with_call"
    assert rejected_check["hand_state"]["acting_seat"] == 5
    assert List.last(rejected_check["hand_state"]["action_log"]) =~ "Rejected action:"

    legal_call = action(table_id, "call")
    assert legal_call["hand_state"]["acting_seat"] == 6

    action(table_id, "call")
    action(table_id, "call")
    action(table_id, "call")
    action(table_id, "call")
    action(table_id, "call")
    action(table_id, "call")
    flop = action(table_id, "check")

    assert flop["hand_state"]["stage"] == "flop"
    assert flop["hand_state"]["acting_seat"] == 3

    rejected_call = action(table_id, "call")
    assert rejected_call["last_event"] =~ "invalid_call_without_bet"
    assert rejected_call["hand_state"]["acting_seat"] == 3
  end

  test "handles foldout and starts the following hand" do
    table_id = unique_table_id()
    _ = fetch_table(table_id)

    action(table_id, "next_hand")
    action(table_id, "fold")
    action(table_id, "fold")
    action(table_id, "fold")
    action(table_id, "fold")
    action(table_id, "fold")
    action(table_id, "fold")
    foldout = action(table_id, "fold")

    assert foldout["game_state"] == "waiting_for_hand"
    assert foldout["players"] |> Enum.find(&(&1["seat"] == 4)) |> Map.fetch!("stack") == 5010

    state = action(table_id, "next_hand")
    assert state["hand_state"]["acting_seat"] == 6
  end

  test "progresses end-to-end across streets and completes at showdown" do
    table_id = unique_table_id()
    _ = fetch_table(table_id)

    preflop = action(table_id, "next_hand")
    assert preflop["hand_state"]["stage"] == "preflop"
    assert preflop["hand_state"]["acting_seat"] == 5

    action(table_id, "call")
    action(table_id, "call")
    action(table_id, "call")
    action(table_id, "call")
    action(table_id, "call")
    action(table_id, "call")
    action(table_id, "call")
    flop = action(table_id, "check")

    assert flop["hand_state"]["stage"] == "flop"
    assert flop["hand_state"]["acting_seat"] == 3
    assert flop["hand_state"]["community_cards"] == ["2h", "7d", "Tc"]

    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    turn = action(table_id, "check")

    assert turn["hand_state"]["stage"] == "turn"
    assert turn["hand_state"]["acting_seat"] == 3
    assert turn["hand_state"]["community_cards"] == ["2h", "7d", "Tc", "Qs"]

    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    river = action(table_id, "check")

    assert river["hand_state"]["stage"] == "river"
    assert river["hand_state"]["acting_seat"] == 3
    assert river["hand_state"]["community_cards"] == ["2h", "7d", "Tc", "Qs", "Ac"]

    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    action(table_id, "check")
    showdown = action(table_id, "check")

    assert showdown["game_state"] == "waiting_for_hand"
    assert showdown["hand_state"]["status"] == "complete"
    assert showdown["hand_state"]["stage"] == "showdown"
    assert length(showdown["hand_state"]["winner_seats"]) == 1
    winning_seat = List.first(showdown["hand_state"]["winner_seats"])
    assert showdown["hand_state"]["winner_amounts"][Integer.to_string(winning_seat)] == 160
  end
end
