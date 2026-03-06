defmodule PokerBackend.HandEvaluator do
  @moduledoc false

  @rank_values %{
    "2" => 2,
    "3" => 3,
    "4" => 4,
    "5" => 5,
    "6" => 6,
    "7" => 7,
    "8" => 8,
    "9" => 9,
    "T" => 10,
    "J" => 11,
    "Q" => 12,
    "K" => 13,
    "A" => 14
  }

  def evaluate(cards) when is_list(cards) and length(cards) >= 5 do
    cards
    |> combinations(5)
    |> Enum.map(&score_five/1)
    |> Enum.reduce(fn candidate, best ->
      if compare_score(elem(candidate, 0), elem(best, 0)) == :gt, do: candidate, else: best
    end)
  end

  def compare(left_cards, right_cards) do
    compare_score(elem(evaluate(left_cards), 0), elem(evaluate(right_cards), 0))
  end

  def compare_score(left, right) do
    left_list = score_to_list(left)
    right_list = score_to_list(right)

    cond do
      left_list > right_list -> :gt
      left_list < right_list -> :lt
      true -> :eq
    end
  end

  defp score_to_list(score) when is_tuple(score), do: score |> Tuple.to_list() |> Enum.flat_map(&flatten_score/1)
  defp flatten_score(value) when is_list(value), do: value
  defp flatten_score(value), do: [value]

  defp score_five(cards) do
    parsed = Enum.map(cards, &parse_card/1)
    ranks = Enum.map(parsed, &elem(&1, 0))
    suits = Enum.map(parsed, &elem(&1, 1))
    sorted_desc = Enum.sort(ranks, :desc)
    frequencies = rank_frequencies(ranks)
    frequency_groups =
      frequencies
      |> Enum.map(fn {rank, count} -> {count, rank} end)
      |> Enum.sort_by(fn {count, rank} -> {-count, -rank} end)

    flush? = Enum.uniq(suits) |> length() == 1
    straight_high = straight_high(ranks)

    cond do
      flush? and straight_high ->
        {{8, straight_high}, description(:straight_flush, [straight_high]), cards}

      match?([{4, _}, {1, _}], frequency_groups) ->
        [{4, four_rank}, {1, kicker}] = frequency_groups
        {{7, four_rank, kicker}, description(:four_of_a_kind, [four_rank]), cards}

      match?([{3, _}, {2, _}], frequency_groups) ->
        [{3, triple_rank}, {2, pair_rank}] = frequency_groups
        {{6, triple_rank, pair_rank}, description(:full_house, [triple_rank, pair_rank]), cards}

      flush? ->
        {{5, sorted_desc}, description(:flush, sorted_desc), cards}

      straight_high ->
        {{4, straight_high}, description(:straight, [straight_high]), cards}

      match?([{3, _}, {1, _}, {1, _}], frequency_groups) ->
        [{3, triple_rank}, {1, kicker_one}, {1, kicker_two}] = frequency_groups
        {{3, triple_rank, kicker_one, kicker_two}, description(:three_of_a_kind, [triple_rank]), cards}

      match?([{2, _}, {2, _}, {1, _}], frequency_groups) ->
        [{2, high_pair}, {2, low_pair}, {1, kicker}] = frequency_groups
        {{2, high_pair, low_pair, kicker}, description(:two_pair, [high_pair, low_pair]), cards}

      match?([{2, _}, {1, _}, {1, _}, {1, _}], frequency_groups) ->
        [{2, pair_rank}, {1, kicker_one}, {1, kicker_two}, {1, kicker_three}] = frequency_groups
        {{1, pair_rank, kicker_one, kicker_two, kicker_three}, description(:pair, [pair_rank]), cards}

      true ->
        {{0, sorted_desc}, description(:high_card, sorted_desc), cards}
    end
  end

  defp parse_card(<<rank::binary-size(1), suit::binary-size(1)>>) do
    {Map.fetch!(@rank_values, rank), suit}
  end

  defp rank_frequencies(ranks) do
    ranks
    |> Enum.frequencies()
    |> Enum.to_list()
  end

  defp straight_high(ranks) do
    unique = Enum.uniq(ranks)
    wheel = if 14 in unique, do: [1 | unique], else: unique

    wheel
    |> Enum.sort()
    |> Enum.chunk_every(5, 1, :discard)
    |> Enum.reduce(nil, fn window, acc ->
      if consecutive?(window) do
        Enum.max(window)
      else
        acc
      end
    end)
  end

  defp consecutive?([a, b, c, d, e]), do: b == a + 1 and c == b + 1 and d == c + 1 and e == d + 1

  defp combinations(_list, 0), do: [[]]
  defp combinations([], _size), do: []

  defp combinations([head | tail], size) do
    with_head = Enum.map(combinations(tail, size - 1), &[head | &1])
    without_head = combinations(tail, size)
    with_head ++ without_head
  end

  defp description(:straight_flush, [high]), do: "Straight flush, #{rank_name(high)} high"
  defp description(:four_of_a_kind, [rank]), do: "Four of a kind, #{plural_rank_name(rank)}"
  defp description(:full_house, [triple, pair]), do: "Full house, #{plural_rank_name(triple)} over #{plural_rank_name(pair)}"
  defp description(:flush, [high | _]), do: "Flush, #{rank_name(high)} high"
  defp description(:straight, [high]), do: "Straight, #{rank_name(high)} high"
  defp description(:three_of_a_kind, [rank]), do: "Three of a kind, #{plural_rank_name(rank)}"
  defp description(:two_pair, [high, low]), do: "Two pair, #{plural_rank_name(high)} and #{plural_rank_name(low)}"
  defp description(:pair, [rank]), do: "Pair of #{plural_rank_name(rank)}"
  defp description(:high_card, [high | _]), do: "High card, #{rank_name(high)}"

  defp rank_name(14), do: "Ace"
  defp rank_name(13), do: "King"
  defp rank_name(12), do: "Queen"
  defp rank_name(11), do: "Jack"
  defp rank_name(10), do: "Ten"
  defp rank_name(9), do: "Nine"
  defp rank_name(8), do: "Eight"
  defp rank_name(7), do: "Seven"
  defp rank_name(6), do: "Six"
  defp rank_name(5), do: "Five"
  defp rank_name(4), do: "Four"
  defp rank_name(3), do: "Three"
  defp rank_name(2), do: "Two"
  defp rank_name(1), do: "Five"

  defp plural_rank_name(14), do: "Aces"
  defp plural_rank_name(13), do: "Kings"
  defp plural_rank_name(12), do: "Queens"
  defp plural_rank_name(11), do: "Jacks"
  defp plural_rank_name(10), do: "Tens"
  defp plural_rank_name(9), do: "Nines"
  defp plural_rank_name(8), do: "Eights"
  defp plural_rank_name(7), do: "Sevens"
  defp plural_rank_name(6), do: "Sixes"
  defp plural_rank_name(5), do: "Fives"
  defp plural_rank_name(4), do: "Fours"
  defp plural_rank_name(3), do: "Threes"
  defp plural_rank_name(2), do: "Twos"
end
