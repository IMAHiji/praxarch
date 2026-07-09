# 設計原理

English version: [design.md](design.md)

## 出發點：pilotfish

[pilotfish](https://github.com/Nanako0129/pilotfish) 建立了 praxarch 沿用的整體架構：

1. **設定層**（`~/.claude/settings.json`）——模型別名（`best`）與 fallback 鏈，
   讓設定不需修改就能撐過模型淘汰。
2. **角色層**（`~/.claude/agents/*.md`）——六個角色，各自透過 frontmatter
   綁定成本適當的模型層級：`scout`（偵查）、`Explore`（內建 agent 的覆寫版，
   否則內建版本會悄悄繼承主要工作階段的模型）、`mech-executor`（完全規格化的機械式工作）、
   `executor`（需要判斷力的工作）、`verifier`（全新脈絡下的對抗式審查）、
   `security-executor`（身分驗證／機密／加密相關工作，刻意不交給前沿模型處理，
   避免其安全分類器誤判並拒絕合理的防禦性安全工作）。
3. **政策層**（`~/.claude/CLAUDE.md`）——派工規則完全以角色名稱撰寫，絕不寫死模型 ID，
   讓角色與模型的綁定可以在底層更動，而政策文字完全不用改。

pilotfish 自己的設計文件相當坦誠地說明了刻意省略的部分：專案層級設定、強制執行 hook、
固定模型 ID，理由是「先讓純政策方式運作；若紀律鬆散，機制化是文件記載的下一步」。
這正是 praxarch 的切入點：把 pilotfish 點名但沒有動手做的機制建出來，同時保留原本
已經運作良好的部分。

## praxarch 新增了什麼，以及為什麼

### 強制執行的 hook，而非僅止於政策文字

政策文字寫起來容易，但在壓力下也容易被忽略——一段很長的工作階段、一個不耐煩的使用者、
或模型自己判斷「這次規則不適用」。praxarch 接上四個 Claude Code hook，
針對最值得機制化的兩條規則做檢查：

- **`route-guard`**（Agent 工具的 PreToolUse）會直接拒絕兩種特定失誤：
  臨時（ad-hoc）平行派工卻沒有指定明確的 `model`（否則會悄悄繼承主要工作階段的模型，
  往往是前沿等級）；以及看起來帶有安全性質（關鍵字比對）卻沒有派給 `security-executor`
  的工作。這兩項檢查刻意設計得很窄——「這是不是一個好的派工決定」這種廣泛判斷仍留給
  政策層處理，而非 hook，因為那種判斷需要關鍵字比對無法掌握的脈絡。
- **`verify-gate`**（Stop）會在工作目錄變更量達到「非瑣碎」門檻（門檻可設定）、
  且該工作階段沒有零重大／嚴重發現的 `CONFIRMED` 驗證紀錄時，阻擋工作階段結束。
  刻意保留兩個逃生閥——`PRAXARCH_SKIP_VERIFY=1` 與在最終訊息中明確寫出
  `PRAXARCH_VERIFY_WAIVED: <原因>`——因為完全沒有逃生閥的硬性關卡，
  最終會變成使用者對它說謊來繞過，這比沒有關卡還糟。
- **`telemetry`**（PostToolUse）與 **`session-init`**（SessionStart）不做任何強制執行，
  只負責觀察與警告。強制執行只用在「未被強制執行的違規」比「偶爾誤擋一次」
  後果更嚴重的那兩條規則上。

每一個具強制力的 hook 在自身發生內部錯誤時都會「失效開放」（fail open）——
route-guard 的臭蟲絕對不能讓工作階段卡在「任何 Agent 呼叫都無法成功」的狀態。

### 結構化驗證

pilotfish 的 verifier 回傳自由格式的 CONFIRMED／REFUTED 文字。這對人類閱讀逐字稿沒問題，
但無法用程式化方式檢查——「講出聽起來像 CONFIRMED 的話」跟「真的確認過」是兩回事。
praxarch 的 verifier 角色被要求在回覆結尾一定要附上一段 JSON 區塊：

```json
{ "verdict": "CONFIRMED", "findings": [] }
```

`telemetry` 會從工具輸出中解析出這段內容，一方面存入該工作階段的狀態（供 `verify-gate`
立即檢查），另一方面附加到 JSONL 紀錄檔（供 `praxarch report` 統計歷史通過率）。
判定結果是**推導**出來的，不是單純採信欄位本身：只有零 `critical`／`major` 發現時才算
`CONFIRMED`，無論 `verdict` 欄位本身寫了什麼——這是為了防範 verifier 出於習慣寫下
「CONFIRMED」卻同時列出重大發現的情況。

### 遙測：實測，而非宣稱

pilotfish 引用了基準測試數據（例如「Sonnet 執行者達到全 Fable 效能的 96%，
成本卻只要 46%」）作為分層派工的預期回報，但工具本身並不會量測*你實際的*角色分布
或省下多少成本。praxarch 的 `telemetry` hook 會把每一次派工（角色、模型、時間戳記、
有適用時的 verifier 判定）記錄到每月的 JSONL 檔案；狀態列即時顯示當前工作階段的計數，
`praxarch report` 則統計歷史的角色分布與 verifier 通過率。

**刻意不宣稱的部分**：「派工對比本地處理的比例」或「升級頻率」。這兩項都需要觀察
主要工作階段本身的直接工作內容，並將多次派工判斷為同一任務的重試——這些都不是
掛在 Agent 工具上的 PostToolUse hook 所能看見的。`/praxarch-report` skill 的早期草稿
曾經承諾過這兩項數據；在確認實際遙測結構無法誠實算出後已經修正。回報一個
「看起來像量測出來、實際上是用猜的」數字，比乾脆不回報還糟。

**相關的已知限制**：根據撰寫本專案時對照 hook 文件確認的結果，Claude Code 的
PostToolUse hook 並不會提供子代理執行的 token 用量或耗時。派工紀錄僅包含
角色／模型／結果，不含成本數字。若 Claude Code 未來在此 hook 提供用量資料，
應該擴充 schema，而不是用猜測去湊。

### 專案層級覆寫

pilotfish 刻意只做全域設定，理由是實際稽核多個專案後發現沒有任何專案層級的模型政策。
praxarch 加了一個範圍很窄、選用性的覆寫介面——`.claude/praxarch.json`——只針對
一個專案真正可能需要調整的三件事：角色對模型的綁定、verify-gate 門檻
（文件為主的專案跟 monorepo 對「非瑣碎」的定義本來就不同）、以及 route-guard
的嚴格程度／額外安全關鍵字。它不會重複政策層的內容——派工*規則*仍然寫在 CLAUDE.md，
依 Claude Code 原生的專案／全域記憶機制疊加；`praxarch.json` 只調整 hook 的門檻。

### 平行分工（fan-out）

這部分不需要新機制——Claude Code 的 Agent 工具本身就支援 `isolation: "worktree"`。
真正缺的是一套有名字的模式：什麼時候值得付出分工的協調成本（三個以上獨立、
可完整規格化的工作項目）、如何標記整批工作供遙測使用
（在每次呼叫的 description 中加上 `[fanout:<batch-id>]`）、
以及「一批分工只做一次合併結果的驗證，而非每個工作者各驗證一次」的規則。
這被寫成 `/fan-out` skill 而非 hook，因為「這是不是真的獨立工作」是 hook
無法安全判斷的事，需要人（或模型）的判斷力。

## 已知限制

- **沒有 token／成本遙測**（見上文）——記錄的資料僅為角色／模型／結果。
- **報表指標刻意比 pilotfish 宣稱的範圍窄**——只有角色分布與 verifier 通過率，
  沒有節省成本百分比或升級頻率。
- **`verify-gate` 的變更量門檻只是一個代理指標，不是語意判斷**——
  純格式調整造成的大量變更可能誤觸（可用 `ignorePatterns` 與逃生閥緩解）；
  變更量小但行為影響重大的修改則可能低於門檻（政策層仍會要求驗證，
  不完全依賴 gate 強制執行）。
- **`route-guard` 的安全關鍵字比對是相對粗略的機制**——
  文字中恰好提到某個關鍵字但實際上與安全性無關的工作可能誤判；
  若某個程式庫覺得這樣太吵，可在該專案的 `praxarch.json` 中設定 `strict: false`，
  把拒絕降級為警告。
