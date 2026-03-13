package api

import (
	"net/http"
	"poker-backend/internal/game"
	"sync"

	"github.com/gin-gonic/gin"
)

type InMemoryUser struct {
	ID       uint   `json:"id"`
	Email    string `json:"email"`
	Username string `json:"username"`
	Balance  int    `json:"balance"`
	Password string `json:"-"`
}

var (
	users      = make(map[string]*InMemoryUser) // email -> user
	usersMu    sync.RWMutex
	nextUserID uint = 1
)

func RegisterRoutes(r *gin.Engine) {
	api := r.Group("/api")
	{
		api.GET("/health", GetHealth)
		api.GET("/tables", ListTables)
		api.GET("/tables/:table_id", GetTable)
		api.POST("/tables/:table_id/actions", TableAction)
		
		usersGroup := api.Group("/users")
		{
			usersGroup.POST("/register", RegisterUser)
			usersGroup.POST("/log-in", LoginUser)
			usersGroup.DELETE("/log-out", LogoutUser)
			usersGroup.GET("/me", GetMe)
		}
	}
}

func GetHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":    "ok",
		"service":   "poker_backend",
		"framework": "gin",
	})
}

func ListTables(c *gin.Context) {
	tables := game.GetRegistry().ListActiveTables()
	if len(tables) == 0 {
		tables = []string{"default"}
	}
	c.JSON(http.StatusOK, gin.H{"data": tables})
}

func GetTable(c *gin.Context) {
	tableID := c.Param("table_id")
	t := game.GetRegistry().GetTable(tableID)
	c.JSON(http.StatusOK, t.GetState())
}

func TableAction(c *gin.Context) {
	tableID := c.Param("table_id")
	t := game.GetRegistry().GetTable(tableID)
	
	var payload map[string]interface{}
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	
	action := c.Query("action")
	if action == "" {
		action, _ = payload["action"].(string)
	}
	
	t.ApplyAction(action, payload)
	c.JSON(http.StatusOK, t.GetState())
}

func RegisterUser(c *gin.Context) {
	var req struct {
		Email    string `json:"email"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	usersMu.Lock()
	defer usersMu.Unlock()

	if _, exists := users[req.Email]; exists {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "Email already taken"})
		return
	}

	user := &InMemoryUser{
		ID:       nextUserID,
		Email:    req.Email,
		Username: req.Username,
		Balance:  5000,
		Password: req.Password,
	}
	users[req.Email] = user
	nextUserID++

	// Set a mock session cookie or just return the user
	// The frontend uses credentials: 'include', so we might need a cookie
	c.SetCookie("_poker_key", req.Email, 3600, "/", "", false, true)

	c.JSON(http.StatusOK, gin.H{"data": user})
}

func LoginUser(c *gin.Context) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	usersMu.RLock()
	user, exists := users[req.Email]
	usersMu.RUnlock()

	if !exists || user.Password != req.Password {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid email or password"})
		return
	}

	c.SetCookie("_poker_key", req.Email, 3600, "/", "", false, true)
	c.JSON(http.StatusOK, gin.H{"data": user})
}

func LogoutUser(c *gin.Context) {
	c.SetCookie("_poker_key", "", -1, "/", "", false, true)
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func GetMe(c *gin.Context) {
	email, err := c.Cookie("_poker_key")
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	usersMu.RLock()
	user, exists := users[email]
	usersMu.RUnlock()

	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": user})
}
