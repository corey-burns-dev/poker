package game

import (
	"fmt"
	"poker-backend/internal/models"
	"sort"
)

// ShowdownResolver handles hand evaluation and pot distribution
type ShowdownResolver struct {
	state *models.TableState
	log   func(string)
}

// NewShowdownResolver creates a new showdown resolver
func NewShowdownResolver(state *models.TableState, log func(string)) *ShowdownResolver {
	return &ShowdownResolver{state: state, log: log}
}

// ResolveShowdown handles the complete showdown process
func (sr *ShowdownResolver) ResolveShowdown() {
	evals := sr.evaluateHands()
	if len(evals) == 0 {
		sr.ResolveFoldout()
		return
	}

	sr.awardPots(evals)
	sr.updateStatePostShowdown()
}

// ResolveFoldout handles when only one player remains
func (sr *ShowdownResolver) ResolveFoldout() {
	winner := sr.findUnfoldedPlayer()
	if winner == nil {
		sr.log("ERROR: no_winner_found")
		return
	}

	pot := sr.state.HandState.Pot
	winner.Stack += pot

	sr.state.HandState.Status = "complete"
	sr.state.HandState.Stage = "showdown"
	sr.state.HandState.ActingSeat = nil
	sr.state.HandState.WinnerSeats = []int{winner.Seat}
	sr.state.HandState.WinnerAmounts = map[string]int{
		fmt.Sprintf("%d", winner.Seat): pot,
	}

	message := fmt.Sprintf("Hand ends by fold. Seat %d wins %d.", winner.Seat, pot)
	sr.log(message)
	sr.state.HandState.HandResult = &models.HandResult{
		Heading: fmt.Sprintf("Seat %d wins by fold", winner.Seat),
		Lines:   []string{message},
	}
}

// evaluateHands gets best 5-card evaluation for each remaining player
func (sr *ShowdownResolver) evaluateHands() []HandEvaluation {
	var evals []HandEvaluation
	for _, p := range sr.state.Players {
		if p.Status == "ACTIVE" || p.Status == "ALL_IN" {
			cards := make([]string, len(p.HoleCards))
			copy(cards, p.HoleCards)
			cards = append(cards, sr.state.HandState.CommunityCards...)

			eval := Evaluate(cards)
			eval.Seat = p.Seat
			evals = append(evals, HandEvaluation{
				Score:       eval.Score,
				Description: eval.Description,
				Cards:       eval.Cards,
				Seat:        p.Seat,
			})
		}
	}
	return evals
}

// awardPots handles side pots and multi-way splits
func (sr *ShowdownResolver) awardPots(evals []HandEvaluation) {
	evalMap := make(map[int]HandEvaluation)
	for _, e := range evals {
		evalMap[e.Seat] = e
	}

	seatIndex := make(map[int]int)
	for i, p := range sr.state.Players {
		seatIndex[p.Seat] = i
	}

	// Collect contribution tiers
	contributions := make(map[int]bool)
	for _, p := range sr.state.Players {
		if p.ContributedThisHand > 0 {
			contributions[p.ContributedThisHand] = true
		}
	}

	var amounts []int
	for a := range contributions {
		amounts = append(amounts, a)
	}
	sort.Ints(amounts)

	winnerAmounts := make(map[string]int)
	winnerSeatsSet := make(map[int]bool)
	var winLines []string

	// Award each tier
	lastAmount := 0
	for _, tierThreshold := range amounts {
		tierSize := tierThreshold - lastAmount
		potForTier := 0
		var eligibleEvals []HandEvaluation

		for _, p := range sr.state.Players {
			if p.ContributedThisHand >= tierThreshold {
				potForTier += tierSize
				if eval, ok := evalMap[p.Seat]; ok {
					eligibleEvals = append(eligibleEvals, eval)
				}
			} else if p.ContributedThisHand > lastAmount {
				potForTier += (p.ContributedThisHand - lastAmount)
				if eval, ok := evalMap[p.Seat]; ok {
					eligibleEvals = append(eligibleEvals, eval)
				}
			}
		}

		if potForTier > 0 && len(eligibleEvals) > 0 {
			winners := sr.findTierWinners(eligibleEvals)
			split := potForTier / len(winners)
			rem := potForTier % len(winners)

			for i, winner := range winners {
				amt := split
				if i == 0 {
					amt += rem
				}
				winnerAmounts[fmt.Sprintf("%d", winner.Seat)] += amt
				winnerSeatsSet[winner.Seat] = true

				if idx, ok := seatIndex[winner.Seat]; ok {
					sr.state.Players[idx].Stack += amt
				}

				winLines = append(winLines, fmt.Sprintf(
					"Seat %d wins %d with %s",
					winner.Seat, amt, winner.Description,
				))
			}
		}

		lastAmount = tierThreshold
	}

	// Update state
	winnerSeats := make([]int, 0, len(winnerSeatsSet))
	for s := range winnerSeatsSet {
		winnerSeats = append(winnerSeats, s)
	}
	sort.Ints(winnerSeats)

	sr.state.HandState.WinnerSeats = winnerSeats
	sr.state.HandState.WinnerAmounts = winnerAmounts
	sr.state.HandState.HandResult = &models.HandResult{
		Lines: winLines,
	}

	for _, line := range winLines {
		sr.log(line)
	}
}

func (sr *ShowdownResolver) findTierWinners(evals []HandEvaluation) []HandEvaluation {
	if len(evals) == 0 {
		return nil
	}

	bestScore := evals[0].Score
	for _, e := range evals {
		if e.Score.Compare(bestScore) > 0 {
			bestScore = e.Score
		}
	}

	var winners []HandEvaluation
	for _, e := range evals {
		if e.Score.Compare(bestScore) == 0 {
			winners = append(winners, e)
		}
	}
	return winners
}

func (sr *ShowdownResolver) findUnfoldedPlayer() *models.Player {
	for i := range sr.state.Players {
		if sr.state.Players[i].Status == "ACTIVE" || sr.state.Players[i].Status == "ALL_IN" {
			return &sr.state.Players[i]
		}
	}
	return nil
}

func (sr *ShowdownResolver) updateStatePostShowdown() {
	sr.state.HandState.Status = "complete"
	sr.state.HandState.Stage = "showdown"
	sr.state.HandState.ActingSeat = nil

	for i := range sr.state.Players {
		if sr.state.Players[i].Stack <= 0 {
			sr.state.Players[i].Status = "BUSTED"
		} else if sr.state.Players[i].WillPlayNextHand {
			sr.state.Players[i].Status = "READY"
		} else {
			sr.state.Players[i].Status = "SITTING_OUT"
		}
		sr.state.Players[i].BetThisStreet = 0
		sr.state.Players[i].ShowCards = true
	}
}
