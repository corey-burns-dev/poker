package game

import (
	"poker-backend/internal/models"
	"testing"
)

func TestConcludeShowdown_SplitPot(t *testing.T) {
	tbl := &Table{
		state: models.TableState{
			Players: []models.Player{
				{
					Seat:                1,
					Name:                "Alice",
					Status:              "ACTIVE",
					HoleCards:           []string{"Ah", "Kh"},
					Stack:               1000,
					ContributedThisHand: 200,
				},
				{
					Seat:                2,
					Name:                "Bob",
					Status:              "ACTIVE",
					HoleCards:           []string{"As", "Ks"},
					Stack:               1000,
					ContributedThisHand: 200,
				},
			},
			HandState: models.HandState{
				Pot:            400,
				CommunityCards: []string{"Ad", "Qc", "Jh", "Th", "2s"}, // Both have Ace-high Straight
				Stage:          "river",
			},
		},
	}

	// Initialize subsystems
	tbl.bettingEngine = NewBettingEngine(&tbl.state, tbl.log)
	tbl.showdownResolver = NewShowdownResolver(&tbl.state, tbl.log)
	tbl.presenceTracker = NewPresenceTracker(&tbl.state, tbl.log)

	tbl.concludeShowdown()

	if len(tbl.state.HandState.WinnerSeats) != 2 {
		t.Errorf("Expected 2 winners, got %d", len(tbl.state.HandState.WinnerSeats))
	}

	expectedAmount := 200

	aliceAmount := tbl.state.HandState.WinnerAmounts["1"]
	bobAmount := tbl.state.HandState.WinnerAmounts["2"]

	if aliceAmount != expectedAmount {
		t.Errorf("Expected Alice to win %d, got %d", expectedAmount, aliceAmount)
	}
	if bobAmount != expectedAmount {
		t.Errorf("Expected Bob to win %d, got %d", expectedAmount, bobAmount)
	}

	if tbl.state.Players[0].Stack != 1200 {
		t.Errorf("Expected Alice stack to be 1200, got %d", tbl.state.Players[0].Stack)
	}
	if tbl.state.Players[1].Stack != 1200 {
		t.Errorf("Expected Bob stack to be 1200, got %d", tbl.state.Players[1].Stack)
	}
}

func TestConcludeShowdown_SplitPot_Remainder(t *testing.T) {
	tbl := &Table{
		state: models.TableState{
			Players: []models.Player{
				{
					Seat:                1,
					Name:                "Alice",
					Status:              "ACTIVE",
					HoleCards:           []string{"Ah", "Kh"},
					Stack:               1000,
					ContributedThisHand: 201,
				},
				{
					Seat:                2,
					Name:                "Bob",
					Status:              "ACTIVE",
					HoleCards:           []string{"As", "Ks"},
					Stack:               1000,
					ContributedThisHand: 200,
				},
			},
			HandState: models.HandState{
				Pot:            401,
				CommunityCards: []string{"Ad", "Qc", "Jh", "Th", "2s"},
				Stage:          "river",
			},
		},
	}

	// Initialize subsystems
	tbl.bettingEngine = NewBettingEngine(&tbl.state, tbl.log)
	tbl.showdownResolver = NewShowdownResolver(&tbl.state, tbl.log)
	tbl.presenceTracker = NewPresenceTracker(&tbl.state, tbl.log)

	tbl.concludeShowdown()

	aliceAmount := tbl.state.HandState.WinnerAmounts["1"]
	bobAmount := tbl.state.HandState.WinnerAmounts["2"]

	if aliceAmount+bobAmount != 401 {
		t.Errorf("Expected total win to be 401, got %d", aliceAmount+bobAmount)
	}

	if (aliceAmount == 201 && bobAmount == 200) || (aliceAmount == 200 && bobAmount == 201) {
		// OK
	} else {
		t.Errorf("Expected split to be 201/200, got %d/%d", aliceAmount, bobAmount)
	}
}

func TestLeave_DisconnectsPlayer(t *testing.T) {
	playerID := "test@example.com"
	tbl := &Table{
		state: models.TableState{
			Players: []models.Player{
				{
					Seat:      1,
					Name:      "Test Player",
					PlayerID:  &playerID,
					IsBot:     false,
					Connected: true,
				},
			},
			ClientConnections: map[string]int{playerID: 1},
		},
	}

	// Initialize subsystems
	tbl.bettingEngine = NewBettingEngine(&tbl.state, tbl.log)
	tbl.showdownResolver = NewShowdownResolver(&tbl.state, tbl.log)
	tbl.presenceTracker = NewPresenceTracker(&tbl.state, tbl.log)

	tbl.Leave(playerID)

	if tbl.state.Players[0].Connected {
		t.Errorf("Expected player to be disconnected")
	}
	if tbl.state.ClientConnections[playerID] != 0 {
		t.Errorf("Expected client connections to be 0, got %d", tbl.state.ClientConnections[playerID])
	}
}
