# praxarch

一套用於 [Claude Code](https://claude.com/product/claude-code) 的多模型協調（orchestration）框架：
由前沿模型（frontier model）在主要工作階段（session）中負責規劃、派工與審查，較便宜的
角色型子代理（role-pinned subagent，haiku／sonnet／opus）則負責大量的執行工作——而且有 hook
機制**強制執行**這套派工政策，而不是單靠模型自行遵守。

本專案衍生自 [pilotfish](https://github.com/Nanako0129/pilotfish)（MIT 授權），其角色／政策／設定
三層架構被完整保留。praxarch 額外補上了 pilotfish 設計文件中明確列為「未來工作」的部分：
強制執行 hook、實測遙測（telemetry）、結構化（可機器檢查的）驗證、專案層級覆寫，以及
正式的平行分工（fan-out）模式。完整原理與和 pilotfish 的差異請見 [`docs/design.zh-TW.md`](docs/design.zh-TW.md)。

English version: [README.md](README.md)

## 你會得到什麼

- **六個角色型子代理**（`scout`、`Explore` 覆寫版、`mech-executor`、`executor`、`verifier`、
  `security-executor`），各自透過 frontmatter 綁定成本適當的模型層級；政策文字一律以角色名稱
  稱呼，絕不寫死模型 ID，因此整套機制在模型淘汰或更新時完全不受影響。
- **強制執行的 hook，而非僅止於政策文字**：
  - `route-guard` 會直接拒絕未指定明確 model 的臨時（ad-hoc）平行派工，以及帶有安全性質
    但未指派給 `security-executor` 的工作。
  - `verify-gate` 會在變更範圍達到「非瑣碎」門檻、且該工作階段沒有零重大／嚴重發現的
    `CONFIRMED` 驗證紀錄時，阻擋工作階段結束（附有逃生閥）。
  - `telemetry` 會把每一次派工記錄到 JSONL 檔案，包括 verifier 的結構化判定結果。
  - `session-init` 會在設定漂移或 `CLAUDE_CODE_SUBAGENT_MODEL` 衝突時發出警告。
- **結構化驗證**：verifier 角色必須輸出 JSON 判定區塊（`CONFIRMED`／`REFUTED` ＋發現清單），
  而非自由格式的文字，讓 gate 可以用程式化方式檢查。
- **遙測介面**：狀態列（status line）即時顯示當前工作階段的角色花費，並提供
  `praxarch report` CLI／`/praxarch-report` skill，統計歷史角色分布與 verifier 通過率。
- **專案層級覆寫**：任何專案下的 `.claude/praxarch.json` 都能針對該專案調整角色對模型的綁定、
  verify-gate 門檻與 route-guard 的嚴格程度。
- **`/fan-out` skill**：在多個獨立 git worktree 中平行執行完全可規格化的獨立工作項目，
  最後只對合併結果做一次驗證的標準模式。

## 安裝

需要 Node.js 與 [pnpm](https://pnpm.io)。

```sh
git clone git@github.com:IMAHiji/praxarch.git
cd praxarch
pnpm install
pnpm build
node dist/cli/index.js install
```

這個指令會先列出所有會在 `~/.claude/` 下新增或變更的檔案計畫——在你確認之前（或加上
`--yes` 供腳本化使用）不會寫入任何內容。任何會被覆寫的檔案都會先備份為
`<file>.praxarch-backup-<timestamp>`。如果你已經設定過 `model`／`fallbackModel`
（例如透過 `/model`），安裝程式**不會**覆寫，只有在該欄位空白時才會設定。

若想直接使用 `praxarch` 指令而非 `node dist/cli/index.js`：

```sh
pnpm link --global
praxarch install
```

想用不寫程式、純手動的安裝方式？參見 [`install/AGENT-INSTALL.md`](install/AGENT-INSTALL.md)——
把它貼進 Claude Code 工作階段，就能以人工方式走過相同的變更流程。

### 檢查安裝狀態

```sh
praxarch doctor
```

會回報哪些部分已正確接好，以及已安裝版本是否與目前程式庫一致。

### 解除安裝

```sh
praxarch uninstall
```

會移除 praxarch 的 hook 項目、角色／skill 檔案與 `~/.claude/praxarch/`，但不會動到
`model`／`fallbackModel`，備份檔也會保留。

## 使用方式

安裝完成後，就可以在主要工作階段中使用這六個角色進行派工——完整的派工協定
（完整規格、優先使用最便宜可行的角色、有限度的升級、安全性工作強制路由、完成前必須驗證）
寫在 praxarch 加入你全域 `CLAUDE.md` 的政策區塊中。隨時可執行 `/praxarch-report`
查看實際派工狀況與驗證通過率。當手上有三個以上獨立、可完整規格化的工作項目時，
可使用 `/fan-out` 平行處理。

## 專案層級設定

將 [`templates/project/praxarch.json`](templates/project/praxarch.json) 複製到
`<project>/.claude/praxarch.json`，再依需求調整其中的欄位——每個欄位都是選填的。
專案設定會覆寫全域的 `~/.claude/praxarch/config.json`，全域設定則覆寫內建預設值。

## 開發

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
```

Hook 與 CLI 的測試方式是對編譯後的輸出、在假的 `$HOME`／`PRAXARCH_HOME` 下執行子程序——
詳見 `src/**/*.test.ts`。所有測試都不會動到你真正的 `~/.claude/`。

## 授權

MIT 授權——詳見 [`LICENSE`](LICENSE)。角色／政策／設定的三層架構衍生自
[pilotfish](https://github.com/Nanako0129/pilotfish)（MIT 授權，Nanako0129）。
