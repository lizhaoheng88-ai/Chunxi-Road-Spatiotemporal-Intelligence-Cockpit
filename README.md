# 春熙路多模态时空智能平台

> "智融数聚·城行脉析"——多源多模态大数据融合驱动的城市活动特征识别与智能规划决策研究

## 本地运行

```bash
# 1. 构建数据包（首次或数据更新后）
python scripts/build_dashboard_data.py

# 2. 启动服务
node server.js

# 3. 打开浏览器
http://127.0.0.1:4173
```

如需启用 AI 在线问答和联网搜索：

```bash
set QWEN_API_KEY=你的通义千问Key
set TAVILY_API_KEY=你的TavilyKey
node server.js
```

## 公网部署（Render）

1. 推送到 GitHub
2. 在 Render 创建 Blueprint 部署，指向此仓库
3. Render 会自动检测 `render.yaml` 并创建服务
4. 在 Render 后台 **Environment** 中添加：
   - `QWEN_API_KEY`：通义千问 DashScope API Key
   - `TAVILY_API_KEY`：Tavily 搜索 API Key
5. 部署完成后获得公网 URL，用户可直接使用 AI 问答

### Docker 手动部署

```bash
docker build -t chunxi-dashboard .
docker run -p 4173:4173 \
  -e QWEN_API_KEY=你的Key \
  -e TAVILY_API_KEY=你的Key \
  chunxi-dashboard
```

## 功能

- **AI 规划问答**：首页极简对话界面，支持自然语言提问春熙路商圈任意问题
- **智能地名解析**：本地匹配 → LLM 解析 → Tavily 联网验证，三级递进
- **联网搜索**：政策、新闻等实时问题自动触发 Tavily 搜索，结合本地数据回答
- **决策证据工作台**：105 个网格诊断卡 + 4 个片区卡 + 供需偏差地图
- **数据总览**：手机信令、视频观测、路网地铁、社会感知、预测结果可视化

## AI 问答模式

| 模式 | 环境变量 | 说明 |
|------|---------|------|
| 本地证据 | 无需配置 | 始终可用，基于结构化证据库回答 |
| 通义千问 | `QWEN_API_KEY` 或 `DASHSCOPE_API_KEY` | 推荐，中文效果好 |
| OpenAI | `OPENAI_API_KEY` | 可选 |
| 豆包 | `DOUBAO_API_KEY` 或 `ARK_API_KEY` | 可选 |
| 联网搜索 | `TAVILY_API_KEY` | 政策/新闻类问题自动触发 |

未配置的模式会自动回退到本地证据模式。

## 文件结构

```
frontend/
├── server.js                # Node.js HTTP 服务 + API 路由
├── lib/
│   ├── chat-assistant.js    # AI 聊天核心（地名解析 + 证据检索 + LLM）
│   ├── provider-client.js   # LLM 多模型适配（Qwen/OpenAI/Doubao）
│   ├── recommendation-engine.js  # 结构化建议生成
│   ├── place-registry.js    # 地名 → 网格映射
│   └── web-search.js        # Tavily 联网搜索
├── public/
│   ├── index.html           # 公众版首页
│   ├── app.js               # 前端交互（地图、图表、问答）
│   ├── styles.css           # 样式
│   └── data/                # 预构建数据包
│       ├── dashboard-data.json
│       ├── decision-support.json
│       ├── decision-graph.json
│       ├── knowledge-base.json
│       └── recommendation-cache.json
├── scripts/                 # 数据构建脚本
├── Dockerfile               # 容器部署
├── render.yaml              # Render 部署配置
└── package.json
```

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/healthz` | GET | 健康检查 |
| `/api/dashboard` | GET | 仪表盘数据 |
| `/api/decision-support` | GET | 决策证据库 |
| `/api/chat` | POST | AI 问答 |
| `/api/decision/recommend` | POST | 网格/片区建议 |
