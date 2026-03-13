package api

import (
	"net/http"
	"poker-backend/internal/auth"
	"poker-backend/internal/db"
	"poker-backend/internal/game"
	"poker-backend/internal/models"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

func RegisterRoutes(r *gin.Engine) {
	api := r.Group("/api")
	{
		api.GET("/health", GetHealth)
		api.GET("/tables", ListTables)
		api.GET("/tables/:table_id", GetTable)
		api.POST("/tables/:table_id/actions", auth.AuthMiddleware(), TableAction)

		usersGroup := api.Group("/users")
		{
			usersGroup.POST("/register", RegisterUser)
			usersGroup.POST("/log-in", LoginUser)
			usersGroup.DELETE("/log-out", LogoutUser)
			usersGroup.GET("/me", auth.AuthMiddleware(), GetMe)
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

	// Override or set player_id from authenticated user
	userEmail, exists := c.Get("userEmail")
	if exists {
		payload["player_id"] = userEmail
	}

	t.ApplyAction(action, payload)
	c.JSON(http.StatusOK, t.GetState())
}

func setAuthCookie(c *gin.Context, token string, maxAge int) {
	// In production, Secure should be true. For now, we'll keep it false for development.
	// But HttpOnly and SameSite should be strict.
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie("_poker_key", token, maxAge, "/", "", false, true)
}

func RegisterUser(c *gin.Context) {
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

	if err := db.DB.Create(&user).Error; err != nil {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "Email or Username already taken"})
		return
	}

	token, err := auth.GenerateToken(user.ID, user.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate token"})
		return
	}

	setAuthCookie(c, token, 3600*24*7)
	c.JSON(http.StatusOK, gin.H{"data": user})
}

func LoginUser(c *gin.Context) {
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
	if err := db.DB.Where("email = ?", req.User.Email).First(&user).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid email or password"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.HashedPassword), []byte(req.User.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid email or password"})
		return
	}

	token, err := auth.GenerateToken(user.ID, user.Email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate token"})
		return
	}

	setAuthCookie(c, token, 3600*24*7)
	c.JSON(http.StatusOK, gin.H{"data": user})
}

func LogoutUser(c *gin.Context) {
	setAuthCookie(c, "", -1)
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func GetMe(c *gin.Context) {
	userID, exists := c.Get("userID")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var user models.User
	if err := db.DB.First(&user, userID).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": user})
}
