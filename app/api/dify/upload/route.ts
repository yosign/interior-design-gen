import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 300; // 设置最大执行时间为 300 秒
export const dynamic = 'force-dynamic'; // 强制动态渲染

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const apiKey = request.headers.get('x-api-key');
    
    // 调试：检查 formData 内容
    const file = formData.get('file');
    console.log('[API Upload] 接收到文件:', file ? `名称=${(file as File).name}, 大小=${(file as File).size}` : '无文件');
    console.log('[API Upload] API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : '未提供');

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API Key is required' },
        { status: 401 }
      );
    }

    // 转发到 Dify API
    console.log('[API Upload] 开始上传到 Dify...');
    
    // 文件上传通常较快，设置60秒超时
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    
    try {
    const response = await fetch('https://api.dify.ai/v1/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
        body: formData,
        signal: controller.signal
    });
      
      clearTimeout(timeout);

    const responseText = await response.text();
    let data: any = null;
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        console.error('[API Upload] Dify 响应非 JSON:', response.status, responseText);
      }
    }

    console.log('[API Upload] Dify 响应:', response.status, data);

    if (!response.ok) {
      console.error('[API Upload] Dify 上传失败:', data);

      // 提供更友好的错误信息
      let errorMessage = data?.error || data?.message || `上传失败: ${response.statusText || response.status}`;
      if (response.status === 403) {
        errorMessage = 'API Key 权限不足或已过期，请检查 Dify API Key 配置';
      } else if (response.status === 413) {
        errorMessage = '文件太大，请选择小于 10MB 的图片';
      } else if (response.status === 429) {
        errorMessage = 'API 请求次数超限，请稍后重试';
      }

      return NextResponse.json(
        { error: errorMessage, details: data },
        { status: response.status }
      );
    }

    return NextResponse.json(data ?? {});
    } catch (fetchError: any) {
      clearTimeout(timeout);
      if (fetchError.name === 'AbortError') {
        console.error('[API Upload] 上传超时（60秒）');
        return NextResponse.json(
          { error: '文件上传超时，请稍后重试' },
          { status: 504 }
        );
      }
      throw fetchError;
    }
  } catch (error: any) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: error.message || 'Upload failed' },
      { status: 500 }
    );
  }
}
