package game

import (
	"errors"
	"sync"
)

type TableRegistry struct {
	mu     sync.RWMutex
	tables map[string]*Table
}

var globalRegistry = &TableRegistry{
	tables: make(map[string]*Table),
}

func init() {
	// Pre-initialize default tables
	// "default" is the Bot Warmup Table
	globalRegistry.tables["default"] = NewTable("default", true)

	// "human-table" is an empty table for human players
	globalRegistry.tables["human-table"] = NewTable("human-table", false)
}

func GetRegistry() *TableRegistry {
	return globalRegistry
}

func (r *TableRegistry) GetTable(tableID string) (*Table, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.tables[tableID]
	if !ok {
		return nil, errors.New("table not found")
	}
	return t, nil
}

func (r *TableRegistry) CreateTable(tableID string, withBots bool) (*Table, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.tables[tableID]; ok {
		return nil, errors.New("table already exists")
	}

	t := NewTable(tableID, withBots)
	r.tables[tableID] = t
	return t, nil
}

func (r *TableRegistry) ListActiveTables() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var ids []string
	// Always include default tables in the list even if not explicitly in the map
	// though they are in init()
	for id := range r.tables {
		ids = append(ids, id)
	}
	return ids
}

func (r *TableRegistry) RemoveTable(tableID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if t, ok := r.tables[tableID]; ok {
		t.Stop()
		delete(r.tables, tableID)
	}
}
