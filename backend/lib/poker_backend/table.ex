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
  # Three archetypes, distributed across 8 seats with slight per-seat variance.
  #   tight      – cautious, folds marginal hands, small bets
  #   balanced   – follows CFR closely, moderate sizing
  #   aggressive – bluffs more, bigger bets, rarely folds pre-flop
  @bot_profiles %{
    1 => %{style: "tight", looseness: -14, aggression: 4, bluff: 1},
    2 => %{style: "aggressive", looseness: 12, aggression: 20, bluff: 9},
    3 => %{style: "balanced", looseness: 2, aggression: 8, bluff: 3},
    4 => %{style: "tight", looseness: -12, aggression: 5, bluff: 1},
    5 => %{style: "aggressive", looseness: 14, aggression: 22, bluff: 11},
    6 => %{style: "balanced", looseness: 4, aggression: 10, bluff: 4},
    7 => %{style: "tight", looseness: -16, aggression: 3, bluff: 0},
    8 => %{style: "aggressive", looseness: 10, aggression: 18, bluff: 7}
  }

  @ranks ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"]
  @suits ["c", "d", "h", "s"]

  # CFR-derived action probabilities aggregated from Leduc poker training
  # (exploitability ~0.002 after 10,000 iterations).
  # Tuples are {fold, passive, aggressive} × 1000.
  # Bucketing: strength=weak/medium/strong, round=preflop/postflop,
  #            pair=whether player has a made hand (pair+) on board,
  #            facing_bet=whether there is a bet to call.
  # CFR+ policy trained on universal_poker (3-rank, 2-suit, 2 hole cards, 1 board card).
  # Values are {fold, passive, aggressive} weights out of 1000.
  # Buckets absent from training (impossible in 3-rank game) retain Leduc fallbacks.
  @cfr_table %{
    # --- preflop ---
    "weak_preflop_nopair_nobet" => {0, 813, 187},
    "weak_preflop_nopair_bet" => {441, 541, 18},
    "medium_preflop_nopair_nobet" => {153, 444, 403},
    "medium_preflop_nopair_bet" => {5, 886, 109},
    "strong_preflop_nopair_nobet" => {0, 122, 878},
    "strong_preflop_nopair_bet" => {0, 685, 315},
    "strong_preflop_pair_nobet" => {167, 166, 667},
    "strong_preflop_pair_bet" => {241, 538, 221},
    # --- postflop ---
    "weak_postflop_nopair_nobet" => {0, 841, 159},
    "weak_postflop_nopair_bet" => {761, 228, 11},
    "weak_postflop_pair_nobet" => {0, 110, 890},
    "weak_postflop_pair_bet" => {2, 531, 467},
    "medium_postflop_nopair_nobet" => {0, 726, 274},
    "medium_postflop_nopair_bet" => {764, 182, 54},
    "medium_postflop_pair_nobet" => {0, 609, 391},
    "medium_postflop_pair_bet" => {228, 592, 180},
    "strong_postflop_nopair_nobet" => {0, 783, 217},
    "strong_postflop_nopair_bet" => {398, 594, 7},
    "strong_postflop_pair_nobet" => {0, 384, 616},
    "strong_postflop_pair_bet" => {59, 667, 274}
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
      deck: [],
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
          |> Map.put(:will_play_next_hand, true)
          |> Map.put(:desired_seat, requested_seat)
        end)
        |> put_in([:last_event], "player_waiting")
        |> update_in(
          [:hand_state, :action_log],
          &append_log(&1, "#{pending.name} is waiting for seat #{requested_seat}.")
        )

      true ->
        seat_player = get_player!(state.players, requested_seat)

        if seat_claim_immediate?(state, seat_player) do
          replacement_stack =
            if(seat_player.stack > 0, do: seat_player.stack, else: @starting_stack)

          next_status =
            cond do
              replacement_stack <= 0 -> "BUSTED"
              state.hand_state.status == "in_progress" -> "SITTING_OUT"
              true -> "READY"
            end

          next_state =
            state
            |> update_player(requested_seat, fn _current ->
              %{
                seat: requested_seat,
                name: player_name,
                stack: replacement_stack,
                status: next_status,
                will_play_next_hand: replacement_stack > 0,
                show_cards: false,
                is_bot: false,
                bot_style: nil,
                player_id: player_id,
                connected: true,
                bet_this_street: 0,
                contributed_this_hand: 0,
                hole_cards: [nil, nil]
              }
            end)
            |> put_in([:last_event], "player_joined_seat")

          message =
            if state.hand_state.status == "in_progress" do
              "#{player_name} claimed seat #{requested_seat}. Ready for next hand."
            else
              "#{player_name} is seated at seat #{requested_seat}."
            end

          update_in(next_state, [:hand_state, :action_log], &append_log(&1, message))
        else
          pending_player = %{
            player_id: player_id,
            name: player_name,
            connected: true,
            will_play_next_hand: true,
            show_cards: false,
            desired_seat: requested_seat
          }

          state
          |> update_in([:pending_players], &(&1 ++ [pending_player]))
          |> put_in([:last_event], "player_joined_waitlist")
          |> update_in(
            [:hand_state, :action_log],
            &append_log(&1, "#{player_name} reserved seat #{requested_seat} for the next hand.")
          )
        end
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

      %{dealer: next_dealer, small_blind: sb_seat, big_blind: bb_seat, acting_seat: acting_seat} =
        next_hand_positions(state.players, state.hand_state.dealer_seat)

      players =
        state.players
        |> reset_players_for_hand()
        |> post_blind(sb_seat, @small_blind)
        |> post_blind(bb_seat, @big_blind)

      {players, deck} = deal_hole_cards(players, next_dealer)

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
        community_cards: [],
        deck: deck,
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

      {community_cards, deck} =
        deal_community_cards(state.hand_state.community_cards, state.hand_state.deck, next_stage)

      acting_seat = next_actionable_seat(players, state.hand_state.dealer_seat)
      message = "#{String.capitalize(next_stage)} dealt. Action on seat #{acting_seat || "none"}."

      updated_state =
        state
        |> Map.put(:players, players)
        |> put_in([:hand_state, :stage], next_stage)
        |> put_in([:hand_state, :community_cards], community_cards)
        |> put_in([:hand_state, :deck], deck)
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
        heading: "Seat #{winner_seat} wins by fold",
        lines: [message],
        hero_outcome: hero_outcome([winner_seat])
      })
      |> update_in(
        [:action_log],
        &(&1 |> append_log(message) |> append_log(next_hand_prompt(state)))
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
        &(&1 |> append_log(message) |> append_log(next_hand_prompt(state)))
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
    board = state.hand_state.community_cards

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
          |> Map.put(:hole_cards, [nil, nil])

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
  defp bot_profile_for(_player), do: %{style: "balanced", looseness: 2, aggression: 8, bluff: 3}

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

  defp bot_hand_strength(state, player) do
    if state.hand_state.stage == "preflop" do
      preflop_strength(player.hole_cards)
    else
      postflop_strength(state, player)
    end
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

  defp cfr_strength_preflop(score) do
    cond do
      score >= 65 -> "strong"
      score >= 40 -> "medium"
      true -> "weak"
    end
  end

  defp cfr_postflop_bucket(state, player) do
    cards = player.hole_cards ++ state.hand_state.community_cards
    {score, _desc, _best} = HandEvaluator.evaluate(cards)
    category = score_category(score)

    cond do
      category >= 3 -> {"strong", true}
      category >= 1 -> {"medium", true}
      true -> {"weak", false}
    end
  end

  defp cfr_key(strength, stage, has_pair, facing_bet) do
    round = if stage == "preflop", do: "preflop", else: "postflop"
    pair_str = if has_pair, do: "pair", else: "nopair"
    bet_str = if facing_bet, do: "bet", else: "nobet"
    "#{strength}_#{round}_#{pair_str}_#{bet_str}"
  end

  defp cfr_profile_adjust({fold, _passive, aggr}, profile) do
    {fold_shift, aggr_shift} =
      case profile.style do
        "tight" -> {90, -60}
        "aggressive" -> {-70, 100}
        _ -> {0, 0}
      end

    fold_adj = clamp(fold + fold_shift, 0, 1000)
    aggr_adj = clamp(aggr + aggr_shift, 0, 1000)
    passive_adj = clamp(1000 - fold_adj - aggr_adj, 0, 1000)
    {fold_adj, passive_adj, aggr_adj}
  end

  defp cfr_sample(_state, _player, {fold, passive, _aggr}) do
    n = :rand.uniform(1000) - 1

    cond do
      n < fold -> :fold
      n < fold + passive -> :passive
      true -> :aggressive
    end
  end

  defp choose_bot_action(state, player) do
    profile = bot_profile_for(player)
    to_call = max(state.hand_state.current_bet - player.bet_this_street, 0)
    stage = state.hand_state.stage
    facing_bet = to_call > 0

    {strength, has_pair} =
      if stage == "preflop" do
        s = preflop_strength(player.hole_cards)
        {cfr_strength_preflop(s), false}
      else
        cfr_postflop_bucket(state, player)
      end

    key = cfr_key(strength, stage, has_pair, facing_bet)
    raw = Map.get(@cfr_table, key, {0, 500, 500})
    probs = cfr_profile_adjust(raw, profile)
    hand_strength = bot_hand_strength(state, player)

    # Stack pressure guard: bots should not casually call off large portions of
    # their stack with weak or medium hands. Mimics basic pot-odds awareness.
    stack_committed = if player.stack > 0, do: to_call / player.stack, else: 0.0

    decision =
      cond do
        # Tight bots fold weak hands preflop
        facing_bet and stage == "preflop" and profile.style == "tight" and hand_strength <= 52 ->
          :fold

        # Weak hand facing a call of 40%+ of stack → always fold (except aggressive style)
        facing_bet and stack_committed >= 0.4 and strength == "weak" and
            profile.style != "aggressive" ->
          :fold

        # Medium hand facing a near-shove (80%+ of stack) → fold unless aggressive
        facing_bet and stack_committed >= 0.8 and strength == "medium" and
            profile.style == "tight" ->
          :fold

        true ->
          cfr_sample(state, player, probs)
      end

    if facing_bet do
      case decision do
        :fold ->
          {"fold", %{}}

        :passive ->
          {"call", %{}}

        :aggressive ->
          raise_target = bot_raise_target(state, player, profile, hand_strength, to_call)
          if raise_target, do: {"raise", %{"amount" => raise_target}}, else: {"call", %{}}
      end
    else
      case decision do
        :aggressive ->
          {"bet", %{"amount" => bot_bet_target(state, player, profile, hand_strength)}}

        _ ->
          {"check", %{}}
      end
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

    next_seat(seats, current_seat)
  end

  defp rotate_seat(seat) do
    next_index = rem(Enum.find_index(@seats, &(&1 == seat)) + 1, length(@seats))
    Enum.at(@seats, next_index)
  end

  defp ready_player_count(players) do
    players
    |> Enum.count(fn player -> player.stack > 0 and player.will_play_next_hand end)
  end

  defp next_hand_positions(players, previous_dealer) do
    ready_seats =
      players
      |> Enum.filter(&(&1.stack > 0 and &1.will_play_next_hand))
      |> Enum.map(& &1.seat)
      |> Enum.sort()

    dealer = next_seat(ready_seats, previous_dealer)

    case ready_seats do
      [_first, _second] ->
        big_blind = next_seat(ready_seats, dealer)

        %{
          dealer: dealer,
          small_blind: dealer,
          big_blind: big_blind,
          acting_seat: dealer
        }

      _ ->
        small_blind = next_seat(ready_seats, dealer)
        big_blind = next_seat(ready_seats, small_blind)

        %{
          dealer: dealer,
          small_blind: small_blind,
          big_blind: big_blind,
          acting_seat: next_seat(ready_seats, big_blind)
        }
    end
  end

  defp next_seat([], _current_seat), do: nil

  defp next_seat(seats, current_seat) do
    Enum.find(seats, &(&1 > current_seat)) || hd(seats)
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

  defp seat_claim_immediate?(state, seat_player) do
    empty_seat?(seat_player) or state.hand_state.status != "in_progress"
  end

  defp deal_hole_cards(players, dealer_seat) do
    active_seats = active_hand_seats(players)

    ordered_seats =
      case active_seats do
        [_, _] ->
          ordered_seats_from(active_seats, dealer_seat)

        _ ->
          first_seat = next_seat(active_seats, dealer_seat)
          ordered_seats_from(active_seats, first_seat)
      end

    deck = shuffled_deck()

    {cards_by_seat, deck} =
      Enum.reduce(1..2, {%{}, deck}, fn _round, {cards_acc, deck_acc} ->
        Enum.reduce(ordered_seats, {cards_acc, deck_acc}, fn seat, {seat_acc, [card | rest]} ->
          {Map.update(seat_acc, seat, [card], &(&1 ++ [card])), rest}
        end)
      end)

    dealt_players =
      Enum.map(players, fn player ->
        Map.put(player, :hole_cards, Map.get(cards_by_seat, player.seat, [nil, nil]))
      end)

    {dealt_players, deck}
  end

  defp deal_community_cards(board, deck, next_stage) do
    draw_count =
      case next_stage do
        "flop" -> 3
        "turn" -> 1
        "river" -> 1
        _ -> 0
      end

    {drawn_cards, remaining_deck} = Enum.split(deck, draw_count)
    {board ++ drawn_cards, remaining_deck}
  end

  defp shuffled_deck do
    for(rank <- @ranks, suit <- @suits, do: rank <> suit)
    |> Enum.shuffle()
  end

  defp active_hand_seats(players) do
    players
    |> Enum.filter(&(&1.status in ["ACTIVE", "ALL_IN"]))
    |> Enum.map(& &1.seat)
    |> Enum.sort()
  end

  defp ordered_seats_from([], _start_seat), do: []

  defp ordered_seats_from(seats, start_seat) do
    {before_start, from_start} = Enum.split_while(seats, &(&1 < start_seat))
    from_start ++ before_start
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
      auto_start_next_hand?(state) ->
        @auto_hand_delay

      state.hand_state.status == "in_progress" and bot_turn?(state) ->
        @auto_bot_delay

      true ->
        nil
    end
  end

  defp auto_progress(state) do
    cond do
      auto_start_next_hand?(state) ->
        apply_action(state, "next_hand", %{})

      state.hand_state.status == "in_progress" and bot_turn?(state) ->
        acting_player = get_player!(state.players, state.hand_state.acting_seat)
        apply_bot_action(state, acting_player)

      true ->
        state
    end
  end

  defp auto_start_next_hand?(state) do
    state.game_state == "waiting_for_hand" and ready_player_count(state.players) >= 2 and
      ready_human_player_count(state.players) == 0
  end

  defp ready_human_player_count(players) do
    players
    |> Enum.count(fn player ->
      not player.is_bot and player.stack > 0 and player.will_play_next_hand
    end)
  end

  defp next_hand_prompt(state) do
    if auto_start_next_hand?(state),
      do: "Next hand starts in 5 seconds.",
      else: "Press Start Next Hand when ready."
  end

  defp broadcast_state(state) do
    broadcast_event(state.table_id, %{type: "table_state", state: state})
  end

  defp broadcast_event(table_id, payload) do
    PubSub.broadcast(PokerBackend.PubSub, topic(table_id), {:table_event, payload})
  end
end
