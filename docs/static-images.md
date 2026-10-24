# Static image uploads

Admins can upload static JPEG, PNG, WebP, AVIF, BMP and SVG. GIFs and animation are rejected. Raster inputs have a 5 MiB limit, 24 million pixel budget and 8192 pixel side limit. Browser encoding uses lossy WebP at quality 0.82. Existing static WebP bytes are retained. Transparent artwork and small text need a visual check because Canvas has no lossless WebP control. AVIF clean-aperture crops and SVG CSS escapes are rejected rather than introducing more decoding logic.

SVG input is limited to 2 MiB and sanitized output to 4 MiB. The exact `@zeropress/svg-hush@0.1.0` artifact wraps svg-hush 0.9.7 with policy `zeropress-svg-v1`. The upstream package has no runtime dependencies or install hook. Its WASM SHA256 is `42c8a019542f13c258a60e5feac5ec4617780bac9ff43980042fed31e106d61f`. The integration test runs the installed Workerd entry point and WASM in Miniflare. The sanitizer may change SVG appearance. Animation and nonlocal CSS URLs are rejected before and after sanitizing. No raw SVG is written by the upload route.

## Enable public SVG delivery

App-hosted `/media/` SVGs receive a restrictive CSP and `nosniff`, including on 304 responses. Direct public R2 custom domains bypass the Worker. Public SVG publication fails closed until `SVG_VERIFIED_PUBLIC_ORIGIN` matches the configured public media origin.

Before setting that value:

1. Disable public access through the bucket's `r2.dev` endpoint. Inventory every enabled custom domain for the bucket.
2. In each domain's Cloudflare zone, create a Response Header Transform Rule matching its hostname, a path starting with `/media/`, and a path ending with `.svg`. Set `X-Content-Type-Options` to `nosniff`. Set `Content-Security-Policy` to `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox`.
3. Put a harmless sanitized SVG probe at the same `/media/probe.svg` path on that bucket using authorized operator tooling. Verify caching is enabled for the media path.
4. Run `CLOUDFLARE_API_TOKEN=... node web/scripts/verify-svg-cdn.mjs https://YOUR_MEDIA_HOST/media/probe.svg ACCOUNT_ID BUCKET` with Node 24 and a token with bucket read access. It verifies all enabled custom hostnames, SVG content type, exact security headers, a CDN cache hit and disabled `r2.dev` access. It prints the activation value only after all checks pass.
5. Set the printed `SVG_VERIFIED_PUBLIC_ORIGIN` as a Worker environment variable through normal deployment configuration. Reverify whenever a domain, rule or public bucket setting changes. Do not enable alternate public delivery hostnames without the same protections.

No public media host or bucket is configured in the current development environment. Live CDN activation remains blocked until an operator provisions and verifies those resources. App-hosted sanitized SVG works without that activation.
