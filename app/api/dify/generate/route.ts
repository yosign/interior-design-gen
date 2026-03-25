import { NextRequest } from 'next/server';

// 使用 Edge Runtime，突破 60 秒限制
export const runtime = 'edge';
export const dynamic = 'force-dynamic';
// Edge Runtime 最长可以等待响应（但连接必须保持活跃）
export const maxDuration = 300;

const stringifyUnknown = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const extractErrorMessage = (payload: unknown, status?: number): string => {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed || `请求失败 (HTTP ${status ?? 500})`;
  }

  if (!payload || typeof payload !== 'object') {
    return `请求失败 (HTTP ${status ?? 500})`;
  }

  const record = payload as Record<string, unknown>;
  const errorField = record.error;
  const messageField = record.message;
  const detailField = record.detail ?? record.details ?? record.reason;
  const codeField = record.code ?? record.error_code;

  let message = '';

  if (typeof errorField === 'string' && errorField.trim()) {
    message = errorField.trim();
  } else if (errorField && typeof errorField === 'object') {
    message = extractErrorMessage(errorField, status);
  } else if (typeof messageField === 'string' && messageField.trim()) {
    message = messageField.trim();
  } else if (detailField) {
    const detailText = stringifyUnknown(detailField).trim();
    if (detailText) {
      message = detailText;
    }
  }

  const codeText = typeof codeField === 'string' || typeof codeField === 'number'
    ? String(codeField).trim()
    : '';

  if (codeText && message && !message.includes(codeText)) {
    return `[${codeText}] ${message}`;
  }

  if (message) {
    return message;
  }

  const fallback = stringifyUnknown(payload).trim();
  if (fallback && fallback !== '{}') {
    return fallback;
  }

  return `请求失败 (HTTP ${status ?? 500})`;
};

const buildErrorEvent = (payload: unknown, status?: number) => ({
  error: extractErrorMessage(payload, status),
  status: status ?? 500,
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const apiKey = request.headers.get('x-api-key');
    const endpoint = request.headers.get('x-api-endpoint') || 'https://api.dify.ai/v1/chat-messages';

    console.log('[API Generate] 收到生成请求');
    console.log('[API Generate] API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : '未提供');
    console.log('[API Generate] Endpoint:', endpoint);
    console.log('[API Generate] 输入图片数量:', body.inputs?.inputimage?.length || 0);

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'API Key is required' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 创建 ReadableStream 来保持连接活跃（每 30 秒发送心跳）
    const encoder = new TextEncoder();
    let heartbeatInterval: NodeJS.Timeout | null = null;
    
    const stream = new ReadableStream({
      async start(controller) {
        try {
          console.log('[API Generate] 开始调用 Dify API（Streaming 模式）...');
          
          // 启动心跳，每 25 秒发送一次（Vercel 60s 超时前保持连接）
          heartbeatInterval = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': heartbeat\n\n'));
              console.log('[API Generate] 发送心跳');
            } catch (e) {
              console.error('[API Generate] 心跳发送失败:', e);
            }
          }, 25000);
          
          // 单次长请求：280 秒超时
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 280000); // 280 秒
          
          console.log('[API Generate] 发起 Streaming 请求（最长 280 秒）...');
          
          const difyResponse = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal: abortController.signal
          });
          
          clearTimeout(timeoutId);

          console.log('[API Generate] Dify API 响应，状态:', difyResponse.status);

          if (!difyResponse.ok) {
            const errorText = await difyResponse.text();
            console.error('[API Generate] Dify 错误:', difyResponse.status, errorText);
            
            let errorData: unknown;
            try {
              errorData = JSON.parse(errorText);
            } catch (e) {
              errorData = errorText.substring(0, 500);
            }
            
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify(buildErrorEvent(errorData, difyResponse.status))}\n\n`
            ));
            controller.close();
            return;
          }

          // 读取 Dify 的 SSE 流
          const reader = difyResponse.body?.getReader();
          const decoder = new TextDecoder();
          
          if (!reader) {
            console.error('[API Generate] 无法读取 Dify 响应流');
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ error: '无法读取 Dify 响应流' })}\n\n`
            ));
            controller.close();
            return;
          }

          let buffer = '';
          let collectedData: any = {
            answer: null,
            outputs: null,
            metadata: null,
            messageEnd: null,
            error: null
          };
          
          console.log('[API Generate] 开始读取 Dify streaming 数据...');
          
          // 逐块读取 Dify 的流
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              console.log('[API Generate] Dify stream 结束');
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 保留最后不完整的行

            for (const line of lines) {
              if (!line.trim() || line.startsWith(':')) {
                continue; // 跳过空行和注释
              }

              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                
                if (data === '[DONE]') {
                  console.log('[API Generate] 收到 [DONE] 标记');
                  continue;
                }

                try {
                  const parsed = JSON.parse(data);
                  console.log('[API Generate] Dify 事件:', parsed.event, '数据片段:', JSON.stringify(parsed).substring(0, 150));

                  if (parsed.error || parsed.event === 'error') {
                    const errorEvent = buildErrorEvent(parsed, difyResponse.status);
                    collectedData.error = errorEvent.error;
                    console.error('[API Generate] Dify 流式错误:', errorEvent.error);
                    controller.enqueue(encoder.encode(
                      `data: ${JSON.stringify(errorEvent)}\n\n`
                    ));
                    await reader.cancel();
                    controller.close();
                    return;
                  }
                  
                  // 收集不同类型的数据
                  if (parsed.event === 'message_end' || parsed.event === 'workflow_finished') {
                    collectedData.messageEnd = parsed;
                  }
                  
                  // 收集 answer
                  if (parsed.answer) {
                    collectedData.answer = parsed.answer;
                  }
                  
                  // 收集 outputs
                  if (parsed.outputs) {
                    collectedData.outputs = parsed.outputs;
                  }
                  
                  // 收集 metadata
                  if (parsed.metadata) {
                    collectedData.metadata = parsed.metadata;
                  }
                  
                } catch (e) {
                  console.warn('[API Generate] 解析 Dify 数据失败:', data.substring(0, 100));
                }
              }
            }
          }

          // 停止心跳
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
          }

          // 组装最终结果（合并收集到的所有数据）
          const finalResult: any = {
            event: 'message_end',
            answer: collectedData.answer,
            outputs: collectedData.outputs,
            metadata: collectedData.metadata,
            ...collectedData.messageEnd // 合并 message_end 事件的其他字段
          };

          console.log('[API Generate] 组装最终结果:', JSON.stringify(finalResult).substring(0, 300));

          // 验证是否有有效数据
          if (finalResult.answer || finalResult.outputs || finalResult.metadata?.outputs) {
            console.log('[API Generate] Dify 生成成功，发送最终结果');
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify(finalResult)}\n\n`
            ));
          } else {
            console.error('[API Generate] 未收到有效的输出数据');
            console.error('[API Generate] 收集到的数据:', JSON.stringify(collectedData, null, 2));
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify(buildErrorEvent(
                collectedData.error || '未收到生成结果，请检查 Dify 工作流配置'
              ))}\n\n`
            ));
          }
          
          controller.close();
          
        } catch (error: any) {
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          console.error('[API Generate] 错误:', error);
          
          let errorMessage = error.message || '生成失败';
          if (error.name === 'AbortError') {
            errorMessage = 'Dify API 请求超时（280秒），请尝试简化提示词或稍后重试';
          }
          
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify(buildErrorEvent(errorMessage))}\n\n`
          ));
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
        'Connection': 'keep-alive'
      }
    });
  } catch (error: any) {
    console.error('Generate error:', error);
    return new Response(
      JSON.stringify(buildErrorEvent(error?.message || 'Generate failed', 500)),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
