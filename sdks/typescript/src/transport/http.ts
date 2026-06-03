import type { ExportRequest, ExportResponse, Transport } from "./types.js";
import type { ScopeCallConfig } from "../config.js";

export class HttpTransport implements Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(config: Pick<ScopeCallConfig, "endpoint" | "apiKey">) {
    // endpoint is now required by config.validate() — by the time we get
    // here it's guaranteed non-empty. The bang reflects the post-validate
    // contract; no silent fallback to a "default" hosted URL that doesn't
    // exist yet (Round-8 review).
    this.endpoint = config.endpoint!;
    this.apiKey = config.apiKey!;
  }

  async send(req: ExportRequest): Promise<ExportResponse> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
          "X-ScopeCall-SDK": "typescript",
        },
        body: JSON.stringify(req),
      });
    } catch (err) {
      // Network error — treat as retryable 503
      return { ok: false, status: 503 };
    }

    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? parseFloat(retryAfterHeader) : undefined;

    return {
      ok: res.ok,
      status: res.status,
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    };
  }
}
