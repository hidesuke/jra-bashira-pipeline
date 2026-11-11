import { describe, expect, it } from "vitest";
import { resolveCourseSide } from "../src/course-side";
import { handleRequest, type HttpDeps } from "../src/http";
import { describePastRunsMissing, extractCourseRecords, extractPastRuns, extractRunnerStats, PAST_RUNS_MISSING_NOTE } from "../src/input-sections";
import { RUNNER_STATS_HEADING, renderRunnerStats, type NameStat } from "../src/runner-stats";
import type { JobState } from "../src/job";
import { keys, MemoryKv } from "../src/kv";
import {
  COURSE_RELATED_EMPTY,
  COURSE_RECORDS_TITLE,
  PAST_RUNS_TITLE,
  renderCourseRecords,
  renderPastRuns,
  type CareerHorse,
} from "../src/past-runs";
import { PREDICT_INPUT_CHUNK_CHARS, loadPredictInput, savePredictInput, type StoredRelatedCourses } from "../src/predict-input";
import type { RaceRef } from "../src/types";

const PROMPT = "DUMMY_PROMPT_LEAK_9f3a これはプロンプトの偽文です。{{not_a_real_prompt}}";
const TAIL = "DUMMY_USER_TAIL_9f3a\n後続のユーザー文です。返してはいけません。";

const race: RaceRef = {
  raceKey: "20261108-05-11",
  raceId: "20261108-05-11",
  date: "2026-11-08",
  venue: "東京",
  venueCode: "05",
  raceNumber: 11,
};

const horse: CareerHorse = { horseName: "ア", queryName: "ア", horseNumber: 1, careerStarts: 1, unresolved: false };
const unresolved: CareerHorse = { horseName: "イ", queryName: "イ", horseNumber: 2, careerStarts: null, unresolved: true };
const none: CareerHorse = { horseName: "ウ", queryName: "ウ", horseNumber: 3, careerStarts: 0, unresolved: false };

const row = {
  horse_name: "ア",
  race_meeting_date: "2026-10-12",
  race_track: "東京",
  race_number: 5,
  race_name_main: "前走",
  surface: "芝",
  distance: 1600,
  official_result: 2,
  time_difference_with_winner_sec: 0,
};

const past = renderPastRuns({ race, horses: [horse, unresolved, none], rows: [row], paces: new Map() });
const course = renderCourseRecords({
  race,
  horses: [horse, unresolved],
  rows: [row],
  current: { track: "東京", surface: "芝", distance: 1600 },
  related: [{ track: "東京", surface: "芝", distance: 2400 }],
});
const unreadableCourse = renderCourseRecords({
  race,
  horses: [horse],
  rows: [row],
  current: { track: "東京", surface: "芝", distance: 1600 },
  related: null,
});
const emptyRelatedCourse = renderCourseRecords({
  race,
  horses: [horse],
  rows: [],
  current: { track: "東京", surface: "芝", distance: 1600 },
  related: [],
});

const wrapped = [PROMPT, "", past, "", course, "", TAIL, "<<<related-courses>>>", "函館,ダート,1000", "<<<end>>>"].join("\n");

function cells(line: string): string[] {
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

function dropLastCell(line: string): string {
  const parts = line.slice(1, -1).split("|");
  parts.pop();
  return `|${parts.join("|")}|`;
}

describe("allowed sections", () => {
  it("keeps empty cells empty and keeps a real zero", () => {
    const data = past.split("\n").find((line) => line.startsWith("| 2026-10-12"));
    expect(data).toBeTruthy();
    const value = cells(data!);
    expect(value[12]).toBe("0");
    expect(value[23]).toBe("");
    expect(value[24]).toBe("");
    expect(value[25]).toBe("");
    expect(value[26]).toBe("");
    expect(value[24]).not.toBe("0");
    const missing = describePastRunsMissing(past);
    expect(missing?.rows).toBe(1);
    expect(missing?.blank["着差"]).toBe(0);
    expect(missing?.blank["レース名"]).toBe(0);
    expect(missing?.blank["前半3F"]).toBe(1);
    expect(missing?.blank["後半3F"]).toBe(1);
    expect(missing?.blank["条件"]).toBe(1);
    expect(missing?.note).toBe(PAST_RUNS_MISSING_NOTE);
    expect(missing?.note).toContain("未出走");
    expect(missing?.note).toContain("レース名の空欄は特別競走ではないことを表す");
    expect(Object.keys(missing?.blank ?? {})).toHaveLength(28);
    expect(Object.keys(missing?.blank ?? {}).at(-1)).toBe("条件");
  });

  it("keeps a non-special race name blank and still fills the condition column", () => {
    const named = { ...row, race_type: "3歳以上", race_condition: "オープン" };
    const unnamed = {
      ...row,
      race_meeting_date: "2026-09-01T00:00:00Z",
      race_number: 3,
      race_name_main: null,
      race_type: "2歳",
      race_condition: "未勝利",
    };
    const text = renderPastRuns({
      race,
      horses: [horse],
      rows: [named, unnamed],
      paces: new Map([["20261012-05-05", { first3f: 34.5, last3f: 35.6 }]]),
    });
    const missing = describePastRunsMissing(text);
    expect(text).toContain("| 2026-10-12 | 東京 | 前走 |");
    expect(text).toContain("| 2026-09-01 | 東京 |  |");
    expect(text).toContain("| 3歳以上オープン |");
    expect(text).toContain("| 2歳未勝利 |");
    expect(text).toContain("| 0 |");
    expect(text).not.toContain("T00:00:00Z");
    expect(missing).toMatchObject({ rows: 2, note: PAST_RUNS_MISSING_NOTE });
    expect(missing?.blank["レース名"]).toBe(1);
    expect(missing?.blank["条件"]).toBe(0);
    expect(missing?.blank["前半3F"]).toBe(1);
    expect(missing?.blank["後半3F"]).toBe(1);
    expect(missing?.blank["着差"]).toBe(0);
  });

  it("still reads a saved table from before the condition column", () => {
    const legacy = past
      .split("\n")
      .map((line) => (line.startsWith("|") ? dropLastCell(line) : line))
      .join("\n");
    expect(legacy).not.toContain("条件");
    expect(extractPastRuns(legacy)).toEqual({ text: legacy });
    const missing = describePastRunsMissing(legacy);
    expect(missing?.rows).toBe(1);
    expect(missing?.blank).not.toHaveProperty("条件");
    expect(missing?.blank["レース名"]).toBe(0);
    expect(missing?.note).toContain("レース名の空欄は特別競走ではないことを表す");
  });

  it("extracts only the past-run and course sections from a user message", () => {
    expect(extractPastRuns(wrapped)).toEqual({ text: past });
    expect(extractCourseRecords(wrapped)).toMatchObject({ text: course });
    const courseText = extractCourseRecords(wrapped);
    expect("text" in courseText && courseText.text).toBe(course);
    const packed = JSON.stringify({ past: extractPastRuns(wrapped), course: extractCourseRecords(wrapped) });
    expect(packed).not.toContain("DUMMY_PROMPT_LEAK_9f3a");
    expect(packed).not.toContain("DUMMY_USER_TAIL_9f3a");
    expect(packed).not.toContain("{{not_a_real_prompt}}");
    expect(packed).not.toContain("<<<");
    expect(packed).not.toContain("函館");
    expect(past).toContain("同名馬のため近走取得不可");
    expect(past).toContain("近走なし");
  });

  it("stops before the next heading when the blocks are separated by one newline", () => {
    const joined = `${past}\n${course}\n${TAIL}`;
    expect(extractPastRuns(joined)).toEqual({ text: past });
    expect(extractCourseRecords(joined)).toMatchObject({ text: course });
    expect(JSON.stringify(extractPastRuns(joined))).not.toContain("DUMMY_USER_TAIL_9f3a");
  });

  it("returns a reason and no body when the heading is not the saved section", () => {
    const mention = `${PROMPT}\n見出しは ${PAST_RUNS_TITLE} です\n${TAIL}`;
    const pastResult = extractPastRuns(mention);
    const courseResult = extractCourseRecords(`${TAIL}\n${COURSE_RECORDS_TITLE} を見て`);
    expect(pastResult).toEqual({ reason: "保存済みの入力に「# 過去走（近10走）」がありません" });
    expect("reason" in courseResult).toBe(true);
    expect(JSON.stringify(pastResult)).not.toContain("DUMMY_");
    expect(JSON.stringify(courseResult)).not.toContain("DUMMY_");
  });

  it("rejects a section whose next line is not the saved introduction", () => {
    const fake = `${PAST_RUNS_TITLE}\nDUMMY_PROMPT_LEAK_9f3a 説明が違います\n\n${past}`;
    expect(extractPastRuns(fake)).toEqual({ text: past });
    expect(JSON.stringify(extractPastRuns(fake))).not.toContain("DUMMY_PROMPT_LEAK_9f3a");
    const onlyFake = `${PAST_RUNS_TITLE}\nDUMMY_PROMPT_LEAK_9f3a 説明が違います`;
    const rejected = extractPastRuns(onlyFake);
    expect(rejected).toEqual({ reason: "保存済みの近10走の形が一致しないため返しません" });
    expect(JSON.stringify(rejected)).not.toContain("DUMMY_PROMPT_LEAK_9f3a");
  });

  it("rejects a horse-shaped continuation and a broken table instead of returning part of them", () => {
    const fakeHorse = `${past}\n\n### 1 ダミー見出し\nDUMMY_PROMPT_LEAK_9f3a`;
    const broken = extractPastRuns(fakeHorse);
    expect(broken).toEqual({ reason: "保存済みの近10走の形が一致しないため返しません" });
    expect(JSON.stringify(broken)).not.toContain("DUMMY_PROMPT_LEAK_9f3a");
    const lines = past.split("\n");
    const rowIndex = lines.findIndex((line) => line.startsWith("| 2026-10-12"));
    lines.splice(rowIndex + 1, 0, "| DUMMY_PROMPT_LEAK_9f3a |");
    const contaminated = extractPastRuns(lines.join("\n"));
    expect(contaminated).toEqual({ reason: "保存済みの近10走の形が一致しないため返しません" });
    expect(JSON.stringify(contaminated)).not.toContain("DUMMY_PROMPT_LEAK_9f3a");
  });

  it("does not turn an unreadable related-course cell into a zero count", () => {
    expect(unreadableCourse).toContain("関連コース: 一覧が読めないため空欄");
    expect(unreadableCourse.split("\n").filter((line) => line.startsWith("関連コース:"))).toContain(COURSE_RELATED_EMPTY);
    expect(unreadableCourse).not.toContain("(0,0,0,0,0,0)");
    const extracted = extractCourseRecords(`${PROMPT}\n\n${unreadableCourse}\n\n${TAIL}`);
    expect(extracted).toMatchObject({ text: unreadableCourse, header: { kind: "unreadable", courses: null } });
    expect(JSON.stringify(extracted)).not.toContain("DUMMY_");
    expect(emptyRelatedCourse).toContain("関連コース: なし");
    expect(emptyRelatedCourse).toContain("(0,0,0,0,0,0)");
    expect(extractCourseRecords(emptyRelatedCourse)).toMatchObject({
      text: emptyRelatedCourse,
      header: { kind: "none", courses: [] },
    });
  });
});

const config = {
  babaUrl: "https://baba.test/latest",
  geminiApiKey: "gemini-key",
  notionToken: "notion-token",
  notionDatabaseId: "db",
  statsPeriodYears: 5,
  statsMinStarts: 30,
  broodmareMinStarts: 50,
  courseSummaryMinCount: 30,
  defaultModel: "gemini-flash-latest",
  accessTeamDomain: "https://team.cloudflareaccess.com",
  accessAud: "aud-tag",
  accessClientIdGrok: "grok-id",
  accessClientIdMuse: "muse-id",
};

function httpDeps(kv: MemoryKv): HttpDeps {
  return {
    config,
    kv,
    now: () => new Date("2026-11-08T06:00:00Z"),
    enqueue: async () => {},
    verifyJwt: async () => ({ common_name: "ignored" }),
    oauth: {
      async getStatus() {
        return { registered: true, authorized: true, needsReauth: false, expiresAt: null, lastError: null };
      },
      async beginAuthorization() {
        return { url: "https://mcp.example/authorize" };
      },
      async completeAuthorization() {
        return { ok: true };
      },
    },
  };
}

function authed(path: string): Request {
  return new Request(`https://worker.example${path}`, {
    headers: { "cf-access-jwt-assertion": "token", "cf-access-client-id": "grok-id" },
  });
}

function job(runId: string): JobState {
  return {
    runId,
    race,
    requestedBy: "Grok Bot",
    phase: "done",
    remarks: "",
    baba: null,
    raceRow: null,
    entries: [],
    formTasks: [],
    odds: null,
    courseVariant: null,
    statTasks: [],
    prediction: null,
    notionPageId: null,
    consistencyWarnings: [],
    updatedAt: "2026-11-08T07:00:00.000Z",
  };
}

const storedRelated: StoredRelatedCourses = {
  status: "ok",
  courses: [{ track: "東京", surface: "芝", distance: 2400 }],
  dropped: 0,
  line: "関連コース: 東京,芝,2400",
};

describe("GET /admin/jobs/input include=past_runs", () => {
  it("returns the stored snapshot and not the surrounding user text", async () => {
    const kv = new MemoryKv();
    const http = httpDeps(kv);
    await kv.put(keys.job(race.raceKey), JSON.stringify(job("run-current")));
    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-saved",
      umabashira: "馬柱BODY",
      raceInput: wrapped,
      horses: [],
      savedAt: "2026-11-08T01:02:03.000Z",
      pastRuns: "STORED_PAST_EXACT",
      courseRecords: course,
      relatedCourses: storedRelated,
    });
    const closed = await handleRequest(new Request(`https://worker.example/admin/jobs/input?race_key=${race.raceKey}&include=past_runs`), http);
    expect(closed.status).toBe(403);
    const missing = await handleRequest(authed("/admin/jobs/input?race_key=missing&include=past_runs"), http);
    expect(missing.status).toBe(404);
    const response = await handleRequest(authed(`/admin/jobs/input?race_key=${race.raceKey}&include=past_runs`), http);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      race_key: string;
      run_id: string;
      input_run_id: string;
      saved_at: string;
      past_runs: string;
      course_records: string;
      related_courses: StoredRelatedCourses;
      past_runs_source: string;
      course_records_source: string;
      related_courses_source: string;
      past_runs_error: string | null;
      past_runs_missing: { rows: number; note: string } | null;
      umabashira?: string;
      race_input?: string;
    };
    expect(body.race_key).toBe(race.raceKey);
    expect(body.run_id).toBe("run-current");
    expect(body.input_run_id).toBe("run-saved");
    expect(body.saved_at).toBe("2026-11-08T01:02:03.000Z");
    expect(body.past_runs).toBe("STORED_PAST_EXACT");
    expect(body.past_runs_missing).toEqual(describePastRunsMissing("STORED_PAST_EXACT"));
    expect(body.past_runs_missing?.rows).toBe(0);
    expect(body.past_runs_missing?.note).toContain("未出走");
    expect(body.course_records).toBe(course);
    expect(body.related_courses).toEqual({
      status: "ok",
      courses: [{ track: "東京", surface: "芝", distance: 2400 }],
      dropped: 0,
      line: "関連コース: 東京,芝,2400",
    });
    expect(body.past_runs_source).toBe("stored");
    expect(body.course_records_source).toBe("stored");
    expect(body.related_courses_source).toBe("stored");
    expect(body.past_runs_error).toBeNull();
    expect(body.umabashira).toBeUndefined();
    expect(body.race_input).toBeUndefined();
    const packed = JSON.stringify(body);
    expect(packed).not.toContain("DUMMY_PROMPT_LEAK_9f3a");
    expect(packed).not.toContain("DUMMY_USER_TAIL_9f3a");
    expect(packed).not.toContain("{{not_a_real_prompt}}");
    expect(packed).not.toContain("<<<");
    expect(packed).not.toContain("函館");
    expect(packed).not.toContain("馬柱BODY");
  });

  it("extracts an old snapshot that has no separate fields", async () => {
    const kv = new MemoryKv();
    const http = httpDeps(kv);
    await kv.put(keys.job(race.raceKey), JSON.stringify(job("run-old")));
    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-old",
      umabashira: "馬柱BODY",
      raceInput: wrapped,
      horses: [],
    });
    const response = await handleRequest(authed(`/admin/jobs/input?race_key=${race.raceKey}&include=past_runs`), http);
    const body = (await response.json()) as {
      past_runs: string;
      past_runs_missing: { rows: number; blank: Record<string, number>; note: string } | null;
      course_records: string;
      saved_at: string | null;
      input_run_id: string;
      past_runs_source: string;
      course_records_source: string;
      related_courses: { status: string; courses: Array<{ track: string }>; dropped: number | null; line: string };
      related_courses_error: string | null;
      race_input?: string;
    };
    expect(body.past_runs).toBe(past);
    expect(body.past_runs_missing).toEqual(describePastRunsMissing(past));
    expect(body.past_runs_missing?.blank["前半3F"]).toBe(1);
    expect(body.past_runs_missing?.blank["後半3F"]).toBe(1);
    expect(body.past_runs_missing?.blank["レース名"]).toBe(0);
    expect(body.past_runs_missing?.blank["着差"]).toBe(0);
    expect(body.course_records).toBe(course);
    expect(body.saved_at).toBeNull();
    expect(body.input_run_id).toBe("run-old");
    expect(body.past_runs_source).toBe("extracted");
    expect(body.course_records_source).toBe("extracted");
    expect(body.related_courses).toMatchObject({
      status: "ok",
      courses: [{ track: "東京", surface: "芝", distance: 2400 }],
      dropped: null,
      line: "関連コース: 東京,芝,2400",
    });
    expect(body.related_courses_error).toBeNull();
    expect(body.race_input).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("DUMMY_");
    expect(JSON.stringify(body)).not.toContain("<<<");
    expect(JSON.stringify(body)).not.toContain("函館");
  });

  it("keeps an unreadable related-course list null and keeps a real zero count", async () => {
    const kv = new MemoryKv();
    const http = httpDeps(kv);
    await kv.put(keys.job(race.raceKey), JSON.stringify(job("run-old")));
    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-old",
      umabashira: "馬柱",
      raceInput: `${past}\n\n${unreadableCourse}\n\n${PROMPT}`,
      horses: [],
    });
    const unread = await handleRequest(authed(`/admin/jobs/input?race_key=${race.raceKey}&include=past_runs`), http);
    const unreadBody = (await unread.json()) as {
      course_records: string;
      related_courses: { status: string; courses: unknown; line: string };
    };
    expect(unreadBody.course_records).toBe(unreadableCourse);
    expect(unreadBody.related_courses).toMatchObject({ status: "unreadable", courses: null, line: "関連コース: 一覧が読めないため空欄" });
    expect(JSON.stringify(unreadBody)).not.toContain("(0,0,0,0,0,0)");
    expect(JSON.stringify(unreadBody)).not.toContain("DUMMY_");

    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-old",
      umabashira: "馬柱",
      raceInput: `${past}\n\n${emptyRelatedCourse}`,
      horses: [],
    });
    const empty = await handleRequest(authed(`/admin/jobs/input?race_key=${race.raceKey}&include=past_runs`), http);
    const emptyBody = (await empty.json()) as {
      course_records: string;
      related_courses: { status: string; courses: unknown[] };
    };
    expect(emptyBody.course_records).toBe(emptyRelatedCourse);
    expect(emptyBody.related_courses).toMatchObject({ status: "ok", courses: [] });
    expect(emptyBody.course_records).toContain("(0,0,0,0,0,0)");
  });

  it("returns null and a reason when the old user text has no section", async () => {
    const kv = new MemoryKv();
    const http = httpDeps(kv);
    await kv.put(keys.job(race.raceKey), JSON.stringify(job("run-old")));
    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-old",
      umabashira: "馬柱",
      raceInput: PROMPT,
      horses: [],
    });
    const response = await handleRequest(authed(`/admin/jobs/input?race_key=${race.raceKey}&include=past_runs`), http);
    const body = (await response.json()) as {
      past_runs: null;
      past_runs_missing: null;
      course_records: null;
      related_courses: null;
      past_runs_error: string;
      course_records_error: string;
    };
    expect(body.past_runs).toBeNull();
    expect(body.past_runs_missing).toBeNull();
    expect(body.course_records).toBeNull();
    expect(body.related_courses).toBeNull();
    expect(body.past_runs_error).toBe("保存済みの入力に「# 過去走（近10走）」がありません");
    expect(body.course_records_error).toContain("コース成績");
    expect(JSON.stringify(body)).not.toContain("DUMMY_");
  });

  it("does not fall back to the user text when a stored chunk is missing", async () => {
    const kv = new MemoryKv();
    const http = httpDeps(kv);
    await kv.put(keys.job(race.raceKey), JSON.stringify(job("run-old")));
    await kv.put(
      keys.predictInput(race.raceKey),
      JSON.stringify({
        v: 1,
        runId: "run-old",
        truncated: false,
        umabashiraBytes: 1,
        raceInputBytes: wrapped.length,
        horses: [],
        umabashira: "馬柱",
        raceInput: wrapped,
        pastRunsChunks: 1,
        courseRecordsChunks: 1,
      }),
    );
    const response = await handleRequest(authed(`/admin/jobs/input?race_key=${race.raceKey}&include=past_runs`), http);
    const body = (await response.json()) as {
      past_runs: null;
      past_runs_missing: null;
      course_records: null;
      past_runs_error: string;
      course_records_error: string;
      incomplete: boolean;
    };
    expect(body.incomplete).toBe(true);
    expect(body.past_runs).toBeNull();
    expect(body.past_runs_missing).toBeNull();
    expect(body.course_records).toBeNull();
    expect(body.past_runs_error).toBe("近10走の分割を最後まで読めませんでした");
    expect(body.course_records_error).toBe("コース成績の分割を最後まで読めませんでした");
    expect(JSON.stringify(body)).not.toContain("DUMMY_");
    expect(JSON.stringify(body)).not.toContain("| 2026-10-12");
  });

  it("round-trips a long past-run field through chunks and drops the old chunks", async () => {
    const kv = new MemoryKv();
    const pastRuns = `近走${"あ".repeat(PREDICT_INPUT_CHUNK_CHARS)}`;
    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-chunk",
      umabashira: "馬柱",
      raceInput: "入力",
      horses: [],
      savedAt: "2026-11-08T01:02:03.000Z",
      pastRuns,
      courseRecords: course,
      relatedCourses: storedRelated,
    });
    const loaded = await loadPredictInput(kv, race.raceKey);
    expect(loaded?.pastRuns).toBe(pastRuns);
    expect(loaded?.courseRecords).toBe(course);
    expect(loaded?.savedAt).toBe("2026-11-08T01:02:03.000Z");
    expect(loaded?.pastRunsState).toBe("stored");
    expect(await kv.get(keys.predictInputChunk(race.raceKey, "p", 0))).toBeTruthy();
    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-chunk",
      umabashira: "馬柱",
      raceInput: "入力",
      horses: [],
      pastRuns: "短い",
      courseRecords: "短い",
    });
    expect(await kv.get(keys.predictInputChunk(race.raceKey, "p", 0))).toBeNull();
    expect(await kv.get(keys.predictInputChunk(race.raceKey, "c", 0))).toBeNull();
    const again = await loadPredictInput(kv, race.raceKey);
    expect(again?.pastRuns).toBe("短い");
    expect(again?.courseRecords).toBe("短い");
  });

  it("returns runner stats from the stored field or the old user text, and drops a fake heading", async () => {
    const stat = (starts: number, wins: number, top3: number): NameStat => ({
      kind: "ok",
      resolvedName: null,
      starts,
      wins,
      top3,
      reason: null,
      cacheable: true,
    });
    const rendered = renderRunnerStats({
      horses: [{ horseNumber: 1, horseName: "ア", sire: "父一", broodmareSire: "母父一", jockey: "騎手A" }],
      venue: "東京",
      surface: "芝",
      distance: 2500,
      period: { from: "2021-11-07", to: "2026-11-07" },
      periodYears: 5,
      dataThrough: "2026-11-03",
      scopes: ["jra_and_non_jra"],
      called: true,
      sires: new Map([["父一", stat(48, 8, 20)]]),
      broodmareSires: new Map([["母父一", { kind: "not_found", resolvedName: null, starts: null, wins: null, top3: null, reason: "名前が見つからない", cacheable: true }]]),
      jockeys: new Map([["騎手A", stat(4, 1, 2)]]),
      minCount: 30,
    }).text;
    expect(extractRunnerStats(`${PROMPT}\n\n${rendered}\n\n${TAIL}`)).toEqual({ text: rendered });
    const sided = renderRunnerStats({
      horses: [{ horseNumber: 1, horseName: "ア", sire: "父一", broodmareSire: "母父一", jockey: "騎手A" }],
      venue: "京都",
      surface: "芝",
      distance: 1600,
      period: { from: "2021-11-07", to: "2026-11-07" },
      periodYears: 5,
      dataThrough: "2026-11-03",
      scopes: ["jra_and_non_jra"],
      called: true,
      sires: new Map([["父一", stat(48, 8, 20)]]),
      broodmareSires: new Map([["母父一", stat(40, 4, 10)]]),
      jockeys: new Map([["騎手A", stat(40, 8, 15)]]),
      minCount: 30,
      courseSide: resolveCourseSide({ raw: "外", raceField: true, statsField: true, racesField: true }),
    }).text;
    expect(sided).toContain("回り: 外（この回りだけを集計。母数が少なくても内と外は混ぜない）");
    expect(extractRunnerStats(`${PROMPT}\n\n${sided}\n\n${TAIL}`)).toEqual({ text: sided });
    expect(JSON.stringify(extractRunnerStats(`${PROMPT}\n\n${rendered}\n\n${TAIL}`))).not.toContain("DUMMY_");
    const fake = extractRunnerStats(`${RUNNER_STATS_HEADING}\nDUMMY_PROMPT_LEAK_9f3a これは節ではありません`);
    expect(fake).toEqual({ reason: "保存済みの出走馬のコース成績の形が一致しないため返しません" });
    expect(JSON.stringify(fake)).not.toContain("DUMMY_");

    const kv = new MemoryKv();
    const http = httpDeps(kv);
    await kv.put(keys.job(race.raceKey), JSON.stringify(job("run-current")));
    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-saved",
      umabashira: "馬柱BODY",
      raceInput: `${PROMPT}\n\n${rendered}\n\n${TAIL}`,
      horses: [],
      savedAt: "2026-11-08T01:02:03.000Z",
      pastRuns: past,
      courseRecords: course,
      relatedCourses: storedRelated,
      runnerStats: rendered,
    });
    const stored = (await (await handleRequest(authed(`/admin/jobs/input?race_key=${race.raceKey}&include=past_runs`), http)).json()) as {
      runner_stats: string;
      runner_stats_source: string;
      runner_stats_error: string | null;
      race_input?: string;
    };
    expect(stored.runner_stats).toBe(rendered);
    expect(stored.runner_stats_source).toBe("stored");
    expect(stored.runner_stats_error).toBeNull();
    expect(stored.race_input).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("DUMMY_");

    await savePredictInput(kv, {
      raceKey: race.raceKey,
      runId: "run-old",
      umabashira: "馬柱",
      raceInput: `${PROMPT}\n\n${rendered}\n\n${TAIL}`,
      horses: [],
    });
    const extracted = (await (await handleRequest(authed(`/admin/jobs/input?race_key=${race.raceKey}&include=past_runs`), http)).json()) as {
      runner_stats: string;
      runner_stats_source: string;
    };
    expect(extracted.runner_stats).toBe(rendered);
    expect(extracted.runner_stats_source).toBe("extracted");
    expect(JSON.stringify(extracted)).not.toContain("DUMMY_");
  });
});
