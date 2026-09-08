package main

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ChatEvent is a single SSE event forwarded to the frontend.
type ChatEvent struct {
	Name string `json:"name"`
	Data string `json:"data"`
}

// ChatStatusEvent reports the state of the backend chat SSE connection.
type ChatStatusEvent struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

const (
	chatStatusConnecting = "connecting"
	chatStatusConnected  = "connected"
	chatStatusDisconnect = "disconnected"
)

// chatStreamManager owns the single chat SSE connection to the backend and its
// reconnect loop, mirroring the demo_web SSE bridge pattern.
type chatStreamManager struct {
	ctx     context.Context
	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
}

func newChatStreamManager(ctx context.Context) *chatStreamManager {
	return &chatStreamManager{ctx: ctx}
}

// Start (re)starts the SSE stream for the given chat session.
func (m *chatStreamManager) Start(baseURL, sessionID, token string) {
	m.Stop()
	ctx, cancel := context.WithCancel(m.ctx)
	m.mu.Lock()
	m.cancel = cancel
	m.done = make(chan struct{})
	m.mu.Unlock()
	go m.run(ctx, baseURL, sessionID, token)
}

// Stop cancels the current stream and waits for it to finish.
func (m *chatStreamManager) Stop() {
	m.mu.Lock()
	cancel := m.cancel
	done := m.done
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

func (m *chatStreamManager) run(ctx context.Context, baseURL, sessionID, token string) {
	defer close(m.done)
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		runtime.EventsEmit(ctx, "chat-status", ChatStatusEvent{Status: chatStatusConnecting})
		err := m.stream(ctx, baseURL, sessionID, token)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			runtime.EventsEmit(ctx, "chat-status", ChatStatusEvent{Status: chatStatusDisconnect, Error: err.Error()})
		} else {
			backoff = time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (m *chatStreamManager) stream(ctx context.Context, baseURL, sessionID, token string) error {
	endpoint := baseURL + "/api/chat/sessions/" + url.PathEscape(sessionID) + "/events?since_seq=0"
	if token != "" {
		endpoint += "&token=" + url.QueryEscape(token)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	runtime.EventsEmit(ctx, "chat-status", ChatStatusEvent{Status: chatStatusConnected})
	reader := bufio.NewReader(resp.Body)

	var (
		eventName string
		dataLines []string
	)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if len(dataLines) > 0 {
				runtime.EventsEmit(ctx, "chat-event", ChatEvent{
					Name: eventName,
					Data: strings.Join(dataLines, "\n"),
				})
			}
			eventName, dataLines = "", nil
		case strings.HasPrefix(line, ":"):
			// comment / keep-alive, ignore
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
}
