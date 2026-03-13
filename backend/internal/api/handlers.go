package api

import (
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"poker-backend/internal/auth"
	"poker-backend/internal/game"
	"poker-backend/internal/models"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

type Handler struct {
	db *gorm.DB
}

func NewHandler(db *gorm.DB) *Handler {
	return &Handler{db: db}
}

func RegisterRoutes(r *gin.Engine, db *gorm.DB) {
	h := NewHandler(db)
	api := r.Group("/api")
	{
		api.GET("/health", h.GetHealth)
		api.GET("/tables", h.ListTables)
		api.POST("/tables", auth.AuthMiddleware(), h.CreateTable)
		api.GET("/tables/:table_id", h.GetTable)
		api.POST("/tables/:table_id/actions", auth.AuthMiddleware(), h.TableAction)

		usersGroup := api.Group("/users")
		{
			usersGroup.POST("/register", h.RegisterUser)
			usersGroup.POST("/log-in", h.LoginUser)
			usersGroup.POST("/guest", h.GuestLogin)
			usersGroup.DELETE("/log-out", h.LogoutUser)
			usersGroup.GET("/me", auth.AuthMiddleware(), h.GetMe)
		}
	}
}

func (h *Handler) GetHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":    "ok",
		"service":   "poker_backend",
		"framework": "gin",
	})
}

func (h *Handler) CreateTable(c *gin.Context) {
	var req struct {
		TableID  string `json:"table_id"`
		WithBots bool   `json:"with_bots"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Basic validation
	if strings.TrimSpace(req.TableID) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "table_id is required"})
		return
	}

	t, err := game.GetRegistry().CreateTable(req.TableID, req.WithBots)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"data": t.GetStateFor("")})
}

func (h *Handler) ListTables(c *gin.Context) {
	tables := game.GetRegistry().ListActiveTables()
	if len(tables) == 0 {
		tables = []string{"default"}
	}
	c.JSON(http.StatusOK, gin.H{"data": tables})
}

func (h *Handler) GetTable(c *gin.Context) {
	tableID := c.Param("table_id")
	t, err := game.GetRegistry().GetTable(tableID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "table not found"})
		return
	}
	playerID := ""
	cookie, err := c.Cookie("_poker_key")
	if err == nil {
		claims, err := auth.ValidateToken(cookie)
		if err == nil {
			playerID = fmt.Sprintf("%d", claims.UserID)
		}
	}
	c.JSON(http.StatusOK, t.GetStateFor(playerID))
}

func (h *Handler) TableAction(c *gin.Context) {
	tableID := c.Param("table_id")
	t, err := game.GetRegistry().GetTable(tableID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "table not found"})
		return
	}

	var payload map[string]interface{}
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	action := c.Query("action")
	if action == "" {
		action, _ = payload["action"].(string)
	}

	// Override or set player_id from authenticated user
	userID, exists := c.Get("userID")
	playerID := ""
	if exists {
		uid := userID.(uint)
		payload["player_id"] = fmt.Sprintf("%d", uid)
		playerID = fmt.Sprintf("%d", uid)
	}

	t.ApplyAction(action, payload)
	c.JSON(http.StatusOK, t.GetStateFor(playerID))
}

func setAuthCookie(c *gin.Context, token string, maxAge int) {
	// In production, Secure should be true. For now, we'll keep it false for development.
	// But HttpOnly and SameSite should be strict.
	secure := os.Getenv("ENV") == "production" || os.Getenv("HTTPS") == "true"
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie("_poker_key", token, maxAge, "/", "", secure, true)
}

func (h *Handler) RegisterUser(c *gin.Context) {
	var req struct {
		User struct {
			Email    string `json:"email"`
			Username string `json:"username"`
			Password string `json:"password"`
		} `json:"user"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if strings.TrimSpace(req.User.Email) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email required"})
		return
	}
	if len(req.User.Username) < 3 || len(req.User.Username) > 30 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username must be 3–30 chars"})
		return
	}
	if len(req.User.Password) == 0 || len(req.User.Password) > 72 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password must be 1–72 chars"})
		return
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.User.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to hash password"})
		return
	}

	user := models.User{
		Email:          req.User.Email,
		Username:       req.User.Username,
		Balance:        5000,
		HashedPassword: string(hashedPassword),
	}

	if err := h.db.Create(&user).Error; err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "Email or Username already taken"})
		return
	}

	token, err := auth.GenerateToken(user.ID, user.Email, user.Username, user.Balance)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate token"})
		return
	}

	setAuthCookie(c, token, 3600*24*7)
	c.JSON(http.StatusOK, gin.H{"data": user})
}

func (h *Handler) LoginUser(c *gin.Context) {
	var req struct {
		User struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		} `json:"user"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var user models.User
	if err := h.db.Where("email = ?", req.User.Email).First(&user).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid email or password"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.HashedPassword), []byte(req.User.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid email or password"})
		return
	}

	token, err := auth.GenerateToken(user.ID, user.Email, user.Username, user.Balance)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate token"})
		return
	}

	setAuthCookie(c, token, 3600*24*7)
	c.JSON(http.StatusOK, gin.H{"data": user})
}

func (h *Handler) GuestLogin(c *gin.Context) {
	// Generate a random high user ID to avoid collision with real DB users
	// In production, we'd use UUIDs or a separate auth mechanism
	rand.Seed(time.Now().UnixNano())
	guestID := uint(1000000000 + rand.Uint32()%1000000000)
	
	guestName := fmt.Sprintf("Guest %d", guestID%10000)
	
	token, err := auth.GenerateToken(guestID, "guest@poker", guestName, 5000)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate token"})
		return
	}

	setAuthCookie(c, token, 3600*24) // 1 day for guests
	c.JSON(http.StatusOK, gin.H{"data": map[string]interface{}{
		"id": guestID,
		"username": guestName,
		"balance": 5000,
	}})
}

func (h *Handler) LogoutUser(c *gin.Context) {
	setAuthCookie(c, "", -1)
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (h *Handler) GetMe(c *gin.Context) {
	userID, exists := c.Get("userID")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	username, _ := c.Get("userName")
	email, _ := c.Get("userEmail")
	balance, _ := c.Get("userBalance")

	user := models.User{
		ID:       userID.(uint),
		Email:    email.(string),
		Username: username.(string),
		Balance:  balance.(int),
	}

	c.JSON(http.StatusOK, gin.H{"data": user})
}
