import { describe, expect, it } from "vitest";
import { runWithModelInvocationContext } from "@zcode/contracts";
import {
  createConversationCaptureFetch,
  type ConversationProviderExchangeRecord,
} from "../src/conversation-recording/index.js";

interface CaptureSink {
  records: ConversationProviderExchangeRecord[];
  waitForRecord: () => Promise<ConversationProviderExchangeRecord>;
  recordProviderExchange: (record: ConversationProviderExchangeRecord) => void;
}

function createCaptureSink(): CaptureSink {
  const records: ConversationProviderExchangeRecord[] = [];
  let resolveRecord!: (record: ConversationProviderExchangeRecord) => void;
  const recordPromise = new Promise<ConversationProviderExchangeRecord>((resolve) => {
    resolveRecord = resolve;
  });
  return {
    records,
    waitForRecord: async () => await recordPromise,
    recordProviderExchange(record) {
      records.push(record);
      resolveRecord(record);
    },
  };
}

describe("conversation capture fetch", () => {
  it("records raw request/response headers and bodies without changing the returned response", async () => {
    const sink = createCaptureSink();
    const wrapped = createConversationCaptureFetch({
      capture: sink,
      fetch: async () =>
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
      modelId: "gpt-test",
      providerId: "openai",
    });

    const response = await runWithModelInvocationContext(
      {
        metadata: { sessionId: "sess_1", traceId: "trace_1", turnId: "turn_1" },
      },
      () =>
        wrapped(
          new Request("https://api.example.com/v1/responses", {
            body: '{"model":"gpt-test","messages":[]}',
            headers: {
              authorization: "Bearer secret-token",
              "content-type": "application/json",
            },
            method: "POST",
          }),
        ),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("response.completed");

    const record = await sink.waitForRecord();
    expect(record.sessionId).toBe("sess_1");
    expect(record.traceId).toBe("trace_1");
    expect(record.turnId).toBe("turn_1");
    expect(record.providerId).toBe("openai");
    expect(record.modelId).toBe("gpt-test");
    expect(record.request.url).toBe("https://api.example.com/v1/responses");
    expect(record.request.method).toBe("POST");
    expect(record.request.headers.authorization).toBe("Bearer secret-token");
    expect(record.request.body).toBe('{"model":"gpt-test","messages":[]}');
    expect(record.response?.status).toBe(200);
    expect(record.response?.headers["content-type"]).toBe("text/event-stream");
    expect(record.response?.body).toContain("response.completed");
    expect(sink.records).toHaveLength(1);
  });

  it("records the original error and rethrows it when the provider request fails", async () => {
    const sink = createCaptureSink();
    const wrapped = createConversationCaptureFetch({
      capture: sink,
      fetch: async () => {
        throw new Error("network down");
      },
      modelId: "gpt-test",
      providerId: "openai",
    });

    await expect(
      wrapped("https://api.example.com/v1/responses", {
        body: '{"messages":[]}',
        headers: { authorization: "Bearer secret-token" },
        method: "POST",
      }),
    ).rejects.toThrow("network down");

    const record = await sink.waitForRecord();
    expect(record.error?.message).toBe("network down");
    expect(record.response).toBeUndefined();
    expect(record.request.method).toBe("POST");
    expect(record.request.headers.authorization).toBe("Bearer secret-token");
  });
});
