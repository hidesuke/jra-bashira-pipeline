import { describe, expect, it } from "vitest";
import { fetchBaba } from "../src/baba";
import { ExternalBudget } from "../src/budget";

const url = "https://jra-dify-pipeline.hdsk.workers.dev/baba/latest";

function venueResponse(): Response {
  return Response.json({
    fetchedAt: "2026-11-08T07:00:00Z",
    venues: [{ venueName: "福島", weather: "晴" }],
  });
}

describe("baba fetch", () => {
  it("uses the service binding when present", async () => {
    const requests: Request[] = [];
    let fallbackCalls = 0;
    const budget = new ExternalBudget();
    const result = await fetchBaba({
      url,
      venue: "福島",
      budget,
      binding: {
        fetch: async (request) => {
          requests.push(request);
          return venueResponse();
        },
      },
      fetcher: async () => {
        fallbackCalls += 1;
        return venueResponse();
      },
    });
    expect(fallbackCalls).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBeInstanceOf(Request);
    expect(requests[0]?.url).toBe(url);
    expect(requests[0]?.method).toBe("GET");
    expect(result.venue).toMatchObject({ venueName: "福島", weather: "晴" });
    expect(result.fetchedAt).toBe("2026-11-08T07:00:00Z");
    expect(result.note).toBeNull();
    expect(budget.used).toBe(1);
  });

  it("falls back to fetch when the binding is absent", async () => {
    const calls: Array<{ input: string; method: string | undefined }> = [];
    const budget = new ExternalBudget();
    const result = await fetchBaba({
      url,
      venue: "福島",
      budget,
      fetcher: async (input, init) => {
        calls.push({ input: String(input), method: init?.method });
        return venueResponse();
      },
    });
    expect(calls).toEqual([{ input: url, method: "GET" }]);
    expect(result.venue).toMatchObject({ venueName: "福島" });
    expect(result.note).toBeNull();
    expect(budget.used).toBe(1);
  });

  it("puts the status and the first 200 chars of the body in the note and the log", async () => {
    const body = `error-${"x".repeat(240)}`;
    const prefix = body.slice(0, 200);
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const budget = new ExternalBudget();
    const result = await fetchBaba({
      url,
      venue: "福島",
      budget,
      fetcher: async () => new Response(body, { status: 404, headers: { "content-type": "text/plain" } }),
      log: (event, fields) => {
        logs.push({ event, fields });
      },
    });
    expect(result.venue).toBeNull();
    expect(result.fetchedAt).toBeNull();
    expect(result.note).toContain("HTTP 404");
    expect(result.note).toContain(prefix);
    expect(result.note).not.toContain(body.slice(0, 201));
    expect(result.note).toContain("レース処理は続けます");
    expect(logs).toEqual([{ event: "baba_fetch_failed", fields: { status: 404, body: prefix } }]);
    expect(budget.used).toBe(1);
  });
});
