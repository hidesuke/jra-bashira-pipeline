/** Cloudflare cron。UTC 7:45 は日本時間 16:45。曜日は 1=日曜なので、金・土は FRI,SAT。 */
export const NEXT_DAY_BATCH_CRON = "45 7 * * FRI,SAT";
