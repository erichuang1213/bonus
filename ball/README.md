# Ball

雙人即時彈跳球對戰遊戲，使用 Express 與 Socket.IO。

## 啟動

```bash
npm install
npm start
```

預設開啟 `http://localhost:3000`。可用環境變數 `PORT` 調整連接埠，例如 Windows PowerShell：

```powershell
$env:PORT=3001; npm start
```

## 線上規則

- 在大廳輸入名稱、選擇英雄後才加入配對隊列；搜尋可隨時取消。
- 找到對手後有 30 秒讓雙方確認。只有兩人都確認，才進入戰場載入流程；有人退出或逾時時，已確認的一方會自動繼續搜尋。
- 伺服器是主球物理、碰撞、血量、能量、岩漿池、角鬥場與黑洞的權威來源。
- 角色選擇、傷害回報與重連皆由目前 Socket 連線驗證。
- `node_modules` 不納入版本控制。
