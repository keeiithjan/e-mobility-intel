# 電動微型移動情報工作台

每天由 GitHub Actions 收集 e-bike 與 e-scooter 的新品、技術元件、重大維修／軟體更新、法規與正式召回。首頁是精選情報，不是事故新聞牆。

## 現在的閱讀方式

- 首頁最多顯示 28 則精選；一則一列：縮圖、繁中短摘要與原文連結。
- 新品、技術元件與重大維修優先；首頁會保留各類別，不讓單一主題佔滿版面。
- 一般車禍、受傷與事故報導會排除；具有召回、火災風險或產品瑕疵等可執行安全資訊才保留。
- 所有通過篩選的紀錄仍保存於 `state/seen_items.json`（上限 240 筆），可供後續統計；首頁不顯示全部累積資料。
- PPT 候選只列高優先資料，可直接開原文取得圖片、規格與引用來源。

## 每日輸出

每次執行會建立 `daily-output/YYYY-MM-DD/`：

- `information_log.csv`：可開啟於 Excel，含原文、繁中標題／摘要、圖片網址、來源網址與引用格式。
- `daily_brief.md`：當日可讀的重點摘要。
- `ppt_material.md` 與 `ppt_material.json`：簡報素材索引。
- `run_report.json`：來源連線與擷取狀態。
- `資訊工作台.html`：可直接雙擊開啟的完整工作台；GitHub Pages 也使用此檔。

## 自然繁中摘要（建議啟用）

要把英文資訊整理成自然、簡短的繁中標題與摘要，請在 GitHub repository 設定一個 Secret。金鑰只存在 GitHub Actions，不會寫入程式碼、工作台或公開網頁。

1. GitHub 專案開啟 `Settings` → `Secrets and variables` → `Actions`。
2. 點 `New repository secret`。
3. Name 填入 `OPENAI_API_KEY`。
4. Value 貼上自己的 OpenAI API key，按 `Add secret`。
5. 到 `Actions` → `Daily e-mobility intelligence` → `Run workflow` 手動跑一次。

啟用後，系統會把每輪精選資料交給模型，以原文標題和摘要寫成 35–60 字的繁中短整理；不會補造規格、數字或結論。未設定 Secret 時，收集與網頁照常運作，但只顯示原文標題／摘要。

## GitHub Actions 與 GitHub Pages

- `Daily e-mobility intelligence` 是唯一每日抓取者，預定約臺北時間 08:15 執行（GitHub 排程可能有延遲）。其他電腦只需開啟 GitHub Pages 或 `git pull`，不需各自執行抓取。
- 若尚未建立 Pages 發布工作流程，執行：

```powershell
Copy-Item .\templates\github-pages.yml.example .\.github\workflows\publish-dashboard.yml
```

再到 GitHub `Settings` → `Pages`，將 Source 選成 `GitHub Actions`。公開網址是：

`https://keeiithjan.github.io/e-mobility-intel/`

## 本機測試（只在需要調整系統時）

```powershell
node .\scripts\daily_intel.mjs --demo
node .\scripts\daily_intel.mjs --baseline
Invoke-Item .\資訊工作台.html
```

日常不需要在每台電腦執行上述命令；讓 GitHub Actions 自動處理即可。
