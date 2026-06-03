import type { ExportRequest, ExportResponse, Transport } from "./types.js";

export class ConsoleTransport implements Transport {
  async send(req: ExportRequest): Promise<ExportResponse> {
    for (const event of req.events) {
      console.log(
        `[scopecall] ${event.timestamp} ${event.model} ` +
        `in=${event.input_tokens} out=${event.output_tokens} ` +
        `cost=$${event.cost_usd.toFixed(6)} latency=${event.latency_ms}ms ` +
        `status=${event.status}`
      );
    }
    return { ok: true, status: 200 };
  }
}
