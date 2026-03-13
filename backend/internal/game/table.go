package game

import (
	"encoding/json"
	"poker-backend/internal/models"
	"sync"
	"time"
)

const (
	SmallBlind             = 10
	BigBlind               = 20
	StartingStack          = 5000
	HandDelay              = 5 * time.Second
	BotDelay               = 450 * time.Millisecond
	DisconnectedHumanDelay = 30 * time.Second
	LogLimit               = 48
)

var Seats = []int{1, 2, 3, 4, 5, 6, 7, 8}

type Table struct {
	mu            sync.RWMutex
	state         models.TableState
	BroadcastChan chan json.RawMessage
	autoTimer     *time.Timer
	timerSeq      int
	subscribers   map[chan struct{}]bool

	// Subsystems
	bettingEngine    *BettingEngine
	showdownResolver *ShowdownResolver
	presenceTracker  *PresenceTracker
}

func NewTable(tableID string, withBots bool) *Table {
	t := &Table{
		BroadcastChan: make(chan json.RawMessage, 100),
		subscribers:   make(map[chan struct{}]bool),
	}
	t.state = t.initialState(tableID, withBots)

	// Initialize subsystems
	t.bettingEngine = NewBettingEngine(&t.state, t.log)
	t.showdownResolver = NewShowdownResolver(&t.state, t.log)
	t.presenceTracker = NewPresenceTracker(&t.state, t.log)

	t.scheduleAutoProgress()
	return t
}

func (t *Table) GetState() models.TableState {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.state
}

func (t *Table) GetStateFor(viewerID string) models.TableState {
	t.mu.RLock()
	defer t.mu.RUnlock()
	s := t.state // copy
	for i, p := range s.Players {
		isViewer := p.PlayerID != nil && *p.PlayerID == viewerID
		if !isViewer && !p.ShowCards {
			s.Players[i].HoleCards = []string{"", ""}
		}
	}
	// Recompute heroOutcome for this viewer
	if s.HandState.HandResult != nil {
		viewerSeat := t.findViewerSeat(viewerID)
		s.HandState.HandResult.HeroOutcome = t.heroOutcomeForSeat(s.HandState.WinnerSeats, viewerSeat)
	}
	return s
}

func (t *Table) Subscribe() chan struct{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	ch := make(chan struct{}, 1)
	t.subscribers[ch] = true
	return ch
}

func (t *Table) Unsubscribe(ch chan struct{}) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.subscribers, ch)
}

func (t *Table) broadcast() {
	// Signal subscribers about a state change
	for ch := range t.subscribers {
		select {
		case ch <- struct{}{}:
		default:
		}
	}

	// For now, keep sending full state to BroadcastChan
	stateBytes, err := json.Marshal(t.state)
	if err != nil {
		return
	}
	raw := json.RawMessage(stateBytes)

	select {
	case t.BroadcastChan <- raw:
	default:
	}
}

func (t *Table) scheduleAutoProgress() {
	if t.autoTimer != nil {
		t.autoTimer.Stop()
	}

	delay := t.autoProgressDelay()
	if delay > 0 {
		t.timerSeq++
		seq := t.timerSeq
		t.autoTimer = time.AfterFunc(delay, func() {
			t.handleAutoProgress(seq)
		})
	}
}

func (t *Table) handleAutoProgress(seq int) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if seq != t.timerSeq {
		return
	}

	if t.autoStartNextHand() {
		t.nextHand()
	} else if t.state.HandState.Status == "in_progress" && t.isBotTurn() {
		t.applyBotAction()
	} else if t.state.HandState.Status == "in_progress" && t.isDisconnectedHumanTurn() {
		t.processHandAction("fold", map[string]interface{}{})
	}

	t.broadcast()
	t.scheduleAutoProgress()
}

func (t *Table) Stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.autoTimer != nil {
		t.autoTimer.Stop()
	}
}

func (t *Table) log(msg string) {
	t.appendHandLog(msg)
}

func (t *Table) isOperator(playerID string) bool {
	return playerID == "1"
}

// Handle showdown completion - DELEGATE
func (t *Table) concludeShowdown() {
	t.showdownResolver.ResolveShowdown()
}

func (t *Table) findViewerSeat(viewerID string) int {
	for _, p := range t.state.Players {
		if p.PlayerID != nil && *p.PlayerID == viewerID {
			return p.Seat
		}
	}
	return 0
}

func (t *Table) ApplyAction(action string, payload map[string]interface{}) {
	t.mu.Lock()
	defer t.mu.Unlock()

	playerID := ""
	if id, ok := payload["player_id"].(string); ok {
		playerID = id
	}

	if action == "join_game" {
		t.joinGame(payload)
	} else if action == "sit_in" {
		t.sitIn(payload)
	} else if action == "sit_out" {
		t.sitOut(payload)
	} else if action == "next_hand" {
		if !t.isOperator(playerID) {
			t.invalidAction("unauthorized")
			return
		}
		t.nextHand()
	} else if action == "clear_table" || action == "add_bot" {
		if !t.isOperator(playerID) {
			t.invalidAction("unauthorized")
			return
		}
		if action == "clear_table" {
			t.clearTable()
		} else {
			t.addBot()
		}
	} else if t.state.HandState.Status == "in_progress" {
		// DELEGATE TO BETTING ENGINE
		authValidator := func(seat int, pid string) bool {
			for _, p := range t.state.Players {
				if p.Seat == seat {
					return p.PlayerID != nil && *p.PlayerID == pid
				}
			}
			return false
		}

		if showdown, err := t.bettingEngine.ProcessAction(action, playerID, payload, authValidator); err != nil {
			t.invalidAction(err.Error())
		} else if showdown {
			t.concludeShowdown()
		}
	} else {
		t.invalidAction("ignored_" + action + "_while_waiting")
	}

	t.broadcast()
	t.scheduleAutoProgress()
}
