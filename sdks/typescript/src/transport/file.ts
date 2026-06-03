import { appendFile } from "node:fs/promises";
import type { ExportRequest, ExportResponse, Transport } from "./types.js";
import { toWire } from "../wire/llm-event.js";

export class FileTransport implements Transport {
  constructor(private readonly path: string) {}

  async send(req: ExportRequest): Promise<ExportResponse> {
    try {
      const lines = req.events.map((e) => toWire(e)).join("\n") + "\n";
      await appendFile(this.path, lines, "utf8");
      return { ok: true, status: 200 };
    } catch (err) {
      return { ok: false, status: 500 };
    }
  }
}
