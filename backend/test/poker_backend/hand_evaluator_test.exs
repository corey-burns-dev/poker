defmodule PokerBackend.HandEvaluatorTest do
  use ExUnit.Case, async: true

  alias PokerBackend.HandEvaluator

  test "detects a straight flush" do
    {score, description, _cards} = HandEvaluator.evaluate(["Ah", "Kh", "Qh", "Jh", "Th", "2c", "3d"])

    assert score == {8, 14}
    assert description == "Straight flush, Ace high"
  end

  test "detects full house over a flush" do
    {score, description, _cards} = HandEvaluator.evaluate(["Ah", "Ad", "Ac", "Kd", "Kh", "2h", "3h"])

    assert score == {6, 14, 13}
    assert description == "Full house, Aces over Kings"
  end

  test "supports wheel straights" do
    {score, description, _cards} = HandEvaluator.evaluate(["Ah", "2d", "3s", "4c", "5h", "Kd", "Qs"])

    assert score == {4, 5}
    assert description == "Straight, Five high"
  end

  test "compares two hands correctly" do
    left = ["Ah", "Ad", "Ac", "Kd", "Kh", "2c", "3d"]
    right = ["Kh", "Kd", "Kc", "Qd", "Qh", "2s", "3c"]

    assert HandEvaluator.compare(left, right) == :gt
  end

  test "returns equal for split-pot hands" do
    board = ["Ah", "Kd", "Qs", "Jc", "Tc"]
    left = ["2h", "3d"] ++ board
    right = ["4h", "5d"] ++ board

    assert HandEvaluator.compare(left, right) == :eq
  end
end
