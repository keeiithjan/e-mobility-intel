# 電動微型移動情報工作台（MVP）

這是一個可在本機、GitHub Codespaces 與 GitHub Actions 運作的每日情報系統，追蹤：

- 電動輔助自行車（e-bike）趨勢、零組件、知識與技術
- 電動滑板車（e-scooter）趨勢、零組件、知識與技術
- 臺灣、歐盟與美國的法規／安全／召回更新
- 品牌新品與官方公告

每次執行會建立來源可追溯的日報、CSV、PPT 素材，以及可雙擊開啟的視覺化工作台。

## 每日輸出

執行後會產生 `daily-output\YYYY-MM-DD\`：

- `information_log.csv`：可直接匯入 Excel、Notion 或 Airtable 的資料表。
- `daily_brief.md`：每日摘要。
- `ppt_material.md`／`ppt_material.json`：可挑選進簡報的素材與來源網址。
- `run_report.json`：本次抓取與來源健康狀態。
- `資訊工作台.html`：位於專案根目錄；雙擊即可看卡片、分類篩選、PPT 候選與來源健康狀態。

每一筆資料均保留原始網址。請開啟原始來源後再作正式引用或對外發布。

## 本機操作 SOP

在專案根目錄執行：

```powershell
# 1. 第一次：確認畫面與輸出格式，不連網
node .\scripts\daily_intel.mjs --demo

# 2. 第一次正式使用：只建立基準，不把舊新聞當成今天的新情報
node .\scripts\daily_intel.mjs --baseline

# 3. 之後每天執行一次：只匯出新項目
node .\scripts\daily_intel.mjs

# 4. 開啟視覺工作台
Invoke-Item .\資訊工作台.html
```

要查看今天的輸出，將 `YYYY-MM-DD` 換成實際日期，例如：

```powershell
Invoke-Item .\daily-output\2026-08-05
```

## GitHub 遠端工作室

GitHub 私有 repository 是程式、設定與日報的唯一主版本；不要讓三台電腦同時各自執行抓取，否則 `state\seen_items.json` 容易發生版本衝突。建議由 GitHub Actions 每天執行一次，三台電腦只讀取、編輯設定或使用 Codespaces。

### 一次性發布（Windows）

先安裝並登入 GitHub CLI：

```powershell
winget install --id GitHub.cli
# 關閉後重新開啟 PowerShell，再執行：
gh auth login
```

登入時選擇 `GitHub.com`、`HTTPS`、`Login with a web browser`。接著，在此專案根目錄執行：

```powershell
git init
git branch -M main
git add .
git commit -m "Initial e-mobility intelligence workspace"
gh repo create e-mobility-intel --private --source=. --remote=origin --push
```

這會在你的 GitHub 帳號建立私有的 `e-mobility-intel` repository。若名稱已被使用，將最後一行的名稱換成別的即可。

### 從任一台電腦工作

```powershell
git clone https://github.com/<你的帳號>/e-mobility-intel.git
Set-Location .\e-mobility-intel
node .\scripts\daily_intel.mjs
```

或者直接在 GitHub repository 按 `Code` → `Codespaces` → `Create codespace on main`，可在瀏覽器中編輯與執行，不必先安裝 Node.js。Codespaces 是否免費及可用時數取決於你的 GitHub 方案。

### 自動日報

`.github/workflows/daily-intel.yml` 會在臺北時間約 08:15 自動執行（GitHub 排程可能延遲），第一天自動建立基準，之後只儲存新項目。它會自動提交 `daily-output`、`state` 與 `資訊工作台.html`。在 GitHub repository 的 `Actions` 分頁可查看執行紀錄。

### 公開網頁工作台（選用）

私有 repository 不代表 GitHub Pages 內容也私有；多數 GitHub 方案的 Pages 網址仍可被公開瀏覽。若日報不含任何內部情報，才可執行下列命令，並在 `Settings` → `Pages` 選擇 `GitHub Actions`：

```powershell
Copy-Item .\templates\github-pages.yml.example .\.github\workflows\publish-dashboard.yml
git add .github\workflows\publish-dashboard.yml
git commit -m "feat: publish dashboard to GitHub Pages"
git push
```

如果資料僅供內部使用，請保持此範例檔不啟用；改在任一台電腦 clone 後雙擊 `資訊工作台.html`，或在 Codespaces 執行 `python3 -m http.server 8000` 後使用 Ports 預覽。

## 資料與來源調整

修改 `config\sources.json`：

- `enabled`：是否抓取來源。
- `kind`：網頁請用 `web`；RSS／Atom 請用 `rss`。
- `region`：來源地區。
- `defaultCategory`：預設分類。
- `priority`：來源的初始優先級。

部分官網可能擋自動抓取或變更網址；請查看每日的 `run_report.json`，再更新對應來源網址或改用其 RSS／官方新聞頁。

## 同步原則

- GitHub：程式、來源設定、歷史日報、狀態檔與視覺工作台。
- OneDrive（可選）：PPT 與 Excel 的人工編修版本、圖片素材及大檔案。
- 機密資料（API key、帳密）絕不應放進 repository；請放在 `.env` 或 GitHub Secrets。
