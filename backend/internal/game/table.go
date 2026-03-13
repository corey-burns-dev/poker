package game

import (
	"encoding/json"
	"poker-backend/internal/models"
	"sync"
	"time"
)

const (
	SmallBlind    = 10
	BigBlind      = 20
	StartingStack = 5000
	HandDelay     = 5 * time.Second
	BotDelay      = 450 * time.Millisecond
	LogLimit      = 48
)

var Seats = []int{1, 2, 3, 4, 5, 6, 7, 8}

type Table struct {
	mu            sync.RWMutex
	state         models.TableState
	BroadcastChan chan json.RawMessage
	autoTimer     *time.Timer
	timerSeq      int
	subscribers   map[chan json.RawMessage]bool
}

func NewTable(tableID string, withBots bool) *Table {
	t := &Table{
		BroadcastChan: make(chan json.RawMessage, 100),
		subscribers:   make(map[chan json.RawMessage]bool),
	}
	t.state = t.initialState(tableID, withBots)
	t.scheduleAutoProgress()
	return t
}

func (t *Table) GetState() models.TableState {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.state
}

func (t *Table) Subscribe() chan json.RawMessage {
	t.mu.Lock()
	defer t.mu.Unlock()
	ch := make(chan json.RawMessage, 10)
	t.subscribers[ch] = true
	return ch
}

func (t *Table) Unsubscribe(ch chan json.RawMessage) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.subscribers, ch)
}

func (t *Table) broadcast() {
	stateBytes, err := json.Marshal(t.state)
	if err != nil {
		return
	}
	raw := json.RawMessage(stateBytes)

	for ch := range t.subscribers {
		select {
		case ch <- raw:
		default:
		}
	}
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
	}

	t.broadcast()
	t.scheduleAutoProgress()
}

func (t *Table) ApplyAction(action string, payload map[string]interface{}) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if action == "join_game" {
		t.joinGame(payload)
	} else if action == "sit_in" {
		t.sitIn(payload)
	} else if action == "sit_out" {
		t.sitOut(payload)
	} else if action == "next_hand" {
		t.nextHand()
	} else if action == "clear_table" {
		t.clearTable()
	} else if action == "add_bot" {
		t.addBot()
	} else if t.state.HandState.Status == "in_progress" {
		t.processHandAction(action, payload)
	} else {
		t.invalidAction("ignored_" + action + "_while_waiting")
	}

	t.broadcast()
	t.scheduleAutoProgress()
}
