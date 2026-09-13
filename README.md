# Folio — AI 用户反馈洞察 Agent

Folio 面向产品经理与用户运营，将上传的用户反馈整理为可追溯的主题、统计与 Agent 回答。重要结论可以回到数据库中的原始反馈 ID；示例数据与用户上传数据明确区分。本仓库为 **v0.1 Evaluation baseline**。

## 已实现功能

- CSV、TSV、XLSX、XLS、TXT 文件预览与字段映射；支持逐行粘贴文本。
- 清理空白反馈、按文本去重，记录导入／跳过／重复数；保留源文件、原始行号、稳定反馈 ID，以及无法解析的日期原值。
- SQLite 保存数据集、原始反馈、分析、主题成员、人工整理记录和模型调用用量。
- 首页统计、Top Issues、原文证据抽屉、反馈 ID 定位，以及主题改名、合并和移出列表。
- FastAPI 数据工具：`get_top_issues`、`get_cluster_detail`、`get_issue_trend`、`compare_versions`、`search_feedback`、`get_evidence`。查询均限定当前数据集。
- 模拟模型与 DeepSeek 模型通过同一服务接口使用。DeepSeek 密钥只在服务端读取；余额不足或密钥无效时回退模拟模式。
- 线上浏览器内模拟聊天支持快捷提问、历史保存和清空会话；不执行反馈分析。
- [示例反馈](backend/sample_feedback.csv) 含 16 条虚构记录。示例主题采用固定演示归类，**不代表用户上传数据的正式模型分析**。

## 技术栈

前端：React 19、TypeScript、Vite。完整分析后端：Python 3.11+、FastAPI、SQLite；线上模拟聊天：浏览器 `localStorage`。表格读取使用 openpyxl 和 xlrd；DeepSeek 请求使用 httpx。

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

## 线上纯前端模拟对话与本地真实分析

[Netlify 页面](https://my-agent-demo-233.netlify.app/) 在生产构建中提供**浏览器内模拟 Agent**，无需 Worker、D1 或其他后端。用户可直接输入问题或点击快捷提问，获得针对反馈分析方法的模拟回复；历史消息保存在当前浏览器的 `localStorage`，刷新后仍在，“清空会话”会清除此浏览器的演示记录。模拟回复不读取上传文件，也不生成数量、趋势、根因或证据 ID 等真实数据结论。线上演示隐藏上传与洞察模块，以免将不可用功能误呈现为已上线。

本地 `npm run dev` 保留 FastAPI 数据集 Agent 和 DeepSeek 的真实分析流程，需要先启动后端。若以后要在线上开放上传、字段解析、统计和有证据的 Agent 回答，仍需部署完整后端并配置 `VITE_API_BASE_URL`。仓库的 [worker/worker.js](worker/worker.js) 是此前 D1 聊天原型，当前 Netlify 前端**不调用它**。

本地检查生产构建：`cd frontend`，执行 `npm run build` 和 `npm run preview`。由于是单文件构建，双击 `dist/index.html` 也应能显示模拟对话；GitHub 仓库中的 `frontend/index.html` 是源码入口，不是构建成品。

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
| `FOLIO_ACCESS_TOKEN` | 公网 API 共享访问口令；本地留空时不要求口令 |

服务端每 60 秒检查一次 DeepSeek 账号可用状态；恢复可用后刷新页面即可切换回真实模式。

## 统计口径与当前限制

- 负向占比 = 负向反馈条数 ÷ 有效反馈总数；提及频次不等于业务优先级。
- 没有有效日期时不提供增长趋势；少于两个有效版本时不提供版本比较。根因和业务影响只能作为待验证假设。
- V1 为单机 SQLite，只有共享访问口令，无个人账户、租户隔离和并发任务队列；单次导入最多 10,000 行、20 MB。
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

此前 D1 Worker 原型测试：`node --test worker/worker.test.mjs`；当前线上演示不使用 Worker。

下一阶段建立带人工标注的评估集，分别测量字段映射与去重准确率、主题成员一致性、情绪分类一致率、Agent 引用 ID 的精确率、缺失日期／版本时的拒答率，以及 DeepSeek 与模拟模式的延迟和 token 用量。每次模型或提示词变更前后运行同一评估集，记录回归；本 baseline 不包含针对评估结果的 Prompt 优化。
