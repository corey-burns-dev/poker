package ws

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"poker-backend/internal/auth"
	"poker-backend/internal/game"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type PhoenixMessage []interface{}

func (m PhoenixMessage) JoinRef() string {
	if len(m) > 0 && m[0] != nil {
		return fmt.Sprintf("%v", m[0])
	}
	return ""
}

func (m PhoenixMessage) MsgRef() string {
	if len(m) > 1 && m[1] != nil {
		return fmt.Sprintf("%v", m[1])
	}
	return ""
}

func (m PhoenixMessage) Topic() string {
	if len(m) > 2 {
		return fmt.Sprintf("%v", m[2])
	}
	return ""
}

func (m PhoenixMessage) Event() string {
	if len(m) > 3 {
		return fmt.Sprintf("%v", m[3])
	}
	return ""
}

func (m PhoenixMessage) Payload() interface{} {
	if len(m) > 4 {
		return m[4]
	}
	return nil
}

type Client struct {
	conn     *websocket.Conn
	mu       sync.Mutex
	playerID string
	topics   map[string]string // topic -> join_ref
}

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Identify player from cookie
	cookie, err := r.Cookie("_poker_key")
	playerID := ""
	if err == nil {
		claims, err := auth.ValidateToken(cookie.Value)
		if err == nil {
			// Using email as playerID for compatibility with existing logic
			playerID = claims.Email
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}
	defer conn.Close()

	client := &Client{
		conn:     conn,
		topics:   make(map[string]string),
		playerID: playerID,
	}

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Read error: %v", err)
			break
		}

		var phxMsg PhoenixMessage
		if err := json.Unmarshal(msg, &phxMsg); err != nil {
			log.Printf("Unmarshal error: %v", err)
			continue
		}

		client.handleMessage(phxMsg)
	}
}

func (c *Client) handleMessage(msg PhoenixMessage) {
	topic := msg.Topic()
	event := msg.Event()
	payload := msg.Payload()

	if event == "phx_join" {
		c.handleJoin(topic, msg.JoinRef(), msg.MsgRef(), payload)
	} else if event == "heartbeat" {
		c.sendReply(topic, "phx_reply", msg.MsgRef(), map[string]interface{}{"status": "ok", "response": map[string]interface{}{}})
	} else if event == "ping" {
		c.sendReply(topic, "phx_reply", msg.MsgRef(), map[string]interface{}{"status": "ok", "response": map[string]interface{}{"type": "pong"}})
	} else if event == "action" {
		c.handleAction(topic, msg.MsgRef(), payload)
	}
}

func (c *Client) handleJoin(topic string, joinRef string, msgRef string, payload interface{}) {
	if len(topic) > 6 && topic[:6] == "table:" {
		tableID := topic[6:]
		t := game.GetRegistry().GetTable(tableID)

		pMap, ok := payload.(map[string]interface{})
		pName := "Anonymous"
		if ok {
			if name, ok := pMap["player_name"].(string); ok {
				pName = name
			}
			// Use playerID from cookie if available, otherwise from payload
			if c.playerID == "" {
				if id, ok := pMap["player_id"].(string); ok {
					c.playerID = id
				}
			}
		}

		if c.playerID != "" {
			t.Join(c.playerID, pName)
		}

		c.topics[topic] = joinRef

		state := t.GetState()
		c.sendReply(topic, "phx_reply", msgRef, map[string]interface{}{
			"status": "ok",
			"response": map[string]interface{}{
				"state": state,
			},
		})

		go c.listenToTable(t, topic)
	}
}

func (c *Client) handleAction(topic string, msgRef string, payload interface{}) {
	if len(topic) > 6 && topic[:6] == "table:" {
		tableID := topic[6:]
		t := game.GetRegistry().GetTable(tableID)

		pMap, ok := payload.(map[string]interface{})
		if ok {
			action := fmt.Sprintf("%v", pMap["action"])
			// Ensure player_id is in payload for table logic
			if _, exists := pMap["player_id"]; !exists && c.playerID != "" {
				pMap["player_id"] = c.playerID
			}
			t.ApplyAction(action, pMap)
		}

		c.sendReply(topic, "phx_reply", msgRef, map[string]interface{}{
			"status": "ok",
			"response": map[string]interface{}{
				"state": t.GetState(),
			},
		})
	}
}

func (c *Client) listenToTable(t *game.Table, topic string) {
	ch := t.Subscribe()
	defer t.Unsubscribe(ch)

	for {
		stateRaw, ok := <-ch
		if !ok {
			break
		}
		c.push(topic, "table_event", map[string]interface{}{
			"type":  "table_state",
			"state": stateRaw,
		})
	}
}

func (c *Client) sendReply(topic string, event string, msgRef string, payload interface{}) {
	joinRef := c.topics[topic]
	resp := []interface{}{joinRef, msgRef, topic, event, payload}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn.WriteJSON(resp)
}

func (c *Client) push(topic string, event string, payload interface{}) {
	joinRef := c.topics[topic]
	resp := []interface{}{joinRef, nil, topic, event, payload}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.conn.WriteJSON(resp)
}
