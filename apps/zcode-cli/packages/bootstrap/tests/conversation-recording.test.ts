import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@zcode/contracts";
import {
  composeConversationEventSink,
  resolveConversationRecorder,
} from "../src/conversation-recording/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-conversation-bootstrap-"));
  tempDirs.push(dir);
  return dir;
}

function buildEvent(sessionId: string): SessionEvent {
  return {
    id: `event_${sessionId}`,
    payload: { ok: true },
    sequenceNumber: 1,
    sessionId,
    timestamp: new Date("2026-10-29T10:00:00.000Z"),
    traceId: "trace_1",
    turnId: "turn_1",
    type: "model_request",
  } as unknown as SessionEvent;
}

describe("conversation recording wiring", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("uses CLI overrides over config and falls back to the storage conversation directory", async () => {
    const cliStorageRoot = await makeTempDir();
    const disabled = resolveConversationRecorder({
      config: { enabled: false },
      cliStorageRoot,
    });
    expect(disabled).toBeUndefined();

    const configEnabled = resolveConversationRecorder({
      cliStorageRoot,
      config: { enabled: true },
    });
    expect(configEnabled).toBeDefined();
    configEnabled!.recordSessionEvent(buildEvent("sess_config"));
    await configEnabled!.close();
    const configEvents = await readFile(
      join(cliStorageRoot, "conversation", "sess_config", "events.jsonl"),
      "utf8",
    );
    expect(configEvents.trim().split("\n")).toHaveLength(1);

    const cliDir = await makeTempDir();
    const cliOverride = resolveConversationRecorder({
      cliDir,
      cliEnabled: true,
      cliStorageRoot,
      config: { enabled: false },
    });
    cliOverride!.recordSessionEvent(buildEvent("sess_cli"));
    await cliOverride!.close();
    const cliEvents = await readFile(join(cliDir, "sess_cli", "events.jsonl"), "utf8");
    expect(cliEvents).toContain("model_request");
  });

  it("keeps the host event sink working and records events even if the host sink fails", async () => {
    const rootDir = await makeTempDir();
    const recorder = resolveConversationRecorder({
      cliDir: rootDir,
      cliEnabled: true,
      cliStorageRoot: rootDir,
      config: { enabled: true },
    });
    const received: string[] = [];
    const sink = composeConversationEventSink(
      {
        onSessionEvent: (event) => {
          received.push(String(event.sessionId));
        },
      },
      recorder,
    );

    await sink!.onSessionEvent(buildEvent("sess_host"));

    let failingSinkError: unknown;
    const failingSink = composeConversationEventSink(
      {
        onSessionEvent: () => {
          throw new Error("host sink failed");
        },
      },
      recorder,
    );
    try {
      await failingSink!.onSessionEvent(buildEvent("sess_fail"));
    } catch (error) {
      failingSinkError = error;
    }

    await recorder!.close();
    expect(received).toEqual(["sess_host"]);
    expect(failingSinkError).toBeInstanceOf(Error);
    const failedEvents = await readFile(join(rootDir, "sess_fail", "events.jsonl"), "utf8");
    expect(failedEvents).toContain("model_request");
  });
});
