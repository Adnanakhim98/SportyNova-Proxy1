
const cors = {
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges"
};

function sendError(res, status, message) {
  res.writeHead(status, {
    ...cors,
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify({ error: message }));
}

function isAllowed(url) {
  const hosts = (process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  return url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    hosts.includes(url.hostname.toLowerCase());
}

function proxyUrl(value, base, endpoint) {
  const target = new URL(value, base);

  if (!isAllowed(target)) return value;

  const result = new URL(endpoint);
  result.searchParams.set("url", target.href);
  return result.href;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "";

  const headers = {
    ...cors,
    "Access-Control-Allow-Origin":
      origin === allowedOrigin ? origin : allowedOrigin,
    "Vary": "Origin"
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    return res.end();
  }

  if (!["GET", "HEAD"].includes(req.method)) {
    return sendError(res, 405, "Method not allowed");
  }

  const raw = req.query.url;

  if (!raw || typeof raw !== "string" || raw.length > 12000) {
    return sendError(res, 400, "Invalid URL");
  }

  let target;

  try {
    target = new URL(raw);
  } catch {
    return sendError(res, 400, "Invalid URL");
  }

  if (!isAllowed(target)) {
    return sendError(res, 403, "Host not allowed");
  }

  const endpoint =
    `${req.headers["x-forwarded-proto"] || "https"}://` +
    `${req.headers.host}/api/proxy`;

  try {
    const requestHeaders = {};

    if (req.headers.range) {
      requestHeaders.Range = req.headers.range;
    }

    let current = target;
    let upstream;

    for (let i = 0; i <= 4; i++) {
      if (!isAllowed(current)) {
        throw new Error("Redirect host not allowed");
      }

      upstream = await fetch(current.href, {
        method: req.method,
        headers: requestHeaders,
        redirect: "manual"
      });

      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const location = upstream.headers.get("location");

        if (!location || i === 4) {
          throw new Error("Redirect limit reached");
        }

        current = new URL(location, current);
        continue;
      }

      break;
    }

    const type = upstream.headers.get("content-type") || "";

    const isPlaylist =
      current.pathname.toLowerCase().endsWith(".m3u8") ||
      type.toLowerCase().includes("mpegurl");

    if (isPlaylist && upstream.ok && req.method === "GET") {
      const text = await upstream.text();

      const rewritten = text.split(/\r?\n/).map(line => {
        const trimmed = line.trim();

        if (!trimmed) return line;

        if (trimmed.startsWith("#")) {
          return line.replace(
            /URI="([^"]+)"/g,
            (match, uri) =>
              `URI="${proxyUrl(uri, current, endpoint)}"`
          );
        }

        return proxyUrl(trimmed, current, endpoint);
      }).join("\n");

      res.writeHead(upstream.status, {
        ...headers,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store"
      });

      return res.end(rewritten);
    }

    const forward = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified"
    ];

    const output = { ...headers };

    for (const name of forward) {
      const value = upstream.headers.get(name);
      if (value) output[name] = value;
    }

    res.writeHead(upstream.status, output);

    if (req.method === "HEAD" || !upstream.body) {
      return res.end();
    }

    const { Readable } = require("node:stream");
    Readable.fromWeb(upstream.body).pipe(res);

  } catch (error) {
    return sendError(res, 502, error.message);
  }
};
      
