package game

import (
	"fmt"
	"poker-backend/internal/models"
)

func (t *Table) normalizePlayerID(val interface{}) string {
	if s, ok := val.(string); ok {
		return s
	}
	if f, ok := val.(float64); ok {
		return fmt.Sprintf("%.0f", f)
	}
	return ""
}

func (t *Table) normalizeSeat(val interface{}) int {
	if i, ok := val.(int); ok {
		return i
	}
	if f, ok := val.(float64); ok {
		return int(f)
	}
	if s, ok := val.(string); ok {
		var i int
		fmt.Sscanf(s, "%d", &i)
		return i
	}
	return 0
}

func (t *Table) normalizePlayerName(val interface{}) string {
	if s, ok := val.(string); ok {
		return s
	}
	return "Player"
}

func (t *Table) normalizeAmount(val interface{}) int {
	if i, ok := val.(int); ok {
		return i
	}
	if f, ok := val.(float64); ok {
		return int(f)
	}
	return 0
}

func (t *Table) appendHandLog(msg string) {
	t.state.HandState.ActionLog = append(t.state.HandState.ActionLog, msg)
	if len(t.state.HandState.ActionLog) > LogLimit {
		t.state.HandState.ActionLog = t.state.HandState.ActionLog[1:]
	}
	t.state.HandState.ActionLogSeq++
}

func (t *Table) invalidAction(reason string) {
	t.state.LastEvent = reason
	t.appendHandLog("Rejected action: " + reason)
}

func (t *Table) heroOutcome(winners []int) string {
	return t.heroOutcomeForSeat(winners, 1) // legacy: hardcoded seat 1
}

func (t *Table) heroOutcomeForSeat(winners []int, viewerSeat int) string {
	if viewerSeat == 0 {
		return "spectator"
	}
	for _, s := range winners {
		if s == viewerSeat {
			if len(winners) == 1 {
				return "win"
			} else {
				return "split"
			}
		}
	}
	// Check if viewer folded
	for _, p := range t.state.Players {
		if p.Seat == viewerSeat && p.Status == "FOLDED" {
			return "folded"
		}
	}
	return "loss"
}

func (t *Table) waitingStatus(p models.Player) string {
	if p.Stack <= 0 {
		return "BUSTED"
	}
	if p.WillPlayNextHand {
		return "READY"
	}
	return "SITTING_OUT"
}

func (t *Table) rotateSeat(seat int) int {
	for i, s := range Seats {
		if s == seat {
			return Seats[(i+1)%len(Seats)]
		}
	}
	return Seats[0]
}
