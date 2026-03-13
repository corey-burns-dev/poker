package game

import (
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

func (r *TableRegistry) GetTable(tableID string) *Table {
	r.mu.Lock()
	defer r.mu.Unlock()

	if t, ok := r.tables[tableID]; ok {
		return t
	}

	// New tables created on the fly start empty (no bots)
	t := NewTable(tableID, false)
	r.tables[tableID] = t
	return t
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
