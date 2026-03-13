package game

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"poker-backend/internal/models"
)

var BotNames = map[int]string{
	1: "Alice", 2: "Bob", 3: "Charlie", 4: "Daisy", 5: "Eli", 6: "Frankie", 7: "Gia", 8: "Harper",
}

type BotProfile struct {
	Style      string `json:"style"`
	Looseness  int    `json:"looseness"`
	Aggression int    `json:"aggression"`
	Bluff      int    `json:"bluff"`
}

var BotProfiles = map[int]BotProfile{
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
	"weak_preflop_nopair_nobet":    {0, 813, 187},
	"weak_preflop_nopair_bet":      {441, 541, 18},
	"medium_preflop_nopair_nobet":  {153, 444, 403},
	"medium_preflop_nopair_bet":    {5, 886, 109},
	"strong_preflop_nopair_nobet":  {0, 122, 878},
	"strong_preflop_nopair_bet":    {0, 685, 315},
	"strong_preflop_pair_nobet":    {167, 166, 667},
	"strong_preflop_pair_bet":      {241, 538, 221},
	"weak_postflop_nopair_nobet":   {0, 841, 159},
	"weak_postflop_nopair_bet":     {761, 228, 11},
	"weak_postflop_pair_nobet":     {0, 110, 890},
	"weak_postflop_pair_bet":       {2, 531, 467},
	"medium_postflop_nopair_nobet": {0, 726, 274},
	"medium_postflop_nopair_bet":   {764, 182, 54},
	"medium_postflop_pair_nobet":   {0, 609, 391},
	"medium_postflop_pair_bet":     {228, 592, 180},
	"strong_postflop_nopair_nobet": {0, 783, 217},
	"strong_postflop_nopair_bet":   {398, 594, 7},
	"strong_postflop_pair_nobet":   {0, 384, 616},
	"strong_postflop_pair_bet":     {59, 667, 274},
}

func init() {
	loadExternalConfigs()
}

func loadExternalConfigs() {
	// Try multiple possible paths for the data directory
	paths := []string{
		"backend/data", // Running from project root
		"data",         // Running from backend/ or in Docker
		"../data",      // Running from backend/internal/game/ (tests)
	}

	for _, p := range paths {
		profilesPath := filepath.Join(p, "bot_profiles.json")
		if _, err := os.Stat(profilesPath); err == nil {
			loadProfiles(profilesPath)
			break
		}
	}

	for _, p := range paths {
		cfrPath := filepath.Join(p, "cfr_table.json")
		if _, err := os.Stat(cfrPath); err == nil {
			loadCFR(cfrPath)
			break
		}
	}
}

func loadProfiles(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("Failed to read bot profiles from %s: %v", path, err)
		return
	}
	var raw map[string]BotProfile
	if err := json.Unmarshal(data, &raw); err != nil {
		log.Printf("Failed to unmarshal bot profiles: %v", err)
		return
	}
	for k, v := range raw {
		var id int
		fmt.Sscanf(k, "%d", &id)
		BotProfiles[id] = v
	}
	log.Printf("Loaded %d bot profiles from %s", len(BotProfiles), path)
}

func loadCFR(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("Failed to read CFR table from %s: %v", path, err)
		return
	}
	if err := json.Unmarshal(data, &CFRTable); err != nil {
		log.Printf("Failed to unmarshal CFR table: %v", err)
		return
	}
	log.Printf("Loaded CFR table from %s", path)
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
