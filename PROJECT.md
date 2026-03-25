# Interior Design Gen

AI 室内设计家具摆放工具。上传一张室内照片 + 最多 4 张家具图片，由 AI 自动将家具自然融合进房间。

---

## 项目信息

| 项目 | 内容 |
|------|------|
| **本地路径** | `C:\Users\Lenovo\Dropbox\Github\interior-design-gen` |
| **GitHub 仓库** | https://github.com/yosign/interior-design-gen |
| **分支** | `master` |
| **创建时间** | 2026-03-25 |
| **Tech Stack** | Next.js 16 · TypeScript · Tailwind CSS · shadcn/ui |

---

## 功能说明

- **室内照片上传**：1 张，16:10 比例展示，拖拽或点击上传
- **家具图片上传**：1–4 张，1:1 网格，拖拽或点击上传
- **自动上传**：选图后立即上传到 Dify，获取 `upload_file_id`
- **图片压缩**：超过 5MB 自动压缩至 50% 再上传
- **内置 Prompt**（不暴露给用户）：
  > "Please place the provided furniture items naturally into the interior room photo. Maintain the original room's lighting, perspective, and architectural details. Make the furniture fit naturally with appropriate shadows and reflections. Keep the room's overall style coherent."
- **生成结果**：右栏展示，支持下载

---

## 环境变量

文件：`.env.local`（已在 `.gitignore` 中排除）

```env
NEXT_PUBLIC_INTERIOR_API_KEY=app-qe04SmkefYjvYNIVYsrUSkke
NEXT_PUBLIC_DIFY_API_ENDPOINT=https://api.dify.ai/v1/chat-messages
```

> API Key 复用自 `sprite-gif-nextjs` 项目的 `NEXT_PUBLIC_DIFY_API_KEY`，即同一个 Dify workflow（nanobanana2）。

---

## API Routes

| 路由 | 说明 |
|------|------|
| `POST /api/dify/upload` | 上传图片到 Dify，返回 `upload_file_id` |
| `POST /api/dify/generate` | 调用 Dify workflow，SSE 流式返回生成结果 |
| `GET /api/image-proxy?url=` | 代理图片下载（绕过 CORS） |

generate route 使用 Edge Runtime，支持最长 300s 超时，内置心跳保活。

---

## 请求结构

```json
{
  "query": "<built-in prompt>",
  "response_mode": "streaming",
  "user": "user-<timestamp>",
  "inputs": {
    "prompt": "<built-in prompt>",
    "inputimage": [
      { "type": "image", "transfer_method": "local_file", "upload_file_id": "<room_id>" },
      { "type": "image", "transfer_method": "local_file", "upload_file_id": "<furniture1_id>" }
    ]
  }
}
```

SSE 解析：监听 `message_end` 事件，从 `outputs.image_url` 或 `answer` 提取结果图片 URL。

---

## 本地开发

```bash
cd C:\Users\Lenovo\Dropbox\Github\interior-design-gen
npm install
npm run dev
# → http://localhost:3000
```

---

## 参考项目

- **sprite-gif-nextjs**：`C:\Users\Lenovo\Dropbox\Github\Gif\sprite-gif-nextjs`
- 复用了 `/multi-image-gen` 的上传逻辑、API routes、SSE 解析方式
