import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@zcode/contracts";
import { createConversationRecorder } from "../src/conversation-recording/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-conversation-recording-"));
  tempDirs.push(dir);
  return dir;
}

describe("conversation recorder", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("appends provider exchanges and events into per-session JSONL files without redaction", async () => {
    const rootDir = await makeTempDir();
    const recorder = createConversationRecorder({ rootDir });

    recorder.recordProviderExchange({
      capturedAt: "2026-10-29T10:00:00.000Z",
      modelId: "gpt-test",
      providerId: "openai",
      request: {
        body: '{"messages":[{"role":"user","content":"data:image/png;base64,AAAA"}]}',
        headers: { authorization: "Bearer secret-token" },
        method: "POST",
        url: "https://api.example.com/v1/responses",
      },
      response: {
        body: "data: {\"type\":\"response.completed\"}\n\n",
        headers: { "content-type": "text/event-stream" },
        status: 200,
      },
      sessionId: "sess_main/../escape",
      traceId: "trace_1",
      turnId: "turn_1",
      type: "provider_exchange",
    });
    recorder.recordSessionEvent({
      id: "event_1",
      payload: { querySource: "main_turn" },
      sequenceNumber: 1,
      sessionId: "sess_child",
      timestamp: new Date("2026-10-29T10:00:01.000Z"),
      traceId: "trace_1",
      turnId: "turn_2",
      type: "model_request",
    } as unknown as SessionEvent);
    await recorder.close();

    const captureLines = (
      await readFile(join(rootDir, "sess_main-escape", "capture.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(captureLines).toHaveLength(1);
    const capture = JSON.parse(captureLines[0]!) as {
      request: { body: string; headers: Record<string, string> };
      response: { body: string; status: number };
      sessionId: string;
    };
    expect(capture.request.headers.authorization).toBe("Bearer secret-token");
    expect(capture.request.body).toContain("data:image/png;base64,AAAA");
    expect(capture.response.status).toBe(200);
    expect(capture.response.body).toContain("response.completed");
    expect(capture.sessionId).toBe("sess_main/../escape");

    const eventLines = (
      await readFile(join(rootDir, "sess_child", "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(eventLines).toHaveLength(1);
    const event = JSON.parse(eventLines[0]!) as {
      payload: { querySource?: string };
      sessionId: string;
      type: string;
    };
    expect(event.type).toBe("model_request");
    expect(event.payload.querySource).toBe("main_turn");
    expect(event.sessionId).toBe("sess_child");
  });

  it("never throws when the recording root cannot be written", async () => {
    const dir = await makeTempDir();
    const rootFile = join(dir, "not-a-directory");
    await writeFile(rootFile, "occupied");

    const recorder = createConversationRecorder({ rootDir: rootFile });
    expect(() =>
      recorder.recordProviderExchange({
        capturedAt: "2026-10-29T10:00:00.000Z",
        modelId: "gpt-test",
        providerId: "openai",
        request: { headers: {}, method: "POST", url: "https://example.com" },
        sessionId: "sess_1",
        type: "provider_exchange",
      }),
    ).not.toThrow();
    await expect(recorder.close()).resolves.toBeUndefined();
  });
});
