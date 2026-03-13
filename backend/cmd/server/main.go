package main

import (
	"log"
	"poker-backend/internal/api"
	"poker-backend/internal/db"
	"poker-backend/internal/ws"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func main() {
	db.InitDB()
	r := gin.Default()

	// CORS configuration
	config := cors.DefaultConfig()
	config.AllowAllOrigins = true
	config.AllowMethods = []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"}
	config.AllowHeaders = []string{"Origin", "Content-Type", "Accept", "Authorization"}
	config.AllowCredentials = true
	r.Use(cors.New(config))

	// WebSocket route
	r.GET("/socket/websocket", func(c *gin.Context) {
		ws.HandleWebSocket(c.Writer, c.Request)
	})

	// API routes
	api.RegisterRoutes(r)

	log.Println("Server starting on :4000")
	if err := r.Run(":4000"); err != nil {
		log.Fatalf("Failed to run server: %v", err)
	}
}
