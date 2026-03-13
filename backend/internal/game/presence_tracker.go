package game

import (
	"poker-backend/internal/models"
	"time"
)

// PresenceTracker handles player connections and presence
type PresenceTracker struct {
	state *models.TableState
	log   func(string)
}

// NewPresenceTracker creates a new presence tracker
func NewPresenceTracker(state *models.TableState, log func(string)) *PresenceTracker {
	return &PresenceTracker{state: state, log: log}
}

// PlayerJoined handles a player joining the table
func (pt *PresenceTracker) PlayerJoined(playerID, playerName string) {
	pt.incrementConnection(playerID)
	pt.reconnectPlayer(playerID)
	pt.state.LastEvent = playerName + " joined the table"
	pt.log(playerName + " joined")
}

// PlayerLeft handles a player leaving the table
func (pt *PresenceTracker) PlayerLeft(playerID string) {
	pt.decrementConnection(playerID)
	pt.disconnectPlayer(playerID)
	pt.state.LastEvent = playerID + " left the table"
	pt.log(playerID + " left")
}

// incrementConnection increases the connection count for a player
func (pt *PresenceTracker) incrementConnection(playerID string) {
	pt.state.ClientConnections[playerID]++
	pt.updateConnectedCount()
}

// decrementConnection decreases the connection count for a player
func (pt *PresenceTracker) decrementConnection(playerID string) {
	if count, exists := pt.state.ClientConnections[playerID]; exists && count > 0 {
		pt.state.ClientConnections[playerID]--
		if pt.state.ClientConnections[playerID] == 0 {
			delete(pt.state.ClientConnections, playerID)
		}
	}
	pt.updateConnectedCount()
}

// updateConnectedCount recalculates the total connected clients
func (pt *PresenceTracker) updateConnectedCount() {
	total := 0
	for _, count := range pt.state.ClientConnections {
		total += count
	}
	pt.state.ConnectedClients = total
}

// reconnectPlayer marks a player as connected and clears disconnect time
func (pt *PresenceTracker) reconnectPlayer(playerID string) {
	for i := range pt.state.Players {
		p := &pt.state.Players[i]
		if p.PlayerID != nil && *p.PlayerID == playerID && !p.IsBot {
			p.Connected = true
			p.DisconnectedAt = nil
			return
		}
	}
}

// disconnectPlayer marks a player as disconnected and sets disconnect time
func (pt *PresenceTracker) disconnectPlayer(playerID string) {
	for i := range pt.state.Players {
		p := &pt.state.Players[i]
		if p.PlayerID != nil && *p.PlayerID == playerID && !p.IsBot {
			if pt.state.ClientConnections[playerID] == 0 {
				p.Connected = false
				now := time.Now()
				p.DisconnectedAt = &now
			}
			return
		}
	}
}

// IsConnected checks if a player is currently connected
func (pt *PresenceTracker) IsConnected(playerID string) bool {
	return pt.state.ClientConnections[playerID] > 0
}

// ConnectedPlayerCount returns the total number of connected players
func (pt *PresenceTracker) ConnectedPlayerCount() int {
	return pt.state.ConnectedClients
}
