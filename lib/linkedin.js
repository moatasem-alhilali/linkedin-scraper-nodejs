import * as cheerio from "cheerio";
import pLimit from "p-limit";
import {
  assertValidLinkedInPostUrl,
  fetchWithRedirectGuard,
  isAllowedLinkedInMediaHost,
  isAllowedLinkedInMediaUrl,
  logError,
  normalizeWhitespace,
  parseUrl,
  withRetries,
} from "./utils.js";

const LINKEDIN_ALLOWED_HOSTS = new Set(["www.linkedin.com"]);
const PRIMARY_TEXT_SELECTORS = [
  ".attributed-text-segment-list__content",
  ".update-components-update-v2__commentary",
];
const RETRY_COUNT = 2;
const MAX_MEDIA_COUNT = 40;
const MAX_DOWNLOAD_COUNT = 40;
const DOWNLOAD_CONCURRENCY = 3;
const HEADLESS_MODE_ENABLED = process.env.ENABLE_HEADLESS === "true";
const POST_MEDIA_CONTAINER_SELECTOR = [
  ".update-components-image",
  ".update-components-image__container",
  ".update-components-carousel",
  ".update-components-carousel__container",
  ".update-components-document",
  ".update-components-document__container",
  ".update-components-video",
  ".update-components-linkedin-video",
  ".feed-shared-update-v2__content",
].join(", ");

const POST_IMAGE_SELECTORS = [
  ".update-components-image__container img",
  ".update-components-image img",
  ".update-components-carousel__container img",
  ".update-components-document__container img",
  ".update-components-article__image img",
  "img.carousel-slide__image",
  ".feed-shared-update-v2__content img[data-delayed-url]",
];

const POST_VIDEO_SELECTORS = [
  ".update-components-video video[src]",
  ".update-components-video video source[src]",
  ".update-components-linkedin-video video[src]",
  ".update-components-linkedin-video video source[src]",
  ".feed-shared-update-v2__content video[src]",
  ".feed-shared-update-v2__content video source[src]",
  'a[href*="/dms/video/"]',
];

const POST_DOCUMENT_SELECTORS = [
  ".update-components-document__container a[href]",
  ".update-components-document__container [data-document-url]",
  'a[href*="/dms/document/"]',
  '[data-document-url*="/dms/document/"]',
];

const INCLUDED_IMAGE_CLASS_HINTS = [
  "update-components-image",
  "update-components-carousel",
  "update-components-document",
  "carousel-slide__image",
  "feed-shared-image",
];

const EXCLUDED_IMAGE_CLASS_HINTS = [
  "feed-shared-actor__avatar",
  "entityphoto",
  "presence-entity__image",
  "ivm-view-attr__img--centered",
  "global-nav",
  "org-top-card-primary-content__logo",
];

const EXCLUDED_IMAGE_URL_HINTS = [
  "profile-displayphoto",
  "company-logo",
  "school-logo",
  "profile-framedphoto",
  "ghost-person",
];

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const MEDIA_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
};

const MIME_TO_EXTENSION = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/mpeg": "mpeg",
  "application/pdf": "pdf",
  "application/octet-stream": "bin",
};

export class LinkedInExtractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LinkedInExtractionError";
    this.code = code;
  }
}

function hasAuthWall($) {
  const title = normalizeWhitespace($("title").first().text()).toLowerCase();
  const ogTitle = normalizeWhitespace(
    $('meta[property="og:title"]').attr("content"),
  ).toLowerCase();
  const combined = `${title} ${ogTitle}`;

  return (
    combined.includes("sign in") ||
    combined.includes("log in") ||
    combined.includes("join linkedin") ||
    combined.includes("linkedin login")
  );
}

function isLowValueFallbackText(text) {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    normalized.includes("join linkedin") ||
    normalized.includes("sign in") ||
    normalized.includes("log in") ||
    normalized.includes("linkedin: log in")
  );
}

function extractPostText($) {
  const chunks = [];

  for (const selector of PRIMARY_TEXT_SELECTORS) {
    $(selector).each((_, element) => {
      const text = normalizeWhitespace($(element).text());
      if (text) {
        chunks.push(text);
      }
    });

    if (chunks.length > 0) {
      break;
    }
  }

  if (chunks.length > 0) {
    return [...new Set(chunks)].join("\n\n");
  }

  const ogDescription = normalizeWhitespace(
    $('meta[property="og:description"]').attr("content"),
  );
  const ogTitle = normalizeWhitespace($('meta[property="og:title"]').attr("content"));
  const fallback = ogDescription || ogTitle;

  if (isLowValueFallbackText(fallback)) {
    return "";
  }

  return fallback;
}

function addCandidateUrl(urlSet, rawUrl, validator = isAllowedLinkedInMediaUrl) {
  const addedUrls = [];
  const value = normalizeWhitespace(rawUrl);
  if (!value) {
    return addedUrls;
  }

  const parts = value.includes(",") ? value.split(",") : [value];
  for (const part of parts) {
    const candidate = part.trim().split(/\s+/)[0];
    if (!candidate) {
      continue;
    }

    try {
      const parsed = new URL(candidate, "https://www.linkedin.com");
      parsed.hash = "";
      const normalized = parsed.toString();

      if (validator(normalized)) {
        if (urlSet.has(normalized)) {
          continue;
        }

        urlSet.add(normalized);
        addedUrls.push(normalized);
      }
    } catch {
      continue;
    }
  }

  return addedUrls;
}

function parseNumericDimension(value) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function hasAnyHint(value, hints) {
  const normalized = String(value || "").toLowerCase();
  return hints.some((hint) => normalized.includes(hint));
}

function isLikelyPostImageElement($, element, urlValue) {
  const parsed = parseUrl(urlValue);
  if (!parsed) {
    return false;
  }

  const pathname = parsed.pathname.toLowerCase();
  if (!pathname.includes("/dms/image/")) {
    return false;
  }

  if (hasAnyHint(pathname, EXCLUDED_IMAGE_URL_HINTS)) {
    return false;
  }

  const $element = $(element);
  const classBlob = [
    $element.attr("class"),
    $element.parent().attr("class"),
    $element.closest("[class]").attr("class"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (hasAnyHint(classBlob, EXCLUDED_IMAGE_CLASS_HINTS)) {
    return false;
  }

  const inKnownMediaContainer =
    $element.closest(POST_MEDIA_CONTAINER_SELECTOR).length > 0;
  const hasStrongClassSignal = hasAnyHint(classBlob, INCLUDED_IMAGE_CLASS_HINTS);

  if (!inKnownMediaContainer && !hasStrongClassSignal) {
    return false;
  }

  const width = parseNumericDimension($element.attr("width"));
  const height = parseNumericDimension($element.attr("height"));
  const tooSmall = (width !== null && width < 140) || (height !== null && height < 140);

  if (tooSmall && !hasStrongClassSignal) {
    return false;
  }

  return true;
}

function extractImageUrls($) {
  const imageSet = new Set();

  for (const selector of POST_IMAGE_SELECTORS) {
    $(selector).each((_, element) => {
      const candidates = [
        $(element).attr("src"),
        $(element).attr("srcset"),
        $(element).attr("data-delayed-url"),
        $(element).attr("data-ghost-url"),
      ];

      for (const candidate of candidates) {
        const addedUrls = addCandidateUrl(imageSet, candidate);
        for (const addedUrl of addedUrls) {
          if (!isLikelyPostImageElement($, element, addedUrl)) {
            imageSet.delete(addedUrl);
          }
        }
      }
    });
  }

  if (imageSet.size === 0) {
    addCandidateUrl(imageSet, $('meta[property="og:image"]').attr("content"));
    addCandidateUrl(
      imageSet,
      $('meta[property="og:image:secure_url"]').attr("content"),
    );
  }

  return [...imageSet].slice(0, MAX_MEDIA_COUNT);
}

function extractVideoUrls($) {
  const videoSet = new Set();

  for (const selector of POST_VIDEO_SELECTORS) {
    $(selector).each((_, element) => {
      addCandidateUrl(videoSet, $(element).attr("src"));
      addCandidateUrl(videoSet, $(element).attr("href"));
      addCandidateUrl(videoSet, $(element).attr("data-delayed-url"));
      addCandidateUrl(videoSet, $(element).attr("data-mp4-source-url"));
      addCandidateUrl(videoSet, $(element).attr("data-video-url"));
    });
  }

  if (videoSet.size === 0) {
    addCandidateUrl(videoSet, $('meta[property="og:video"]').attr("content"));
    addCandidateUrl(
      videoSet,
      $('meta[property="og:video:secure_url"]').attr("content"),
    );

    const scriptVideos = extractScriptMediaUrls($, "video");
    for (const url of scriptVideos) {
      videoSet.add(url);
    }
  }

  return [...videoSet]
    .filter((url) => {
      const pathname = parseUrl(url)?.pathname?.toLowerCase() || "";
      return (
        pathname.includes("/dms/video/") ||
        pathname.includes("/dms/videoplayback/")
      );
    })
    .slice(0, MAX_MEDIA_COUNT);
}

function decodeEscapedUrl(urlValue) {
  return String(urlValue)
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function extractScriptMediaUrls($, kind) {
  const mediaSet = new Set();
  const escapedPattern = new RegExp(
    `https:\\\\\\/\\\\\\/[a-z0-9.-]+\\\\\\/dms\\\\\\/${kind}[^"\\\\\\s<]*`,
    "gi",
  );
  const plainPattern = new RegExp(
    `https://[a-z0-9.-]+/dms/${kind}[^"'\\s<]*`,
    "gi",
  );

  $("script").each((_, element) => {
    const scriptBody = $(element).html();
    if (!scriptBody || scriptBody.length > 2_000_000) {
      return;
    }

    const matches = [
      ...(scriptBody.match(escapedPattern) || []),
      ...(scriptBody.match(plainPattern) || []),
    ];

    for (const match of matches) {
      addCandidateUrl(mediaSet, decodeEscapedUrl(match));
    }
  });

  return mediaSet;
}

function extractDocumentUrls($) {
  const documentSet = new Set();

  for (const selector of POST_DOCUMENT_SELECTORS) {
    $(selector).each((_, element) => {
      addCandidateUrl(documentSet, $(element).attr("href"));
      addCandidateUrl(documentSet, $(element).attr("data-document-url"));
      addCandidateUrl(documentSet, $(element).attr("src"));
    });
  }

  if (documentSet.size === 0) {
    const scriptDocuments = extractScriptMediaUrls($, "document");
    for (const url of scriptDocuments) {
      documentSet.add(url);
    }
  }

  return [...documentSet]
    .filter((url) => {
      const pathname = parseUrl(url)?.pathname?.toLowerCase() || "";
      return pathname.includes("/dms/document/");
    })
    .slice(0, MAX_MEDIA_COUNT);
}

function extensionFromUrl(urlValue) {
  try {
    const pathname = new URL(urlValue).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (!match) {
      return null;
    }

    return match[1].toLowerCase();
  } catch {
    return null;
  }
}

function inferMediaType(requestedType, mimeType, sourceUrl) {
  const normalizedMime = String(mimeType || "").toLowerCase();
  const pathname = parseUrl(sourceUrl)?.pathname?.toLowerCase() || "";

  if (normalizedMime.startsWith("text/html")) {
    return null;
  }

  if (normalizedMime.startsWith("image/")) {
    return "image";
  }

  if (normalizedMime.startsWith("video/")) {
    return "video";
  }

  if (normalizedMime === "application/pdf") {
    return "document";
  }

  if (pathname.includes("/dms/document/") || pathname.endsWith(".pdf")) {
    return "document";
  }

  if (
    pathname.includes("/dms/video/") ||
    pathname.includes("/dms/videoplayback/") ||
    /\.(mp4|mov|webm|mpeg)$/i.test(pathname)
  ) {
    return "video";
  }

  if (pathname.includes("/dms/image/")) {
    return "image";
  }

  if (
    (normalizedMime === "" || normalizedMime === "application/octet-stream") &&
    (requestedType === "image" ||
      requestedType === "video" ||
      requestedType === "document")
  ) {
    return requestedType;
  }

  return null;
}

function mediaFilename(index, mediaType, mimeType, sourceUrl) {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  const ext = MIME_TO_EXTENSION[mime] || extensionFromUrl(sourceUrl) || "jpg";
  return `linkedin-${mediaType}-${index + 1}.${ext}`;
}

async function scrapeOnce(postUrl) {
  if (HEADLESS_MODE_ENABLED) {
    logError(
      "Headless flag enabled but base implementation uses HTML scraping only",
      new Error("ENABLE_HEADLESS=true without headless module"),
      { postUrl },
    );
  }

  const response = await fetchWithRedirectGuard(postUrl, {
    allowedHosts: LINKEDIN_ALLOWED_HOSTS,
    headers: BROWSER_HEADERS,
    timeoutMs: 12_000,
    maxRedirects: 2,
  });

  if ([401, 403, 999].includes(response.status)) {
    throw new LinkedInExtractionError(
      "PRIVATE_OR_PROTECTED",
      `LinkedIn returned ${response.status}`,
    );
  }

  if (!response.ok) {
    throw new LinkedInExtractionError(
      "SCRAPE_FAILED",
      `LinkedIn returned ${response.status}`,
    );
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  if (hasAuthWall($)) {
    throw new LinkedInExtractionError(
      "PRIVATE_OR_PROTECTED",
      "LinkedIn page requires authentication",
    );
  }

  const text = extractPostText($);
  const imageUrls = extractImageUrls($);
  const videoUrls = extractVideoUrls($);
  const documentUrls = extractDocumentUrls($);

  if (!text) {
    throw new LinkedInExtractionError(
      "TEXT_NOT_FOUND",
      "Could not extract post text",
    );
  }

  return { text, imageUrls, videoUrls, documentUrls };
}

export async function scrapeLinkedInPost(postUrl) {
  try {
    assertValidLinkedInPostUrl(postUrl);
  } catch {
    throw new LinkedInExtractionError("INVALID_URL", "Invalid LinkedIn post URL");
  }

  return withRetries(() => scrapeOnce(postUrl), {
    retries: RETRY_COUNT,
    onRetry: (error, attempt) => {
      logError("Retrying LinkedIn scrape", error, {
        postUrl,
        attempt,
      });
    },
  });
}

export async function downloadLinkedInMedia(mediaEntries) {
  const dedupedEntries = [];
  const seenUrls = new Set();

  for (const entry of mediaEntries || []) {
    const url = normalizeWhitespace(entry?.url);
    if (!url || seenUrls.has(url) || !isAllowedLinkedInMediaUrl(url)) {
      continue;
    }

    seenUrls.add(url);
    dedupedEntries.push({
      url,
      requestedType: entry?.type || "image",
    });
  }

  if (dedupedEntries.length === 0) {
    return [];
  }

  const limit = pLimit(DOWNLOAD_CONCURRENCY);
  const entries = dedupedEntries.slice(0, MAX_DOWNLOAD_COUNT);
  const downloads = entries.map((entry, index) =>
    limit(async () => {
      try {
        const response = await fetchWithRedirectGuard(entry.url, {
          allowedHosts: isAllowedLinkedInMediaHost,
          headers: MEDIA_HEADERS,
          timeoutMs: 12_000,
          maxRedirects: 2,
        });

        if (!response.ok) {
          throw new Error(`Media download returned ${response.status}`);
        }

        const contentTypeHeader = (
          response.headers.get("content-type") || ""
        ).toLowerCase();
        const mimeType = contentTypeHeader.split(";")[0].trim();
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) {
          throw new Error("Empty media buffer");
        }

        const mediaType = inferMediaType(entry.requestedType, mimeType, entry.url);
        if (!mediaType) {
          throw new Error(`Unsupported content type: ${contentTypeHeader}`);
        }

        return {
          url: entry.url,
          buffer,
          mediaType,
          mimeType,
          filename: mediaFilename(index, mediaType, mimeType, entry.url),
        };
      } catch (error) {
        logError("Skipping media after download failure", error, { url: entry.url });
        return null;
      }
    }),
  );

  const result = await Promise.all(downloads);
  return result.filter(Boolean);
}
