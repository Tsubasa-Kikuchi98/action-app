// TextGenerator ポートの実装: Responses API + Structured Outputs（json_schema / strict）。
import { getOpenAI } from "./client.mjs";

/**
 * @param {{model: string, system: string, user: string, schemaName: string, schema: object}} req
 * @returns {Promise<{text: string, usage: object, model: string}>}
 */
export async function createStructured({ model, system, user, schemaName, schema }) {
  const openai = getOpenAI();
  const resp = await openai.responses.create({
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
  });
  return { text: resp.output_text ?? "", usage: resp.usage, model, raw: resp };
}

export const textGenerator = { createStructured };
