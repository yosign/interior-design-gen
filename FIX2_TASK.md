# interior-design-gen 修复任务2：Workflow API 格式修正

## 核心问题

当前代码把图片用 chat-messages 格式传给 Dify，但这个应用用的是 **workflow**（`/v1/workflows/run`）。
两种 API 的图片格式完全不同。

### 当前错误格式（chat-messages 格式）
```json
{
  "inputs": {
    "inputimage": [
      {
        "type": "image",
        "transfer_method": "local_file",
        "upload_file_id": "abc123"
      }
    ]
  }
}
```

### 正确格式（workflow file variable 格式）
上传后 Dify 返回完整 file 对象，直接用这个对象传给 workflow：
```json
{
  "inputs": {
    "inputimage": [
      {
        "dify_model_identity": "dify__file",
        "type": "image",
        "transfer_method": "local_file",
        "upload_file_id": "abc123"
      }
    ]
  }
}
```

实际上 workflow file 类型只需要：
```json
{
  "transfer_method": "local_file",
  "upload_file_id": "abc123",
  "type": "image"
}
```

## 修复步骤

### 1. 修改 app/api/dify/upload/route.ts

upload API 返回的是完整 file 对象，前端需要保存完整对象（不只是 id）。
这个文件不需要改，上传逻辑没问题。

### 2. 修改 app/api/dify/generate/route.ts

**关键改动**：API endpoint 从 `chat-messages` 换成 `workflows/run`，response 格式不同。

找到 `generate/route.ts`，把整个文件重写为以下逻辑：

```typescript
// 使用 Edge Runtime
export const runtime = 'edge';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const body = await request.json();
  const apiKey = request.headers.get('x-api-key');
  
  // endpoint 固定用 workflows/run（前端传来的 endpoint 忽略）
  const WORKFLOW_ENDPOINT = 'https://api.dify.ai/v1/workflows/run';

  // streaming response
  const encoder = new TextEncoder();
  let heartbeatInterval: NodeJS.Timeout | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        heartbeatInterval = setInterval(() => {
          try { controller.enqueue(encoder.encode(': heartbeat\n\n')); } catch {}
        }, 25000);

        const difyResponse = await fetch(WORKFLOW_ENDPOINT, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: body.inputs,
            response_mode: 'streaming',
            user: body.user || `user-${Date.now()}`,
          }),
        });

        if (!difyResponse.ok) {
          const errorText = await difyResponse.text();
          let errorData: unknown;
          try { errorData = JSON.parse(errorText); } catch { errorData = errorText; }
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ error: extractErrorMessage(errorData, difyResponse.status) })}\n\n`
          ));
          controller.close();
          return;
        }

        const reader = difyResponse.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: '无法读取响应流' })}\n\n`));
          controller.close();
          return;
        }

        let buffer = '';
        let finalImageUrl: string | null = null;
        const collectedEvents: unknown[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim() || line.startsWith(':')) continue;
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data) as Record<string, unknown>;
                collectedEvents.push(parsed);

                // workflow 事件：workflow_finished 包含最终 outputs
                if (parsed.event === 'workflow_finished') {
                  const workflowData = parsed.data as Record<string, unknown> | undefined;
                  const outputs = workflowData?.outputs as Record<string, unknown> | undefined;
                  if (outputs) {
                    finalImageUrl = findImageUrl(outputs);
                  }
                  if (!finalImageUrl) {
                    finalImageUrl = findImageUrl(parsed);
                  }
                }

                // node_finished 里可能有图片
                if (parsed.event === 'node_finished' && !finalImageUrl) {
                  finalImageUrl = findImageUrl(parsed);
                }

                // 进度更新给前端
                if (parsed.event === 'node_started') {
                  const nodeData = parsed.data as Record<string, unknown> | undefined;
                  const nodeTitle = nodeData?.title || 'Processing';
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ event: 'progress', statusText: `Running: ${nodeTitle}` })}\n\n`
                  ));
                }

              } catch {}
            }
          }
        }

        if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }

        if (finalImageUrl) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ event: 'workflow_finished', imageUrl: finalImageUrl })}\n\n`
          ));
        } else {
          console.error('[Generate] No image URL. Events collected:', JSON.stringify(collectedEvents, null, 2));
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ error: 'No image URL returned. Check browser console for raw API response.' })}\n\n`
          ));
        }

        controller.close();

      } catch (err: unknown) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        const msg = err instanceof Error ? err.message : 'Generation failed';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
        controller.close();
      }
    },
    cancel() {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}

// 递归查找图片 URL（支持直接 URL / markdown / 嵌套对象）
function findImageUrl(obj: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof obj === 'string') {
    const s = obj.trim();
    const md = s.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
    if (md) return md[1];
    if (s.startsWith('http')) return s;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findImageUrl(item, depth + 1);
      if (found) return found;
    }
  }
  if (obj && typeof obj === 'object') {
    const r = obj as Record<string, unknown>;
    const priority = ['image_url', 'url', 'image', 'result', 'output', 'img_url', 'src', 'value', 'text', 'content'];
    for (const k of priority) {
      if (k in r) { const f = findImageUrl(r[k], depth + 1); if (f) return f; }
    }
    for (const v of Object.values(r)) {
      const f = findImageUrl(v, depth + 1);
      if (f) return f;
    }
  }
  return null;
}

function extractErrorMessage(payload: unknown, status?: number): string {
  if (typeof payload === 'string') return payload || `Request failed (${status})`;
  if (payload && typeof payload === 'object') {
    const r = payload as Record<string, unknown>;
    const msg = r.message || r.error || r.detail;
    if (typeof msg === 'string') return msg;
  }
  return `Request failed (${status ?? 500})`;
}
```

### 3. 修改 app/page.tsx 的 handleGenerate 函数

**图片格式修正**：把 inputimage 的格式从 chat-messages 格式改为 workflow file 格式。

找到 `handleGenerate` 函数中构建 inputs 的部分：

```typescript
// 旧的（错误）
inputs: {
  prompt: finalPrompt,
  aspect_ratio: roomImage.aspectRatio ?? '1:1',
  inputimage: [
    {
      type: 'image',
      transfer_method: 'local_file',
      upload_file_id: roomImage.uploadFileId,
    },
    ...uploadedFurniture.map((item) => ({
      type: 'image',
      transfer_method: 'local_file',
      upload_file_id: item.uploadFileId,
    })),
  ],
},
```

改为：

```typescript
// 新的（正确 workflow 格式）
inputs: {
  prompt: finalPrompt,
  aspect_ratio: roomImage.aspectRatio ?? '1:1',
  inputimage: [
    {
      transfer_method: 'local_file',
      upload_file_id: roomImage.uploadFileId,
      type: 'image',
    },
    ...uploadedFurniture.map((item) => ({
      transfer_method: 'local_file',
      upload_file_id: item.uploadFileId,
      type: 'image',
    })),
  ],
},
```

### 4. 修改 app/page.tsx 的 SSE 解析逻辑（handleGenerate 中）

workflow_finished 事件现在直接包含 `imageUrl`（后端已提取好），前端简化处理：

找到 SSE 解析 while 循环，把：
```typescript
if (eventName === 'message_end' || eventName === 'workflow_finished') {
  finalImageUrl = extractResultImageUrl(parsed)
}
const attemptedUrl = extractResultImageUrl(parsed)
if (attemptedUrl) finalImageUrl = attemptedUrl
```

改为：
```typescript
// 后端已提取好 imageUrl
if (parsed.imageUrl && typeof parsed.imageUrl === 'string') {
  finalImageUrl = parsed.imageUrl
}
// 进度更新
if (parsed.statusText && typeof parsed.statusText === 'string') {
  setGeneration((current) => ({ ...current, statusText: parsed.statusText as string }))
}
// 错误处理
if (parsed.error && typeof parsed.error === 'string') {
  throw new Error(parsed.error)
}
```

---

## 完成后

```bash
cd "C:\Users\Lenovo\Dropbox\Github\interior-design-gen"
npm run build 2>&1
git add -A
git commit -m "fix: use workflows/run API + correct file object format for workflow inputs"
git push
npx vercel --prod --yes
openclaw system event --text "Done: interior-design-gen workflow API fix deployed" --mode now
```
