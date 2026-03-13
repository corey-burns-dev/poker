package game

import (
	"testing"
)

func TestEvaluate(t *testing.T) {
	tests := []struct {
		name     string
		cards    []string
		category int
	}{
		{
			name:     "High Card",
			cards:    []string{"As", "Kd", "7h", "5c", "2s"},
			category: 0,
		},
		{
			name:     "Pair",
			cards:    []string{"As", "Ad", "7h", "5c", "2s"},
			category: 1,
		},
		{
			name:     "Two Pair",
			cards:    []string{"As", "Ad", "Kh", "Kc", "2s"},
			category: 2,
		},
		{
			name:     "Three of a Kind",
			cards:    []string{"As", "Ad", "Ah", "5c", "2s"},
			category: 3,
		},
		{
			name:     "Straight",
			cards:    []string{"As", "2d", "3h", "4c", "5s"},
			category: 4,
		},
		{
			name:     "Flush",
			cards:    []string{"As", "Ks", "Ts", "5s", "2s"},
			category: 5,
		},
		{
			name:     "Full House",
			cards:    []string{"As", "Ad", "Ah", "Ks", "Kd"},
			category: 6,
		},
		{
			name:     "Four of a Kind",
			cards:    []string{"As", "Ad", "Ah", "Ac", "2s"},
			category: 7,
		},
		{
			name:     "Straight Flush",
			cards:    []string{"2s", "3s", "4s", "5s", "6s"},
			category: 8,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := Evaluate(tt.cards)
			if res.Score.Category != tt.category {
				t.Errorf("Evaluate() category = %v, want %v", res.Score.Category, tt.category)
			}
		})
	}
}
