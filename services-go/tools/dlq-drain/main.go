// dlq-drain — Dead-Letter Queue inspection and recovery tool.
//
// Reads events from the ScopeCall DLQ topic (events.dlq) and provides three
// operations: list (inspect without committing), retry (republish to the main
// topic), and discard (commit offsets without reprocessing).
//
// USAGE:
//
//	dlq-drain [--broker ADDR] [--topic TOPIC] [--target TARGET] list   [--limit N]
//	dlq-drain [--broker ADDR] [--topic TOPIC] [--target TARGET] retry  [--limit N]
//	dlq-drain [--broker ADDR] [--topic TOPIC] [--target TARGET] discard [--limit N]
//
// EXAMPLES:
//
//	dlq-drain list                            # show up to 100 DLQ messages
//	dlq-drain retry --limit 10                # republish first 10 DLQ events
//	dlq-drain discard --limit 5               # drop first 5 DLQ events
//	dlq-drain --broker redpanda:9092 list     # connect to non-default broker
//
// EXIT CODES:
//
//	0 — success (including "DLQ empty" for list/retry/discard)
//	1 — configuration or Kafka error

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"time"

	kafka "github.com/segmentio/kafka-go"
)

// ── Wire types (must match Rust DlqEnvelope in processor/src/dlq.rs) ─────────

type EnrichedEvent struct {
	OrgID       string  `json:"org_id"`
	TraceID     string  `json:"trace_id"`
	SpanID      string  `json:"span_id"`
	Model       string  `json:"model"`
	Provider    string  `json:"provider"`
	InputTokens uint32  `json:"input_tokens"`
	OutputTokens uint32 `json:"output_tokens"`
	CostUSD     float64 `json:"cost_usd"`
	Status      string  `json:"status"`
	Environment string  `json:"environment"`
	SDKVersion  string  `json:"sdk_version"`
}

type DlqEnvelope struct {
	Original    EnrichedEvent `json:"original"`
	Error       string        `json:"error"`
	Attempts    uint32        `json:"attempts"`
	FailedAt    string        `json:"failed_at"`
	SourceTopic string        `json:"source_topic"`
}

// ── CLI flags ─────────────────────────────────────────────────────────────────

type Config struct {
	Broker  string
	Topic   string
	Target  string // replay target topic (retry command only)
	Limit   int
	Command string
}

func parseFlags() Config {
	broker := flag.String("broker", envOr("KAFKA_BROKERS", "localhost:9092"), "Kafka broker address")
	topic := flag.String("topic", envOr("KAFKA_DLQ_TOPIC", "events.dlq"), "DLQ topic name")
	target := flag.String("target", envOr("KAFKA_TOPIC", "events.llm_calls"), "Replay target topic (retry command)")
	limit := flag.Int("limit", 100, "Maximum number of messages to process")
	flag.Parse()

	args := flag.Args()
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "dlq-drain: command required (list|retry|discard)")
		fmt.Fprintln(os.Stderr, "Usage: dlq-drain [flags] <list|retry|discard>")
		flag.PrintDefaults()
		os.Exit(1)
	}

	cmd := args[0]
	switch cmd {
	case "list", "retry", "discard":
	default:
		fmt.Fprintf(os.Stderr, "dlq-drain: unknown command %q (want list|retry|discard)\n", cmd)
		os.Exit(1)
	}

	return Config{
		Broker:  *broker,
		Topic:   *topic,
		Target:  *target,
		Limit:   *limit,
		Command: cmd,
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	log.SetFlags(0)
	log.SetPrefix("[dlq-drain] ")

	cfg := parseFlags()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	switch cfg.Command {
	case "list":
		if err := cmdList(ctx, cfg); err != nil {
			log.Fatalf("list: %v", err)
		}
	case "retry":
		if err := cmdRetry(ctx, cfg); err != nil {
			log.Fatalf("retry: %v", err)
		}
	case "discard":
		if err := cmdDiscard(ctx, cfg); err != nil {
			log.Fatalf("discard: %v", err)
		}
	}
}

// ── Commands ──────────────────────────────────────────────────────────────────

// cmdList reads up to cfg.Limit messages from the DLQ and prints them as
// newline-delimited JSON to stdout. Offsets are NOT committed — list is
// a non-destructive inspection command.
func cmdList(ctx context.Context, cfg Config) error {
	r := newReader(cfg.Broker, cfg.Topic)
	defer r.Close()

	fmt.Fprintf(os.Stderr, "Reading up to %d messages from %s@%s (no commit)\n",
		cfg.Limit, cfg.Topic, cfg.Broker)

	count := 0
	for count < cfg.Limit {
		msg, err := readWithDeadline(ctx, r)
		if err == io.EOF || err == context.DeadlineExceeded {
			break
		}
		if err != nil {
			return fmt.Errorf("reading message: %w", err)
		}

		var env DlqEnvelope
		if err := json.Unmarshal(msg.Value, &env); err != nil {
			fmt.Fprintf(os.Stderr, "WARN: skipping non-DlqEnvelope message at offset %d: %v\n",
				msg.Offset, err)
			count++
			continue
		}

		printEnvelope(env, msg.Offset)
		count++
	}

	fmt.Fprintf(os.Stderr, "Listed %d message(s).\n", count)
	return nil
}

// cmdRetry reads up to cfg.Limit messages from the DLQ, republishes the
// original events to cfg.Target, then commits the DLQ offsets.
func cmdRetry(ctx context.Context, cfg Config) error {
	r := newGroupReader(cfg.Broker, cfg.Topic, "dlq-drain-retry")
	defer r.Close()

	w := newWriter(cfg.Broker, cfg.Target)
	defer w.Close()

	fmt.Fprintf(os.Stderr, "Retrying up to %d messages: %s → %s\n",
		cfg.Limit, cfg.Topic, cfg.Target)

	count := 0
	for count < cfg.Limit {
		msg, err := readWithDeadline(ctx, r)
		if err == io.EOF || err == context.DeadlineExceeded {
			break
		}
		if err != nil {
			return fmt.Errorf("reading message: %w", err)
		}

		var env DlqEnvelope
		if err := json.Unmarshal(msg.Value, &env); err != nil {
			fmt.Fprintf(os.Stderr, "WARN: skipping non-DlqEnvelope at offset %d: %v\n",
				msg.Offset, err)
		} else {
			// Republish the enriched event (unwrapped from DLQ envelope)
			payload, err := json.Marshal(env.Original)
			if err != nil {
				return fmt.Errorf("marshaling event: %w", err)
			}

			if err := w.WriteMessages(ctx, kafka.Message{Value: payload}); err != nil {
				return fmt.Errorf("republishing to %s: %w", cfg.Target, err)
			}
			fmt.Fprintf(os.Stderr, "  retried trace_id=%s (was: %s)\n",
				env.Original.TraceID, env.Error)
		}

		// Commit DLQ offset regardless (malformed messages are also discarded)
		if err := r.CommitMessages(ctx, msg); err != nil {
			return fmt.Errorf("committing offset %d: %w", msg.Offset, err)
		}
		count++
	}

	fmt.Fprintf(os.Stderr, "Retried %d message(s).\n", count)
	return nil
}

// cmdDiscard reads up to cfg.Limit messages from the DLQ and commits their
// offsets without republishing. Events are permanently discarded.
func cmdDiscard(ctx context.Context, cfg Config) error {
	r := newGroupReader(cfg.Broker, cfg.Topic, "dlq-drain-discard")
	defer r.Close()

	fmt.Fprintf(os.Stderr, "Discarding up to %d messages from %s (PERMANENT)\n",
		cfg.Limit, cfg.Topic)

	count := 0
	for count < cfg.Limit {
		msg, err := readWithDeadline(ctx, r)
		if err == io.EOF || err == context.DeadlineExceeded {
			break
		}
		if err != nil {
			return fmt.Errorf("reading message: %w", err)
		}

		if err := r.CommitMessages(ctx, msg); err != nil {
			return fmt.Errorf("committing offset %d: %w", msg.Offset, err)
		}

		// Log what we discarded
		var env DlqEnvelope
		if jsonErr := json.Unmarshal(msg.Value, &env); jsonErr == nil {
			fmt.Fprintf(os.Stderr, "  discarded trace_id=%s (attempts=%d error=%s)\n",
				env.Original.TraceID, env.Attempts, env.Error)
		} else {
			fmt.Fprintf(os.Stderr, "  discarded offset=%d (unparseable)\n", msg.Offset)
		}

		count++
	}

	fmt.Fprintf(os.Stderr, "Discarded %d message(s).\n", count)
	return nil
}

// ── Kafka helpers ─────────────────────────────────────────────────────────────

// newReader creates a partition reader (no consumer group — for list command).
func newReader(broker, topic string) *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers:   []string{broker},
		Topic:     topic,
		Partition: 0,
		MinBytes:  1,
		MaxBytes:  10e6,
		MaxWait:   2 * time.Second,
	})
}

// newGroupReader creates a consumer-group reader (for retry/discard — commits offsets).
func newGroupReader(broker, topic, groupID string) *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers:  []string{broker},
		Topic:    topic,
		GroupID:  groupID,
		MinBytes: 1,
		MaxBytes: 10e6,
		MaxWait:  2 * time.Second,
	})
}

func newWriter(broker, topic string) *kafka.Writer {
	return &kafka.Writer{
		Addr:     kafka.TCP(broker),
		Topic:    topic,
		Balancer: &kafka.LeastBytes{},
	}
}

// readWithDeadline reads one message; returns io.EOF if the context deadline
// fires before a message is available (i.e., DLQ is empty or caught up).
func readWithDeadline(ctx context.Context, r *kafka.Reader) (kafka.Message, error) {
	readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	msg, err := r.ReadMessage(readCtx)
	if err != nil {
		if err == context.DeadlineExceeded || readCtx.Err() != nil {
			return kafka.Message{}, io.EOF
		}
		return kafka.Message{}, err
	}
	return msg, nil
}

// ── Output ────────────────────────────────────────────────────────────────────

func printEnvelope(env DlqEnvelope, offset int64) {
	out := map[string]any{
		"offset":       offset,
		"failed_at":    env.FailedAt,
		"attempts":     env.Attempts,
		"error":        env.Error,
		"source_topic": env.SourceTopic,
		"trace_id":     env.Original.TraceID,
		"org_id":       env.Original.OrgID,
		"model":        env.Original.Model,
		"provider":     env.Original.Provider,
		"status":       env.Original.Status,
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
