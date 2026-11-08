import { describe, expect, it } from "vitest";
import { ExternalBudget } from "../src/budget";
import { generateText } from "../src/gemini";
import { JobError } from "../src/types";

const model = "gemini-flash-latest";

function call(fetcher: typeof fetch, json = false) {
  return generateText({
    apiKey: "k",
    model,
    prompt: "user",
    budget: new ExternalBudget(),
    json,
    fetcher,
  });
}

function sseText(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function byteSplit(text: string, size: number): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const early = {
  modelVersion: "gemini-3.8-flash",
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 1, totalTokenCount: 3 },
  candidates: [{ content: { parts: [{ text: "考えSECRET", thought: true }, { text: "本" }] } }],
};

const finalChunk = {
  usageMetadata: {
    promptTokenCount: 67,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 800,
    totalTokenCount: 887,
    cachedContentTokenCount: 4,
  },
  candidates: [
    {
      finishReason: "STOP",
      groundingMetadata: {
        webSearchQueries: ["福島 芝 1600", 1, "コース"],
        groundingChunks: [{ web: { title: "cite-me" } }],
      },
      content: { parts: [{ text: "文です", thought: false }] },
    },
  ],
};

describe("gemini sse", () => {
  it("accumulates text across events, skips thoughts, and keeps the final usage", async () => {
    const seen: string[] = [];
    const result = await call(async (input, init) => {
      seen.push(String(input));
      expect(JSON.parse(String(init?.body)).generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "high" } });
      return streamResponse([sseText([early, finalChunk]), "data: [DONE]\n\n"]);
    });
    expect(seen).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse",
    ]);
    expect(result.text).toBe("本文です");
    expect(result.text).not.toContain("SECRET");
    expect(result.text).not.toContain("cite-me");
    expect(result).toMatchObject({
      modelVersion: "gemini-3.8-flash",
      finishReason: "STOP",
      usageMetadata: {
        promptTokenCount: 67,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 800,
        totalTokenCount: 887,
      },
      webSearchQueries: ["福島 芝 1600", "コース"],
    });
  });

  it("parses when chunk boundaries split UTF-8, JSON, and the blank line", async () => {
    const body = sseText([early, finalChunk]);
    const result = await call(async () => byteSplit(body, 1));
    expect(result.text).toBe("本文です");
    expect(result.usageMetadata.totalTokenCount).toBe(887);
    expect(result.finishReason).toBe("STOP");
  });

  it("joins a data line that is split across chunks and a CRLF blank line", async () => {
    const payload = JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "分割本文" }] } }],
      modelVersion: "split-model",
    });
    const result = await call(async () => streamResponse([`data: ${payload.slice(0, 12)}`, `${payload.slice(12)}\r\n`, "\r\n"]));
    expect(result.text).toBe("分割本文");
    expect(result.modelVersion).toBe("split-model");
  });

  it("accepts a data field without a space and a JSON object split over data lines", async () => {
    const compact = await call(async () =>
      streamResponse(['data:{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"詰めて"}]}}]}\n\n']),
    );
    expect(compact.text).toBe("詰めて");
    const wrapped = await call(async () =>
      streamResponse([
        'data: {"candidates":[{"content":{"parts":\n',
        'data: [{"text":"行またぎ"}]},"finishReason":"MAX_TOKENS"}]}\n\n',
      ]),
    );
    expect(wrapped.text).toBe("行またぎ");
    expect(wrapped.finishReason).toBe("MAX_TOKENS");
  });

  it("fails the call when a later event is an error, even if text already arrived", async () => {
    const raw = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: "途中" }] } }],
    })}\n\ndata: ${JSON.stringify({ error: { code: 503, message: "overloaded" } })}\n\n`;
    const chunks: string[] = [];
    for (let i = 0; i < raw.length; i += 7) chunks.push(raw.slice(i, i + 7));
    await expect(call(async () => streamResponse(chunks))).rejects.toThrow(/overloaded/);
    try {
      await call(async () => streamResponse(chunks));
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).retryable).toBe(true);
      expect((err as JobError).httpStatus).toBe(503);
      expect((err as JobError).message).toBe("Gemini (gemini-flash-latest) が失敗しました: overloaded");
    }
  });

  it("treats a stream 400 as non-retryable so json mode falls back once", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const result = await call(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return streamResponse([`data: ${JSON.stringify({ error: { code: 400, message: "bad schema" } })}\n\n`]);
      }
      return streamResponse([
        `data: ${JSON.stringify({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{\"指数分布\":\"x\"}" }] } }],
        })}\n\n`,
      ]);
    }, true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "high" },
    });
    expect(bodies[1]?.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "high" } });
    expect(result.text).toContain("指数分布");
  });

  it("rejects an empty stream and a blocked prompt with the empty-text error", async () => {
    await expect(call(async () => streamResponse([""]))).rejects.toThrow(/応答テキストが空です/);
    await expect(
      call(async () => streamResponse([`data: ${JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })}\n\n`])),
    ).rejects.toThrow(/応答テキストが空です/);
    await expect(
      call(async () =>
        streamResponse([
          `data: ${JSON.stringify({
            candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "hidden", thought: true }] } }],
          })}\n\n`,
        ]),
      ),
    ).rejects.toThrow(/応答テキストが空です/);
    try {
      await call(async () => new Response(null));
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).retryable).toBe(true);
      expect((err as JobError).message).toBe("Gemini (gemini-flash-latest) のストリームが途中で切れました");
    }
  });

  it("keeps finishReason SAFETY when the blocked candidate still has text", async () => {
    const result = await call(async () =>
      streamResponse([
        `data: ${JSON.stringify({
          candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "一部だけ" }] } }],
        })}\n\n`,
      ]),
    );
    expect(result.text).toBe("一部だけ");
    expect(result.finishReason).toBe("SAFETY");
  });

  it("rejects a truncated tail and does not return the text already parsed", async () => {
    const raw =
      sseText([{ candidates: [{ content: { parts: [{ text: "途中まで" }] } }] }]) +
      'data: {"candidates":[{"content":{"parts":[{"text":"切';
    await expect(call(async () => streamResponse([raw.slice(0, 20), raw.slice(20)]))).rejects.toThrow(
      /ストリームが途中で切れました/,
    );
    try {
      await call(async () => streamResponse([raw]));
    } catch (err) {
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).retryable).toBe(true);
      expect((err as JobError).httpStatus).toBeNull();
    }
  });

  it("rejects a framed event that is not JSON", async () => {
    await expect(call(async () => streamResponse(["data: {not-json}\n\n"]))).rejects.toThrow(/ストリームを解釈できません/);
  });

  it("rejects a stream that errors after the first event", async () => {
    const encoder = new TextEncoder();
    await expect(
      call(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "途中" }] } }] })}\n\n`,
                  ),
                );
                controller.error(new Error("socket reset"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    ).rejects.toThrow(/ストリームが途中で切れました: socket reset/);
  });
});
