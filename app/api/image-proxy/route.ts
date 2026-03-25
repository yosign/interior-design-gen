import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return true;
  }

  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }

  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    return true;
  }

  return false;
}

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get('url');
  if (!rawUrl) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid url parameter' }, { status: 400 });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return NextResponse.json({ error: 'Only http/https urls are allowed' }, { status: 400 });
  }

  if (isPrivateOrLocalHost(targetUrl.hostname)) {
    return NextResponse.json({ error: 'Private/local network urls are not allowed' }, { status: 403 });
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        Accept: 'image/*,*/*;q=0.8',
      },
    });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Upstream request failed with status ${upstream.status}` },
        { status: upstream.status }
      );
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const body = await upstream.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    console.error('[image-proxy] fetch failed:', error);
    return NextResponse.json({ error: 'Image proxy request failed' }, { status: 502 });
  }
}
