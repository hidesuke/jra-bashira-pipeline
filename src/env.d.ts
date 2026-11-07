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
}
