// OpenAI クライアントの生成（遅延初期化）。
import OpenAI from "openai";

let _openai = null;
export function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY が未設定です（.env を確認してください）");
  }
  _openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}
