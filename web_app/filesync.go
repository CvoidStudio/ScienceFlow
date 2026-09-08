package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// FileTreeNode mirrors the gateway's file tree node (flat list, relative paths).
type FileTreeNode struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Type  string `json:"type"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

// FileTreeResponse mirrors GET /sessions/{id}/files.
type FileTreeResponse struct {
	Root string          `json:"root"`
	Tree []FileTreeNode `json:"tree"`
}

// FileTreeEvent is the SSE "file" event payload emitted by the gateway.
// kind="tree" carries the full tree; kind="changes" carries deltas.
type FileTreeEvent struct {
	Kind      string         `json:"kind"`
	Root      string         `json:"root,omitempty"`
	Tree      []FileTreeNode `json:"tree,omitempty"`
	Added     []FileTreeNode `json:"added,omitempty"`
	Removed   []FileTreeNode `json:"removed,omitempty"`
	Modified  []FileTreeNode `json:"modified,omitempty"`
	Overflow  bool           `json:"overflow,omitempty"`
	Timestamp string         `json:"timestamp,omitempty"`
}

// GatewayFetchFiles fetches the current workspace file tree for a session via
// GET /sessions/{id}/files. Used for on-demand full-tree calibration (e.g.
// after an overflow event).
func (a *App) GatewayFetchFiles(token string, sessionID string) (FileTreeResponse, error) {
	endpoint := a.gatewayURL + "/sessions/" + url.PathEscape(sessionID) + "/files"

	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return FileTreeResponse{}, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return FileTreeResponse{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return FileTreeResponse{}, errGatewayUnauthorized
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return FileTreeResponse{}, fmt.Errorf("fetch files status %d: %s", resp.StatusCode, string(body))
	}

	var result FileTreeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return FileTreeResponse{}, err
	}
	return result, nil
}
