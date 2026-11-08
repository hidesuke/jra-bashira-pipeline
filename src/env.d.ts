// wrangler.jsonc の secrets.required は最初の deploy を止める
// （Worker が無いと secret を先に置けない）ので、ここだけ型を足す。
interface Env {
  GEMINI_API_KEY: string;
  NOTION_TOKEN: string;
  TOKEN_ENCRYPTION_KEY: string;
  // ダッシュボードの Secret。vars には置かない。
  ACCESS_AUD: string;
  // wrangler.jsonc の services。バインディングが無いテストとローカルでは未設定。
  BABA?: Fetcher;
  // 任意。未設定なら通知しない。値は Secret。ログに出さない。
  NOTIFY_WEBHOOK_URL?: string;
  NOTIFY_WEBHOOK_KEY?: string;
  // 平文。未設定なら Authorization（値は Bearer <NOTIFY_WEBHOOK_KEY>）。
  // Authorization 以外の名前なら、キーをそのヘッダーへそのまま入れる。
  NOTIFY_WEBHOOK_KEY_HEADER?: string;
}
