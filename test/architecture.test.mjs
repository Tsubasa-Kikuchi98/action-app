// 依存の向き（内向きのみ）を機械的に守るためのテスト。
// domain ← usecases ← adapters ← cli の順で、外側を import していないことを確かめる。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** dir 以下の .mjs を再帰で集める。 */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else if (e.name.endsWith(".mjs")) out.push(f);
  }
  return out;
}

/** そのファイルの import 文の指定子を返す。 */
function imports(file) {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(/^\s*import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["'];?\s*$/gm)].map((m) => m[1]);
}

const layerOf = (file) => {
  const r = path.relative(ROOT, file).replace(/\\/g, "/");
  if (r.startsWith("src/domain/")) return "domain";
  if (r.startsWith("src/usecases/")) return "usecases";
  if (r.startsWith("src/adapters/")) return "adapters";
  if (r.startsWith("src/cli/")) return "cli";
  return "other";
};

const files = walk(path.join(ROOT, "src"));

test("domain は外部依存（node 組み込み / SDK / dotenv）を一切 import しない", () => {
  for (const f of files.filter((f) => layerOf(f) === "domain")) {
    for (const spec of imports(f)) {
      assert.ok(
        spec.startsWith("."),
        `${path.relative(ROOT, f)} が外部モジュール "${spec}" を import している（domain は純粋であること）`
      );
    }
  }
});

test("domain は他の層を import しない", () => {
  for (const f of files.filter((f) => layerOf(f) === "domain")) {
    for (const spec of imports(f)) {
      const target = layerOf(path.resolve(path.dirname(f), spec));
      assert.equal(target, "domain", `${path.relative(ROOT, f)} → ${spec}`);
    }
  }
});

test("usecases は adapters / cli を import しない（ポート経由のみ）", () => {
  for (const f of files.filter((f) => layerOf(f) === "usecases")) {
    for (const spec of imports(f)) {
      if (!spec.startsWith(".")) {
        // node:path はパス文字列の計算だけで I/O を伴わないので許可する
        assert.equal(spec, "node:path", `${path.relative(ROOT, f)} が "${spec}" を import している`);
        continue;
      }
      const target = layerOf(path.resolve(path.dirname(f), spec));
      assert.ok(["domain", "usecases"].includes(target), `${path.relative(ROOT, f)} → ${spec}（${target}）`);
    }
  }
});

test("adapters は usecases / cli を import しない", () => {
  for (const f of files.filter((f) => layerOf(f) === "adapters")) {
    for (const spec of imports(f)) {
      if (!spec.startsWith(".")) continue;
      const target = layerOf(path.resolve(path.dirname(f), spec));
      assert.ok(["domain", "adapters"].includes(target), `${path.relative(ROOT, f)} → ${spec}（${target}）`);
    }
  }
});

test("scripts/*.mjs は src/cli を呼ぶだけの互換エントリ（実装を持たない）", () => {
  const dir = path.join(ROOT, "scripts");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".mjs") && n !== "gen-image.mjs")) {
    const src = fs.readFileSync(path.join(dir, name), "utf8");
    const code = src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"));
    assert.ok(code.length <= 3, `scripts/${name} が ${code.length} 行ある（互換エントリは 2 行）`);
    assert.ok(src.includes(`../src/cli/${name}`), `scripts/${name} が src/cli/${name} を呼んでいない`);
  }
});
