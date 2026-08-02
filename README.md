# 隨身書 book-reader

行動優先的 PWA 閱讀器：把整本書（各章節 PDF）裝進手機，離線閱讀、畫螢光筆、寫筆記、全文搜尋。

**線上網址**：https://jeremyl861225.github.io/book-reader/

## 特色

- 📖 **章節目錄**：依「章 → 節」自動歸類，記住上次閱讀位置
- 🖍 **螢光筆**：長按選字即可標記，四種顏色，可附加筆記
- 🗂 **筆記總覽**：集中查看所有標記與筆記，點擊跳回原文
- 🔍 **全文搜尋**：搜尋全書內文，點結果直接跳到該段落
- 📥 **PDF 匯入**：在手機上直接選取章節 PDF，文字就地抽取
- 🔒 **隱私**：書的內容只儲存在裝置的瀏覽器（IndexedDB），不上傳任何伺服器
- 📴 **離線可用**：Service Worker 快取，加入主畫面後如原生 app

## 使用方式

1. 用手機瀏覽器開啟上面的網址
2. **加入主畫面**：
   - iPhone（Safari）：分享按鈕 → 「加入主畫面」
   - Android（Chrome）：選單 → 「安裝應用程式」
3. 進入「設定」→「匯入章節 PDF」，一次選取多個檔案
4. 檔名建議格式：`第1章第2節 標題.pdf` 或 `1-2 標題.pdf`，會自動依編號歸類排序

> 💡 建議定期到「設定 → 匯出資料」備份，清除瀏覽器資料會連同內容與筆記一起清掉。

## 技術

純前端、零框架、無建置步驟：

- [pdf.js](https://mozilla.github.io/pdf.js/)（已 vendor，含 CJK cmaps）在裝置端抽取 PDF 文字
- IndexedDB 儲存章節內容與標記；localStorage 儲存偏好
- Service Worker 離線快取；GitHub Actions 自動部署到 GitHub Pages

## 開發

```bash
# 本地預覽（任一靜態伺服器皆可）
python3 -m http.server 8000
# 開 http://localhost:8000
```

推送到 `main` 分支即自動部署。
