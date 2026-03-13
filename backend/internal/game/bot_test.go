package game

import (
	"poker-backend/internal/models"
	"testing"
)

func TestChooseBotAction_Preflop(t *testing.T) {
	tbl := NewTable("test", false)
	player := models.Player{
		Seat:      1,
		IsBot:     true,
		HoleCards: []string{"Ah", "Ad"}, // Very strong
		Stack:     5000,
	}

	tbl.state.HandState = models.HandState{
		Status:     "in_progress",
		Stage:      "preflop",
		CurrentBet: 20,
	}

	action, payload := tbl.chooseBotAction(player)
	if action == "fold" {
		t.Errorf("Bot should not fold Pocket Aces preflop")
	}
	if action == "raise" {
		amount := payload["amount"].(int)
		if amount <= 20 {
			t.Errorf("Raise amount should be greater than current bet, got %d", amount)
		}
	}
}

func TestChooseBotAction_Postflop_Strong(t *testing.T) {
	tbl := NewTable("test", false)
	player := models.Player{
		Seat:      1,
		IsBot:     true,
		HoleCards: []string{"Ah", "Ad"},
		Stack:     5000,
	}

	tbl.state.HandState = models.HandState{
		Status:         "in_progress",
		Stage:          "flop",
		CommunityCards: []string{"As", "2c", "7d"}, // Trip Aces
		CurrentBet:     0,
		Pot:            100,
	}

	action, _ := tbl.chooseBotAction(player)
	// With Trip Aces and no bet, should likely bet or check (CFR based)
	if action == "fold" {
		t.Errorf("Bot should not fold Set of Aces")
	}
}
