# ScopeCall — SDK Design Document

> Complete technical specification for the ScopeCall SDK.
> Covers Python and TypeScript implementations, instrumentation internals, and design decisions.

---

## Design Principles

```
1. Zero friction       → one line to get value, nothing else required
2. Zero impact         → never slow down, never break the customer's app
3. Zero trust          → assume ScopeCall servers are down, degrade gracefully
4. Privacy first       → PII redacted before leaving customer infrastructure
5. Framework agnostic  → works with any AI library, not just LangChain
```

---

## SDK Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Customer Application                  │
│                                                         │
│   import scopecall                                         │
│   scopecall.init(api_key="xxx")                            │
│                                                         │
│   ┌─────────────────────────────────────────────────┐   │
│   │              ScopeCall SDK                         │   │
│   │                                                 │   │
│   │  ┌───────────┐  ┌───────────┐  ┌────────────┐  │   │
│   │  │Instrumentor│  │ Processor │  │  Exporter  │  │   │
│   │  │           │  │           │  │            │  │   │
│   │  │ Wraps AI  │→ │ Enriches  │→ │  Batches   │  │   │
│   │  │ libraries │  │ Calculates│  │  & sends   │  │   │
│   │  │ at import │  │ Redacts   │  │  async     │  │   │
│   │  └───────────┘  └───────────┘  └────────────┘  │   │
│   │                                      ↓          │   │
│   │                              Background thread  │   │
│   └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                              ↓
                    HTTPS POST (batched)
                              ↓
                    ScopeCall Ingest API
```

---

## Python SDK

### Package Structure

```
scopecall-python/
├── scopecall/
│   ├── __init__.py          → public API: init(), trace(), flush(), shutdown()
│   ├── config.py            → configuration management
│   ├── instrumentor.py      → library patching + OpenLLMetry integration
│   ├── processor.py         → event enrichment, cost calculation
│   ├── redactor.py          → PII detection and redaction
│   ├── exporter.py          → batching, queuing, HTTP export
│   ├── tracer.py            → trace context management
│   ├── pricing.py           → model pricing table
│   └── models.py            → event data models (dataclasses)
├── tests/
│   ├── test_instrumentor.py
│   ├── test_redactor.py
│   ├── test_exporter.py
│   └── fixtures/
├── pyproject.toml
└── README.md
```

### Public API

```python
# ── scopecall/__init__.py ──────────────────────────────────

import scopecall

# 1. Initialize (required, call once at startup)
scopecall.init(
    api_key: str,
    *,
    environment: str = "production",
    capture_content: bool = True,
    redact_pii: bool = True,
    feature_name: str | None = None,    # default tag for ALL calls
    endpoint: str = "https://ingest.scopecall.com",
    batch_size: int = 50,
    flush_interval: float = 5.0,
    timeout: float = 3.0,
    disabled: bool = False,              # if True, init is a no-op
)

# 2. Trace context (optional, adds metadata to calls within block)
with scopecall.trace(
    feature: str | None = None,          # OVERRIDES init() feature_name for this block
    user_id: str | None = None,
    session_id: str | None = None,
    metadata: dict | None = None,
):
    response = openai.chat.completions.create(...)

# 3. Manual flush (optional, for serverless/short-lived processes)
scopecall.flush(timeout: float = 5.0) -> bool

# 4. Shutdown (optional, ensures all events sent before process exits)
scopecall.shutdown(timeout: float = 5.0)
```

**Tag precedence** (when both init() default and trace() block-level are set):
```
trace(feature=...)        always overrides init(feature_name=...)
trace(user_id=...)        always overrides any init default
metadata=...              merged: trace metadata wins on key conflicts
```

Tags resolved at SDK-event-creation time. If neither init nor trace provides
a tag, the field is None in the emitted event (NOT empty string).

> **NOTE**: `scopecall.identify(user_id, properties)` was in earlier drafts but is
> **Not in the public API today.** User properties are not currently stored or
> attached to events. If user-property persistence is added later, it will ship
> with explicit storage semantics in a future release. For now, attach per-call
> user context via `trace(user_id=...)`.

### Initialization Flow

```python
# ── scopecall/config.py ────────────────────────────────────

@dataclass
class ScopeCallConfig:
    api_key: str
    environment: str = "production"
    capture_content: bool = True
    redact_pii: bool = True
    feature_name: str | None = None
    endpoint: str = "https://ingest.scopecall.com"
    batch_size: int = 50
    flush_interval: float = 5.0
    timeout: float = 3.0
    disabled: bool = False

    def __post_init__(self):
        # Auto-detect environment from common env vars
        if self.environment == "production":
            env = os.getenv("ENVIRONMENT") or \
                  os.getenv("ENV") or \
                  os.getenv("NODE_ENV") or \
                  os.getenv("VERCEL_ENV") or \
                  "production"
            self.environment = env

        # Warn if using test key in production
        if self.api_key.startswith("sc_test_") and \
           self.environment == "production":
            warnings.warn(
                "ScopeCall test key used in production environment",
                ScopeCallWarning
            )
```

```python
# ── scopecall/__init__.py ──────────────────────────────────

import logging
import warnings

_client: ScopeCallClient | None = None
_logger = logging.getLogger("scopecall")

def init(api_key: str, **kwargs) -> None:
    global _client

    # Idempotency: calling init() twice creates duplicate exporter threads
    # and duplicate atexit handlers. Match TypeScript SDK behavior.
    if _client is not None:
        warnings.warn(
            "scopecall.init() called more than once. Ignoring duplicate call. "
            "If you need to reconfigure, call scopecall.shutdown() first.",
            UserWarning,
            stacklevel=2,
        )
        return

    config = ScopeCallConfig(api_key=api_key, **kwargs)

    # Honor disabled=True: short-circuit without starting any threads or
    # instrumenting libraries. The customer's AI calls run normally; nothing
    # gets captured. Useful for opt-out at deploy time without code changes.
    if config.disabled:
        _logger.info("ScopeCall disabled by config; no instrumentation will run.")
        _client = _NoOpClient()  # sentinel — flush/shutdown are no-ops
        return

    # Start the exporter background thread
    exporter = ScopeCallExporter(config)
    exporter.start()

    # Instrument AI libraries
    instrumentor = ScopeCallInstrumentor(config, exporter)
    instrumentor.instrument()

    _client = ScopeCallClient(config, instrumentor, exporter)

    # Register shutdown hook
    atexit.register(_client.shutdown)


class _NoOpClient:
    """Returned when disabled=True. All operations are no-ops."""
    def flush(self, timeout: float = 5.0) -> bool: return True
    def shutdown(self, timeout: float = 5.0) -> None: return
```

### Instrumentation Layer

```python
# ── scopecall/instrumentor.py ──────────────────────────────

class ScopeCallInstrumentor:
    """
    Wraps OpenLLMetry instrumentation and adds ScopeCall-specific processing.
    OpenLLMetry handles the per-library patching.
    We add: cost calculation, PII redaction, ScopeCall export format.
    """

    def __init__(self, config: ScopeCallConfig, exporter: ScopeCallExporter):
        self.config = config
        self.exporter = exporter

    def instrument(self) -> None:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from traceloop.sdk import Traceloop

        # 1. Set up our own OTel tracer provider with the ScopeCall span processor.
        #    Critical: do this BEFORE calling Traceloop.init() so OpenLLMetry's
        #    instrumentation patches use our provider.
        provider = TracerProvider()
        processor = ScopeCallSpanProcessor(self.config, self.exporter)
        provider.add_span_processor(processor)
        trace.set_tracer_provider(provider)

        # 2. Tell OpenLLMetry to instrument AI libraries but NOT to set up its own
        #    exporter or batching. We provide both.
        #
        # NOTE: The exact API has churned across OpenLLMetry releases. As of
        # traceloop-sdk 0.15+, the working pattern is:
        Traceloop.init(
            disable_batch=True,           # we handle batching
            should_enrich_metrics=False,  # we compute cost/tokens in ScopeCallSpanProcessor
            api_endpoint=None,            # don't send to Traceloop SaaS
            api_key=None,                 # ditto
            # We do NOT pass exporter=None — Traceloop with no exporter just doesn't
            # export; our ScopeCallSpanProcessor attached to the global TracerProvider
            # receives the spans regardless.
        )

        # CI test: tests/test_instrumentor.py asserts that an OpenAI call produces
        # a span that our ScopeCallSpanProcessor.on_end() receives. Pin traceloop-sdk
        # version tightly (~=0.15.0) until upstream stabilizes.
```

```python
# ── scopecall/processor.py ─────────────────────────────────

class ScopeCallSpanProcessor(SpanProcessor):
    """
    Receives completed spans from OpenLLMetry.
    Transforms to ScopeCall event format.
    Calculates cost.
    Redacts PII.
    Forwards to exporter.
    """

    def on_end(self, span: ReadableSpan) -> None:
        # Only process LLM/AI spans
        if not self._is_ai_span(span):
            return

        try:
            event = self._span_to_event(span)
            self.exporter.enqueue(event)
        except Exception:
            # Never raise — customer app must not be affected
            pass

    def _span_to_event(self, span: ReadableSpan) -> LLMEvent:
        attrs = span.attributes or {}

        # Extract standard OpenLLMetry attributes
        model = attrs.get("gen_ai.request.model", "unknown")
        provider = self._infer_provider(model)
        input_tokens = attrs.get("gen_ai.usage.prompt_tokens", 0)
        output_tokens = attrs.get("gen_ai.usage.completion_tokens", 0)
        input_text = attrs.get("gen_ai.prompt.0.content", "")
        output_text = attrs.get("gen_ai.completion.0.content", "")

        # Calculate cost
        cost_usd = PricingTable.calculate(model, input_tokens, output_tokens)

        # Redact PII if enabled
        if self.config.redact_pii and self.config.capture_content:
            input_text = Redactor.redact(input_text)
            output_text = Redactor.redact(output_text)

        # Suppress content if capture_content=False
        if not self.config.capture_content:
            input_text = ""
            output_text = ""

        # Compute duration. OTel span times are nanoseconds since epoch.
        duration_ms = (span.end_time - span.start_time) / 1_000_000  # ns → ms

        # Convert OTel IDs to standard hex format.
        # NOTE: OTel trace_id is a 128-bit integer (not a UUID despite the schema
        # field type). We format as 32-char lowercase hex, matching W3C Trace Context.
        # ClickHouse stores this in a String column (not UUID) to preserve the
        # hex format that other observability tooling (Jaeger, Zipkin, OTLP) expects.
        trace_id_hex = format(span.context.trace_id, '032x')
        span_id_hex = format(span.context.span_id, '016x')
        parent_span_id_hex = (
            format(span.parent.span_id, '016x') if span.parent else None
        )

        # Convert span.start_time (nanoseconds since epoch) → milliseconds since epoch
        # to match the schema definition (timestamp field is documented as ms-precision).
        timestamp_ms = span.start_time // 1_000_000

        return LLMEvent(
            trace_id=trace_id_hex,
            span_id=span_id_hex,
            parent_span_id=parent_span_id_hex,
            timestamp=timestamp_ms,
            model=model,
            provider=provider,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            latency_ms=int(duration_ms),
            status=self._get_status(span),
            input_text=input_text,
            output_text=output_text,
            error_message=self._get_error(span),
            feature_name=self._get_feature_name(),
            user_id=self._get_user_id(),
            environment=self.config.environment,
        )
```

### PII Redaction

```python
# ── scopecall/redactor.py ──────────────────────────────────

class Redactor:
    """
    Fast PII detection and redaction.
    Runs in-process before any data leaves customer infrastructure.
    Prioritizes speed over perfect recall — better to miss rare PII
    than to slow down every call.
    """

    # Compiled regex patterns for common PII.
    #
    # IMPORTANT ORDERING NOTES:
    # - EMAIL must run BEFORE PHONE (some emails have phone-like fragments)
    # - SSN must run BEFORE PHONE (xxx-xx-xxxx looks similar to phone fragments)
    # - CARD must run BEFORE PHONE (16-digit cards match phone regex on 3rd block)
    # - IP must run BEFORE PHONE (IPs are dot-separated but phone regex is permissive)
    #
    # The redactor applies these in order. Don't shuffle without re-running tests.
    PATTERNS: list[tuple[str, Pattern]] = [
        ("EMAIL",   re.compile(
            r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'
        )),
        ("CARD",    re.compile(
            # 4 groups of 4 digits, separated by space or hyphen
            r'\b(?:\d{4}[-\s]?){3}\d{4}\b'
        )),
        ("SSN",     re.compile(
            r'\b\d{3}-\d{2}-\d{4}\b'
        )),
        ("IP",      re.compile(
            # IPv4 only — IPv6 redaction is more complex, deferred
            r'\b(?:\d{1,3}\.){3}\d{1,3}\b'
        )),
        ("PHONE",   re.compile(
            # NANP format — matches +1 555-123-4567, (555) 123-4567, 555.123.4567, etc.
            # Deliberately strict: leading boundary + 10 digits with separators.
            r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b'
        )),
    ]

    @classmethod
    def _is_valid_card(cls, candidate: str) -> bool:
        """
        Luhn checksum to reduce false positives on 16-digit numbers that
        happen to match the card format but aren't real cards (e.g., order
        IDs, tracking numbers). Run after regex match, before replacement.
        """
        digits = [int(d) for d in candidate if d.isdigit()]
        if len(digits) != 16:
            return False
        checksum = 0
        for i, d in enumerate(reversed(digits)):
            if i % 2 == 1:
                d *= 2
                if d > 9:
                    d -= 9
            checksum += d
        return checksum % 10 == 0

    # Optional: lightweight NER for names
    # Disabled by default (adds ~5ms per call)
    _ner_enabled: bool = False

    @classmethod
    def redact(cls, text: str) -> str:
        if not text:
            return text

        for label, pattern in cls.PATTERNS:
            if label == "CARD":
                # Apply Luhn check before redacting — reduces false positives
                # on 16-digit numbers that aren't actually credit cards.
                def sub_card(match):
                    return "[CARD]" if cls._is_valid_card(match.group(0)) else match.group(0)
                text = pattern.sub(sub_card, text)
            else:
                text = pattern.sub(f'[{label}]', text)

        if cls._ner_enabled:
            text = cls._redact_names(text)

        return text

    @classmethod
    def add_pattern(cls, label: str, pattern: str) -> None:
        """Allow customers to add custom redaction patterns."""
        cls.PATTERNS.append((label, re.compile(pattern)))

    @classmethod
    def _redact_names(cls, text: str) -> str:
        """
        Lightweight name detection using spacy NER.
        Only loaded if customer explicitly enables NER redaction.
        """
        import spacy
        doc = cls._nlp(text)
        result = text
        for ent in reversed(doc.ents):
            if ent.label_ == "PERSON":
                result = result[:ent.start_char] + "[NAME]" + result[ent.end_char:]
        return result
```

### Cost Calculation

```python
# ── scopecall/pricing.py ───────────────────────────────────

@dataclass
class ModelPricing:
    input_per_1k: float   # $ per 1000 input tokens
    output_per_1k: float  # $ per 1000 output tokens


class PricingTable:
    """
    Maintained pricing for all major models.
    Updated via background refresh from ScopeCall API (daily).
    Falls back to bundled table if API unreachable.
    """

    # Bundled pricing — prices are per 1k tokens, USD.
    # IMPORTANT: This table will drift. The SDK refreshes it daily from the ScopeCall
    # pricing endpoint (which is updated by us when providers change prices).
    # CI lint: tests/test_pricing.py asserts table freshness against a known date
    # so PRs that go stale fail CI.
    _TABLE: dict[str, ModelPricing] = {
        # OpenAI (last verified 2026-05)
        "gpt-4o":                ModelPricing(0.0025,  0.010),   # $2.50 / $10 per 1M
        "gpt-4o-mini":           ModelPricing(0.00015, 0.0006),
        "gpt-4-turbo":           ModelPricing(0.010,   0.030),
        "gpt-4":                 ModelPricing(0.030,   0.060),
        "gpt-3.5-turbo":         ModelPricing(0.0005,  0.0015),

        # Anthropic (last verified 2026-05)
        "claude-3-opus-20240229":   ModelPricing(0.015,    0.075),
        "claude-3-5-sonnet-20241022": ModelPricing(0.003,  0.015),
        "claude-3-haiku-20240307":  ModelPricing(0.00025,  0.00125),
        "claude-sonnet-4-6":        ModelPricing(0.003,    0.015),

        # Google (last verified 2026-05)
        "gemini-1.5-pro":        ModelPricing(0.00125, 0.005),
        "gemini-1.5-flash":      ModelPricing(0.000075, 0.0003),
    }

    # Track when this table was last refreshed locally (background thread updates it)
    _last_refreshed_at: float | None = None

    @classmethod
    def calculate(
        cls,
        model: str,
        input_tokens: int,
        output_tokens: int
    ) -> float:
        pricing = cls._TABLE.get(model)
        if not pricing:
            # Unknown model — return 0, flag for review
            return 0.0

        return (
            (input_tokens / 1000 * pricing.input_per_1k) +
            (output_tokens / 1000 * pricing.output_per_1k)
        )

    @classmethod
    def refresh(cls, updated_table: dict) -> None:
        """Called by background refresher when new pricing fetched."""
        cls._TABLE.update(updated_table)
```

### Async Exporter

```python
# ── scopecall/exporter.py ──────────────────────────────────

class ScopeCallExporter:
    """
    Collects events, batches them, and sends to ScopeCall ingest API.

    Key design decisions:
    - Uses a bounded queue (never grows unbounded)
    - Background thread handles all I/O (never blocks caller)
    - If queue is full, drops oldest events (backpressure)
    - If ScopeCall unreachable, events dropped after 3 retries
    - Customer app is never affected by ScopeCall failures
    """

    MAX_QUEUE_SIZE = 10_000  # ~10MB at average event size

    def __init__(self, config: ScopeCallConfig):
        self.config = config
        self._queue: Queue[LLMEvent] = Queue(maxsize=self.MAX_QUEUE_SIZE)
        self._thread: Thread | None = None
        self._shutdown_event = Event()
        self._flush_now = Event()  # signaled by flush() to drain immediately
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
            "X-ScopeCall-SDK": f"python/{__version__}",
        })

    def start(self) -> None:
        self._thread = Thread(
            target=self._run,
            name="scopecall-exporter",
            daemon=True,  # dies when main process dies
        )
        self._thread.start()

    def enqueue(self, event: LLMEvent) -> None:
        try:
            self._queue.put_nowait(event)
        except QueueFull:
            # Drop oldest event, enqueue new one
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(event)
            except (QueueEmpty, QueueFull):
                pass  # best effort

    def flush(self, timeout: float = 5.0) -> bool:
        """
        Block until all queued events have been SENT (or send attempts exhausted).

        Returns True if all events were sent, False if timeout reached with events
        still pending.

        CRITICAL: We call task_done() AFTER _send_with_retry, not after dequeue.
        This makes Queue.join() actually wait for the network send to complete,
        not just for the queue to be empty. The earlier version of this code had
        a bug where flush() returned as soon as the queue drained but before
        events were transmitted.
        """
        # Best effort: signal the run loop to flush now (don't wait for interval)
        self._flush_now.set()

        # Wait for all in-flight events to complete sending
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._queue.unfinished_tasks == 0:
                return True
            time.sleep(0.05)
        return False

    def shutdown(self, timeout: float = 5.0) -> None:
        self._shutdown_event.set()
        self._flush_now.set()
        if self._thread:
            self._thread.join(timeout=timeout)

    def _run(self) -> None:
        """Background thread: drain queue in batches."""
        while not self._shutdown_event.is_set():
            batch = self._collect_batch()
            if batch:
                self._send_batch_and_ack(batch)
            else:
                # Nothing to send, wait for next flush interval or explicit flush
                self._flush_now.wait(timeout=self.config.flush_interval)
                self._flush_now.clear()

        # Final drain on shutdown
        while not self._queue.empty():
            batch = self._collect_batch()
            if batch:
                self._send_batch_and_ack(batch)

    def _collect_batch(self) -> list[LLMEvent]:
        """
        Pull events from queue into a batch. Does NOT call task_done() —
        that happens after _send_batch_and_ack() actually transmits.
        """
        batch = []
        deadline = time.monotonic() + self.config.flush_interval

        while len(batch) < self.config.batch_size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                event = self._queue.get(timeout=min(remaining, 0.1))
                batch.append(event)
                # NOTE: no task_done() here — see _send_batch_and_ack
            except QueueEmpty:
                break

        return batch

    def _send_batch_and_ack(self, batch: list[LLMEvent]) -> None:
        """
        Send the batch, then ack each event in the queue.
        Even on failure we ack — flush() waits for SEND ATTEMPTS to complete,
        not for successful delivery (events can be dropped, see _send_with_retry).
        """
        try:
            self._send_with_retry(batch)
        finally:
            for _ in batch:
                self._queue.task_done()

    def _send_with_retry(
        self,
        batch: list[LLMEvent],
        max_retries: int = 3
    ) -> None:
        payload = {
            "events": [e.to_dict() for e in batch],
            # Use timezone-aware UTC. datetime.utcnow() is deprecated since 3.12.
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }

        for attempt in range(max_retries):
            try:
                response = self._session.post(
                    f"{self.config.endpoint}/v1/ingest",
                    json=payload,
                    timeout=self.config.timeout,
                )
                if response.status_code == 200:
                    return
                if response.status_code in (400, 401, 403):
                    # Non-retryable errors
                    return
            except requests.RequestException:
                pass

            # Exponential backoff: 0.1s, 0.2s, 0.4s.
            # IMPORTANT: wait on the shutdown event so shutdown(timeout=5) doesn't
            # hang while we sleep through retry backoffs. If shutdown is requested,
            # bail out — drop remaining attempts. This was missing in earlier draft.
            if attempt < max_retries - 1:
                backoff = 0.1 * (2 ** attempt)
                if self._shutdown_event.wait(timeout=backoff):
                    return  # shutdown requested mid-retry, abandon

        # All retries failed — events dropped silently
        # Never raise, never affect customer app
```

### Trace Context

```python
# ── scopecall/tracer.py ────────────────────────────────────

from contextlib import contextmanager
from contextvars import ContextVar

_current_context: ContextVar[TraceContext | None] = ContextVar(
    "scopecall_context",
    default=None
)

@dataclass
class TraceContext:
    feature_name: str | None = None
    user_id: str | None = None
    session_id: str | None = None
    metadata: dict | None = None

@contextmanager
def trace(
    feature: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    metadata: dict | None = None,
):
    """
    Context manager that tags all AI calls within the block.

    Usage:
        with scopecall.trace(feature="search", user_id=user.id):
            response = openai.chat.completions.create(...)
    """
    ctx = TraceContext(
        feature_name=feature,
        user_id=user_id,
        session_id=session_id,
        metadata=metadata,
    )
    token = _current_context.set(ctx)
    try:
        yield
    finally:
        _current_context.reset(token)

def get_current_context() -> TraceContext | None:
    return _current_context.get()
```

### Framework-Specific Usage Examples

```python
# ── FastAPI integration ──────────────────────────────────

from fastapi import FastAPI, Request
import scopecall

scopecall.init(api_key="sc_live_xxx")

app = FastAPI()

@app.post("/chat")
async def chat(request: Request, body: ChatRequest):
    user_id = request.headers.get("X-User-ID")

    with scopecall.trace(feature="chat", user_id=user_id):
        response = await openai_client.chat.completions.create(
            model="gpt-4o",
            messages=body.messages,
        )

    return {"reply": response.choices[0].message.content}


# ── LangChain integration ────────────────────────────────

import scopecall
scopecall.init(api_key="sc_live_xxx")
# All LangChain calls automatically instrumented — nothing else needed

from langchain_openai import ChatOpenAI
from langchain.chains import RetrievalQA

llm = ChatOpenAI(model="gpt-4o")
chain = RetrievalQA.from_chain_type(llm=llm, retriever=retriever)

# This call is automatically captured — every LLM call, every tool call
result = chain.invoke({"query": "What is the return policy?"})


# ── Django integration ───────────────────────────────────

# settings.py
import scopecall
scopecall.init(
    api_key=os.getenv("SCOPECALL_API_KEY"),
    environment=os.getenv("DJANGO_ENV", "production"),
)


# ── Serverless / AWS Lambda ──────────────────────────────

import scopecall

# Initialize outside handler (reused across warm invocations).
# For serverless: small batch, short flush interval (NOT zero — flush_interval=0
# would cause the background loop to never pick up events because the
# Event.wait(timeout=0) returns immediately and the queue collection times out).
scopecall.init(
    api_key=os.getenv("SCOPECALL_API_KEY"),
    batch_size=1,         # send one event per request — no waiting for full batch
    flush_interval=0.1,   # 100ms — short enough for Lambda, > 0 so loop works
)

def handler(event, context):
    response = openai_client.chat.completions.create(...)
    # CRITICAL: flush() blocks until events transmitted (fixed semantics — see Exporter)
    # Without this, Lambda may freeze before background thread sends.
    scopecall.flush(timeout=2.0)
    return response
```

---

## TypeScript SDK

### Package Structure

```
scopecall-node/
├── src/
│   ├── index.ts          → public API exports
│   ├── client.ts         → ScopeCallClient class
│   ├── config.ts         → configuration + validation
│   ├── instrumentor.ts   → library patching
│   ├── processor.ts      → event enrichment + cost calculation
│   ├── redactor.ts       → PII redaction
│   ├── exporter.ts       → batching + HTTP export
│   ├── tracer.ts         → AsyncLocalStorage context
│   ├── pricing.ts        → model pricing table
│   └── types.ts          → TypeScript interfaces
├── tests/
├── package.json
└── README.md
```

### Public API

```typescript
// ── src/index.ts ────────────────────────────────────────

import { ScopeCallClient } from './client'

let _client: ScopeCallClient | null = null

export function init(options: ScopeCallOptions): void {
    if (_client) {
        console.warn('[ScopeCall] Already initialized. Ignoring duplicate init.')
        return
    }
    _client = new ScopeCallClient(options)
    _client.start()
}

export function trace<T>(
    options: TraceOptions,
    fn: () => T | Promise<T>
): Promise<T> {
    return _client?.trace(options, fn) ?? Promise.resolve(fn())
}

export async function flush(): Promise<void> {
    await _client?.flush()
}

export async function shutdown(): Promise<void> {
    await _client?.shutdown()
}
```

```typescript
// ── src/types.ts ─────────────────────────────────────────

export interface ScopeCallOptions {
    apiKey: string
    environment?: string        // default: auto-detected
    captureContent?: boolean    // default: true
    redactPii?: boolean         // default: true
    featureName?: string
    endpoint?: string           // default: https://ingest.scopecall.com
    batchSize?: number          // default: 50
    flushInterval?: number      // default: 5000 (ms)
    timeout?: number            // default: 3000 (ms)
    disabled?: boolean          // default: false
}

export interface TraceOptions {
    feature?: string
    userId?: string
    sessionId?: string
    metadata?: Record<string, unknown>
}

export interface LLMEvent {
    traceId: string
    spanId: string
    parentSpanId?: string
    timestamp: number
    model: string
    provider: string
    inputTokens: number
    outputTokens: number
    costUsd: number
    latencyMs: number
    status: 'success' | 'error' | 'timeout' | 'rate_limited'
    inputText: string
    outputText: string
    errorMessage?: string
    featureName?: string
    userId?: string
    sessionId?: string
    environment: string
    sdkVersion: string
}
```

### Instrumentation (TypeScript)

```typescript
// ── src/instrumentor.ts ──────────────────────────────────

import { NodeSDK } from '@opentelemetry/sdk-node'
import { ScopeCallSpanExporter } from './exporter'

export class ScopeCallInstrumentor {
    private sdk: NodeSDK | null = null

    constructor(
        private config: ScopeCallConfig,
        private exporter: ScopeCallExporter,
    ) {}

    instrument(): void {
        // OpenLLMetry handles patching OpenAI, Anthropic, LangChain
        // We provide our span exporter to receive the spans
        const { Traceloop } = require('@traceloop/node-server-sdk')

        Traceloop.initialize({
            exporter: new ScopeCallSpanExporter(this.config, this.exporter),
            disableBatch: true,
        })
    }
}
```

### Trace Context (AsyncLocalStorage)

```typescript
// ── src/tracer.ts ────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks'

interface TraceContext {
    featureName?: string
    userId?: string
    sessionId?: string
    metadata?: Record<string, unknown>
}

const storage = new AsyncLocalStorage<TraceContext>()

export async function withTrace<T>(
    options: TraceOptions,
    fn: () => T | Promise<T>
): Promise<T> {
    const context: TraceContext = {
        featureName: options.feature,
        userId: options.userId,
        sessionId: options.sessionId,
        metadata: options.metadata,
    }

    return storage.run(context, fn)
}

export function getCurrentContext(): TraceContext | undefined {
    return storage.getStore()
}
```

### TypeScript Usage Examples

```typescript
// ── Next.js API Route ────────────────────────────────────

// lib/scopecall.ts (initialize once)
import { init } from '@scopecall/scopecall-js'

init({
    apiKey: process.env.SCOPECALL_API_KEY!,
    environment: process.env.NODE_ENV,
})


// app/api/chat/route.ts
import { trace } from '@scopecall/scopecall-js'
import { OpenAI } from 'openai'

const openai = new OpenAI()

export async function POST(req: Request) {
    const { messages, userId } = await req.json()

    const response = await trace({ feature: 'chat', userId }, () =>
        openai.chat.completions.create({
            model: 'gpt-4o',
            messages,
        })
    )

    return Response.json({ reply: response.choices[0].message.content })
}


// ── Vercel AI SDK integration ────────────────────────────

import { init } from '@scopecall/scopecall-js'
import { streamText } from 'ai'
import { openai } from '@ai-sdk/openai'

init({ apiKey: process.env.SCOPECALL_API_KEY! })
// All Vercel AI SDK calls automatically instrumented


// ── Express.js ───────────────────────────────────────────

import express from 'express'
import { init, trace } from '@scopecall/scopecall-js'

init({ apiKey: process.env.SCOPECALL_API_KEY! })

const app = express()

app.post('/summarize', async (req, res) => {
    const summary = await trace(
        { feature: 'summarize', userId: req.user.id },
        () => generateSummary(req.body.text)
    )
    res.json({ summary })
})
```

---

## Data Models

### LLMEvent (canonical event format)

```typescript
interface LLMEvent {
    // Identity
    traceId: string              // UUID v4, groups related spans
    spanId: string               // UUID v4, unique per call
    parentSpanId?: string        // set for nested calls in agents

    // Timing
    timestamp: number            // Unix ms, when call started
    latencyMs: number            // total round-trip ms
    ttftMs?: number              // time to first token (streaming)

    // Model
    model: string                // exact model ID from provider
    provider: string             // openai | anthropic | google | etc.

    // Usage
    inputTokens: number
    outputTokens: number
    costUsd: number              // calculated, 6 decimal places

    // Status
    status: EventStatus          // success | error | timeout | rate_limited

    // Content (may be empty if captureContent=false)
    inputText: string            // redacted if redactPii=true
    outputText: string           // redacted if redactPii=true
    errorMessage?: string

    // Context
    featureName?: string         // developer-provided tag
    userId?: string              // end user identifier
    sessionId?: string           // conversation/session grouping
    environment: string          // prod | staging | dev
    metadata?: Record<string, string>  // arbitrary key-value

    // SDK
    sdkVersion: string           // e.g. "1.2.3"
    sdkLanguage: string          // python | typescript
}
```

### AgentSpan (for multi-step agents)

```typescript
interface AgentSpan extends LLMEvent {
    spanType: 'llm' | 'tool' | 'agent'
    toolName?: string            // for tool calls
    toolInput?: string           // JSON string
    toolOutput?: string          // JSON string
    stepNumber: number           // position in agent execution
    agentName?: string           // which agent class/function
}
```

---

## Testing Strategy

### Unit Tests

```python
# tests/test_redactor.py

def test_redacts_email():
    result = Redactor.redact("Contact me at john@acme.com for details")
    assert result == "Contact me at [EMAIL] for details"

def test_redacts_phone():
    result = Redactor.redact("Call me at 555-123-4567")
    assert result == "Call me at [PHONE]"

def test_preserves_non_pii():
    text = "The product costs $49.99 and ships in 3-5 days"
    assert Redactor.redact(text) == text

def test_empty_string():
    assert Redactor.redact("") == ""

def test_custom_pattern():
    Redactor.add_pattern("ACCOUNT", r'ACC-\d{8}')
    result = Redactor.redact("Your account ACC-12345678 is active")
    assert result == "Your account [ACCOUNT] is active"
```

```python
# tests/test_exporter.py

def test_graceful_degradation_on_server_down(mock_server_down):
    """Exporter must not raise when ScopeCall server unreachable."""
    exporter = ScopeCallExporter(config)
    exporter.start()

    # Enqueue events
    for _ in range(10):
        exporter.enqueue(make_test_event())

    # Should not raise
    exporter.flush()
    exporter.shutdown()

def test_bounded_queue_drops_oldest(monkeypatch):
    """When queue is full, oldest events are dropped."""
    monkeypatch.setattr(ScopeCallExporter, 'MAX_QUEUE_SIZE', 5)
    exporter = ScopeCallExporter(config)

    events = [make_test_event() for _ in range(10)]
    for event in events:
        exporter.enqueue(event)

    assert exporter._queue.qsize() == 5

def test_batch_respects_size_limit():
    exporter = ScopeCallExporter(ScopeCallConfig(api_key="x", batch_size=10))
    for _ in range(25):
        exporter.enqueue(make_test_event())

    batch = exporter._collect_batch()
    assert len(batch) <= 10
```

### Integration Tests

```python
# tests/test_integration.py
# Requires: OPENAI_API_KEY, test ScopeCall endpoint

def test_openai_call_captured(scopecall_test_server):
    scopecall.init(
        api_key="sc_test_xxx",
        endpoint=scopecall_test_server.url,
    )

    response = openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Say 'hello'"}],
    )
    scopecall.flush()

    events = scopecall_test_server.received_events()
    assert len(events) == 1
    assert events[0]["model"] == "gpt-4o-mini"
    assert events[0]["status"] == "success"
    assert events[0]["input_tokens"] > 0
    assert events[0]["cost_usd"] > 0
```

### Version Compatibility Matrix

```
scopecall-python 1.x.x

openai         >= 0.28.0   ✓  (legacy)
               >= 1.0.0    ✓  (current)
anthropic      >= 0.18.0   ✓
               >= 0.20.0   ✓  (current)
langchain      >= 0.0.300  ✓
               >= 0.1.0    ✓  (current)
               >= 0.2.0    ✓
llama-index    >= 0.9.0    ✓
               >= 0.10.0   ✓  (current)
python         >= 3.8      ✓
               >= 3.12     ✓

scopecall-node 1.x.x

openai         >= 4.0.0    ✓
@anthropic-ai  >= 0.20.0   ✓
langchain      >= 0.1.0    ✓
node.js        >= 18.0     ✓
               >= 20.0     ✓  (recommended)
```

---

## Security Considerations

### API Key Handling

```python
# Keys should come from environment variables — never hardcoded
scopecall.init(api_key=os.getenv("SCOPECALL_API_KEY"))

# SDK warns if key appears to be hardcoded (starts with sc_live_ in source)
# SDK warns if test key used in production environment
```

### Data Transmission

```
Transport encryption    TLS 1.3 for all SDK → Ingest traffic, no HTTP
Auth header             Authorization: Bearer sc_live_xxxxxxxxxxxx
Certificate pinning     Optional, enterprise tier
```

**On payload signing (intentionally NOT in MVP)**: Earlier drafts mentioned HMAC-SHA256
payload signing. We deliberately do NOT do this in the SDK — TLS + Bearer token
authentication is sufficient for our threat model. Adding HMAC requires careful key
distribution and rotation that adds complexity without meaningful security gain when
TLS is already in place. If a future enterprise customer requires it, we add it as
an opt-in feature with a separate signing key (not the API key).

### Key Rotation

```python
# Old key continues to work for 24 hours after rotation
# Allows zero-downtime key rotation:

# Step 1: Generate new key in dashboard
# Step 2: Deploy new key to application
# Step 3: Old key automatically expires after 24h
```

---

## Performance Benchmarks

### Target Overhead Per Call

```
SDK interception overhead    < 0.1ms
PII redaction (per call)     < 2ms
Event serialization          < 0.5ms
Queue enqueue                < 0.1ms
─────────────────────────────────────
Total overhead per AI call   < 3ms

Typical AI call latency      800-3000ms
ScopeCall overhead              < 0.3% of total latency
```

### Memory Usage

```
SDK base memory footprint    < 10MB
Event queue (10k events)     < 100MB
Background thread            < 1MB
─────────────────────────────────────
Total memory overhead        < 50MB typical
```

### Throughput

```
Events per second (single SDK instance)   > 10,000
Batch send throughput                     > 50MB/second
Queue drain rate                          > 1,000 events/second
```

---

## SDK Changelog Policy

```
Semantic versioning: MAJOR.MINOR.PATCH

PATCH (1.0.x)  → Bug fixes, pricing table updates
               → Auto-updated via pip install scopecall-py --upgrade

MINOR (1.x.0)  → New framework support, new optional features
               → Backwards compatible

MAJOR (x.0.0)  → Breaking API changes
               → Migration guide provided
               → Old major version maintained 12 months

Pricing table  → Updated independently via background refresh
               → No SDK update required when model prices change
```
