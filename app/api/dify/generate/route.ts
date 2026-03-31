import { NextRequest } from 'next/server';

// 使用 Edge Runtime，突破 60 秒限制
export const runtime = 'edge';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const body = await request.json();
  const apiKey = request.headers.get('x-api-key');

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'API Key is required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Always use workflows/run (ignore any endpoint header from client)
  const WORKFLOW_ENDPOINT = 'https://api.dify.ai/v1/workflows/run';

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
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ error: '无法读取响应流' })}\n\n`
          ));
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

                // workflow_finished contains final outputs
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

                // node_finished may also contain image
                if (parsed.event === 'node_finished' && !finalImageUrl) {
                  finalImageUrl = findImageUrl(parsed);
                }

                // progress update for frontend
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

// Recursively find image URL (supports direct URL / markdown / nested objects)
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
