package game

import (
	"fmt"
	"poker-backend/internal/models"
	"sort"
)

func (t *Table) processHandAction(action string, payload map[string]interface{}) {
	if t.state.HandState.ActingSeat == nil {
		t.invalidAction("no_actor_for_" + action)
		return
	}
	seat := *t.state.HandState.ActingSeat
	var player *models.Player
	playerIdx := -1
	for i := range t.state.Players {
		if t.state.Players[i].Seat == seat {
			player = &t.state.Players[i]
			playerIdx = i
			break
		}
	}
	if player == nil || player.Status != "ACTIVE" {
		t.invalidAction("invalid_actor")
		return
	}

	// Validate that the authenticated user matches the acting player
	if playerID, ok := payload["player_id"].(string); ok {
		if player.PlayerID == nil || *player.PlayerID != playerID {
			t.invalidAction("unauthorized_action")
			return
		}
	} else {
		t.invalidAction("missing_player_id")
		return
	}
	toCall := t.state.HandState.CurrentBet - player.BetThisStreet
	if toCall < 0 {
		toCall = 0
	}
	amount := t.normalizeAmount(payload["amount"])
	switch action {
	case "fold":
		player.Status = "FOLDED"
		t.markActed(seat)
		t.advanceAfterAction(seat, fmt.Sprintf("Seat %d folds.", seat), action)
	case "check":
		if toCall == 0 {
			t.markActed(seat)
			t.advanceAfterAction(seat, fmt.Sprintf("Seat %d checks.", seat), action)
		} else {
			t.invalidAction("invalid_check")
		}
	case "call":
		if toCall > 0 {
			paid := toCall
			if player.Stack < toCall {
				paid = player.Stack
			}
			t.contribute(playerIdx, paid)
			t.markActed(seat)
			t.advanceAfterAction(seat, fmt.Sprintf("Seat %d calls %d.", seat, paid), action)
		} else {
			t.invalidAction("invalid_call")
		}
	case "bet":
		if t.state.HandState.CurrentBet == 0 && amount >= BigBlind && amount <= player.Stack {
			t.contribute(playerIdx, amount)
			t.state.HandState.CurrentBet = amount
			t.state.HandState.MinimumRaise = amount
			t.resetActedTo([]int{seat})
			t.advanceAfterAction(seat, fmt.Sprintf("Seat %d bets %d.", seat, amount), action)
		} else {
			t.invalidAction("invalid_bet")
		}
	case "raise":
		minRaise := t.state.HandState.CurrentBet + t.state.HandState.MinimumRaise
		if amount >= minRaise && amount <= player.BetThisStreet+player.Stack {
			contribution := amount - player.BetThisStreet
			raiseSize := amount - t.state.HandState.CurrentBet
			t.contribute(playerIdx, contribution)
			t.state.HandState.CurrentBet = amount
			t.state.HandState.MinimumRaise = raiseSize
			t.resetActedTo([]int{seat})
			t.advanceAfterAction(seat, fmt.Sprintf("Seat %d raises to %d.", seat, amount), action)
		} else {
			t.invalidAction("invalid_raise")
		}
	}
}

func (t *Table) contribute(playerIdx int, amount int) {
	p := &t.state.Players[playerIdx]
	p.Stack -= amount
	p.BetThisStreet += amount
	p.ContributedThisHand += amount
	t.state.HandState.Pot += amount
	if p.Stack == 0 {
		p.Status = "ALL_IN"
	}
}

func (t *Table) markActed(seat int) {
	for _, s := range t.state.HandState.ActedSeats {
		if s == seat {
			return
		}
	}
	t.state.HandState.ActedSeats = append(t.state.HandState.ActedSeats, seat)
}

func (t *Table) resetActedTo(seats []int) {
	t.state.HandState.ActedSeats = seats
}

func (t *Table) advanceAfterAction(seat int, message string, action string) {
	t.state.HandState.LastAction = action
	t.state.LastEvent = message
	t.appendHandLog(message)
	if t.oneContenderLeft() {
		t.concludeFoldout()
		return
	}
	if t.streetComplete() {
		t.advanceStreet()
	} else {
		next := t.nextActionableSeat(seat)
		if next == 0 {
			t.advanceStreet()
		} else {
			t.state.HandState.ActingSeat = &next
		}
	}
}

func (t *Table) oneContenderLeft() bool {
	count := 0
	for _, p := range t.state.Players {
		if p.Status == "ACTIVE" || p.Status == "ALL_IN" {
			count++
		}
	}
	return count == 1
}

func (t *Table) streetComplete() bool {
	var contenders []models.Player
	for _, p := range t.state.Players {
		if p.Status == "ACTIVE" || p.Status == "ALL_IN" {
			contenders = append(contenders, p)
		}
	}
	for _, p := range contenders {
		if p.Status == "ACTIVE" && p.BetThisStreet != t.state.HandState.CurrentBet {
			return false
		}
	}
	for _, p := range t.state.Players {
		if p.Status == "ACTIVE" {
			acted := false
			for _, s := range t.state.HandState.ActedSeats {
				if s == p.Seat {
					acted = true
					break
				}
			}
			if !acted {
				return false
			}
		}
	}
	return true
}

func (t *Table) nextActionableSeat(current int) int {
	var seats []int
	for _, p := range t.state.Players {
		if p.Status == "ACTIVE" {
			seats = append(seats, p.Seat)
		}
	}
	sort.Ints(seats)
	return t.nextSeatInList(seats, current)
}

func (t *Table) advanceStreet() {
	nextStage := ""
	drawCount := 0
	switch t.state.HandState.Stage {
	case "preflop":
		nextStage = "flop"
		drawCount = 3
	case "flop":
		nextStage = "turn"
		drawCount = 1
	case "turn":
		nextStage = "river"
		drawCount = 1
	case "river":
		t.concludeShowdown()
		return
	}
	for i := range t.state.Players {
		t.state.Players[i].BetThisStreet = 0
	}
	if len(t.state.HandState.Deck) < drawCount {
		t.concludeShowdown()
		return
	}
	drawn := t.state.HandState.Deck[:drawCount]
	t.state.HandState.Deck = t.state.HandState.Deck[drawCount:]
	t.state.HandState.CommunityCards = append(t.state.HandState.CommunityCards, drawn...)
	t.state.HandState.Stage = nextStage
	t.state.HandState.CurrentBet = 0
	t.state.HandState.ActedSeats = []int{}
	t.state.HandState.MinimumRaise = BigBlind
	if t.runoutOnly() {
		t.state.HandState.ActingSeat = nil
		t.advanceStreet()
	} else {
		next := t.nextActionableSeat(t.state.HandState.DealerSeat)
		t.state.HandState.ActingSeat = &next
		t.state.LastEvent = nextStage + "_dealt"
		t.appendHandLog(fmt.Sprintf("%s dealt. Action on seat %d.", nextStage, next))
	}
}

func (t *Table) runoutOnly() bool {
	active := 0
	allIn := 0
	for _, p := range t.state.Players {
		if p.Status == "ACTIVE" {
			active++
		}
		if p.Status == "ALL_IN" {
			allIn++
		}
	}
	return allIn > 0 && active <= 1
}

func (t *Table) concludeFoldout() {
	var winner *models.Player
	for i := range t.state.Players {
		if t.state.Players[i].Status == "ACTIVE" || t.state.Players[i].Status == "ALL_IN" {
			winner = &t.state.Players[i]
			break
		}
	}
	if winner == nil {
		t.invalidAction("no_winner_found")
		return
	}
	pot := t.state.HandState.Pot
	winner.Stack += pot
	winnerSeat := winner.Seat
	t.state.HandState.Status = "complete"
	t.state.HandState.Stage = "showdown"
	t.state.HandState.ActingSeat = nil
	t.state.HandState.WinnerSeats = []int{winnerSeat}
	t.state.HandState.WinnerAmounts = map[string]int{fmt.Sprintf("%d", winnerSeat): pot}
	message := fmt.Sprintf("Hand ends by fold. Seat %d wins %d.", winnerSeat, pot)
	t.state.LastEvent = "hand_complete"
	t.state.HandState.HandResult = &models.HandResult{
		Heading:     fmt.Sprintf("Seat %d wins by fold", winnerSeat),
		Lines:       []string{message},
		HeroOutcome: t.heroOutcome([]int{winnerSeat}),
	}
	t.appendHandLog(message)
	t.appendHandLog("Next hand starting shortly...")
	t.pruneDisconnected()
}
