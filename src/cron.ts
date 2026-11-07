/** cron を定義しても、時刻を決めるまではレースを積まない。 */
export function cronSkipReason(): string {
  return "開発モードは POST /run の 1 レースだけ。cron では何も積まない";
}
