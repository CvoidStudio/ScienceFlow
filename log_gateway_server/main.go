package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"log_gateway_server/internal/agent"
	"log_gateway_server/internal/auth"
	"log_gateway_server/internal/config"
	"log_gateway_server/internal/filewatch"
	"log_gateway_server/internal/hub"
	"log_gateway_server/internal/server"
	"log_gateway_server/internal/session"
	"log_gateway_server/internal/tailer"
)

func main() {
	cfgPath := flag.String("config", "config.json", "path to config file")
	flag.Parse()

	logger := log.New(os.Stdout, "[log_gateway] ", log.LstdFlags)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}

	reg, err := tailer.NewRegistry(cfg.Registry.Path, cfg.Registry.FlushInterval.Duration)
	if err != nil {
		logger.Fatalf("init registry: %v", err)
	}
	reg.Start()

	h := hub.New()

	t := tailer.New(cfg.Inputs, reg, h, logger)
	t.Start(cfg.Scan.Frequency.Duration)

	var authStore *auth.Store
	if cfg.Auth.Enabled {
		authStore, err = auth.Load(cfg.Auth.File, []byte(cfg.Auth.TokenSecret))
		if err != nil {
			logger.Fatalf("load auth: %v", err)
		}
		if cfg.Auth.TokenSecret == "" {
			logger.Printf("auth enabled: %d user(s) from %s; token_secret empty, using ephemeral secret", authStore.Count(), cfg.Auth.File)
		} else {
			logger.Printf("auth enabled: %d user(s) loaded from %s", authStore.Count(), cfg.Auth.File)
		}
	}

	sessions := session.NewManager(cfg.Auth.SessionTTL.Duration)
	defer sessions.Stop()

	agentRunner := agent.New(cfg.Agent, logger)
	fileWatcher := filewatch.New(cfg.Agent.FileSyncInterval.Duration)
	if cfg.Agent.Enabled {
		logger.Printf("agent invocation enabled: python=%s module=%s command=%s repo=%s max_concurrent=%d max_queue=%d",
			cfg.Agent.Python, cfg.Agent.Module, cfg.Agent.Command, cfg.Agent.RepoRoot,
			cfg.Agent.MaxConcurrent, cfg.Agent.MaxQueue)

		// Dynamic RAW.log tracking: instead of a static glob that tails every
		// session's RAW.log, we register the "agent-logs" source name up front
		// (so ACL/subscription filtering works from login) and attach/detach
		// individual files as tasks start/finish.
		t.RegisterSourceName(agent.RawLogSource)
		agentRunner.OnTaskStart = func(task *agent.Task) {
			if task.RawLogPath != "" {
				t.WatchFile(task.RawLogPath, agent.RawLogSource, 100*time.Millisecond)
			}
		}
		agentRunner.OnTaskFinish = func(task *agent.Task) {
			if task.RawLogPath != "" {
				// Keep tailing briefly so the final flushed lines reach SSE
				// before the harvester is detached.
				t.UnwatchFileAfter(task.RawLogPath, 10*time.Second)
			}
		}
	}

	srv := server.New(
		h,
		cfg.Server.Host,
		cfg.Server.Port,
		cfg.Server.SSEPath,
		logger,
		authStore,
		sessions,
		cfg.Auth.TokenTTL.Duration,
		cfg.Backend.URL,
		t.SourceNames,
		t.SourceOfPath,
		t.LookupSource,
		agentRunner,
		fileWatcher,
		cfg.Workspace,
	)
	httpSrv := &http.Server{Addr: srv.Addr(), Handler: srv.Handler()}

	go func() {
		logger.Printf("listening on http://%s   SSE endpoint: %s", srv.Addr(), cfg.Server.SSEPath)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("http server: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	logger.Println("shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	t.Stop()
	reg.Stop()
	logger.Println("bye")
}
