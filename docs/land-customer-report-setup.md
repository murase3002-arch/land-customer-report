# 土地なし管理客 週次レポート セットアップ手順

毎週木曜日 9:00 JST に、Googleスプレッドシートのデータを分析して Gmail でレポートを送信します。

---

## 必要なもの

| 項目 | 用途 |
|------|------|
| Googleアカウント | スプレッドシートの作成・共有 |
| Google Cloud プロジェクト | Sheets APIの有効化、サービスアカウント作成 |
| Gmail（2段階認証ON） | アプリパスワードによる送信 |
| Anthropic API Key | Claude でのデータ分析（既存で使用中） |

---

## Step 1: Google Cloud プロジェクト設定

### 1-1. プロジェクト作成 / Sheets API 有効化

1. [Google Cloud Console](https://console.cloud.google.com/) を開く
2. 新しいプロジェクトを作成（または既存プロジェクトを使用）
3. 左メニュー「APIとサービス」→「ライブラリ」を開く
4. 「Google Sheets API」を検索して **有効にする**

### 1-2. サービスアカウント作成

1. 「APIとサービス」→「認証情報」→「認証情報を作成」→「サービスアカウント」
2. サービスアカウント名を入力（例: `land-report-bot`）→「作成して続行」
3. ロールは「閲覧者」で OK → 「完了」
4. 作成したサービスアカウントをクリック
5. 「キー」タブ → 「鍵を追加」→「新しい鍵を作成」→ **JSON** を選択してダウンロード

### 1-3. サービスアカウントキーをBase64エンコード

ダウンロードした JSON ファイルをBase64に変換します:

```bash
base64 -i your-service-account-key.json | tr -d '\n'
```

出力された文字列をコピーしておきます（GitHub Secretsに登録します）。

---

## Step 2: スプレッドシートの設定

### 2-1. スプレッドシートの準備

スプレッドシートに以下の列を作成してください（1行目はヘッダー）:

| A列 | B列 | C列 | D列 | E列 | F列 |
|-----|-----|-----|-----|-----|-----|
| 顧客名 | 最終接触日 | メモ・備考 | ステータス | 予算 | 探しているエリア |

**最終接触日の形式（どれでも対応）:**
- `2024/1/15`
- `2024-01-15`
- `2024年1月15日`

### 2-2. サービスアカウントに共有

1. スプレッドシートを開く
2. 右上の「共有」ボタンをクリック
3. サービスアカウントのメールアドレス（例: `land-report-bot@your-project.iam.gserviceaccount.com`）を追加
4. 権限は「閲覧者」で OK

### 2-3. スプレッドシートIDを確認

URLから ID を取得します:
```
https://docs.google.com/spreadsheets/d/★ここがID★/edit
```

---

## Step 3: 設定ファイルの更新

`configs/projects/land-customers.yml` を開いて以下を編集:

```yaml
spreadsheet:
  id: "コピーしたスプレッドシートID"  # ← 変更
  sheet_name: "シート1"               # ← タブ名が違う場合は変更

email:
  to: "送信先のメールアドレス@gmail.com"  # ← 変更
```

**列の順序が違う場合** は `columns` セクションも変更してください（A列=1, B列=2...）。

---

## Step 4: Gmail アプリパスワード取得

1. [Googleアカウント設定](https://myaccount.google.com/) → セキュリティ
2. 「2段階認証プロセス」を **ON** にする（まだの場合）
3. [アプリパスワード](https://myaccount.google.com/apppasswords) を開く
4. アプリ名（例: `land-report`）を入力 → 「作成」
5. 表示された **16桁のパスワード** をコピー（スペースなしで保存）

---

## Step 5: GitHub Secrets の登録

リポジトリの「Settings」→「Secrets and variables」→「Actions」に以下を追加:

| シークレット名 | 値 |
|---------------|-----|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Step 1-3 でBase64エンコードした文字列 |
| `GMAIL_USER` | 送信元 Gmail アドレス（例: `you@gmail.com`） |
| `GMAIL_APP_PASSWORD` | Step 4 で取得した16桁パスワード（スペースなし） |
| `LAND_REPORT_TO_EMAIL` | 送信先メールアドレス（同じでも別でも OK） |
| `ANTHROPIC_API_KEY` | （既存、すでに登録済みの場合は不要） |

---

## Step 6: 動作確認（手動実行）

1. GitHub リポジトリの「Actions」タブを開く
2. 「土地なし管理客 週次レポート」ワークフローを選択
3. 「Run workflow」ボタンで手動実行
4. ログを確認して `Done!` が出れば成功
5. 指定した Gmail にレポートが届いているか確認

---

## スケジュール

`毎週木曜日 9:00 JST` に自動送信されます。

ワークフローファイルで変更できます（`.github/workflows/weekly-land-report.yml`）:
```yaml
# cron: '分 時(UTC) 日 月 曜日(0=日,4=木)'
- cron: '0 0 * * 4'  # 木曜 9:00 JST = UTC 0:00
```

---

## トラブルシューティング

| エラー | 原因と対処 |
|--------|-----------|
| `GOOGLE_SERVICE_ACCOUNT_KEY is not set` | GitHub SecretにGoogleサービスアカウントキーを登録 |
| `スプレッドシートIDが設定されていません` | `land-customers.yml` の `id` を実際のIDに変更 |
| `Request had insufficient authentication scopes` | サービスアカウントのキーを再生成して再登録 |
| `The caller does not have permission` | スプレッドシートをサービスアカウントメールに共有しているか確認 |
| `Invalid login: 535-5.7.8` | Gmailのアプリパスワードが間違っているか、2段階認証がOFF |
| 接触日が認識されない | B列の日付形式を確認（YYYY/M/D, YYYY-MM-DD, YYYY年M月D日）|
