import type { LLMEvent } from "../wire/llm-event.js";

export interface ExportRequest {
  events: LLMEvent[];
  // snake_case to match the Rust ingest DTO (IngestBatch.sent_at).
  // The whole wire schema is snake_case; only SDK internals use camelCase.
  sent_at: string; // ISO 8601
}

export interface ExportResponse {
  ok: boolean;
  status: number;
  retryAfterSeconds?: number;
}

export interface Transport {
  send(req: ExportRequest): Promise<ExportResponse>;
  /** Called on shutdown — implementations should flush/close resources */
  close?(): Promise<void>;
}
