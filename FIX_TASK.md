# interior-design-gen 修复任务

## Bug 1: 生成成功但无 URL 返回

### 问题
`extractResultImageUrl` 函数只检查了固定几个字段，但 Dify workflow 的实际输出结构可能不同。
需要大幅扩展提取逻辑，覆盖所有可能的字段路径。

### 修复 app/page.tsx 中的 extractResultImageUrl 函数

把现有函数替换为以下更健壮的版本：

```typescript
function extractResultImageUrl(payload: Record<string, unknown>): string | null {
  // 递归提取所有字符串值中的第一个 http URL
  function findUrl(obj: unknown, depth = 0): string | null {
    if (depth > 5) return null
    if (typeof obj === 'string') {
      const trimmed = obj.trim()
      // 直接是 URL
      if (trimmed.startsWith('http') && (trimmed.includes('.jpg') || trimmed.includes('.png') || trimmed.includes('.webp') || trimmed.includes('.jpeg') || trimmed.includes('image') || trimmed.includes('upload'))) {
        return trimmed
      }
      // markdown 格式 ![...](url)
      const mdMatch = trimmed.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/)
      if (mdMatch) return mdMatch[1]
      // 纯 URL（不带图片扩展名但是 http 开头）
      if (trimmed.startsWith('http') && trimmed.length > 10) {
        return trimmed
      }
      return null
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findUrl(item, depth + 1)
        if (found) return found
      }
    }
    if (obj && typeof obj === 'object') {
      // 优先检查常见字段名
      const priorityKeys = ['image_url', 'url', 'image', 'result', 'output', 'img_url', 'src', 'link', 'value', 'text', 'content']
      const record = obj as Record<string, unknown>
      for (const key of priorityKeys) {
        if (key in record) {
          const found = findUrl(record[key], depth + 1)
          if (found) return found
        }
      }
      // 再遍历所有字段
      for (const val of Object.values(record)) {
        const found = findUrl(val, depth + 1)
        if (found) return found
      }
    }
    return null
  }

  // 1. 先检查 outputs（最可能的位置）
  const outputs = (payload.outputs as Record<string, unknown> | undefined)
    || ((payload.metadata as Record<string, unknown> | undefined)?.outputs as Record<string, unknown> | undefined)
  if (outputs) {
    const fromOutputs = findUrl(outputs)
    if (fromOutputs) return fromOutputs
  }

  // 2. 检查 answer 字段（可能是 markdown 或纯 URL）
  if (payload.answer) {
    const fromAnswer = findUrl(payload.answer)
    if (fromAnswer) return fromAnswer
  }

  // 3. 兜底：递归搜索整个 payload
  return findUrl(payload)
}
```

同时，在前端 SSE 解析部分（handleGenerate 函数中），修改条件触发逻辑：

找到这段代码：
```typescript
if (eventName === 'message_end' || eventName === 'workflow_finished') {
  finalImageUrl = extractResultImageUrl(parsed)
}
```

替换为：
```typescript
// 每个事件都尝试提取 URL（不仅限于 message_end）
const attemptedUrl = extractResultImageUrl(parsed)
if (attemptedUrl) {
  finalImageUrl = attemptedUrl
}

// 更新状态文字
if (eventName === 'message' || eventName === 'agent_message') {
  setGeneration((current) => ({
    ...current,
    statusText: 'Refining placement and lighting...',
  }))
}
```

同时在 handleGenerate 结束时，如果 finalImageUrl 为 null，不要直接抛错，而是打印详细 log 帮助调试：
找到：
```typescript
if (!finalImageUrl) {
  throw new Error('Generation completed but no image URL was returned')
}
```
替换为：
```typescript
if (!finalImageUrl) {
  console.error('[Generate] No image URL found. Full SSE data collected:', JSON.stringify(collectedDebugData, null, 2))
  throw new Error('Generation completed but no image URL was returned. Check browser console for raw API response.')
}
```

并在 handleGenerate 函数顶部的 let 变量声明处，添加：
```typescript
let collectedDebugData: Record<string, unknown>[] = []
```

并在 SSE 解析循环中，每次 parse 成功后追加：
```typescript
collectedDebugData.push(parsed)
```

---

## Bug 2: 家具比例问题

### 问题
`aspect_ratio` 字段是从 `roomImage.aspectRatio` 拿到的，这没问题（应该用房间图的比例）。
但实际上可能是 Dify prompt 里没有明确指定保持家具原始尺寸，导致家具变形。

### 修复 BUILT_IN_PROMPT

在 app/page.tsx 顶部，找到 `const BUILT_IN_PROMPT` 并替换为：

```typescript
const BUILT_IN_PROMPT =
  "Please place the provided furniture items naturally into the interior room photo. Strictly preserve the original room structure — do NOT redraw or alter the walls, doors, windows, flooring, ceiling, outdoor views, or any architectural elements. Only add or adjust the furniture items. Preserve the original proportions and shape of each furniture item exactly as shown — do not stretch, distort, or resize the furniture beyond what is needed for natural perspective. Make the furniture fit naturally with appropriate shadows and reflections matching the original lighting and perspective. The furniture should look like it physically belongs in the room."
```

---

## 完成后

```bash
cd "C:\Users\Lenovo\Dropbox\Github\interior-design-gen"
npm run build 2>&1
git add -A
git commit -m "fix: robust URL extraction + furniture proportion prompt"
git push
npx vercel --prod --yes
openclaw system event --text "Done: interior-design-gen URL fix deployed" --mode now
```
