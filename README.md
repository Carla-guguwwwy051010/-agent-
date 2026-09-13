# Folio — AI 用户反馈洞察 Agent

Folio 面向产品经理与用户运营，将上传的用户反馈整理为可追溯的主题、统计与 Agent 回答。重要结论可以回到数据库中的原始反馈 ID；示例数据与用户上传数据明确区分。本仓库为 **v0.1 Evaluation baseline**。

## 已实现功能

- CSV、TSV、XLSX、XLS、TXT 文件预览与字段映射；支持逐行粘贴文本。
- 清理空白反馈、按文本去重，记录导入／跳过／重复数；保留源文件、原始行号、稳定反馈 ID，以及无法解析的日期原值。
- SQLite 保存数据集、原始反馈、分析、主题成员、人工整理记录和模型调用用量。
- 首页统计、Top Issues、原文证据抽屉、反馈 ID 定位，以及主题改名、合并和移出列表。
- FastAPI 数据工具：`get_top_issues`、`get_cluster_detail`、`get_issue_trend`、`compare_versions`、`search_feedback`、`get_evidence`。查询均限定当前数据集。
- 模拟模型与 DeepSeek 模型通过同一服务接口使用。DeepSeek 密钥只在服务端读取；余额不足或密钥无效时回退模拟模式。
- [示例反馈](backend/sample_feedback.csv) 含 16 条虚构记录。示例主题采用固定演示归类，**不代表用户上传数据的正式模型分析**。

## 技术栈

前端：React 19、TypeScript、Vite。后端：Python 3.11+、FastAPI、SQLite。表格读取使用 openpyxl 和 xlrd；DeepSeek 请求使用 httpx。

## 本地启动

需要 Python 3.11+ 与 Node.js 20+。在仓库根目录分别启动两个终端：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

```powershell
cd frontend
npm ci
npm run dev
```

打开 [http://localhost:5173/](http://localhost:5173/)。首次使用会载入示例反馈；也可以上传自己的文件。API 健康检查：`http://localhost:8000/api/health`。数据库默认写在 `backend/folio.db`，该文件不入库。

## Netlify 部署与打包预览

仓库根目录的 `netlify.toml` 将构建目录设为 `frontend`，运行 `npm ci && npm run build`，只发布 `frontend/dist`。构建时将 JS/CSS 内联到 `dist/index.html`，因此这个构建文件可以直接打开并显示界面。`frontend/public/_redirects` 会复制到构建目录，供单页路由使用。当前前端是 **React + Vite**，并未使用 Vue Router。

Netlify 只托管前端静态文件。完整的上传、数据分析和 Agent 对话还需要单独部署 FastAPI，并为其提供持久化 SQLite 存储。在 Netlify 的环境变量中设置 `VITE_API_BASE_URL=https://你的后端域名`（不要附加 `/api`）；在后端环境变量中设置 `FOLIO_CORS_ORIGINS=https://my-agent-demo-233.netlify.app`。修改构建环境变量后重新部署。若未连接后端，页面仍可显示，但会提示分析服务不可用。DeepSeek API Key 只能放在后端环境变量中。

本地检查生产构建请运行 `cd frontend`、`npm run build`、`npm run preview`，再打开命令输出的 HTTP 地址。双击 `dist/index.html` 可以检查静态页面是否载入，但 `file://` 无法提供 API；GitHub 仓库中直接查看源码 `index.html` 也不是网站部署。
## 环境变量

复制 [backend/.env.example](backend/.env.example) 为 `backend/.env`。前端公开的后端地址示例见 [frontend/.env.example](frontend/.env.example)；可在 Netlify 构建环境中设置。两处 `.env` 均由 Git 忽略，切勿提交真实密钥。

| 变量 | 说明 |
| --- | --- |
| `MODEL_PROVIDER` | `auto` 自动选择；`mock` 强制模拟 |
| `DEEPSEEK_API_KEY` | DeepSeek 服务端密钥；留空时用模拟模式 |
| `DEEPSEEK_MODEL` | 模型名，默认 `deepseek-v4-flash` |
| `DEEPSEEK_BASE_URL` | API 地址，默认 `https://api.deepseek.com` |
| `DEEPSEEK_TIMEOUT` | 单次请求超时秒数 |
| `DEEPSEEK_RETRIES` | 可重试错误的重试次数 |
| `FOLIO_DB` | SQLite 文件路径 |
| `FOLIO_CORS_ORIGINS` | 允许访问后端的额外前端域名，多个域名用英文逗号分隔 |

服务端每 60 秒检查一次 DeepSeek 账号可用状态；恢复可用后刷新页面即可切换回真实模式。

## 统计口径与当前限制

- 负向占比 = 负向反馈条数 ÷ 有效反馈总数；提及频次不等于业务优先级。
- 没有有效日期时不提供增长趋势；少于两个有效版本时不提供版本比较。根因和业务影响只能作为待验证假设。
- V1 为单机 SQLite，无登录、租户隔离和并发任务队列；单次导入最多 10,000 行、20 MB。
- 模型分析可能需要人工复核。DeepSeek 部分批次失败会回退模拟分类并报告错误；尚无失败条目单独重跑界面。
- 当前支持主题级人工整理，尚无逐条反馈人工修正界面或完整趋势图。外部字体依赖网络。
- 不记录 API Key；模型调用日志只保存次数、耗时和 token 用量等元数据。

## 测试与后续 Evaluation

```powershell
cd backend
python -m pytest -q
cd ../frontend
npm run build
```

下一阶段建立带人工标注的评估集，分别测量字段映射与去重准确率、主题成员一致性、情绪分类一致率、Agent 引用 ID 的精确率、缺失日期／版本时的拒答率，以及 DeepSeek 与模拟模式的延迟和 token 用量。每次模型或提示词变更前后运行同一评估集，记录回归；本 baseline 不包含针对评估结果的 Prompt 优化。
