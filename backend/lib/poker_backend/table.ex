defmodule PokerBackend.Table do
  use GenServer

  alias PokerBackend.HandEvaluator
  alias Phoenix.PubSub

  @seats [1, 2, 3, 4, 5, 6, 7, 8]
  @small_blind 10
  @big_blind 20
  @starting_stack 5000
  @auto_hand_delay 5_000
  @auto_bot_delay 450
  @bot_names %{
    1 => "Alice",
    2 => "Bob",
    3 => "Charlie",
    4 => "Daisy",
    5 => "Eli",
    6 => "Frankie",
    7 => "Gia",
    8 => "Harper"
  }
  @bot_profiles %{
    1 => %{style: "nit", looseness: -16, aggression: 10, bluff: 1},
    2 => %{style: "calling_station", looseness: 14, aggression: -8, bluff: 0},
    3 => %{style: "balanced", looseness: 2, aggression: 6, bluff: 3},
    4 => %{style: "lag", looseness: 10, aggression: 18, bluff: 8},
    5 => %{style: "lag", looseness: 12, aggression: 20, bluff: 10},
    6 => %{style: "nit", looseness: -14, aggression: 12, bluff: 1},
    7 => %{style: "balanced", looseness: 4, aggression: 8, bluff: 4},
    8 => %{style: "calling_station", looseness: 12, aggression: -6, bluff: 1}
  }

  @starting_hands %{
    1 => ["Ah", "Ad"],
    2 => ["Kh", "Qh"],
    3 => ["Js", "Jd"],
    4 => ["9c", "9d"],
    5 => ["8h", "8d"],
    6 => ["As", "Kd"],
    7 => ["Qc", "Qd"],
    8 => ["7s", "6s"]
  }

  @board_by_street %{
    "preflop" => [],
    "flop" => ["2h", "7d", "Tc"],
    "turn" => ["2h", "7d", "Tc", "Qs"],
    "river" => ["2h", "7d", "Tc", "Qs", "Ac"],
    "showdown" => ["2h", "7d", "Tc", "Qs", "Ac"]
  }

  def start_link(opts) do
    table_id = Keyword.fetch!(opts, :table_id)
    GenServer.start_link(__MODULE__, table_id, name: via(table_id))
  end

  def ensure_started(table_id) do
    case Registry.lookup(PokerBackend.TableRegistry, table_id) do
      [] ->
        spec = {__MODULE__, table_id: table_id}
        DynamicSupervisor.start_child(PokerBackend.TableSupervisor, spec)

      [{pid, _value}] ->
        {:ok, pid}
    end
  end

  def state(table_id), do: GenServer.call(via(table_id), :state)

  def join(table_id, player_id, player_name),
    do: GenServer.call(via(table_id), {:join, player_id, player_name})

  def leave(table_id, player_id), do: GenServer.call(via(table_id), {:leave, player_id})
  def ping(table_id, payload), do: GenServer.call(via(table_id), {:ping, payload})

  def action(table_id, action, payload \\ %{}),
    do: GenServer.call(via(table_id), {:action, action, payload})

  def topic(table_id), do: "table:" <> table_id

  defp via(table_id), do: {:via, Registry, {PokerBackend.TableRegistry, table_id}}

  @impl true
  def init(table_id) do
    state =
      table_id
      |> initial_state()
      |> maybe_schedule_auto_progress()

    {:ok, state}
  end

  @impl true
  def handle_call(:state, _from, state), do: {:reply, state, state}

  @impl true
  def handle_call({:join, player_id, player_name}, _from, state) do
    next_state =
      state
      |> increment_connection(player_id)
      |> reconnect_player(player_id)
      |> put_in([:last_event], "#{player_name} joined the table")
      |> maybe_schedule_auto_progress()

    broadcast_state(next_state)
    {:reply, {:ok, next_state}, next_state}
  end

  @impl true
  def handle_call({:leave, player_id}, _from, state) do
    next_state =
      state
      |> decrement_connection(player_id)
      |> handle_disconnect(player_id)
      |> maybe_schedule_auto_progress()

    broadcast_state(next_state)
    {:reply, {:ok, next_state}, next_state}
  end

  @impl true
  def handle_call({:ping, payload}, _from, state) do
    event = %{
      type: "pong",
      table_id: state.table_id,
      payload: payload,
      server_time: DateTime.utc_now()
    }

    broadcast_event(state.table_id, event)
    {:reply, {:ok, event}, state}
  end

  @impl true
  def handle_call({:action, action, payload}, _from, state) do
    next_state =
      state
      |> apply_action(action, payload)
      |> maybe_schedule_auto_progress()

    broadcast_state(next_state)
    {:reply, {:ok, next_state}, next_state}
  end

  @impl true
  def handle_info(:auto_progress, state) do
    base_state = Map.put(state, :auto_tick_scheduled, false)
    next_state = auto_progress(base_state) |> maybe_schedule_auto_progress()

    if next_state != state do
      broadcast_state(next_state)
    end

    {:noreply, next_state}
  end

  defp initial_state(table_id) do
    %{
      table_id: table_id,
      players: initial_players(),
      game_state: "waiting_for_hand",
      hand_number: 1,
      connected_clients: 0,
      last_event: "table_created",
      hand_state: initial_hand_state(1, 1),
      auto_tick_scheduled: false,
      client_connections: %{},
      pending_players: []
    }
  end

  defp initial_players do
    @seats
    |> Enum.map(&build_bot_player(&1, @starting_stack))
  end

  defp build_bot_player(seat, stack) do
    profile = Map.fetch!(@bot_profiles, seat)

    %{
      seat: seat,
      name: Map.fetch!(@bot_names, seat),
      stack: stack,
      status: "READY",
      will_play_next_hand: true,
      show_cards: true,
      is_bot: true,
      bot_style: profile.style,
      player_id: nil,
      connected: false,
      bet_this_street: 0,
      contributed_this_hand: 0,
      hole_cards: [nil, nil]
    }
  end

  defp build_empty_seat(seat) do
    %{
      seat: seat,
      name: "Open Seat",
      stack: 0,
      status: "EMPTY",
      will_play_next_hand: false,
      show_cards: false,
      is_bot: true,
      bot_style: nil,
      player_id: nil,
      connected: false,
      bet_this_street: 0,
      contributed_this_hand: 0,
      hole_cards: [nil, nil]
    }
  end

  defp empty_seat?(player) do
    player.is_bot and is_nil(player.player_id) and player.stack <= 0
  end

  defp initial_hand_state(hand_number, dealer_seat) do
    %{
      status: "waiting",
      stage: "preflop",
      hand_number: hand_number,
      pot: 0,
      current_bet: 0,
      minimum_raise: @big_blind,
      acting_seat: nil,
      dealer_seat: dealer_seat,
      small_blind_seat: rotate_seat(dealer_seat),
      big_blind_seat: rotate_seat(rotate_seat(dealer_seat)),
      community_cards: [],
      action_log: ["Table ready. First hand starting shortly."],
      last_action: "waiting_for_next_hand",
      acted_seats: [],
      winner_seats: [],
      winner_amounts: %{},
      side_pots: [],
      hand_result: nil
    }
  end

  defp apply_action(state, "join_game", payload) do
    player_id = normalize_player_id(payload)
    requested_seat = normalize_seat(payload)

    player_name =
      payload
      |> Map.get("player_name", "You")
      |> to_string()
      |> String.trim()
      |> case do
        "" -> "You"
        value -> value
      end

    cond do
      is_nil(player_id) ->
        invalid_action(state, "missing_player_id")

      is_nil(requested_seat) ->
        invalid_action(state, "missing_seat_selection")

      seat_unavailable?(state, requested_seat, player_id) ->
        invalid_action(state, "seat_#{requested_seat}_unavailable")

      player = Enum.find(state.players, &(&1.player_id == player_id)) ->
        state
        |> update_player(player.seat, fn current ->
          current
          |> Map.put(:name, player_name)
          |> Map.put(:connected, true)
        end)
        |> put_in([:last_event], "player_reconnected")
        |> update_in(
          [:hand_state, :action_log],
          &append_log(&1, "#{player_name} is seated at seat #{player.seat}.")
        )

      pending = Enum.find(state.pending_players, &(&1.player_id == player_id)) ->
        state
        |> update_pending_player(player_id, fn current ->
          current
          |> Map.put(:name, player_name)
          |> Map.put(:connected, true)
          |> Map.put(:desired_seat, requested_seat)
        end)
        |> put_in([:last_event], "player_waiting")
        |> update_in(
          [:hand_state, :action_log],
          &append_log(&1, "#{pending.name} is waiting for seat #{requested_seat}.")
        )

      true ->
        pending_player = %{
          player_id: player_id,
          name: player_name,
          connected: true,
          will_play_next_hand: false,
          show_cards: false,
          desired_seat: requested_seat
        }

        state
        |> update_in([:pending_players], &(&1 ++ [pending_player]))
        |> put_in([:last_event], "player_joined_waitlist")
        |> update_in(
          [:hand_state, :action_log],
          &append_log(&1, "#{player_name} reserved seat #{requested_seat}.")
        )
    end
  end

  defp apply_action(state, "sit_in", payload) do
    player_id = normalize_player_id(payload)

    cond do
      player = Enum.find(state.players, &(&1.player_id == player_id)) ->
        updated_state =
          state
          |> update_player(player.seat, fn current ->
            current
            |> Map.put(:will_play_next_hand, current.stack > 0)
            |> Map.put(
              :status,
              if(state.hand_state.status == "waiting" and current.stack > 0,
                do: "READY",
                else: current.status
              )
            )
          end)
          |> put_in([:last_event], "player_sitting_in")

        message =
          if state.hand_state.status == "in_progress" do
            "#{player.name} will be dealt in next hand."
          else
            "#{player.name} is ready for the next hand."
          end

        update_in(updated_state, [:hand_state, :action_log], &append_log(&1, message))

      Enum.any?(state.pending_players, &(&1.player_id == player_id)) ->
        state
        |> update_pending_player(player_id, &Map.put(&1, :will_play_next_hand, true))
        |> put_in([:last_event], "pending_player_sitting_in")
        |> update_in(
          [:hand_state, :action_log],
          &append_log(&1, "You will be dealt in once a seat opens.")
        )

      true ->
        invalid_action(state, "player_not_joined")
    end
  end

  defp apply_action(state, "sit_out", payload) do
    player_id = normalize_player_id(payload)

    cond do
      player = Enum.find(state.players, &(&1.player_id == player_id)) ->
        updated_state =
          state
          |> update_player(player.seat, fn current ->
            next_status =
              cond do
                state.hand_state.status == "waiting" and current.stack > 0 -> "SITTING_OUT"
                current.status in ["ACTIVE", "ALL_IN"] -> current.status
                current.stack <= 0 -> "BUSTED"
                true -> "SITTING_OUT"
              end

            current
            |> Map.put(:will_play_next_hand, false)
            |> Map.put(:status, next_status)
          end)
          |> put_in([:last_event], "player_sitting_out")

        message =
          if state.hand_state.status == "in_progress" and player.status in ["ACTIVE", "ALL_IN"] do
            "#{player.name} will sit out after this hand."
          else
            "#{player.name} is sitting out."
          end

        update_in(updated_state, [:hand_state, :action_log], &append_log(&1, message))

      Enum.any?(state.pending_players, &(&1.player_id == player_id)) ->
        state
        |> update_pending_player(player_id, &Map.put(&1, :will_play_next_hand, false))
        |> put_in([:last_event], "pending_player_sitting_out")
        |> update_in([:hand_state, :action_log], &append_log(&1, "You are waiting for a seat."))

      true ->
        invalid_action(state, "player_not_joined")
    end
  end

  defp apply_action(state, "set_card_visibility", payload) do
    player_id = normalize_player_id(payload)
    show_cards = normalize_show_cards(payload)

    cond do
      is_nil(player_id) ->
        invalid_action(state, "missing_player_id")

      player = Enum.find(state.players, &(&1.player_id == player_id)) ->
        cond do
          state.hand_state.status != "complete" ->
            invalid_action(state, "card_visibility_only_available_after_hand")

          Enum.all?(player.hole_cards, &is_nil/1) ->
            invalid_action(state, "no_cards_to_reveal")

          true ->
            visibility_label = if(show_cards, do: "shown", else: "hidden")

            state
            |> update_player(player.seat, &Map.put(&1, :show_cards, show_cards))
            |> put_in([:last_event], "player_card_visibility_changed")
            |> update_in(
              [:hand_state, :action_log],
              &append_log(&1, "#{player.name} #{visibility_label} their cards.")
            )
        end

      true ->
        invalid_action(state, "player_not_joined")
    end
  end

  defp apply_action(state, "clear_table", _payload) do
    if state.hand_state.status == "in_progress" do
      invalid_action(state, "cannot_clear_table_during_hand")
    else
      hand_state =
        state.hand_state.hand_number
        |> initial_hand_state(state.hand_state.dealer_seat)
        |> Map.put(:action_log, ["Table cleared. Add bots or reserve a seat to begin."])

      %{
        state
        | players: Enum.map(@seats, &build_empty_seat/1),
          pending_players: [],
          game_state: "waiting_for_hand",
          last_event: "table_cleared",
          hand_state: hand_state
      }
    end
  end

  defp apply_action(state, "add_bot", payload) do
    if state.hand_state.status == "in_progress" do
      invalid_action(state, "cannot_add_bot_during_hand")
    else
      requested_seat = normalize_seat(payload)

      seat_player =
        if is_nil(requested_seat) do
          Enum.find(state.players, &empty_seat?/1)
        else
          Enum.find(state.players, &(&1.seat == requested_seat))
        end

      cond do
        is_nil(seat_player) ->
          invalid_action(state, "no_open_seat_for_bot")

        not empty_seat?(seat_player) ->
          invalid_action(state, "seat_#{seat_player.seat}_unavailable_for_bot")

        true ->
          state
          |> update_player(seat_player.seat, fn _ ->
            build_bot_player(seat_player.seat, @starting_stack)
          end)
          |> put_in([:last_event], "bot_added_seat_#{seat_player.seat}")
          |> update_in(
            [:hand_state, :action_log],
            &append_log(&1, "Bot added to seat #{seat_player.seat}.")
          )
      end
    end
  end

  defp apply_action(state, "next_hand", _payload) do
    state = materialize_pending_players(state)

    if ready_player_count(state.players) < 2 do
      invalid_action(state, "not_enough_ready_players")
    else
      next_hand_number = state.hand_number + 1
      next_dealer = rotate_seat(state.hand_state.dealer_seat)
      sb_seat = rotate_seat(next_dealer)
      bb_seat = rotate_seat(sb_seat)

      players =
        state.players
        |> reset_players_for_hand()
        |> post_blind(sb_seat, @small_blind)
        |> post_blind(bb_seat, @big_blind)

      acting_seat = next_actionable_seat(players, bb_seat)

      hand_state = %{
        status: "in_progress",
        stage: "preflop",
        hand_number: next_hand_number,
        pot: @small_blind + @big_blind,
        current_bet: @big_blind,
        minimum_raise: @big_blind,
        acting_seat: acting_seat,
        dealer_seat: next_dealer,
        small_blind_seat: sb_seat,
        big_blind_seat: bb_seat,
        community_cards: @board_by_street["preflop"],
        action_log: [
          "Hand #{next_hand_number} started.",
          "Blinds posted: #{@small_blind} / #{@big_blind}.",
          "Action on seat #{acting_seat}."
        ],
        last_action: "hand_started",
        acted_seats: [],
        winner_seats: [],
        winner_amounts: %{},
        side_pots: [],
        hand_result: nil
      }

      %{
        state
        | players: players,
          hand_number: next_hand_number,
          game_state: "hand_in_progress",
          last_event: "hand_#{next_hand_number}_started",
          hand_state: hand_state
      }
    end
  end

  defp apply_action(state, action, payload) do
    if state.hand_state.status != "in_progress" do
      invalid_action(state, "ignored_#{action}_while_waiting")
    else
      process_hand_action(state, action, payload)
    end
  end

  defp process_hand_action(state, action, payload) do
    seat = state.hand_state.acting_seat

    cond do
      is_nil(seat) ->
        invalid_action(state, "no_actor_for_#{action}")

      true ->
        player = get_player!(state.players, seat)
        to_call = max(state.hand_state.current_bet - player.bet_this_street, 0)
        amount = normalize_amount(payload)

        if authorized_action?(player, payload) do
          case validate_action(state, player, action, to_call, amount) do
            {:ok, :fold} ->
              state
              |> update_player(seat, &Map.put(&1, :status, "FOLDED"))
              |> mark_acted(seat)
              |> advance_after_action(seat, "Seat #{seat} folds.", action)

            {:ok, :check} ->
              state
              |> mark_acted(seat)
              |> advance_after_action(seat, "Seat #{seat} checks.", action)

            {:ok, {:call, call_amount}} ->
              state
              |> contribute(seat, call_amount)
              |> mark_acted(seat)
              |> advance_after_action(seat, "Seat #{seat} calls #{call_amount}.", action)

            {:ok, {:bet, target}} ->
              contribution = target - player.bet_this_street

              state
              |> contribute(seat, contribution)
              |> put_in([:hand_state, :current_bet], target)
              |> put_in([:hand_state, :minimum_raise], max(@big_blind, target))
              |> reset_acted_to([seat])
              |> advance_after_action(seat, "Seat #{seat} bets #{target}.", action)

            {:ok, {:raise, target, reopens?}} ->
              contribution = target - player.bet_this_street
              raise_size = target - state.hand_state.current_bet

              updated_state =
                state
                |> contribute(seat, contribution)
                |> put_in([:hand_state, :current_bet], target)
                |> update_min_raise(reopens?, raise_size)
                |> update_acted_after_raise(seat, reopens?)

              advance_after_action(
                updated_state,
                seat,
                "Seat #{seat} raises to #{target}.",
                action
              )

            {:error, reason} ->
              invalid_action(state, reason)
          end
        else
          invalid_action(state, "unauthorized_player_action")
        end
    end
  end

  defp validate_action(state, player, action, to_call, amount) do
    max_target = player.bet_this_street + player.stack
    current_bet = state.hand_state.current_bet
    min_raise_target = current_bet + state.hand_state.minimum_raise

    cond do
      player.status != "ACTIVE" ->
        {:error, "seat_#{player.seat}_is_not_actionable"}

      action == "fold" ->
        {:ok, :fold}

      action == "check" and to_call == 0 ->
        {:ok, :check}

      action == "check" ->
        {:error, "invalid_check_with_call_#{to_call}_for_seat_#{player.seat}"}

      action == "call" and to_call > 0 ->
        {:ok, {:call, min(player.stack, to_call)}}

      action == "call" ->
        {:error, "invalid_call_without_bet_for_seat_#{player.seat}"}

      action == "bet" and current_bet != 0 ->
        {:error, "invalid_bet_when_current_bet_is_#{current_bet}"}

      action == "bet" and amount <= 0 ->
        {:error, "invalid_bet_amount_#{amount}"}

      action == "bet" and amount > max_target ->
        {:error, "invalid_bet_over_stack_#{amount}"}

      action == "bet" and amount < @big_blind and amount != max_target ->
        {:error, "invalid_bet_below_minimum_#{@big_blind}"}

      action == "bet" ->
        {:ok, {:bet, amount}}

      action == "raise" and current_bet == 0 ->
        {:error, "invalid_raise_without_bet"}

      action == "raise" and amount <= current_bet ->
        {:error, "invalid_raise_target_#{amount}_must_exceed_#{current_bet}"}

      action == "raise" and amount > max_target ->
        {:error, "invalid_raise_over_stack_#{amount}"}

      action == "raise" and amount < min_raise_target and amount != max_target ->
        {:error, "invalid_raise_below_minimum_target_#{min_raise_target}"}

      action == "raise" ->
        reopens? = amount >= min_raise_target
        {:ok, {:raise, amount, reopens?}}

      true ->
        {:error, "unsupported_action_#{action}"}
    end
  end

  defp update_min_raise(state, true, raise_size),
    do: put_in(state, [:hand_state, :minimum_raise], raise_size)

  defp update_min_raise(state, false, _raise_size), do: state

  defp update_acted_after_raise(state, seat, true), do: reset_acted_to(state, [seat])
  defp update_acted_after_raise(state, seat, false), do: mark_acted(state, seat)

  defp contribute(state, seat, amount) do
    update_player(state, seat, fn player ->
      paid = min(player.stack, max(amount, 0))

      player
      |> Map.put(:stack, player.stack - paid)
      |> Map.put(:bet_this_street, player.bet_this_street + paid)
      |> Map.put(:contributed_this_hand, player.contributed_this_hand + paid)
      |> maybe_all_in()
    end)
    |> update_in(
      [:hand_state, :pot],
      &(&1 + min(get_player!(state.players, seat).stack, max(amount, 0)))
    )
  end

  defp invalid_action(state, reason) do
    state
    |> put_in([:last_event], reason)
    |> update_in([:hand_state, :action_log], &append_log(&1, "Rejected action: #{reason}"))
  end

  defp advance_after_action(state, seat, message, action) do
    next_state =
      state
      |> put_in([:hand_state, :last_action], action)
      |> put_in([:last_event], message)
      |> update_in([:hand_state, :action_log], &append_log(&1, message))

    cond do
      one_contender_left?(next_state.players) ->
        conclude_foldout(next_state, contending_seats(next_state.players))

      street_complete?(next_state) ->
        advance_street_or_showdown(next_state)

      true ->
        case next_actionable_seat(next_state.players, seat) do
          nil -> advance_street_or_showdown(next_state)
          next_seat -> put_in(next_state, [:hand_state, :acting_seat], next_seat)
        end
    end
  end

  defp advance_street_or_showdown(state) do
    next_stage =
      case state.hand_state.stage do
        "preflop" -> "flop"
        "flop" -> "turn"
        "turn" -> "river"
        "river" -> "showdown"
        "showdown" -> "showdown"
      end

    if next_stage == "showdown" do
      conclude_showdown(state)
    else
      players = Enum.map(state.players, &Map.put(&1, :bet_this_street, 0))
      acting_seat = next_actionable_seat(players, state.hand_state.dealer_seat)
      message = "#{String.capitalize(next_stage)} dealt. Action on seat #{acting_seat || "none"}."

      updated_state =
        state
        |> Map.put(:players, players)
        |> put_in([:hand_state, :stage], next_stage)
        |> put_in([:hand_state, :community_cards], @board_by_street[next_stage])
        |> put_in([:hand_state, :acting_seat], acting_seat)
        |> put_in([:hand_state, :current_bet], 0)
        |> put_in([:hand_state, :acted_seats], [])
        |> put_in([:hand_state, :minimum_raise], @big_blind)
        |> put_in([:last_event], "#{next_stage}_dealt")
        |> update_in([:hand_state, :action_log], &append_log(&1, message))

      if is_nil(acting_seat), do: advance_street_or_showdown(updated_state), else: updated_state
    end
  end

  defp conclude_foldout(state, [winner_seat]) do
    pot = state.hand_state.pot
    winner_amounts = %{winner_seat => pot}

    players =
      state.players
      |> Enum.map(fn player ->
        player
        |> Map.put(:bet_this_street, 0)
        |> Map.put(:show_cards, player.is_bot)
        |> Map.put(:status, waiting_status(player))
      end)
      |> Enum.map(fn player ->
        %{player | stack: player.stack + Map.get(winner_amounts, player.seat, 0)}
      end)
      |> prune_disconnected_players()

    message = "Hand ends by fold. Seat #{winner_seat} wins #{pot}."

    hand_state =
      state.hand_state
      |> Map.put(:status, "complete")
      |> Map.put(:stage, "showdown")
      |> Map.put(:acting_seat, nil)
      |> Map.put(:winner_seats, [winner_seat])
      |> Map.put(:winner_amounts, winner_amounts)
      |> Map.put(:side_pots, [
        %{amount: pot, eligible_seats: [winner_seat], winner_seats: [winner_seat]}
      ])
      |> Map.put(:hand_result, %{
        heading: "Seat #{winner_seat} wins",
        lines: [message],
        hero_outcome: hero_outcome([winner_seat])
      })
      |> update_in(
        [:action_log],
        &(&1 |> append_log(message) |> append_log("Next hand starts in 5 seconds."))
      )

    %{
      state
      | players: players,
        game_state: "waiting_for_hand",
        last_event: "hand_complete",
        hand_state: hand_state
    }
  end

  defp conclude_showdown(state) do
    evaluations = showdown_evaluations(state)
    side_pots = build_side_pots(state.players)
    {winner_amounts, resolved_side_pots} = award_side_pots(side_pots, evaluations)
    winner_seats = winner_amounts |> Map.keys() |> Enum.sort()

    players =
      state.players
      |> Enum.map(fn player ->
        player
        |> Map.put(:bet_this_street, 0)
        |> Map.put(:show_cards, player.is_bot or player.status in ["ACTIVE", "ALL_IN"])
        |> Map.put(:status, waiting_status(player))
      end)
      |> Enum.map(fn player ->
        %{player | stack: player.stack + Map.get(winner_amounts, player.seat, 0)}
      end)
      |> prune_disconnected_players()

    message = showdown_message(winner_seats, winner_amounts)

    hand_state =
      state.hand_state
      |> Map.put(:status, "complete")
      |> Map.put(:stage, "showdown")
      |> Map.put(:community_cards, @board_by_street["showdown"])
      |> Map.put(:acting_seat, nil)
      |> Map.put(:winner_seats, winner_seats)
      |> Map.put(:winner_amounts, winner_amounts)
      |> Map.put(:side_pots, resolved_side_pots)
      |> Map.put(
        :hand_result,
        build_hand_result(winner_seats, winner_amounts, message, evaluations)
      )
      |> update_in(
        [:action_log],
        &(&1 |> append_log(message) |> append_log("Next hand starts in 5 seconds."))
      )

    %{
      state
      | players: players,
        game_state: "waiting_for_hand",
        last_event: "hand_complete",
        hand_state: hand_state
    }
  end

  defp build_hand_result(winner_seats, winner_amounts, message, evaluations) do
    winner_names = Enum.map_join(winner_seats, ", ", &"Seat #{&1}")

    %{
      heading:
        if(length(winner_seats) > 1,
          do: "Split pot: #{winner_names}",
          else: "#{winner_names} wins"
        ),
      lines:
        [message] ++
          Enum.map(evaluations, fn %{seat: seat, description: description} ->
            payout =
              case Map.get(winner_amounts, seat, 0) do
                0 -> ""
                amount -> " for #{amount}"
              end

            "Seat #{seat}: #{description}#{payout}"
          end),
      hero_outcome: hero_outcome(winner_seats)
    }
  end

  defp hero_outcome(winner_seats) do
    cond do
      1 in winner_seats and length(winner_seats) > 1 -> "split"
      1 in winner_seats -> "win"
      true -> "loss"
    end
  end

  defp showdown_evaluations(state) do
    board = @board_by_street["showdown"]

    state.players
    |> Enum.filter(&(&1.status in ["ACTIVE", "ALL_IN"]))
    |> Enum.map(fn player ->
      {score, description, _cards} = HandEvaluator.evaluate(player.hole_cards ++ board)
      %{seat: player.seat, score: score, description: description}
    end)
    |> Enum.sort_by(& &1.seat)
  end

  defp build_side_pots(players) do
    levels =
      players
      |> Enum.map(& &1.contributed_this_hand)
      |> Enum.filter(&(&1 > 0))
      |> Enum.uniq()
      |> Enum.sort()

    {_last_level, pots} =
      Enum.reduce(levels, {0, []}, fn level, {previous_level, acc} ->
        participants = Enum.filter(players, &(&1.contributed_this_hand >= level))

        eligible =
          participants
          |> Enum.filter(&(&1.status in ["ACTIVE", "ALL_IN"]))
          |> Enum.map(& &1.seat)

        amount = (level - previous_level) * length(participants)

        pot =
          if amount > 0 and eligible != [] do
            [%{amount: amount, eligible_seats: Enum.sort(eligible)}]
          else
            []
          end

        {level, acc ++ pot}
      end)

    pots
  end

  defp award_side_pots(side_pots, evaluations) do
    eval_by_seat = Map.new(evaluations, fn eval -> {eval.seat, eval} end)

    Enum.reduce(side_pots, {%{}, []}, fn pot, {amounts_acc, pots_acc} ->
      pot_winners = winning_seats_for_pot(pot.eligible_seats, eval_by_seat)
      split = split_amount(pot.amount, pot_winners)

      resolved_pot =
        pot
        |> Map.put(:winner_seats, pot_winners)
        |> Map.put(:winner_amounts, split)

      {merge_winner_amounts(amounts_acc, split), pots_acc ++ [resolved_pot]}
    end)
  end

  defp winning_seats_for_pot(eligible_seats, eval_by_seat) do
    contenders = Enum.map(eligible_seats, &Map.fetch!(eval_by_seat, &1))

    best_score =
      contenders
      |> Enum.map(& &1.score)
      |> Enum.reduce(fn candidate, best ->
        if HandEvaluator.compare_score(candidate, best) == :gt, do: candidate, else: best
      end)

    contenders
    |> Enum.filter(&(HandEvaluator.compare_score(&1.score, best_score) == :eq))
    |> Enum.map(& &1.seat)
    |> Enum.sort()
  end

  defp split_amount(amount, winner_seats) do
    base = div(amount, length(winner_seats))
    remainder = rem(amount, length(winner_seats))

    winner_seats
    |> Enum.with_index()
    |> Map.new(fn {seat, index} ->
      extra = if index < remainder, do: 1, else: 0
      {seat, base + extra}
    end)
  end

  defp merge_winner_amounts(left, right) do
    Map.merge(left, right, fn _seat, left_amount, right_amount -> left_amount + right_amount end)
  end

  defp showdown_message([winner_seat], winner_amounts) do
    "Showdown. Seat #{winner_seat} drags the pot of #{Map.fetch!(winner_amounts, winner_seat)}."
  end

  defp showdown_message(winner_seats, winner_amounts) do
    payouts =
      winner_seats
      |> Enum.map_join(", ", fn seat -> "Seat #{seat} (#{Map.fetch!(winner_amounts, seat)})" end)

    "Showdown. Split pot between #{payouts}."
  end

  defp contending_seats(players) do
    players
    |> Enum.filter(&(&1.status in ["ACTIVE", "ALL_IN"]))
    |> Enum.map(& &1.seat)
  end

  defp one_contender_left?(players), do: length(contending_seats(players)) == 1

  defp street_complete?(state) do
    contenders = Enum.filter(state.players, &(&1.status in ["ACTIVE", "ALL_IN"]))
    actionable = Enum.filter(state.players, &(&1.status == "ACTIVE"))

    contenders != [] and
      Enum.all?(contenders, fn player ->
        player.bet_this_street == state.hand_state.current_bet or player.status == "ALL_IN"
      end) and
      Enum.all?(actionable, &Enum.member?(state.hand_state.acted_seats, &1.seat))
  end

  defp reset_players_for_hand(players) do
    Enum.map(players, fn player ->
      cond do
        player.stack <= 0 ->
          player
          |> Map.put(:status, "BUSTED")
          |> Map.put(:show_cards, player.is_bot)
          |> Map.put(:bet_this_street, 0)
          |> Map.put(:contributed_this_hand, 0)
          |> Map.put(:hole_cards, [nil, nil])

        player.will_play_next_hand ->
          player
          |> Map.put(:status, "ACTIVE")
          |> Map.put(:show_cards, player.is_bot)
          |> Map.put(:bet_this_street, 0)
          |> Map.put(:contributed_this_hand, 0)
          |> Map.put(:hole_cards, Map.get(@starting_hands, player.seat, [nil, nil]))

        true ->
          player
          |> Map.put(:status, "SITTING_OUT")
          |> Map.put(:show_cards, player.is_bot)
          |> Map.put(:bet_this_street, 0)
          |> Map.put(:contributed_this_hand, 0)
          |> Map.put(:hole_cards, [nil, nil])
      end
    end)
  end

  defp post_blind(players, seat, blind) do
    update_player_in_list(players, seat, fn player ->
      paid = min(player.stack, blind)

      player
      |> Map.put(:stack, player.stack - paid)
      |> Map.put(:bet_this_street, paid)
      |> Map.put(:contributed_this_hand, paid)
      |> maybe_all_in()
    end)
  end

  defp mark_acted(state, seat),
    do: update_in(state, [:hand_state, :acted_seats], &Enum.uniq(&1 ++ [seat]))

  defp reset_acted_to(state, seats), do: put_in(state, [:hand_state, :acted_seats], seats)

  defp maybe_all_in(player) do
    if player.stack == 0 and player.status == "ACTIVE" do
      %{player | status: "ALL_IN"}
    else
      player
    end
  end

  defp waiting_status(player) do
    cond do
      player.stack <= 0 -> "BUSTED"
      player.will_play_next_hand -> "READY"
      true -> "SITTING_OUT"
    end
  end

  defp get_player!(players, seat) do
    case Enum.find(players, &(&1.seat == seat)) do
      nil -> raise ArgumentError, "seat #{seat} not found"
      player -> player
    end
  end

  defp update_player(state, seat, fun) do
    Map.update!(state, :players, &update_player_in_list(&1, seat, fun))
  end

  defp update_player_in_list(players, seat, fun) do
    Enum.map(players, fn player -> if player.seat == seat, do: fun.(player), else: player end)
  end

  defp append_log(entries, line), do: entries |> Kernel.++([line]) |> Enum.take(-16)

  defp normalize_amount(%{"amount" => amount}) when is_number(amount), do: round(amount)

  defp normalize_amount(%{"amount" => amount}) when is_binary(amount) do
    case Integer.parse(amount) do
      {parsed, _} -> parsed
      :error -> 0
    end
  end

  defp normalize_amount(_payload), do: 0

  defp normalize_show_cards(%{"show_cards" => show_cards}) when is_boolean(show_cards),
    do: show_cards

  defp normalize_show_cards(%{"show_cards" => show_cards}) when is_binary(show_cards) do
    String.downcase(String.trim(show_cards)) in ["true", "1", "yes", "on"]
  end

  defp normalize_show_cards(_payload), do: false

  defp parse_card_rank(<<rank::binary-size(1), _suit::binary-size(1)>>) do
    case rank do
      "2" -> 2
      "3" -> 3
      "4" -> 4
      "5" -> 5
      "6" -> 6
      "7" -> 7
      "8" -> 8
      "9" -> 9
      "T" -> 10
      "J" -> 11
      "Q" -> 12
      "K" -> 13
      "A" -> 14
    end
  end

  defp parse_card_suit(<<_rank::binary-size(1), suit::binary-size(1)>>), do: suit

  defp card_ranks(cards), do: Enum.map(cards, &parse_card_rank/1)
  defp card_suits(cards), do: Enum.map(cards, &parse_card_suit/1)

  defp clamp(value, minimum, _maximum) when value < minimum, do: minimum
  defp clamp(value, _minimum, maximum) when value > maximum, do: maximum
  defp clamp(value, _minimum, _maximum), do: value

  defp score_category(score) when is_tuple(score), do: elem(score, 0)

  defp bot_profile_for(%{seat: seat, is_bot: true}), do: Map.fetch!(@bot_profiles, seat)
  defp bot_profile_for(_player), do: %{style: "balanced", looseness: 0, aggression: 0, bluff: 0}

  defp preflop_strength([left, right]) do
    left_rank = parse_card_rank(left)
    right_rank = parse_card_rank(right)
    left_suit = parse_card_suit(left)
    right_suit = parse_card_suit(right)
    high = max(left_rank, right_rank)
    low = min(left_rank, right_rank)
    gap = high - low
    pair_bonus = if(left_rank == right_rank, do: 28 + high * 2, else: 0)
    suited_bonus = if(left_suit == right_suit, do: 5, else: 0)

    connectivity_bonus =
      cond do
        gap == 0 -> 0
        gap == 1 -> 7
        gap == 2 -> 4
        gap == 3 -> 1
        true -> -2 * min(gap - 3, 4)
      end

    broadway_bonus = Enum.count([left_rank, right_rank], &(&1 >= 10)) * 3
    ace_bonus = if(14 in [left_rank, right_rank], do: 4, else: 0)

    base =
      high * 3 + low + pair_bonus + suited_bonus + connectivity_bonus + broadway_bonus + ace_bonus

    clamp(round(base * 0.9), 18, 100)
  end

  defp preflop_strength(_cards), do: 0

  defp flush_draw?(cards) do
    cards
    |> card_suits()
    |> Enum.frequencies()
    |> Map.values()
    |> Enum.any?(&(&1 >= 4))
  end

  defp straight_draw?(cards) do
    ranks =
      cards
      |> card_ranks()
      |> Enum.uniq()
      |> then(fn values -> if 14 in values, do: [1 | values], else: values end)

    Enum.any?(1..10, fn start_rank ->
      cards_in_window =
        Enum.count(ranks, fn rank ->
          rank >= start_rank and rank <= start_rank + 4
        end)

      cards_in_window >= 4
    end)
  end

  defp draw_bonus(stage, cards) when stage in ["flop", "turn"] do
    flush_bonus = if(flush_draw?(cards), do: 8, else: 0)
    straight_bonus = if(straight_draw?(cards), do: 6, else: 0)
    combo_bonus = if(flush_bonus > 0 and straight_bonus > 0, do: 4, else: 0)
    flush_bonus + straight_bonus + combo_bonus
  end

  defp draw_bonus(_stage, _cards), do: 0

  defp pair_strength_bonus(player, community_cards) do
    hole_ranks = card_ranks(player.hole_cards)
    board_ranks = card_ranks(community_cards)
    pocket_pair? = length(Enum.uniq(hole_ranks)) == 1
    highest_board = Enum.max([0 | board_ranks])
    highest_hole = Enum.max([0 | hole_ranks])

    cond do
      pocket_pair? and highest_hole > highest_board -> 10
      highest_hole == highest_board and Enum.any?(hole_ranks, &(&1 == highest_board)) -> 7
      pocket_pair? -> 4
      true -> 0
    end
  end

  defp postflop_strength(state, player) do
    cards = player.hole_cards ++ state.hand_state.community_cards
    {score, _description, _best_cards} = HandEvaluator.evaluate(cards)

    base =
      case score_category(score) do
        0 -> 20
        1 -> 44 + pair_strength_bonus(player, state.hand_state.community_cards)
        2 -> 62
        3 -> 74
        4 -> 80
        5 -> 84
        6 -> 92
        7 -> 97
        8 -> 100
      end

    clamp(base + draw_bonus(state.hand_state.stage, cards), 20, 100)
  end

  defp board_danger(community_cards) do
    suit_pressure =
      community_cards
      |> card_suits()
      |> Enum.frequencies()
      |> Map.values()
      |> then(&Enum.max([0 | &1]))
      |> Kernel.-(2)
      |> max(0)
      |> Kernel.*(3)

    pair_pressure =
      if community_cards
         |> card_ranks()
         |> Enum.frequencies()
         |> Map.values()
         |> Enum.any?(&(&1 >= 2)),
         do: 4,
         else: 0

    straight_pressure = if(straight_draw?(community_cards), do: 4, else: 0)
    high_card_pressure = Enum.count(card_ranks(community_cards), &(&1 >= 12)) * 2
    suit_pressure + pair_pressure + straight_pressure + high_card_pressure
  end

  defp seat_distance(from_seat, to_seat) do
    to_index = Enum.find_index(@seats, &(&1 == to_seat))
    from_index = Enum.find_index(@seats, &(&1 == from_seat))
    rem(to_index - from_index + length(@seats), length(@seats))
  end

  defp position_adjustment(state, player) do
    cond do
      player.seat == state.hand_state.small_blind_seat -> -4
      player.seat == state.hand_state.big_blind_seat -> -2
      player.seat == state.hand_state.dealer_seat -> 4
      seat_distance(state.hand_state.dealer_seat, player.seat) >= 5 -> 3
      true -> 0
    end
  end

  defp decision_noise(state, player) do
    stage_seed =
      case state.hand_state.stage do
        "preflop" -> 1
        "flop" -> 2
        "turn" -> 3
        "river" -> 4
        _ -> 5
      end

    rem(state.hand_state.hand_number * 13 + player.seat * 7 + stage_seed * 11, 9) - 4
  end

  defp bot_hand_strength(state, player) do
    if state.hand_state.stage == "preflop" do
      preflop_strength(player.hole_cards)
    else
      postflop_strength(state, player)
    end
  end

  defp call_pressure(state, player, to_call) do
    pot_odds = div(to_call * 100, max(state.hand_state.pot + to_call, 1))
    stack_pressure = div(to_call * 100, max(player.stack + to_call, 1))
    pot_odds + stack_pressure
  end

  defp semi_bluff_bonus(state, player, profile) do
    cards = player.hole_cards ++ state.hand_state.community_cards
    bonus = draw_bonus(state.hand_state.stage, cards)

    cond do
      bonus == 0 -> 0
      profile.style == "lag" -> bonus + profile.bluff
      true -> div(bonus, 2)
    end
  end

  defp continue_score(state, player, profile, to_call) do
    bot_hand_strength(state, player) +
      profile.looseness +
      position_adjustment(state, player) +
      decision_noise(state, player) -
      board_danger(state.hand_state.community_cards) -
      call_pressure(state, player, to_call)
  end

  defp aggression_score(state, player, profile, to_call) do
    bot_hand_strength(state, player) +
      profile.aggression +
      semi_bluff_bonus(state, player, profile) +
      position_adjustment(state, player) +
      decision_noise(state, player) -
      div(call_pressure(state, player, to_call), 2)
  end

  defp normalized_raise_target(desired, current_bet, min_raise_target, max_target) do
    cond do
      max_target <= current_bet -> nil
      max_target < min_raise_target -> max_target
      true -> clamp(desired, min_raise_target, max_target)
    end
  end

  defp bot_bet_target(state, player, profile, strength) do
    max_target = player.bet_this_street + player.stack
    pot = max(state.hand_state.pot, @big_blind)

    factor =
      cond do
        strength >= 90 -> 1.0
        strength >= 75 -> 0.75
        true -> 0.55
      end

    desired = round(pot * (factor + profile.aggression / 100))
    clamp(desired, @big_blind, max_target)
  end

  defp bot_raise_target(state, player, profile, strength, to_call) do
    current_bet = state.hand_state.current_bet
    min_raise_target = current_bet + state.hand_state.minimum_raise
    max_target = player.bet_this_street + player.stack
    pot = max(state.hand_state.pot + to_call, @big_blind * 2)

    factor =
      cond do
        strength >= 92 -> 1.15
        strength >= 78 -> 0.85
        true -> 0.6
      end

    desired = current_bet + round(pot * (factor + profile.aggression / 100))
    normalized_raise_target(desired, current_bet, min_raise_target, max_target)
  end

  defp choose_unopened_bot_action(state, player, profile) do
    strength = bot_hand_strength(state, player)

    open_score =
      strength + profile.looseness + profile.aggression + position_adjustment(state, player) +
        decision_noise(state, player)

    semi_bluff = semi_bluff_bonus(state, player, profile)

    cond do
      open_score >= 72 or (profile.style == "lag" and strength + semi_bluff >= 52) ->
        {"bet", %{"amount" => bot_bet_target(state, player, profile, strength)}}

      true ->
        {"check", %{}}
    end
  end

  defp choose_bot_action(state, player) do
    profile = bot_profile_for(player)
    to_call = max(state.hand_state.current_bet - player.bet_this_street, 0)
    strength = bot_hand_strength(state, player)
    continue = continue_score(state, player, profile, to_call)
    aggression = aggression_score(state, player, profile, to_call)

    cond do
      to_call == 0 ->
        choose_unopened_bot_action(state, player, profile)

      aggression >= 82 and bot_raise_target(state, player, profile, strength, to_call) ->
        {"raise", %{"amount" => bot_raise_target(state, player, profile, strength, to_call)}}

      continue >= 38 ->
        {"call", %{}}

      to_call <= @big_blind and profile.style in ["calling_station", "lag"] and continue >= 28 ->
        {"call", %{}}

      true ->
        {"fold", %{}}
    end
  end

  defp fallback_bot_action(state, player) do
    to_call = max(state.hand_state.current_bet - player.bet_this_street, 0)

    cond do
      to_call == 0 -> {"check", %{}}
      to_call <= min(player.stack, @big_blind) -> {"call", %{}}
      true -> {"fold", %{}}
    end
  end

  defp validated_bot_action(state, player) do
    {action, payload} = choose_bot_action(state, player)
    to_call = max(state.hand_state.current_bet - player.bet_this_street, 0)
    amount = normalize_amount(payload)

    case validate_action(state, player, action, to_call, amount) do
      {:ok, _result} -> {action, payload}
      {:error, _reason} -> fallback_bot_action(state, player)
    end
  end

  defp apply_bot_action(state, player) do
    {action, payload} = validated_bot_action(state, player)
    apply_action(state, action, payload)
  end

  defp next_actionable_seat(players, current_seat) do
    seats =
      players
      |> Enum.filter(&(&1.status == "ACTIVE"))
      |> Enum.map(& &1.seat)
      |> Enum.sort()

    case seats do
      [] -> nil
      _ -> Enum.find(seats, &(&1 > current_seat)) || hd(seats)
    end
  end

  defp rotate_seat(seat) do
    next_index = rem(Enum.find_index(@seats, &(&1 == seat)) + 1, length(@seats))
    Enum.at(@seats, next_index)
  end

  defp ready_player_count(players) do
    players
    |> Enum.count(fn player -> player.stack > 0 and player.will_play_next_hand end)
  end

  defp normalize_player_id(%{"player_id" => player_id}) when is_binary(player_id) do
    trimmed = String.trim(player_id)
    if trimmed == "", do: nil, else: trimmed
  end

  defp normalize_player_id(_payload), do: nil

  defp normalize_seat(%{"seat" => seat}) when is_integer(seat) and seat in @seats,
    do: seat

  defp normalize_seat(%{"seat" => seat}) when is_binary(seat) do
    case Integer.parse(seat) do
      {parsed, _} when parsed in @seats -> parsed
      _ -> nil
    end
  end

  defp normalize_seat(_payload), do: nil

  defp authorized_action?(%{is_bot: true}, _payload), do: true

  defp authorized_action?(player, payload) do
    player.player_id == normalize_player_id(payload)
  end

  defp increment_connection(state, player_id) do
    connections =
      Map.update(state.client_connections, player_id, 1, &(&1 + 1))

    state
    |> Map.put(:client_connections, connections)
    |> Map.put(:connected_clients, total_connections(connections))
  end

  defp decrement_connection(state, player_id) do
    connections =
      case Map.get(state.client_connections, player_id) do
        nil -> state.client_connections
        1 -> Map.delete(state.client_connections, player_id)
        count -> Map.put(state.client_connections, player_id, count - 1)
      end

    state
    |> Map.put(:client_connections, connections)
    |> Map.put(:connected_clients, total_connections(connections))
  end

  defp total_connections(connections) do
    connections
    |> Map.values()
    |> Enum.sum()
  end

  defp reconnect_player(state, player_id) do
    state =
      case Enum.find(state.players, &(&1.player_id == player_id and not &1.is_bot)) do
        nil -> state
        player -> update_player(state, player.seat, &Map.put(&1, :connected, true))
      end

    if Enum.any?(state.pending_players, &(&1.player_id == player_id)) do
      update_pending_player(state, player_id, &Map.put(&1, :connected, true))
    else
      state
    end
  end

  defp handle_disconnect(state, player_id) do
    if Map.has_key?(state.client_connections, player_id) do
      state
    else
      state =
        case Enum.find(state.players, &(&1.player_id == player_id and not &1.is_bot)) do
          nil ->
            state

          player ->
            state
            |> update_player(player.seat, fn current ->
              current
              |> Map.put(:connected, false)
              |> Map.put(:will_play_next_hand, false)
            end)
            |> maybe_fold_disconnected_actor(player)
        end

      state
      |> update_pending_connection(player_id, false)
      |> maybe_prune_disconnected_players()
    end
  end

  defp maybe_fold_disconnected_actor(state, player) do
    if state.hand_state.status == "in_progress" and state.hand_state.acting_seat == player.seat and
         player.status == "ACTIVE" do
      apply_action(state, "fold", %{})
    else
      state
    end
  end

  defp maybe_prune_disconnected_players(state) do
    if state.hand_state.status == "waiting" do
      state
      |> Map.update!(:players, &prune_disconnected_players/1)
      |> Map.update!(:pending_players, &Enum.filter(&1, fn player -> player.connected end))
    else
      state
    end
  end

  defp prune_disconnected_players(players) do
    Enum.map(players, fn player ->
      if not player.is_bot and not player.connected and
           player.status in ["SITTING_OUT", "READY", "BUSTED"] do
        build_bot_player(player.seat, player.stack)
      else
        player
      end
    end)
  end

  defp update_pending_player(state, player_id, fun) do
    Map.update!(state, :pending_players, fn pending_players ->
      Enum.map(pending_players, fn player ->
        if player.player_id == player_id, do: fun.(player), else: player
      end)
    end)
  end

  defp update_pending_connection(state, player_id, connected) do
    if Enum.any?(state.pending_players, &(&1.player_id == player_id)) do
      update_pending_player(state, player_id, &Map.put(&1, :connected, connected))
    else
      state
    end
  end

  defp seat_unavailable?(state, seat, player_id) do
    cond do
      Enum.any?(state.players, &(&1.seat == seat and not &1.is_bot and &1.player_id != player_id)) ->
        true

      Enum.any?(state.pending_players, &(&1.desired_seat == seat and &1.player_id != player_id)) ->
        true

      true ->
        false
    end
  end

  defp materialize_pending_players(state) do
    {players, remaining_pending_players} =
      Enum.reduce(state.pending_players, {state.players, []}, fn pending_player,
                                                                 {players_acc, pending_acc} ->
        case Enum.find(players_acc, &(&1.seat == pending_player.desired_seat and &1.is_bot)) do
          nil ->
            {players_acc, pending_acc ++ [pending_player]}

          bot_seat ->
            replacement_stack = if(bot_seat.stack > 0, do: bot_seat.stack, else: @starting_stack)

            replacement = %{
              seat: bot_seat.seat,
              name: pending_player.name,
              stack: replacement_stack,
              status:
                cond do
                  replacement_stack <= 0 -> "BUSTED"
                  pending_player.will_play_next_hand -> "READY"
                  true -> "SITTING_OUT"
                end,
              will_play_next_hand: pending_player.will_play_next_hand and replacement_stack > 0,
              show_cards: false,
              is_bot: false,
              player_id: pending_player.player_id,
              connected: pending_player.connected,
              bet_this_street: 0,
              contributed_this_hand: 0,
              hole_cards: [nil, nil]
            }

            updated_players =
              Enum.map(players_acc, fn player ->
                if player.seat == bot_seat.seat, do: replacement, else: player
              end)

            {updated_players, pending_acc}
        end
      end)

    %{state | players: players, pending_players: remaining_pending_players}
  end

  defp bot_turn?(state) do
    case state.hand_state.acting_seat do
      nil ->
        false

      seat ->
        case Enum.find(state.players, &(&1.seat == seat)) do
          %{is_bot: true, status: "ACTIVE"} -> true
          _ -> false
        end
    end
  end

  defp maybe_schedule_auto_progress(%{auto_tick_scheduled: true} = state), do: state

  defp maybe_schedule_auto_progress(state) do
    case auto_progress_delay(state) do
      nil ->
        state

      delay ->
        Process.send_after(self(), :auto_progress, delay)
        Map.put(state, :auto_tick_scheduled, true)
    end
  end

  defp auto_progress_delay(state) do
    cond do
      state.game_state == "waiting_for_hand" and ready_player_count(state.players) >= 2 ->
        @auto_hand_delay

      state.hand_state.status == "in_progress" and bot_turn?(state) ->
        @auto_bot_delay

      true ->
        nil
    end
  end

  defp auto_progress(state) do
    cond do
      state.game_state == "waiting_for_hand" and ready_player_count(state.players) >= 2 ->
        apply_action(state, "next_hand", %{})

      state.hand_state.status == "in_progress" and bot_turn?(state) ->
        acting_player = get_player!(state.players, state.hand_state.acting_seat)
        apply_bot_action(state, acting_player)

      true ->
        state
    end
  end

  defp broadcast_state(state) do
    broadcast_event(state.table_id, %{type: "table_state", state: state})
  end

  defp broadcast_event(table_id, payload) do
    PubSub.broadcast(PokerBackend.PubSub, topic(table_id), {:table_event, payload})
  end
end
