# 隨身書 book-reader

行動優先的 PWA 書架：把好幾本書裝進手機，離線閱讀、畫螢光筆、寫筆記、全文搜尋。

**線上網址**：https://jeremyl861225.github.io/book-reader/

## 特色

- **書架**：一台裝置放多本書，各自有目錄與閱讀進度
- **章節目錄**：依「章 → 節」自動歸類，記住上次閱讀位置
- **螢光筆**：長按選字即可標記，四種顏色，可附加筆記
- **筆記總覽**：集中查看整個書架的標記與筆記，點擊跳回原文
- **全文搜尋**：一次搜尋書架上所有書，點結果直接跳到該段落
- **書籍檔匯出／匯入**：把一本書連同螢光筆與筆記匯出成檔案，用 AirDrop 或雲端硬碟傳到另一台裝置接著讀
- **PDF 匯入**：在手機上直接選取章節 PDF，文字就地抽取
- **隱私**：內容只儲存在裝置的瀏覽器（IndexedDB），不上傳任何伺服器
- **離線可用**：Service Worker 快取，加入主畫面後如原生 app

## 使用方式

1. 用手機瀏覽器開啟上面的網址
2. **加入主畫面**：
   - iPhone（Safari）：分享按鈕 → 「加入主畫面」
   - Android（Chrome）：選單 → 「安裝應用程式」
3. 把書放進來，兩種方式：
   - **書籍檔**（推薦）：設定 → 書籍管理 → 「匯入書籍檔」，一次全選該書的所有 `.book.json`
   - **章節 PDF**：設定 → 加入內容 → 選好收進哪一本書 → 「匯入章節」，檔名建議 `第1章第2節 標題.pdf` 或 `1-2 標題.pdf`

> 建議定期到「設定 → 整機備份」匯出，清除瀏覽器資料會連同內容與筆記一起清掉。

## 書籍檔格式（`.book.json`）

一本書的完整封裝，內容＋螢光筆＋筆記都在裡面，可自行用任何方式搬運到別台裝置。
大書會拆成多份，每份預設上限 20 MB（避免手機解析過大的 JSON）；
同一本書的每一份 `book.key` 相同，app 匯入時會自動合併成一本。

```json
{
  "app": "book-reader-book",
  "version": 1,
  "book": { "key": "同一本書的識別碼", "title": "書名" },
  "part": 1, "parts": 13,
  "sections": [
    { "id": "…", "chapter": 3, "chapterTitle": "SECTION III - Endocrine Surgery",
      "section": 35, "title": "章節標題",
      "paras": ["段落字串", { "img": "data:image/jpeg;base64,…", "caption": "可選" }] }
  ],
  "highlights": [
    { "id": "…", "sectionId": "對應 sections[].id", "groupId": "…", "paraIdx": 4,
      "start": 0, "end": 32, "quote": "被標記的文字", "color": "yellow",
      "note": "筆記內容", "createdAt": 1754130000000 }
  ]
}
```

匯入時 app 會重新配發 `sections[].id`，並同步改寫 `highlights[].sectionId`，
所以不同裝置之間的 id 不會互相衝突。

要從書的 PDF 產生這個格式，用 `tools/convert.py` 轉成內容包，再用 `tools/make_book.py` 打包：

```bash
python3 tools/convert.py "<書的資料夾>" packs/
python3 tools/make_book.py packs/ "書名" out/
```

## 技術

純前端、零框架、無建置步驟：

- [pdf.js](https://mozilla.github.io/pdf.js/)（已 vendor，含 CJK cmaps）在裝置端抽取 PDF 文字
- IndexedDB 儲存書籍、章節與標記；localStorage 儲存偏好
- Service Worker 離線快取；GitHub Actions 自動部署到 GitHub Pages

## 開發

```bash
python3 -m http.server 8000
```

推送到 `main` 分支即自動部署。
