package game

import (
	"poker-backend/internal/models"
	"testing"
)

func TestConcludeShowdown_SidePots(t *testing.T) {
	// Scenario:
	// Alice (Seat 1): All-in for 100
	// Bob (Seat 2): All-in for 500
	// Charlie (Seat 3): All-in for 500
	// Total Pot: 1100
	// Alice has the best hand.
	// Bob has the second best hand.
	
	// Alice should win 300.
	// Bob should win 800.
	
	tbl := &Table{
		state: models.TableState{
			Players: []models.Player{
				{
					Seat:                1,
					Name:                "Alice",
					Status:              "ALL_IN",
					Stack:               0,
					ContributedThisHand: 100,
					HoleCards:           []string{"Ah", "As"}, // Best hand: Three of a kind Aces
				},
				{
					Seat:                2,
					Name:                "Bob",
					Status:              "ALL_IN",
					Stack:               0,
					ContributedThisHand: 500,
					HoleCards:           []string{"Kh", "Ks"}, // Second best: Pair of Kings
				},
				{
					Seat:                3,
					Name:                "Charlie",
					Status:              "ALL_IN",
					Stack:               0,
					ContributedThisHand: 500,
					HoleCards:           []string{"2h", "3s"}, // Worst hand: High card
				},
			},
			HandState: models.HandState{
				Pot:            1100,
				CommunityCards: []string{"Ad", "5c", "8h", "Td", "2s"},
				Stage:          "river",
				Status:         "in_progress",
			},
		},
	}

	tbl.concludeShowdown()

	aliceWin := tbl.state.HandState.WinnerAmounts["1"]
	bobWin := tbl.state.HandState.WinnerAmounts["2"]
	charlieWin := tbl.state.HandState.WinnerAmounts["3"]

	if aliceWin != 300 {
		t.Errorf("Expected Alice to win 300, got %d", aliceWin)
	}
	if bobWin != 800 {
		t.Errorf("Expected Bob to win 800, got %d", bobWin)
	}
	if charlieWin != 0 {
		t.Errorf("Expected Charlie to win 0, got %d", charlieWin)
	}
}
