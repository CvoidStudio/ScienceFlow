package agent

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type ModelConfig struct {
	ID        string `json:"id"`
	ModelName string `json:"model_name"`
	APIKey    string `json:"api_key"`
	APIURL    string `json:"api_url"`
	Active    bool   `json:"is_active"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type ModelView struct {
	ID           string `json:"id"`
	ModelName    string `json:"model_name"`
	APIKey       string `json:"api_key"`
	APIKeyMasked string `json:"api_key_masked"`
	APIURL       string `json:"api_url"`
	Active       bool   `json:"is_active"`
	CreatedAt    string `json:"created_at,omitempty"`
	UpdatedAt    string `json:"updated_at,omitempty"`
}

type ModelCreateRequest struct {
	ModelName string `json:"model_name"`
	APIKey    string `json:"api_key"`
	APIURL    string `json:"api_url"`
}

type ModelUpdateRequest struct {
	ModelName string `json:"model_name"`
	APIKey    string `json:"api_key"`
	APIURL    string `json:"api_url"`
}

type modelStoreFile struct {
	Models []ModelConfig `json:"models"`
	Active string        `json:"active"`
}

type ModelStore struct {
	mu               sync.RWMutex
	path             string
	models           map[string]ModelConfig
	active           string
	sessions         map[string]string
	sessionsCoder    map[string]string
	sessionsFeedback map[string]string
}

func NewModelStore(path string) (*ModelStore, error) {
	store := &ModelStore{
		path:             path,
		models:           make(map[string]ModelConfig),
		sessions:         make(map[string]string),
		sessionsCoder:    make(map[string]string),
		sessionsFeedback: make(map[string]string),
	}
	if path == "" {
		return store, nil
	}
	if err := store.load(); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *ModelStore) load() error {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read model store: %w", err)
	}
	var data modelStoreFile
	if err := json.Unmarshal(b, &data); err != nil {
		return fmt.Errorf("parse model store: %w", err)
	}
	for _, m := range data.Models {
		if m.ID == "" || m.ModelName == "" {
			continue
		}
		m.Active = m.ID == data.Active
		s.models[m.ID] = m
	}
	s.active = data.Active
	return nil
}

func (s *ModelStore) saveLocked() error {
	if s.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("create model store dir: %w", err)
	}
	data := modelStoreFile{Active: s.active}
	for _, m := range s.models {
		m.Active = m.ID == s.active
		data.Models = append(data.Models, m)
	}
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, b, 0o600)
}

func (s *ModelStore) List() []ModelView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]ModelView, 0, len(s.models))
	for _, m := range s.models {
		items = append(items, modelView(m, m.ID == s.active))
	}
	return items
}

func (s *ModelStore) Create(req ModelCreateRequest) (ModelView, error) {
	name := strings.TrimSpace(req.ModelName)
	if name == "" || strings.TrimSpace(req.APIKey) == "" || strings.TrimSpace(req.APIURL) == "" {
		return ModelView{}, errors.New("model_name, api_key and api_url are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.models {
		if strings.EqualFold(m.ModelName, name) {
			return ModelView{}, errors.New("model already exists")
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	id := "model-" + randomHex(8)
	m := ModelConfig{ID: id, ModelName: name, APIKey: strings.TrimSpace(req.APIKey), APIURL: strings.TrimSpace(req.APIURL), CreatedAt: now, UpdatedAt: now}
	s.models[id] = m
	if s.active == "" {
		s.active = id
	}
	if err := s.saveLocked(); err != nil {
		return ModelView{}, err
	}
	return modelView(m, id == s.active), nil
}

func (s *ModelStore) Update(id string, req ModelUpdateRequest) (ModelView, error) {
	name := strings.TrimSpace(req.ModelName)
	if name == "" || strings.TrimSpace(req.APIURL) == "" {
		return ModelView{}, errors.New("model_name and api_url are required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.models[id]
	if !ok {
		return ModelView{}, errors.New("model not found")
	}
	for otherID, other := range s.models {
		if otherID != id && strings.EqualFold(other.ModelName, name) {
			return ModelView{}, errors.New("model already exists")
		}
	}
	m.ModelName = name
	if apiKey := strings.TrimSpace(req.APIKey); apiKey != "" {
		m.APIKey = apiKey
	}
	m.APIURL = strings.TrimSpace(req.APIURL)
	m.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	s.models[id] = m
	if err := s.saveLocked(); err != nil {
		return ModelView{}, err
	}
	return modelView(m, id == s.active), nil
}

func (s *ModelStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.models[id]; !ok {
		return errors.New("model not found")
	}
	delete(s.models, id)
	for sessionID, modelID := range s.sessions {
		if modelID == id {
			delete(s.sessions, sessionID)
		}
	}
	for sessionID, modelID := range s.sessionsCoder {
		if modelID == id {
			delete(s.sessionsCoder, sessionID)
		}
	}
	for sessionID, modelID := range s.sessionsFeedback {
		if modelID == id {
			delete(s.sessionsFeedback, sessionID)
		}
	}
	if s.active == id {
		s.active = ""
		for modelID := range s.models {
			s.active = modelID
			break
		}
	}
	return s.saveLocked()
}

func (s *ModelStore) Activate(id string) (ModelView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.models[id]
	if !ok {
		return ModelView{}, errors.New("model not found")
	}
	s.active = id
	if err := s.saveLocked(); err != nil {
		return ModelView{}, err
	}
	return modelView(m, true), nil
}

func (s *ModelStore) SetSessionModel(session, id string) error {
	if strings.TrimSpace(session) == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.models[id]; !ok {
		return errors.New("model not found")
	}
	s.sessions[session] = id
	return nil
}

func (s *ModelStore) ForSession(session string) (ModelConfig, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if id := s.sessions[session]; id != "" {
		m, ok := s.models[id]
		return m, ok
	}
	if s.active == "" {
		return ModelConfig{}, false
	}
	m, ok := s.models[s.active]
	return m, ok
}

// SetSessionStages stores optional per-session stage model overrides. An empty
// id clears the override so the stage follows the session's main model.
func (s *ModelStore) SetSessionStages(session, coderID, feedbackID string) error {
	session = strings.TrimSpace(session)
	if session == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, stageID := range []string{coderID, feedbackID} {
		if stageID != "" {
			if _, ok := s.models[stageID]; !ok {
				return errors.New("model not found")
			}
		}
	}
	if coderID != "" {
		s.sessionsCoder[session] = coderID
	} else {
		delete(s.sessionsCoder, session)
	}
	if feedbackID != "" {
		s.sessionsFeedback[session] = feedbackID
	} else {
		delete(s.sessionsFeedback, session)
	}
	return nil
}

// SessionStages returns the raw per-session stage overrides (may be empty).
func (s *ModelStore) SessionStages(session string) (string, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessionsCoder[session], s.sessionsFeedback[session]
}

// StageForSession resolves the model entry for a stage ("code" or "feedback"):
// the stage override if set, otherwise the session's main model, otherwise the
// globally active model.
func (s *ModelStore) StageForSession(session, stage string) (ModelConfig, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	stageID := ""
	switch stage {
	case "code":
		stageID = s.sessionsCoder[session]
	case "feedback":
		stageID = s.sessionsFeedback[session]
	}
	if stageID == "" {
		stageID = s.sessions[session]
	}
	if stageID == "" {
		stageID = s.active
	}
	if stageID == "" {
		return ModelConfig{}, false
	}
	m, ok := s.models[stageID]
	return m, ok
}

func modelView(m ModelConfig, active bool) ModelView {
	return ModelView{ID: m.ID, ModelName: m.ModelName, APIKey: m.APIKey, APIKeyMasked: maskSecret(m.APIKey), APIURL: m.APIURL, Active: active, CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt}
}

func maskSecret(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if len(s) <= 8 {
		return "****"
	}
	return s[:4] + "****" + s[len(s)-4:]
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
