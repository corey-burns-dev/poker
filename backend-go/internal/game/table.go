package game

import (
	"fmt"
	"math/rand"
	"poker-backend/internal/models"
	"sort"
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

var BotNames = map[int]string{
	1: "Alice", 2: "Bob", 3: "Charlie", 4: "Daisy", 5: "Eli", 6: "Frankie", 7: "Gia", 8: "Harper",
}

var BotProfiles = map[int]struct {
	Style      string
	Looseness  int
	Aggression int
	Bluff      int
}{
	1: {"tight", -14, 4, 1},
	2: {"aggressive", 12, 20, 9},
	3: {"balanced", 2, 8, 3},
	4: {"tight", -12, 5, 1},
	5: {"aggressive", 14, 22, 11},
	6: {"balanced", 4, 10, 4},
	7: {"tight", -16, 3, 0},
	8: {"aggressive", 10, 18, 7},
}

var CFRTable = map[string][3]int{
	"weak_preflop_nopair_nobet":   {0, 813, 187},
	"weak_preflop_nopair_bet":     {441, 541, 18},
	"medium_preflop_nopair_nobet": {153, 444, 403},
	"medium_preflop_nopair_bet":   {5, 886, 109},
	"strong_preflop_nopair_nobet": {0, 122, 878},
	"strong_preflop_nopair_bet":   {0, 685, 315},
	"strong_preflop_pair_nobet":   {167, 166, 667},
	"strong_preflop_pair_bet":     {241, 538, 221},
	"weak_postflop_nopair_nobet":  {0, 841, 159},
	"weak_postflop_nopair_bet":    {761, 228, 11},
	"weak_postflop_pair_nobet":    {0, 110, 890},
	"weak_postflop_pair_bet":      {2, 531, 467},
}

type Table struct {
	mu            sync.RWMutex
	state         models.TableState
	BroadcastChan chan models.TableState
	autoTimer     *time.Timer
	subscribers   map[chan models.TableState]bool
}

func NewTable(tableID string, withBots bool) *Table {
	t := &Table{
		BroadcastChan: make(chan models.TableState, 100),
		subscribers:   make(map[chan models.TableState]bool),
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

func (t *Table) Subscribe() chan models.TableState {
	t.mu.Lock()
	defer t.mu.Unlock()
	ch := make(chan models.TableState, 10)
	t.subscribers[ch] = true
	return ch
}

func (t *Table) Unsubscribe(ch chan models.TableState) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.subscribers, ch)
}

func (t *Table) initialState(tableID string, withBots bool) models.TableState {
	players := make([]models.Player, len(Seats))
	for i, seat := range Seats {
		if withBots {
			players[i] = t.buildBotPlayer(seat, StartingStack)
		} else {
			players[i] = t.buildEmptySeat(seat)
		}
	}

	return models.TableState{
		TableID:           tableID,
		Players:           players,
		GameState:         "waiting_for_hand",
		HandNumber:        1,
		ConnectedClients:  0,
		LastEvent:         "table_created",
		HandState:         t.initialHandState(1, 1),
		ClientConnections: make(map[string]int),
	}
}

func (t *Table) buildEmptySeat(seat int) models.Player {
	return models.Player{
		Seat:                seat,
		Name:                fmt.Sprintf("Seat %d", seat),
		Stack:               0,
		Status:              "SITTING_OUT",
		WillPlayNextHand:    false,
		IsBot:               true,
		Connected:           false,
		BetThisStreet:       0,
		ContributedThisHand: 0,
		HoleCards:           []string{"", ""},
	}
}

func (t *Table) buildBotPlayer(seat int, stack int) models.Player {
	profile := BotProfiles[seat]
	style := profile.Style
	return models.Player{
		Seat:                seat,
		Name:                BotNames[seat],
		Stack:               stack,
		Status:              "READY",
		WillPlayNextHand:    true,
		ShowCards:           true,
		IsBot:               true,
		BotStyle:            &style,
		Connected:           false,
		BetThisStreet:       0,
		ContributedThisHand: 0,
		HoleCards:           []string{"", ""},
	}
}

func (t *Table) initialHandState(handNumber int, dealerSeat int) models.HandState {
	return models.HandState{
		Status:         "waiting",
		Stage:          "preflop",
		HandNumber:     handNumber,
		Pot:            0,
		CurrentBet:     0,
		MinimumRaise:   BigBlind,
		DealerSeat:     dealerSeat,
		SmallBlindSeat: t.rotateSeat(dealerSeat),
		BigBlindSeat:   t.rotateSeat(t.rotateSeat(dealerSeat)),
		CommunityCards: []string{},
		ActionLog:      []string{"Table ready. First hand starting shortly."},
		ActionLogSeq:   1,
		LastAction:     "waiting_for_next_hand",
		WinnerAmounts:  make(map[string]int),
	}
}

func (t *Table) rotateSeat(seat int) int {
	for i, s := range Seats {
		if s == seat {
			return Seats[(i+1)%len(Seats)]
		}
	}
	return Seats[0]
}

func (t *Table) Join(playerID string, playerName string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.incrementConnection(playerID)
	t.reconnectPlayer(playerID)
	t.state.LastEvent = playerName + " joined the table"
	t.broadcast()
	t.scheduleAutoProgress()
}

func (t *Table) incrementConnection(playerID string) {
	t.state.ClientConnections[playerID]++
	t.state.ConnectedClients = t.totalConnections()
}

func (t *Table) totalConnections() int {
	total := 0
	for _, count := range t.state.ClientConnections {
		total += count
	}
	return total
}

func (t *Table) reconnectPlayer(playerID string) {
	for i := range t.state.Players {
		if t.state.Players[i].PlayerID != nil && *t.state.Players[i].PlayerID == playerID && !t.state.Players[i].IsBot {
			t.state.Players[i].Connected = true
			return
		}
	}
}

func (t *Table) broadcast() {
	for ch := range t.subscribers {
		select {
		case ch <- t.state:
		default:
		}
	}
	select {
	case t.BroadcastChan <- t.state:
	default:
	}
}

func (t *Table) scheduleAutoProgress() {
	if t.autoTimer != nil {
		t.autoTimer.Stop()
	}

	delay := t.autoProgressDelay()
	if delay > 0 {
		t.autoTimer = time.AfterFunc(delay, t.handleAutoProgress)
	}
}

func (t *Table) autoProgressDelay() time.Duration {
	if t.autoStartNextHand() {
		return HandDelay
	}
	if t.state.HandState.Status == "in_progress" && t.isBotTurn() {
		return BotDelay
	}
	return 0
}

func (t *Table) autoStartNextHand() bool {
	return t.state.HandState.Status == "complete" || (t.state.HandState.Status == "waiting" && t.readyPlayerCount() >= 2)
}

func (t *Table) readyPlayerCount() int {
	count := 0
	for _, p := range t.state.Players {
		if p.Stack > 0 && p.WillPlayNextHand {
			count++
		}
	}
	return count
}

func (t *Table) isBotTurn() bool {
	if t.state.HandState.ActingSeat == nil {
		return false
	}
	seat := *t.state.HandState.ActingSeat
	for _, p := range t.state.Players {
		if p.Seat == seat {
			return p.IsBot && p.Status == "ACTIVE"
		}
	}
	return false
}

func (t *Table) handleAutoProgress() {
	t.mu.Lock()
	defer t.mu.Unlock()

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

func (t *Table) clearTable() {
	for i, p := range t.state.Players {
		if p.IsBot || p.PlayerID == nil {
			t.state.Players[i] = t.buildEmptySeat(p.Seat)
		}
	}
	t.state.LastEvent = "table_cleared"
}

func (t *Table) addBot() {
	for i, p := range t.state.Players {
		if p.IsBot && p.Stack <= 0 {
			t.state.Players[i] = t.buildBotPlayer(p.Seat, StartingStack)
			t.state.LastEvent = "bot_added"
			return
		}
	}
	t.invalidAction("no_empty_seats_for_bot")
}

func (t *Table) joinGame(payload map[string]interface{}) {
	playerID := t.normalizePlayerID(payload["player_id"])
	requestedSeat := t.normalizeSeat(payload["seat"])
	playerName := t.normalizePlayerName(payload["player_name"])

	if playerID == "" {
		t.invalidAction("missing_player_id")
		return
	}
	if requestedSeat == 0 {
		t.invalidAction("missing_seat_selection")
		return
	}

	if t.seatUnavailable(requestedSeat, playerID) {
		t.invalidAction("seat_unavailable")
		return
	}

	for i, p := range t.state.Players {
		if p.PlayerID != nil && *p.PlayerID == playerID {
			t.state.Players[i].Name = playerName
			t.state.Players[i].Connected = true
			t.state.LastEvent = "player_reconnected"
			t.appendHandLog(playerName + " is seated at seat " + fmt.Sprintf("%d", p.Seat) + ".")
			return
		}
	}

	seatIndex := -1
	for i, p := range t.state.Players {
		if p.Seat == requestedSeat {
			seatIndex = i
			break
		}
	}

	if seatIndex != -1 && t.seatClaimImmediate(t.state.Players[seatIndex]) {
		stack := StartingStack
		status := "READY"
		if t.state.HandState.Status == "in_progress" {
			status = "SITTING_OUT"
		}
		pid := playerID
		t.state.Players[seatIndex] = models.Player{
			Seat:             requestedSeat,
			Name:             playerName,
			Stack:            stack,
			Status:           status,
			WillPlayNextHand: true,
			IsBot:            false,
			PlayerID:         &pid,
			Connected:        true,
			HoleCards:        []string{"", ""},
		}
		t.state.LastEvent = "player_joined_seat"
		t.appendHandLog(playerName + " is seated at seat " + fmt.Sprintf("%d", requestedSeat) + ".")
	} else {
		pending := models.PendingPlayer{
			PlayerID:         playerID,
			Name:             playerName,
			Connected:        true,
			WillPlayNextHand: true,
			DesiredSeat:      requestedSeat,
		}
		t.state.PendingPlayers = append(t.state.PendingPlayers, pending)
		t.state.LastEvent = "player_joined_waitlist"
		t.appendHandLog(playerName + " reserved seat " + fmt.Sprintf("%d", requestedSeat) + " for the next hand.")
	}
}

func (t *Table) seatUnavailable(seat int, playerID string) bool {
	for _, p := range t.state.Players {
		if p.Seat == seat && !p.IsBot && (p.PlayerID == nil || *p.PlayerID != playerID) {
			return true
		}
	}
	for _, p := range t.state.PendingPlayers {
		if p.DesiredSeat == seat && p.PlayerID != playerID {
			return true
		}
	}
	return false
}

func (t *Table) seatClaimImmediate(p models.Player) bool {
	return (p.IsBot && p.PlayerID == nil && p.Stack <= 0) || t.state.HandState.Status != "in_progress"
}

func (t *Table) sitIn(payload map[string]interface{}) {
	playerID := t.normalizePlayerID(payload["player_id"])
	found := false
	for i, p := range t.state.Players {
		if p.PlayerID != nil && *p.PlayerID == playerID {
			t.state.Players[i].WillPlayNextHand = p.Stack > 0
			if t.state.HandState.Status == "waiting" && p.Stack > 0 {
				t.state.Players[i].Status = "READY"
			}
			t.state.LastEvent = "player_sitting_in"
			t.appendHandLog(p.Name + " is ready for the next hand.")
			found = true
			break
		}
	}
	if !found {
		t.invalidAction("player_not_joined")
	}
}

func (t *Table) sitOut(payload map[string]interface{}) {
	playerID := t.normalizePlayerID(payload["player_id"])
	found := false
	for i, p := range t.state.Players {
		if p.PlayerID != nil && *p.PlayerID == playerID {
			t.state.Players[i].WillPlayNextHand = false
			if t.state.HandState.Status == "waiting" {
				t.state.Players[i].Status = "SITTING_OUT"
			}
			t.state.LastEvent = "player_sitting_out"
			t.appendHandLog(p.Name + " is sitting out.")
			found = true
			break
		}
	}
	if !found {
		t.invalidAction("player_not_joined")
	}
}

func (t *Table) nextHand() {
	t.materializePendingPlayers()
	if t.readyPlayerCount() < 2 {
		t.invalidAction("not_enough_ready_players")
		return
	}

	t.state.HandNumber++
	nextHandNumber := t.state.HandNumber
	pos := t.nextHandPositions(t.state.HandState.DealerSeat)
	t.resetPlayersForHand()
	t.postBlind(pos.smallBlind, SmallBlind)
	t.postBlind(pos.bigBlind, BigBlind)

	ranks := []string{"2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"}
	suits := []string{"c", "d", "h", "s"}
	var deck []string
	for _, r := range ranks {
		for _, s := range suits {
			deck = append(deck, r+s)
		}
	}
	rand.Seed(time.Now().UnixNano())
	rand.Shuffle(len(deck), func(i, j int) { deck[i], deck[j] = deck[j], deck[i] })

	t.dealHoleCards(pos.dealer, &deck)

	t.state.HandState = models.HandState{
		Status:         "in_progress",
		Stage:          "preflop",
		HandNumber:     nextHandNumber,
		Pot:            SmallBlind + BigBlind,
		CurrentBet:     BigBlind,
		MinimumRaise:   BigBlind,
		ActingSeat:     &pos.actingSeat,
		DealerSeat:     pos.dealer,
		SmallBlindSeat: pos.smallBlind,
		BigBlindSeat:   pos.bigBlind,
		CommunityCards: []string{},
		Deck:           deck,
		ActionLog: []string{
			fmt.Sprintf("Hand %d started.", nextHandNumber),
			fmt.Sprintf("Blinds posted: %d / %d.", SmallBlind, BigBlind),
			fmt.Sprintf("Action on seat %d.", pos.actingSeat),
		},
		ActionLogSeq:  3,
		LastAction:    "hand_started",
		WinnerAmounts: make(map[string]int),
	}
	t.state.GameState = "hand_in_progress"
	t.state.LastEvent = fmt.Sprintf("hand_%d_started", nextHandNumber)
}

func (t *Table) materializePendingPlayers() {
	var remaining []models.PendingPlayer
	for _, pending := range t.state.PendingPlayers {
		replaced := false
		for i, p := range t.state.Players {
			if p.Seat == pending.DesiredSeat && p.IsBot && p.PlayerID == nil {
				pid := pending.PlayerID
				t.state.Players[i] = models.Player{
					Seat:             p.Seat,
					Name:             pending.Name,
					Stack:            StartingStack,
					Status:           "READY",
					WillPlayNextHand: pending.WillPlayNextHand,
					IsBot:            false,
					PlayerID:         &pid,
					Connected:        pending.Connected,
					HoleCards:        []string{"", ""},
				}
				replaced = true
				break
			}
		}
		if !replaced {
			remaining = append(remaining, pending)
		}
	}
	t.state.PendingPlayers = remaining
}

type handPositions struct {
	dealer, smallBlind, bigBlind, actingSeat int
}

func (t *Table) nextHandPositions(prevDealer int) handPositions {
	var readySeats []int
	for _, p := range t.state.Players {
		if p.Stack > 0 && p.WillPlayNextHand {
			readySeats = append(readySeats, p.Seat)
		}
	}
	dealer := t.nextSeatInList(readySeats, prevDealer)
	if len(readySeats) == 2 {
		bb := t.nextSeatInList(readySeats, dealer)
		return handPositions{dealer, dealer, bb, dealer}
	}
	sb := t.nextSeatInList(readySeats, dealer)
	bb := t.nextSeatInList(readySeats, sb)
	acting := t.nextSeatInList(readySeats, bb)
	return handPositions{dealer, sb, bb, acting}
}

func (t *Table) nextSeatInList(seats []int, current int) int {
	for _, s := range seats {
		if s > current {
			return s
		}
	}
	if len(seats) > 0 {
		return seats[0]
	}
	return 1
}

func (t *Table) resetPlayersForHand() {
	for i, p := range t.state.Players {
		if p.Stack <= 0 {
			t.state.Players[i].Status = "BUSTED"
		} else if p.WillPlayNextHand {
			t.state.Players[i].Status = "ACTIVE"
		} else {
			t.state.Players[i].Status = "SITTING_OUT"
		}
		t.state.Players[i].BetThisStreet = 0
		t.state.Players[i].ContributedThisHand = 0
		t.state.Players[i].HoleCards = []string{"", ""}
	}
}

func (t *Table) postBlind(seat int, amount int) {
	for i, p := range t.state.Players {
		if p.Seat == seat {
			paid := amount
			if p.Stack < amount {
				paid = p.Stack
			}
			t.state.Players[i].Stack -= paid
			t.state.Players[i].BetThisStreet = paid
			t.state.Players[i].ContributedThisHand = paid
			if t.state.Players[i].Stack == 0 {
				t.state.Players[i].Status = "ALL_IN"
			}
			return
		}
	}
}

func (t *Table) dealHoleCards(dealer int, deck *[]string) {
	var activeSeats []int
	for _, p := range t.state.Players {
		if p.Status == "ACTIVE" || p.Status == "ALL_IN" {
			activeSeats = append(activeSeats, p.Seat)
		}
	}
	startSeat := t.nextSeatInList(activeSeats, dealer)
	if len(activeSeats) == 2 {
		startSeat = dealer
	}
	ordered := t.orderedSeatsFrom(activeSeats, startSeat)
	cardsBySeat := make(map[int][]string)
	for i := 0; i < 2; i++ {
		for _, s := range ordered {
			if len(*deck) == 0 {
				break
			}
			card := (*deck)[0]
			*deck = (*deck)[1:]
			cardsBySeat[s] = append(cardsBySeat[s], card)
		}
	}
	for i, p := range t.state.Players {
		if cards, ok := cardsBySeat[p.Seat]; ok {
			t.state.Players[i].HoleCards = cards
		}
	}
}

func (t *Table) orderedSeatsFrom(seats []int, start int) []int {
	var res []int
	startIndex := -1
	for i, s := range seats {
		if s >= start {
			startIndex = i
			break
		}
	}
	if startIndex == -1 && len(seats) > 0 {
		startIndex = 0
	}
	if startIndex != -1 {
		res = append(res, seats[startIndex:]...)
		res = append(res, seats[:startIndex]...)
	}
	return res
}

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

func (t *Table) concludeShowdown() {
	evaluations := t.showdownEvaluations()
	if len(evaluations) == 0 {
		t.concludeFoldout()
		return
	}
	bestEval := evaluations[0]
	for _, e := range evaluations {
		if e.Score.Compare(bestEval.Score) > 0 {
			bestEval = e
		}
	}
	winners := []int{bestEval.Seat}
	pot := t.state.HandState.Pot
	winnerAmounts := map[string]int{fmt.Sprintf("%d", bestEval.Seat): pot}
	for i, p := range t.state.Players {
		if p.Seat == bestEval.Seat {
			t.state.Players[i].Stack += pot
		}
		t.state.Players[i].Status = t.waitingStatus(t.state.Players[i])
		t.state.Players[i].BetThisStreet = 0
		t.state.Players[i].ShowCards = true
	}
	t.state.HandState.Status = "complete"
	t.state.HandState.Stage = "showdown"
	t.state.HandState.WinnerSeats = winners
	t.state.HandState.WinnerAmounts = winnerAmounts
	message := fmt.Sprintf("Showdown. Seat %d wins %d.", bestEval.Seat, pot)
	t.state.HandState.HandResult = &models.HandResult{
		Heading:     fmt.Sprintf("Seat %d wins", bestEval.Seat),
		Lines:       []string{message},
		HeroOutcome: t.heroOutcome(winners),
	}
	t.appendHandLog(message)
	t.appendHandLog("Next hand starting shortly...")
	t.pruneDisconnected()
}

func (t *Table) showdownEvaluations() []HandEvaluation {
	var evals []HandEvaluation
	for _, p := range t.state.Players {
		if p.Status == "ACTIVE" || p.Status == "ALL_IN" {
			eval := Evaluate(append(p.HoleCards, t.state.HandState.CommunityCards...))
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

func (t *Table) waitingStatus(p models.Player) string {
	if p.Stack <= 0 {
		return "BUSTED"
	}
	if p.WillPlayNextHand {
		return "READY"
	}
	return "SITTING_OUT"
}

func (t *Table) heroOutcome(winners []int) string {
	for _, s := range winners {
		if s == 1 {
			return "win"
		}
	}
	return "loss"
}

func (t *Table) pruneDisconnected() {
	for i, p := range t.state.Players {
		if !p.IsBot && !p.Connected {
			t.state.Players[i] = t.buildBotPlayer(p.Seat, p.Stack)
		}
	}
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

func (t *Table) applyBotAction() {
	if t.state.HandState.ActingSeat == nil {
		return
	}
	seat := *t.state.HandState.ActingSeat
	var player models.Player
	found := false
	for _, p := range t.state.Players {
		if p.Seat == seat {
			player = p
			found = true
			break
		}
	}
	if !found || !player.IsBot {
		return
	}
	action, payload := t.chooseBotAction(player)
	t.processHandAction(action, payload)
}

func (t *Table) chooseBotAction(player models.Player) (string, map[string]interface{}) {
	toCall := t.state.HandState.CurrentBet - player.BetThisStreet
	if toCall < 0 {
		toCall = 0
	}
	facingBet := toCall > 0
	stage := t.state.HandState.Stage
	strength := "weak"
	hasPair := false
	if stage == "preflop" {
		s := t.preflopStrength(player.HoleCards)
		if s >= 65 {
			strength = "strong"
		} else if s >= 40 {
			strength = "medium"
		}
	} else {
		strength, hasPair = t.postflopBucket(player)
	}
	key := fmt.Sprintf("%s_%s_%s_%s", strength, stage, t.pairStr(hasPair), t.betStr(facingBet))
	probs, ok := CFRTable[key]
	if !ok {
		probs = [3]int{0, 500, 500}
	}
	decision := t.cfrSample(probs)
	if facingBet {
		switch decision {
		case "fold":
			return "fold", nil
		case "passive":
			return "call", nil
		case "aggressive":
			amount := t.botRaiseTarget(player, strength)
			if amount > 0 {
				return "raise", map[string]interface{}{"amount": amount}
			}
			return "call", nil
		}
	} else {
		switch decision {
		case "aggressive":
			return "bet", map[string]interface{}{"amount": t.botBetTarget(player, strength)}
		default:
			return "check", nil
		}
	}
	return "check", nil
}

func (t *Table) pairStr(b bool) string {
	if b {
		return "pair"
	}
	return "nopair"
}
func (t *Table) betStr(b bool) string {
	if b {
		return "bet"
	}
	return "nobet"
}
func (t *Table) cfrSample(probs [3]int) string {
	n := rand.Intn(1000)
	if n < probs[0] {
		return "fold"
	}
	if n < probs[0]+probs[1] {
		return "passive"
	}
	return "aggressive"
}

func (t *Table) preflopStrength(cards []string) int {
	if len(cards) < 2 {
		return 0
	}
	v1 := rankValues[string(cards[0][0])]
	v2 := rankValues[string(cards[1][0])]
	s := v1 + v2
	if v1 == v2 {
		s += 20
	}
	if cards[0][1] == cards[1][1] {
		s += 10
	}
	return s * 2
}

func (t *Table) postflopBucket(player models.Player) (string, bool) {
	eval := Evaluate(append(player.HoleCards, t.state.HandState.CommunityCards...))
	if eval.Score.Category >= 3 {
		return "strong", true
	}
	if eval.Score.Category >= 1 {
		return "medium", true
	}
	return "weak", false
}

func (t *Table) botBetTarget(player models.Player, strength string) int {
	pot := t.state.HandState.Pot
	if pot < BigBlind {
		pot = BigBlind
	}
	factor := 0.5
	if strength == "strong" {
		factor = 0.8
	}
	target := int(float64(pot) * factor)
	if target < BigBlind {
		target = BigBlind
	}
	if target > player.Stack {
		target = player.Stack
	}
	return target
}

func (t *Table) botRaiseTarget(player models.Player, strength string) int {
	currentBet := t.state.HandState.CurrentBet
	minRaise := t.state.HandState.MinimumRaise
	pot := t.state.HandState.Pot
	factor := 0.5
	if strength == "strong" {
		factor = 1.0
	}
	target := currentBet + int(float64(pot)*factor)
	if target < currentBet+minRaise {
		target = currentBet + minRaise
	}
	if target > player.BetThisStreet+player.Stack {
		target = player.BetThisStreet + player.Stack
	}
	return target
}
