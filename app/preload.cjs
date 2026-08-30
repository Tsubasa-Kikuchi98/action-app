// contextBridge で renderer に最小限の API だけを公開する。
// renderer は Node にも fs にも触れない（contextIsolation: true / nodeIntegration: false / sandbox: true）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trailer", {
  /** 起動時の既定値（ジョブ名・モック有無・工程一覧・ROOT）。 */
  defaults: () => ipcRenderer.invoke("app:defaults"),

  /** 完成した trailer.mp4 を持つ過去ジョブの一覧（新しい順）。 */
  jobs: () => ipcRenderer.invoke("app:jobs"),

  /** out/<job>/script.json を読む。 */
  script: (job) => ipcRenderer.invoke("app:script", job),

  /** エクスプローラで out/<job>/ を開く。 */
  openFolder: (job) => ipcRenderer.invoke("app:open-folder", job),

  /** 生成を開始する（同時に 1 本まで）。進捗は onEvent に流れる。 */
  generate: (opts) => ipcRenderer.invoke("app:generate", opts),

  /** 以後の工程を止める。 */
  cancel: () => ipcRenderer.invoke("app:cancel"),

  /** API キーの設定状態（値は末尾 4 文字だけ返る）。 */
  config: () => ipcRenderer.invoke("app:config"),

  /** API キーを保存する（userData/config.json。次の生成から有効）。 */
  saveConfig: (values) => ipcRenderer.invoke("app:config-save", values),

  /** 工程イベントの購読。戻り値を呼ぶと解除。 */
  onEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on("pipeline:event", h);
    return () => ipcRenderer.removeListener("pipeline:event", h);
  },
});
