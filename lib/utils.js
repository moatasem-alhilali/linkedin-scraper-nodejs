const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LINKEDIN_POST_PATH_PREFIXES = ["/posts/", "/feed/update/"];

export const LINKEDIN_HOST = "www.linkedin.com";
export const FETCH_TIMEOUT_MS = 12_000;

function isHostnameAllowed(hostname, allowedHosts) {
  const normalized = hostname.toLowerCase();

  if (typeof allowedHosts === "function") {
    return allowedHosts(normalized);
  }

  if (allowedHosts instanceof Set) {
    return allowedHosts.has(normalized);
  }

  if (Array.isArray(allowedHosts)) {
    return allowedHosts.map((item) => item.toLowerCase()).includes(normalized);
  }

  return false;
}

export function parseUrl(input) {
  try {
    return new URL(String(input));
  } catch {
    return null;
  }
}

export function extractFirstUrl(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  const match = text.match(/https?:\/\/[^\s<>"'`]+/i);
  if (!match) {
    return null;
  }

  return match[0].replace(/[),.;!?]+$/, "");
}

export function isValidLinkedInPostUrl(urlValue) {
  const url = parseUrl(urlValue);
  if (!url) {
    return false;
  }

  if (url.protocol !== "https:") {
    return false;
  }

  if (url.hostname.toLowerCase() !== LINKEDIN_HOST) {
    return false;
  }

  return LINKEDIN_POST_PATH_PREFIXES.some((prefix) =>
    url.pathname.startsWith(prefix),
  );
}

export function assertValidLinkedInPostUrl(urlValue) {
  if (!isValidLinkedInPostUrl(urlValue)) {
    throw new Error("Invalid LinkedIn post URL");
  }
}

export function isAllowedLinkedInMediaHost(hostname) {
  const normalized = hostname.toLowerCase();

  if (!normalized.endsWith(".licdn.com")) {
    return false;
  }

  return /^[a-z0-9-]+\.licdn\.com$/i.test(normalized);
}

export function isAllowedLinkedInMediaUrl(urlValue) {
  const url = parseUrl(urlValue);
  if (!url) {
    return false;
  }

  if (url.protocol !== "https:") {
    return false;
  }

  return isAllowedLinkedInMediaHost(url.hostname);
}

export function isAllowedLinkedInImageHost(hostname) {
  return isAllowedLinkedInMediaHost(hostname);
}

export function isAllowedLinkedInImageUrl(urlValue) {
  return isAllowedLinkedInMediaUrl(urlValue);
}

export function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function trimForTelegram(text, maxLength = 3900) {
  const normalized = String(text || "");
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(maxLength - 1, 0))}…`;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function fetchWithTimeout(url, init = {}) {
  const { timeoutMs = FETCH_TIMEOUT_MS, ...fetchInit } = init;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithRedirectGuard(urlValue, options = {}) {
  const {
    allowedHosts,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxRedirects = 3,
    method = "GET",
    headers = {},
  } = options;

  if (!allowedHosts) {
    throw new Error("allowedHosts is required");
  }

  let currentUrl = String(urlValue);

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const parsed = parseUrl(currentUrl);
    if (!parsed) {
      throw new Error("Invalid URL");
    }

    if (parsed.protocol !== "https:") {
      throw new Error("Only HTTPS URLs are allowed");
    }

    if (!isHostnameAllowed(parsed.hostname, allowedHosts)) {
      throw new Error(`Blocked hostname: ${parsed.hostname}`);
    }

    const response = await fetchWithTimeout(parsed.toString(), {
      timeoutMs,
      method,
      headers,
      redirect: "manual",
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Redirect response missing location header");
    }

    const nextUrl = new URL(location, parsed);
    if (!isHostnameAllowed(nextUrl.hostname, allowedHosts)) {
      throw new Error(`Blocked redirect hostname: ${nextUrl.hostname}`);
    }

    currentUrl = nextUrl.toString();
  }

  throw new Error("Too many redirects");
}

export async function withRetries(task, options = {}) {
  const { retries = 2, baseDelayMs = 400, onRetry } = options;
  let attempt = 0;

  while (attempt <= retries) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }

      if (typeof onRetry === "function") {
        onRetry(error, attempt + 1);
      }

      await sleep(baseDelayMs * (attempt + 1));
      attempt += 1;
    }
  }

  throw new Error("Retry logic exhausted unexpectedly");
}

export function logError(message, error, meta = {}) {
  const payload = {
    level: "error",
    message,
    error: error?.message || String(error),
    stack: error?.stack,
    ...meta,
  };

  console.error(JSON.stringify(payload));
}

export async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
