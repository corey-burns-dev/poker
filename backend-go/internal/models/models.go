package models

import (
	"time"
)

type User struct {
	ID             uint       `gorm:"primaryKey" json:"id"`
	Email          string     `gorm:"uniqueIndex;type:citext" json:"email"`
	Username       string     `gorm:"uniqueIndex;type:citext" json:"username"`
	Balance        int        `gorm:"default:5000" json:"balance"`
	HashedPassword string     `json:"-"`
	ConfirmedAt    *time.Time `json:"confirmed_at"`
	CreatedAt      time.Time  `json:"inserted_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

type Player struct {
	Seat                 int      `json:"seat"`
	Name                 string   `json:"name"`
	Stack                int      `json:"stack"`
	Status               string   `json:"status"`
	WillPlayNextHand     bool     `json:"will_play_next_hand"`
	ShowCards            bool     `json:"show_cards"`
	IsBot                bool     `json:"is_bot"`
	BotStyle             *string  `json:"bot_style"`
	PlayerID             *string  `json:"player_id"`
	Connected            bool     `json:"connected"`
	BetThisStreet        int      `json:"bet_this_street"`
	ContributedThisHand  int      `json:"contributed_this_hand"`
	HoleCards            []string `json:"hole_cards"`
}

type HandState struct {
	Status          string         `json:"status"`
	Stage           string         `json:"stage"`
	HandNumber      int            `json:"hand_number"`
	Pot             int            `json:"pot"`
	CurrentBet      int            `json:"current_bet"`
	MinimumRaise    int            `json:"minimum_raise"`
	ActingSeat      *int           `json:"acting_seat"`
	DealerSeat      int            `json:"dealer_seat"`
	SmallBlindSeat  int            `json:"small_blind_seat"`
	BigBlindSeat    int            `json:"big_blind_seat"`
	CommunityCards  []string       `json:"community_cards"`
	Deck            []string       `json:"-"`
	ActionLog       []string       `json:"action_log"`
	ActionLogSeq    int            `json:"action_log_seq"`
	LastAction      string         `json:"last_action"`
	ActedSeats      []int          `json:"acted_seats"`
	WinnerSeats     []int          `json:"winner_seats"`
	WinnerAmounts   map[string]int `json:"winner_amounts"`
	SidePots        []SidePot      `json:"side_pots"`
	HandResult      *HandResult    `json:"hand_result"`
}

type SidePot struct {
	Amount        int            `json:"amount"`
	EligibleSeats []int          `json:"eligible_seats"`
	WinnerSeats   []int          `json:"winner_seats"`
	WinnerAmounts map[string]int `json:"winner_amounts"`
}

type HandResult struct {
	Heading     string   `json:"heading"`
	Lines       []string `json:"lines"`
	HeroOutcome string   `json:"hero_outcome"`
}

type TableState struct {
	TableID           string            `json:"table_id"`
	Players           []Player          `json:"players"`
	GameState         string            `json:"game_state"`
	HandNumber        int               `json:"hand_number"`
	ConnectedClients  int               `json:"connected_clients"`
	LastEvent         string            `json:"last_event"`
	HandState         HandState         `json:"hand_state"`
	ClientConnections map[string]int    `json:"-"`
	PendingPlayers    []PendingPlayer   `json:"pending_players"`
}

type PendingPlayer struct {
	PlayerID         string `json:"player_id"`
	Name             string `json:"name"`
	Connected        bool   `json:"connected"`
	WillPlayNextHand bool   `json:"will_play_next_hand"`
	DesiredSeat      int    `json:"desired_seat"`
}
