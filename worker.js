/**
 * Cloudflare DoH Proxy
 * 完善版本 - 2026-05-31
 * 修复 ECS 透传, CORS, 日志, 缓存问题
 */

export default {
  async fetch(request: Request, env: Record<string, string>): Promise<Response> {
    const url = new URL(request.url);

    // 首页提示
    if (url.pathname === '/') {
      return new Response('DoH Proxy running.\nEndpoint: /dns-query', {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // 只处理 /dns-query 路径
    if (url.pathname !== '/dns-query') {
      return new Response('Not Found', { status: 404 });
    }

    const upstream = new URL(env.DOH_UPSTREAM ?? 'https://cloudflare-dns.com/dns-query');

    // 透传 ECS 客户端子网
    const clientIP = request.headers.get('CF-Connecting-IP');
    if (clientIP) {
      // 按 RFC 7871 标准传递客户端 /24 子网
      url.searchParams.set('ecs', `${clientIP}/24`);
    }

    // 复制请求
    const newRequest = new Request(request, {
      headers: new Headers(request.headers)
    });

    // 禁用所有缓存
    newRequest.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    newRequest.headers.delete('If-None-Match');
    newRequest.headers.delete('If-Modified-Since');

    try {
      const response = await fetch(upstream, newRequest);

      // 复制响应并添加 CORS 头
      const newResponse = new Response(response.body, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');

      return newResponse;

    } catch (e) {
      console.error('Upstream error:', e);
      return new Response('Upstream DNS server error', { status: 503 });
    }
  }
};
