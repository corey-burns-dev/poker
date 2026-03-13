package game

import (
	"fmt"
	"poker-backend/internal/models"
	"sort"
)

// BettingEngine handles all betting logic and validation
type BettingEngine struct {
	state *models.TableState
	log   func(string) // callback for logging
}

// NewBettingEngine creates a new betting engine
func NewBettingEngine(state *models.TableState, log func(string)) *BettingEngine {
	return &BettingEngine{state: state, log: log}
}

// ProcessAction handles a betting action with validation
func (be *BettingEngine) ProcessAction(action string, playerID string, payload map[string]interface{}, validateAuth func(int, string) bool) (showdown bool, err error) {
	if be.state.HandState.ActingSeat == nil {
		return false, fmt.Errorf("no_actor_for_%s", action)
	}

	seat := *be.state.HandState.ActingSeat
	playerIdx, player := be.findPlayerBySeat(seat)
	if player == nil || player.Status != "ACTIVE" {
		return false, fmt.Errorf("invalid_actor")
	}

	// Validate authentication
	if !validateAuth(seat, playerID) {
		return false, fmt.Errorf("unauthorized_action")
	}

	toCall := be.state.HandState.CurrentBet - player.BetThisStreet
	if toCall < 0 {
		toCall = 0
	}

	amount := be.normalizeAmount(payload["amount"])

	switch action {
	case "fold":
		player.Status = "FOLDED"
		be.markActed(seat)
		showdown = be.advanceAfterAction(seat, fmt.Sprintf("Seat %d folds.", seat), action)
	case "check":
		if toCall != 0 {
			return false, fmt.Errorf("invalid_check")
		}
		be.markActed(seat)
		showdown = be.advanceAfterAction(seat, fmt.Sprintf("Seat %d checks.", seat), action)
	case "call":
		if toCall <= 0 {
			return false, fmt.Errorf("invalid_call")
		}
		be.handleCall(playerIdx, toCall)
	case "bet":
		if err := be.validateBet(player, amount); err != nil {
			return false, err
		}
		be.handleBet(playerIdx, amount)
	case "raise":
		if err := be.validateRaise(player, amount); err != nil {
			return false, err
		}
		be.handleRaise(playerIdx, amount)
	default:
		return false, fmt.Errorf("unknown_action_%s", action)
	}

	return false, nil
}

// Private helpers

func (be *BettingEngine) findPlayerBySeat(seat int) (int, *models.Player) {
	for i := range be.state.Players {
		if be.state.Players[i].Seat == seat {
			return i, &be.state.Players[i]
		}
	}
	return -1, nil
}

func (be *BettingEngine) normalizeAmount(amount interface{}) int {
	if amount == nil {
		return 0
	}
	switch v := amount.(type) {
	case float64:
		return int(v)
	case int:
		return v
	default:
		return 0
	}
}

func (be *BettingEngine) contribute(playerIdx int, amount int) {
	p := &be.state.Players[playerIdx]
	p.Stack -= amount
	p.BetThisStreet += amount
	p.ContributedThisHand += amount
	be.state.HandState.Pot += amount
	if p.Stack == 0 {
		p.Status = "ALL_IN"
	}
}

func (be *BettingEngine) markActed(seat int) {
	for _, s := range be.state.HandState.ActedSeats {
		if s == seat {
			return
		}
	}
	be.state.HandState.ActedSeats = append(be.state.HandState.ActedSeats, seat)
}

func (be *BettingEngine) resetActedTo(seats []int) {
	be.state.HandState.ActedSeats = seats
}

func (be *BettingEngine) advanceAfterAction(seat int, message string, action string) (showdown bool) {
	be.state.HandState.LastAction = action
	be.log(message)
	if be.oneContenderLeft() {
		showdown = true
		return
	}
	if be.streetComplete() {
		be.advanceStreet()
	} else {
		next := be.nextActionableSeat(seat)
		if next == 0 {
			be.advanceStreet()
		} else {
			be.state.HandState.ActingSeat = &next
		}
	}
	return false
}

func (be *BettingEngine) oneContenderLeft() bool {
	count := 0
	for _, p := range be.state.Players {
		if p.Status == "ACTIVE" || p.Status == "ALL_IN" {
			count++
		}
	}
	return count == 1
}

func (be *BettingEngine) streetComplete() bool {
	var contenders []models.Player
	for _, p := range be.state.Players {
		if p.Status == "ACTIVE" || p.Status == "ALL_IN" {
			contenders = append(contenders, p)
		}
	}
	for _, p := range contenders {
		if p.Status == "ACTIVE" && p.BetThisStreet != be.state.HandState.CurrentBet {
			return false
		}
	}
	for _, p := range be.state.Players {
		if p.Status == "ACTIVE" {
			acted := false
			for _, s := range be.state.HandState.ActedSeats {
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

func (be *BettingEngine) nextActionableSeat(current int) int {
	var seats []int
	for _, p := range be.state.Players {
		if p.Status == "ACTIVE" {
			seats = append(seats, p.Seat)
		}
	}
	sort.Ints(seats)
	return be.nextSeatInList(seats, current)
}

func (be *BettingEngine) nextSeatInList(seats []int, current int) int {
	if len(seats) == 0 {
		return 0
	}
	for _, s := range seats {
		if s > current {
			return s
		}
	}
	return seats[0]
}

func (be *BettingEngine) advanceStreet() {
	nextStage := ""
	drawCount := 0
	switch be.state.HandState.Stage {
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
		// Showdown - let caller handle
		return
	}
	for i := range be.state.Players {
		be.state.Players[i].BetThisStreet = 0
	}
	if len(be.state.HandState.Deck) < drawCount {
		// Trigger showdown
		return
	}
	drawn := be.state.HandState.Deck[:drawCount]
	be.state.HandState.Deck = be.state.HandState.Deck[drawCount:]
	be.state.HandState.CommunityCards = append(be.state.HandState.CommunityCards, drawn...)
	be.state.HandState.Stage = nextStage
	be.state.HandState.CurrentBet = 0
	be.state.HandState.ActedSeats = []int{}
	be.state.HandState.MinimumRaise = BigBlind
	if be.runoutOnly() {
		be.state.HandState.ActingSeat = nil
		be.advanceStreet() // Runout to river
	} else {
		next := be.nextActionableSeat(be.state.HandState.DealerSeat)
		be.state.HandState.ActingSeat = &next
		be.log(fmt.Sprintf("%s dealt. Action on seat %d.", nextStage, next))
	}
}

func (be *BettingEngine) runoutOnly() bool {
	active := 0
	allIn := 0
	for _, p := range be.state.Players {
		if p.Status == "ACTIVE" {
			active++
		}
		if p.Status == "ALL_IN" {
			allIn++
		}
	}
	return allIn > 0 && active <= 1
}

func (be *BettingEngine) handleCall(playerIdx int, toCall int) (showdown bool) {
	seat := be.state.Players[playerIdx].Seat
	paid := toCall
	if be.state.Players[playerIdx].Stack < toCall {
		paid = be.state.Players[playerIdx].Stack
	}
	be.contribute(playerIdx, paid)
	be.markActed(seat)
	showdown = be.advanceAfterAction(seat, fmt.Sprintf("Seat %d calls %d.", seat, paid), "call")
	return
}

func (be *BettingEngine) validateBet(player *models.Player, amount int) error {
	if be.state.HandState.CurrentBet != 0 || amount < BigBlind || amount > player.Stack {
		return fmt.Errorf("invalid_bet")
	}
	return nil
}

func (be *BettingEngine) handleBet(playerIdx int, amount int) (showdown bool) {
	seat := be.state.Players[playerIdx].Seat
	be.contribute(playerIdx, amount)
	be.state.HandState.CurrentBet = amount
	be.state.HandState.MinimumRaise = amount
	be.resetActedTo([]int{seat})
	showdown = be.advanceAfterAction(seat, fmt.Sprintf("Seat %d bets %d.", seat, amount), "bet")
	return
}

func (be *BettingEngine) validateRaise(player *models.Player, amount int) error {
	minRaise := be.state.HandState.CurrentBet + be.state.HandState.MinimumRaise
	if amount < minRaise || amount > player.BetThisStreet+player.Stack {
		return fmt.Errorf("invalid_raise")
	}
	return nil
}

func (be *BettingEngine) handleRaise(playerIdx int, amount int) (showdown bool) {
	seat := be.state.Players[playerIdx].Seat
	contribution := amount - be.state.Players[playerIdx].BetThisStreet
	raiseSize := amount - be.state.HandState.CurrentBet
	be.contribute(playerIdx, contribution)
	be.state.HandState.CurrentBet = amount
	be.state.HandState.MinimumRaise = raiseSize
	be.resetActedTo([]int{seat})
	showdown = be.advanceAfterAction(seat, fmt.Sprintf("Seat %d raises to %d.", seat, amount), "raise")
	return
}
