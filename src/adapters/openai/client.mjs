// OpenAI クライアントの生成（遅延初期化）。
import OpenAI from "openai";

// クライアントはキーごとにキャッシュする（デスクトップアプリの設定画面で
// キーを変えたとき、再起動なしで次の生成から反映されるようにするため）。
let _openai = null;
let _key = "";
export function getOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY が未設定です（.env または設定画面を確認してください）");
  }
  if (!_openai || _key !== key) {
    _openai = new OpenAI({ apiKey: key });
    _key = key;
  }
  return _openai;
}
