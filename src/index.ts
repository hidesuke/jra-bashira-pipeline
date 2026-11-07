import { accessJwks, verifyAccessJwt } from "./access";
import { BUILD_COMMIT } from "./build-info";
import { cronSkipReason } from "./cron";
import { BashiraAuth } from "./bashira/auth-do";
import { handleRequest, type HttpDeps } from "./http";
import { handleJobMessage, type AppConfig, type PipelineDeps } from "./pipeline";
import { QUEUE_MAX_RETRIES, type JobMessage } from "./types";

export { BashiraAuth };

function appConfig(env: Env): AppConfig {
  return {
    babaUrl: env.BABA_URL,
    geminiApiKey: env.GEMINI_API_KEY,
    notionToken: env.NOTION_TOKEN,
    notionDatabaseId: env.NOTION_DATABASE_ID,
    statsPeriodYears: positiveInt(env.STATS_PERIOD_YEARS, "STATS_PERIOD_YEARS"),
    statsMinStarts: positiveInt(env.STATS_MIN_STARTS, "STATS_MIN_STARTS"),
    broodmareMinStarts: positiveInt(env.STATS_BROODMARE_SIRE_MIN_STARTS, "STATS_BROODMARE_SIRE_MIN_STARTS"),
    defaultModel: env.DEFAULT_MODEL,
  };
}

function httpDeps(env: Env): HttpDeps {
  const config = {
    ...appConfig(env),
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN,
    accessAud: env.ACCESS_AUD,
    accessClientIdGrok: env.ACCESS_CLIENT_ID_GROK,
    accessClientIdMuse: env.ACCESS_CLIENT_ID_MUSE,
  };
  const stub = env.BASHIRA_AUTH.getByName("bashira");
  return {
    config,
    kv: env.APP_KV,
    enqueue: async (message) => {
      await env.RACE_QUEUE.send(message);
    },
    now: () => new Date(),
    version: {
      id: env.CF_VERSION_METADATA.id,
      tag: env.CF_VERSION_METADATA.tag,
      timestamp: env.CF_VERSION_METADATA.timestamp,
    },
    buildCommit: BUILD_COMMIT,
    verifyJwt: (token) =>
      verifyAccessJwt(token, {
        issuer: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_AUD,
        key: accessJwks(env.ACCESS_TEAM_DOMAIN),
      }),
    oauth: stub,
  };
}

function pipelineDeps(env: Env): PipelineDeps {
  const stub = env.BASHIRA_AUTH.getByName("bashira");
  return {
    kv: env.APP_KV,
    config: appConfig(env),
    bashira: stub,
    enqueue: async (message) => {
      await env.RACE_QUEUE.send(message);
    },
    now: () => new Date(),
    log: (event, fields) => {
      console.log(JSON.stringify({ event, ...fields }));
    },
  };
}

function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} は正の整数である必要があります`);
  }
  return parsed;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, httpDeps(env));
  },
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const deps = pipelineDeps(env);
    for (const message of batch.messages) {
      const decision = await handleJobMessage(message.body as JobMessage, deps, {
        attempt: message.attempts,
        maxRetries: QUEUE_MAX_RETRIES,
      });
      if (decision === "retry") message.retry();
      else message.ack();
    }
  },
  async scheduled(): Promise<void> {
    // cron を後から有効にしても、時刻を決めるまではレースを積まない。
    console.log(JSON.stringify({ event: "cron_skipped", reason: cronSkipReason() }));
  },
} satisfies ExportedHandler<Env>;
