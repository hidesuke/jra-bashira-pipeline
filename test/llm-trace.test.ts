import { describe, expect, it } from "vitest";
import { keys, MemoryKv } from "../src/kv";
import { loadLlmTrace, saveLlmTrace } from "../src/llm-trace";
import { PREDICT_INPUT_CHUNK_CHARS, PREDICT_INPUT_MAX_CHARS } from "../src/predict-input";

describe("llm trace", () => {
  it("keeps the course record when the race output is added later", async () => {
    const kv = new MemoryKv();
    await saveLlmTrace(kv, "20261108-05-11", {
      coursePromptVersion: "c1",
      racePromptVersion: "r1",
      courseModel: "course-model",
      raceModel: "race-model",
      courseUser: "ユーザー文",
      courseOutput: "コース出力",
    });
    await saveLlmTrace(kv, "20261108-05-11", {
      raceOutput: "レース出力",
      raceWebSearchQueries: ["検索しない"],
    });
    const loaded = await loadLlmTrace(kv, "20261108-05-11");
    expect(loaded).toMatchObject({
      coursePromptVersion: "c1",
      racePromptVersion: "r1",
      courseModel: "course-model",
      courseUser: "ユーザー文",
      courseOutput: "コース出力",
      raceOutput: "レース出力",
      raceWebSearchQueries: ["検索しない"],
      truncated: false,
      incomplete: false,
    });
    expect(await kv.get(keys.llmTrace("20261108-05-11"))).not.toContain("システム");
  });

  it("splits a long output and clips at the value limit", async () => {
    const kv = new MemoryKv();
    const longOutput = `頭${"あ".repeat(PREDICT_INPUT_CHUNK_CHARS)}尾`;
    await saveLlmTrace(kv, "20261108-05-11", { courseOutput: longOutput, courseUser: "短い" });
    const loaded = await loadLlmTrace(kv, "20261108-05-11");
    expect(loaded?.courseOutput).toBe(longOutput);
    expect(loaded?.courseUser).toBe("短い");
    expect(loaded?.truncated).toBe(false);
    const meta = JSON.parse((await kv.get(keys.llmTrace("20261108-05-11"))) ?? "{}") as { courseOutput?: string; courseOutputChunks?: number };
    expect(meta.courseOutput).toBeUndefined();
    expect(meta.courseOutputChunks).toBeGreaterThan(1);

    const huge = "う".repeat(PREDICT_INPUT_MAX_CHARS + 20);
    const clipped = await saveLlmTrace(kv, "20261108-05-11", { courseOutput: huge });
    expect(clipped.truncated).toBe(true);
    const again = await loadLlmTrace(kv, "20261108-05-11");
    expect(again?.courseUser).toBe("短い");
    expect(again?.courseOutput?.includes("う".repeat(PREDICT_INPUT_MAX_CHARS))).toBe(true);
    expect(again?.courseOutput?.includes("う".repeat(PREDICT_INPUT_MAX_CHARS + 1))).toBe(false);
    expect(again?.courseOutput).toContain("切り詰め");
  });

  it("reports a missing chunk as incomplete", async () => {
    const kv = new MemoryKv();
    const longOutput = "あ".repeat(PREDICT_INPUT_CHUNK_CHARS + 10);
    await saveLlmTrace(kv, "20261108-05-11", { courseOutput: longOutput });
    await kv.delete(keys.llmTraceChunk("20261108-05-11", "co", 0));
    const loaded = await loadLlmTrace(kv, "20261108-05-11");
    expect(loaded?.incomplete).toBe(true);
    expect(loaded?.courseOutput).not.toBe(longOutput);
  });
});
