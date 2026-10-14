//go:build !windows

package main

// platformSystemStats returns zeroed values on non-Windows platforms
// (server-mode deployments on Linux/macOS). The web UI treats zeros as
// "unavailable" and simply hides the local machine gauges.
func platformSystemStats() (SystemStats, error) {
	return SystemStats{}, nil
}
