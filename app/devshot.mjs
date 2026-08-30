// 開発時の自動操作＋スクリーンショット（TRAILER_SHOT_DIR が指定されたときだけ読み込まれる）。
// 「入力 → 生成 → 進捗 → 完成 → 再生」の一連を人手なしで通し、PNG を保存する。
// 製品機能ではなく検証用のヘルパなので、UI からは一切参照されない。
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EPISODE =
  process.env.TRAILER_SHOT_EPISODE ??
  "金曜の 22 時、本番リリースの直前に設定ファイルを 1 行だけ書き換えた。" +
    "デプロイした瞬間に全社の勤怠システムが落ちて、先輩と上司と 3 人で朝までロールバックを試し続けた。原因はカンマ 1 個だった。";

export function attach(win, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const f = path.join(dir, `${name}.png`);
    fs.writeFileSync(f, img.toPNG());
    console.log(`[devshot] ${f}`);
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  // renderer 側の console とエラーを main の標準出力に出す（原因追跡用）
  win.webContents.on("console-message", (e) => {
    console.log(`[renderer:${e.level ?? "?"}] ${e.message ?? ""}`);
  });
  win.webContents.on("preload-error", (_e, p, err) => {
    console.error(`[preload-error] ${p}: ${err?.stack ?? err}`);
  });

  win.webContents.once("did-finish-load", async () => {
    try {
      await sleep(1200);
      console.log(`[devshot] window.trailer = ${await js(`typeof window.trailer`)}`);
      await js(`(() => {
        const t = document.getElementById("episode");
        t.value = ${JSON.stringify(EPISODE)};
        document.getElementById("style").value = ${JSON.stringify(process.env.TRAILER_SHOT_STYLE ?? "nolan")};
        document.getElementById("job").value = ${JSON.stringify(process.env.TRAILER_SHOT_JOB ?? "mockdemo")};
        return true;
      })()`);
      await shot("01-input");

      await js(`document.getElementById("go").click(), true`);
      // TRAILER_SHOT_CANCEL_MS が指定されていれば「中止」も自動で押す
      if (process.env.TRAILER_SHOT_CANCEL_MS) {
        await sleep(Number(process.env.TRAILER_SHOT_CANCEL_MS));
        await js(`document.getElementById("stop").click(), true`);
      }
      await sleep(6000);
      await js(`(() => { document.getElementById("logBox").open = true; return true; })()`);
      await sleep(400);
      await shot("02-progress");

      // 完成 / 失敗 / 中止のいずれかになるまで待つ
      const deadline = Date.now() + Number(process.env.TRAILER_SHOT_TIMEOUT_SEC ?? 420) * 1000;
      let status = "";
      while (Date.now() < deadline) {
        await sleep(2000);
        status = await js(`document.getElementById("status").textContent`);
        if (/^(完成|失敗|中止)/.test(status)) break;
      }
      await sleep(1500);
      await js(`(() => { document.getElementById("logBox").open = false; return true; })()`);
      await shot("03-done");

      // 再生できることを確かめる（2 秒だけ再生してからコマを撮る）
      const played = await js(`(async () => {
        const v = document.getElementById("player");
        if (!v || !v.src) return "no video";
        try { await v.play(); } catch (e) { return "play error: " + e.message; }
        await new Promise((r) => setTimeout(r, 2200));
        v.pause();
        return JSON.stringify({ src: v.src, duration: v.duration, currentTime: v.currentTime,
                                w: v.videoWidth, h: v.videoHeight, error: v.error && v.error.code });
      })()`);
      console.log(`[devshot] status=${status}`);
      console.log(`[devshot] video=${played}`);
      await shot("04-playing");

      // 履歴からの再生（クリック経路）も 1 枚撮る
      await js(`(() => { const li = document.querySelector("#jobs li:not(.empty)"); if (li) li.click(); return true; })()`);
      await sleep(1500);
      await shot("05-history");

      fs.writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({ status, video: played }, null, 2),
        "utf8"
      );
    } catch (e) {
      console.error(`[devshot] 失敗: ${e?.stack ?? e}`);
      try { await shot("99-error"); } catch { /* 撮れなければ諦める */ }
    } finally {
      if (process.env.TRAILER_SHOT_KEEP !== "1") {
        setTimeout(() => app.quit(), 500);
      }
    }
  });
}
