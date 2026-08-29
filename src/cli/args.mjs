// CLI の共通引数パーサ。各コマンドはここで解析した値を usecase に渡すだけ。
//
// 共通フラグ: --force / --dry-run / --stills / --skip-script / --style=... / --job <name>
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));

  /** `--name` または `--name=value` を探す。 */
  const flag = (name) => flags.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));

  /** `--name=value` の value（`--name` だけなら ""、無ければ null）。 */
  const value = (name) => {
    const a = flag(name);
    if (!a) return null;
    return a.includes("=") ? a.slice(a.indexOf("=") + 1) : "";
  };

  return {
    argv,
    flags,
    positional,
    flag,
    value,
    has: (name) => argv.includes(`--${name}`),
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run"),
    stills: argv.includes("--stills"),
    skipScript: argv.includes("--skip-script"),
    /** 位置引数の i 番目（既定値つき）。 */
    at: (i, fallback) => positional[i] ?? fallback,
    /** ジョブ名: 最初の位置引数（既定 demo1）。 */
    job: positional[0] ?? "demo1",
  };
}
