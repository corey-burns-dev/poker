package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"poker-backend/internal/db"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestRegisterUser_NestedPayload(t *testing.T) {
	db.SetupTestDB()
	gin.SetMode(gin.TestMode)
	r := gin.Default()
	h := NewHandler(db.DB)
	r.POST("/api/users/register", h.RegisterUser)

	payload := map[string]interface{}{
		"user": map[string]string{
			"email":    "test@example.com",
			"username": "testuser",
			"password": "password123",
		},
	}
	body, _ := json.Marshal(payload)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/users/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)

	data, exists := response["data"].(map[string]interface{})
	assert.True(t, exists)
	assert.Equal(t, "test@example.com", data["email"])
	assert.Equal(t, "testuser", data["username"])
}

func TestLoginUser_NestedPayload(t *testing.T) {
	db.SetupTestDB()
	gin.SetMode(gin.TestMode)
	r := gin.Default()
	h := NewHandler(db.DB)
	r.POST("/api/users/register", h.RegisterUser)
	r.POST("/api/users/log-in", h.LoginUser)

	// First register
	registerPayload := map[string]interface{}{
		"user": map[string]string{
			"email":    "login@example.com",
			"username": "loginuser",
			"password": "password123",
		},
	}
	regBody, _ := json.Marshal(registerPayload)
	regW := httptest.NewRecorder()
	regReq, _ := http.NewRequest("POST", "/api/users/register", bytes.NewBuffer(regBody))
	regReq.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(regW, regReq)
	assert.Equal(t, http.StatusOK, regW.Code)

	// Then login
	loginPayload := map[string]interface{}{
		"user": map[string]string{
			"email":    "login@example.com",
			"password": "password123",
		},
	}
	loginBody, _ := json.Marshal(loginPayload)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("POST", "/api/users/log-in", bytes.NewBuffer(loginBody))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)

	data, exists := response["data"].(map[string]interface{})
	assert.True(t, exists)
	assert.Equal(t, "login@example.com", data["email"])
}
