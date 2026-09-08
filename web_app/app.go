package main

import (
	"context"
)

// App holds the desktop application state: the shared context, the configured
// backend base URL, and the chat SSE bridge.
type App struct {
	ctx        context.Context
	baseURL    string
	gatewayURL string
	stream     *chatStreamManager
	gwStream   *gatewayStreamManager
}

// NewApp creates the application struct. The backend base URL is resolved from
// config.json (next to the executable, then the working directory), falling
// back to http://127.0.0.1:8200.
func NewApp() *App {
	return &App{
		baseURL:    resolveBaseURL(),
		gatewayURL: resolveGatewayURL(),
	}
}

// startup is called when the app starts. It saves the context so we can call
// the Wails runtime (EventsEmit) and initialises the SSE bridges.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.stream = newChatStreamManager(ctx)
	a.gwStream = newGatewayStreamManager(ctx)
}

// shutdown stops the SSE bridges when the app quits.
func (a *App) shutdown(ctx context.Context) {
	if a.stream != nil {
		a.stream.Stop()
	}
	if a.gwStream != nil {
		a.gwStream.Stop()
	}
}

// SetBackendURL changes the backend base URL at runtime.
func (a *App) SetBackendURL(url string) {
	a.baseURL = normalizeBaseURL(url, defaultBackendURL)
}

// GetBackendURL returns the currently configured backend base URL.
func (a *App) GetBackendURL() string {
	return a.baseURL
}

// StartChatStream (re)starts the backend chat SSE stream for the given session.
func (a *App) StartChatStream(sessionID string, token string) {
	if a.stream == nil {
		return
	}
	a.stream.Start(a.gatewayURL, sessionID, token)
}

// StopChatStream stops the current backend chat SSE stream.
func (a *App) StopChatStream() {
	if a.stream != nil {
		a.stream.Stop()
	}
}

// SetGatewayURL changes the log gateway base URL at runtime.
func (a *App) SetGatewayURL(url string) {
	a.gatewayURL = normalizeBaseURL(url, defaultGatewayURL)
}

// GetGatewayURL returns the currently configured log gateway base URL.
func (a *App) GetGatewayURL() string {
	return a.gatewayURL
}

// GatewayStartStream (re)starts the log gateway SSE stream for a session.
func (a *App) GatewayStartStream(sessionID string) {
	if a.gwStream == nil {
		return
	}
	a.gwStream.Start(a.gatewayURL, sessionID)
}

// GatewayStopStream stops the current log gateway SSE stream.
func (a *App) GatewayStopStream() {
	if a.gwStream != nil {
		a.gwStream.Stop()
	}
}