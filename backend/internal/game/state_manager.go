package game

import (
	"fmt"
	"math/rand"
	"poker-backend/internal/models"
	"time"
)

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

func (t *Table) pruneDisconnected() {
	for i, p := range t.state.Players {
		if !p.IsBot && !p.Connected {
			t.state.Players[i] = t.buildBotPlayer(p.Seat, p.Stack)
		}
	}
}
