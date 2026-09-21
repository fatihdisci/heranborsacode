export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=86400',
          'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet',
        },
      });
    }
    const upstream = await env.BACKEND.fetch(request);
    const response = new Response(upstream.body, upstream);
    response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet');
    response.headers.set('referrer-policy', 'no-referrer');
    response.headers.set('x-content-type-options', 'nosniff');
    return response;
  },
};
