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

- 伺服器是主球物理、碰撞、血量、能量、岩漿池、角鬥場與黑洞的權威來源。
- 角色選擇、傷害回報與重連皆由目前 Socket 連線驗證。
- `node_modules` 不納入版本控制。
