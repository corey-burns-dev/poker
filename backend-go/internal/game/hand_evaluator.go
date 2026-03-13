package game

import (
	"fmt"
	"sort"
)

var rankValues = map[string]int{
	"2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "T": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
}

var rankNames = map[int]string{
	2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten", 11: "Jack", 12: "Queen", 13: "King", 14: "Ace", 1: "Ace",
}

var pluralRankNames = map[int]string{
	2: "Twos", 3: "Threes", 4: "Fours", 5: "Fives", 6: "Sixes", 7: "Sevens", 8: "Eights", 9: "Nines", 10: "Tens", 11: "Jacks", 12: "Queens", 13: "Kings", 14: "Aces", 1: "Aces",
}

type Score struct {
	Category int   // 0: High Card, 1: Pair, ..., 8: Straight Flush
	Values   []int // Tie-breakers
}

func (s Score) Compare(other Score) int {
	if s.Category > other.Category {
		return 1
	}
	if s.Category < other.Category {
		return -1
	}
	for i := 0; i < len(s.Values) && i < len(other.Values); i++ {
		if s.Values[i] > other.Values[i] {
			return 1
		}
		if s.Values[i] < other.Values[i] {
			return -1
		}
	}
	return 0
}

type HandEvaluation struct {
	Score       Score
	Description string
	Cards       []string
	Seat        int
}

func Evaluate(cards []string) HandEvaluation {
	if len(cards) < 5 {
		return HandEvaluation{}
	}

	best := HandEvaluation{Score: Score{Category: -1}}

	combs := combinations(cards, 5)
	for _, comb := range combs {
		eval := scoreFive(comb)
		if best.Score.Category == -1 || eval.Score.Compare(best.Score) > 0 {
			best = eval
		}
	}

	return best
}

func scoreFive(cards []string) HandEvaluation {
	type parsedCard struct {
		rank int
		suit string
	}

	parsed := make([]parsedCard, 5)
	ranks := make([]int, 5)
	suits := make([]string, 5)
	for i, c := range cards {
		r := rankValues[string(c[0])]
		s := string(c[1])
		parsed[i] = parsedCard{r, s}
		ranks[i] = r
		suits[i] = s
	}

	sort.Slice(ranks, func(i, j int) bool { return ranks[i] > ranks[j] })

	freqs := make(map[int]int)
	for _, r := range ranks {
		freqs[r]++
	}

	type freqGroup struct {
		count int
		rank  int
	}
	var groups []freqGroup
	for r, c := range freqs {
		groups = append(groups, freqGroup{c, r})
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].count != groups[j].count {
			return groups[i].count > groups[j].count
		}
		return groups[i].rank > groups[j].rank
	})

	isFlush := true
	for i := 1; i < 5; i++ {
		if suits[i] != suits[0] {
			isFlush = false
			break
		}
	}

	straightHigh := getStraightHigh(ranks)

	if isFlush && straightHigh > 0 {
		return HandEvaluation{
			Score:       Score{Category: 8, Values: []int{straightHigh}},
			Description: fmt.Sprintf("Straight flush, %s high", rankNames[straightHigh]),
			Cards:       cards,
		}
	}

	if groups[0].count == 4 {
		return HandEvaluation{
			Score:       Score{Category: 7, Values: []int{groups[0].rank, groups[1].rank}},
			Description: fmt.Sprintf("Four of a kind, %s", pluralRankNames[groups[0].rank]),
			Cards:       cards,
		}
	}

	if groups[0].count == 3 && groups[1].count == 2 {
		return HandEvaluation{
			Score:       Score{Category: 6, Values: []int{groups[0].rank, groups[1].rank}},
			Description: fmt.Sprintf("Full house, %s over %s", pluralRankNames[groups[0].rank], pluralRankNames[groups[1].rank]),
			Cards:       cards,
		}
	}

	if isFlush {
		return HandEvaluation{
			Score:       Score{Category: 5, Values: ranks},
			Description: fmt.Sprintf("Flush, %s high", rankNames[ranks[0]]),
			Cards:       cards,
		}
	}

	if straightHigh > 0 {
		return HandEvaluation{
			Score:       Score{Category: 4, Values: []int{straightHigh}},
			Description: fmt.Sprintf("Straight, %s high", rankNames[straightHigh]),
			Cards:       cards,
		}
	}

	if groups[0].count == 3 {
		return HandEvaluation{
			Score:       Score{Category: 3, Values: []int{groups[0].rank, groups[1].rank, groups[2].rank}},
			Description: fmt.Sprintf("Three of a kind, %s", pluralRankNames[groups[0].rank]),
			Cards:       cards,
		}
	}

	if groups[0].count == 2 && groups[1].count == 2 {
		return HandEvaluation{
			Score:       Score{Category: 2, Values: []int{groups[0].rank, groups[1].rank, groups[2].rank}},
			Description: fmt.Sprintf("Two pair, %s and %s", pluralRankNames[groups[0].rank], pluralRankNames[groups[1].rank]),
			Cards:       cards,
		}
	}

	if groups[0].count == 2 {
		return HandEvaluation{
			Score:       Score{Category: 1, Values: []int{groups[0].rank, groups[1].rank, groups[2].rank, groups[3].rank}},
			Description: fmt.Sprintf("Pair of %s", pluralRankNames[groups[0].rank]),
			Cards:       cards,
		}
	}

	return HandEvaluation{
		Score:       Score{Category: 0, Values: ranks},
		Description: fmt.Sprintf("High card, %s", rankNames[ranks[0]]),
		Cards:       cards,
	}
}

func getStraightHigh(ranks []int) int {
	uniqueMap := make(map[int]bool)
	for _, r := range ranks {
		uniqueMap[r] = true
	}
	var unique []int
	for r := range uniqueMap {
		unique = append(unique, r)
	}
	if uniqueMap[14] {
		unique = append(unique, 1)
	}
	sort.Ints(unique)

	if len(unique) < 5 {
		return 0
	}

	bestHigh := 0
	for i := 0; i <= len(unique)-5; i++ {
		if unique[i+4] == unique[i]+4 {
			bestHigh = unique[i+4]
		}
	}
	return bestHigh
}

func combinations(list []string, size int) [][]string {
	if size == 0 {
		return [][]string{{}}
	}
	if len(list) == 0 {
		return nil
	}

	var res [][]string
	// with head
	head := list[0]
	withHead := combinations(list[1:], size-1)
	for _, c := range withHead {
		res = append(res, append([]string{head}, c...))
	}
	// without head
	withoutHead := combinations(list[1:], size)
	res = append(res, withoutHead...)

	return res
}

func (s Score) CategoryName() string {
	switch s.Category {
	case 8: return "straight_flush"
	case 7: return "four_of_a_kind"
	case 6: return "full_house"
	case 5: return "flush"
	case 4: return "straight"
	case 3: return "three_of_a_kind"
	case 2: return "two_pair"
	case 1: return "pair"
	default: return "high_card"
	}
}
