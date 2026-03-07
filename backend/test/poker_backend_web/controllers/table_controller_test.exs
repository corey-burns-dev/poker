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

  defp dealt_cards(state) do
    hole_cards =
      state["players"]
      |> Enum.flat_map(fn player -> player["hole_cards"] || [] end)
      |> Enum.reject(&is_nil/1)

    hole_cards ++ state["hand_state"]["community_cards"]
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
    assert length(dealt_cards(preflop)) == 16
    assert Enum.uniq(dealt_cards(preflop)) == dealt_cards(preflop)

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
    assert length(flop["hand_state"]["community_cards"]) == 3
    assert Enum.uniq(dealt_cards(flop)) == dealt_cards(flop)

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
    assert length(turn["hand_state"]["community_cards"]) == 4
    assert Enum.uniq(dealt_cards(turn)) == dealt_cards(turn)

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
    assert length(river["hand_state"]["community_cards"]) == 5
    assert Enum.uniq(dealt_cards(river)) == dealt_cards(river)

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
    assert length(showdown["hand_state"]["community_cards"]) == 5
    assert showdown["hand_state"]["winner_seats"] != []
    assert Enum.sum(Map.values(showdown["hand_state"]["winner_amounts"])) == 160
    assert showdown["hand_state"]["hand_result"]["heading"] =~ "wins"
    assert Enum.any?(showdown["hand_state"]["hand_result"]["lines"], &String.contains?(&1, "shows"))
  end

  test "supports clearing a table and adding bots one at a time" do
    table_id = unique_table_id()
    _ = fetch_table(table_id)

    cleared = action(table_id, "clear_table")

    assert Enum.count(cleared["players"], &(&1["is_bot"] and &1["stack"] <= 0)) == 8
    assert cleared["last_event"] == "table_cleared"

    first_bot = action(table_id, "add_bot")
    assert Enum.count(first_bot["players"], &(&1["is_bot"] and &1["stack"] > 0)) == 1

    seat_four_bot = action(table_id, "add_bot", %{"seat" => 4})
    seat_four = Enum.find(seat_four_bot["players"], &(&1["seat"] == 4))

    assert seat_four["is_bot"]
    assert seat_four["stack"] == 5000
  end

  test "seats a human immediately and deals them into the next hand" do
    table_id = unique_table_id()
    _ = fetch_table(table_id)

    action(table_id, "clear_table")
    action(table_id, "add_bot", %{"seat" => 1})

    seated =
      action(table_id, "join_game", %{
        "player_id" => "player-1",
        "player_name" => "Hero",
        "seat" => 2
      })

    hero = Enum.find(seated["players"], &(&1["player_id"] == "player-1"))

    assert hero["seat"] == 2
    assert hero["status"] == "READY"
    assert hero["will_play_next_hand"]

    started = action(table_id, "next_hand", %{"player_id" => "player-1"})
    hero_in_hand = Enum.find(started["players"], &(&1["player_id"] == "player-1"))

    assert hero_in_hand["status"] == "ACTIVE"
    assert Enum.all?(hero_in_hand["hole_cards"], &(is_binary(&1) and byte_size(&1) == 2))
  end

  test "starts sparse heads-up tables with blinds on occupied seats" do
    table_id = unique_table_id()
    _ = fetch_table(table_id)

    action(table_id, "clear_table")
    action(table_id, "add_bot", %{"seat" => 1})

    action(table_id, "join_game", %{
      "player_id" => "player-heads-up",
      "player_name" => "Hero",
      "seat" => 4
    })

    started = action(table_id, "next_hand", %{"player_id" => "player-heads-up"})
    hero = Enum.find(started["players"], &(&1["player_id"] == "player-heads-up"))
    bot = Enum.find(started["players"], &(&1["seat"] == 1))

    assert started["hand_state"]["dealer_seat"] == 4
    assert started["hand_state"]["small_blind_seat"] == 4
    assert started["hand_state"]["big_blind_seat"] == 1
    assert started["hand_state"]["acting_seat"] == 4
    assert hero["bet_this_street"] == 10
    assert bot["bet_this_street"] == 20

    called = action(table_id, "call", %{"player_id" => "player-heads-up"})

    assert called["last_event"] == "Seat 4 calls 10."
    assert called["hand_state"]["acting_seat"] == 1
  end

  test "queues a human for the next hand when claiming a bot seat mid-hand" do
    table_id = unique_table_id()
    _ = fetch_table(table_id)

    action(table_id, "next_hand")

    queued =
      action(table_id, "join_game", %{
        "player_id" => "player-queue",
        "player_name" => "Hero",
        "seat" => 2
      })

    pending = Enum.find(queued["pending_players"], &(&1["player_id"] == "player-queue"))

    assert pending["desired_seat"] == 2
    assert pending["will_play_next_hand"]
  end
end
