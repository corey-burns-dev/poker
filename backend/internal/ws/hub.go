package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"poker-backend/internal/auth"
	"poker-backend/internal/game"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		allowed := strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",")
		origin := r.Header.Get("Origin")
		for _, a := range allowed {
			if strings.TrimSpace(a) == origin {
				return true
			}
		}
		return false
	},
}

type SocketMessage []interface{}

func (m SocketMessage) JoinRef() string {
	if len(m) > 0 && m[0] != nil {
		return fmt.Sprintf("%v", m[0])
	}
	return ""
}

func (m SocketMessage) MsgRef() string {
	if len(m) > 1 && m[1] != nil {
		return fmt.Sprintf("%v", m[1])
	}
	return ""
}

func (m SocketMessage) Topic() string {
	if len(m) > 2 {
		return fmt.Sprintf("%v", m[2])
	}
	return ""
}

func (m SocketMessage) Event() string {
	if len(m) > 3 {
		return fmt.Sprintf("%v", m[3])
	}
	return ""
}

func (m SocketMessage) Payload() interface{} {
	if len(m) > 4 {
		return m[4]
	}
	return nil
}

type Client struct {
	conn      *websocket.Conn
	mu        sync.Mutex
	playerID  string
	topics    map[string]string // topic -> join_ref
	listeners map[string]context.CancelFunc
}

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Identify player from cookie
	cookie, err := r.Cookie("_poker_key")
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	claims, err := auth.ValidateToken(cookie.Value)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	playerID := fmt.Sprintf("%d", claims.UserID)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}
	defer conn.Close()

	client := &Client{
		conn:      conn,
		topics:    make(map[string]string),
		listeners: make(map[string]context.CancelFunc),
		playerID:  playerID,
	}

	defer func() {
		// Clean up table memberships on disconnect
		if client.playerID != "" {
			client.mu.Lock()
			defer client.mu.Unlock()
			for _, cancel := range client.listeners {
				cancel()
			}
			for topic := range client.topics {
				if len(topic) > 6 && topic[:6] == "table:" {
					tableID := topic[6:]
					if t, err := game.GetRegistry().GetTable(tableID); err == nil {
						t.Leave(client.playerID)
					}
				}
			}
		}
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Read error: %v", err)
			break
		}

		var phxMsg SocketMessage
		if err := json.Unmarshal(msg, &phxMsg); err != nil {
			log.Printf("Unmarshal error: %v", err)
			continue
		}

		client.handleMessage(phxMsg)
	}
}

func (c *Client) handleMessage(msg SocketMessage) {
	topic := msg.Topic()
	event := msg.Event()
	payload := msg.Payload()

	switch event {
	case "join":
		c.handleJoin(topic, msg.JoinRef(), msg.MsgRef(), payload)
	case "heartbeat":
		c.sendReply(topic, "reply", msg.MsgRef(), map[string]interface{}{"status": "ok", "response": map[string]interface{}{}})
	case "ping":
		c.sendReply(topic, "reply", msg.MsgRef(), map[string]interface{}{"status": "ok", "response": map[string]interface{}{"type": "pong"}})
	case "action":
		c.handleAction(topic, msg.MsgRef(), payload)
	}
}

func (c *Client) handleJoin(topic string, joinRef string, msgRef string, payload interface{}) {
	if len(topic) > 6 && topic[:6] == "table:" {
		tableID := topic[6:]
		t, err := game.GetRegistry().GetTable(tableID)
		if err != nil {
			c.sendReply(topic, "reply", msgRef, map[string]interface{}{
				"status": "error",
				"response": map[string]interface{}{
					"reason": "table not found",
				},
			})
			return
		}

		pMap, ok := payload.(map[string]interface{})
		pName := "Anonymous"
		if ok {
			if name, ok := pMap["player_name"].(string); ok {
				pName = name
			}
		}

		if c.playerID != "" {
			t.Join(c.playerID, pName)
		}

		c.mu.Lock()
		if cancel, ok := c.listeners[topic]; ok {
			cancel()
		}
		ctx, cancel := context.WithCancel(context.Background())
		c.listeners[topic] = cancel
		c.topics[topic] = joinRef
		c.mu.Unlock()

		state := t.GetStateFor(c.playerID)
		c.sendReply(topic, "reply", msgRef, map[string]interface{}{
			"status": "ok",
			"response": map[string]interface{}{
				"state": state,
			},
		})

		go c.listenToTable(ctx, t, topic)
	}
}

func (c *Client) handleAction(topic string, msgRef string, payload interface{}) {
	if len(topic) > 6 && topic[:6] == "table:" {
		tableID := topic[6:]
		t, err := game.GetRegistry().GetTable(tableID)
		if err != nil {
			c.sendReply(topic, "reply", msgRef, map[string]interface{}{
				"status": "error",
				"response": map[string]interface{}{
					"reason": "table not found",
				},
			})
			return
		}

		pMap, ok := payload.(map[string]interface{})
		if ok {
			action := fmt.Sprintf("%v", pMap["action"])
			// Ensure player_id is in payload for table logic
			if c.playerID != "" {
				pMap["player_id"] = c.playerID
			}
			t.ApplyAction(action, pMap)
		}

		c.sendReply(topic, "reply", msgRef, map[string]interface{}{
			"status": "ok",
			"response": map[string]interface{}{
				"state": t.GetStateFor(c.playerID),
			},
		})
	}
}

func (c *Client) listenToTable(ctx context.Context, t *game.Table, topic string) {
	ch := t.Subscribe()
	defer t.Unsubscribe(ch)

	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-ch:
			if !ok {
				return
			}
			state := t.GetStateFor(c.playerID)
			c.push(topic, "table_event", map[string]interface{}{
				"type":  "table_state",
				"state": state,
			})
		}
	}
}

func (c *Client) sendReply(topic string, event string, msgRef string, payload interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	joinRef := c.topics[topic]
	resp := []interface{}{joinRef, msgRef, topic, event, payload}
	err := c.conn.WriteJSON(resp)
	if err != nil {
		c.conn.Close()
	}
}

func (c *Client) push(topic string, event string, payload interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	joinRef := c.topics[topic]
	resp := []interface{}{joinRef, nil, topic, event, payload}
	err := c.conn.WriteJSON(resp)
	if err != nil {
		c.conn.Close()
	}
}
