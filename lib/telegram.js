import { fetchWithTimeout, safeJson, trimForTelegram } from "./utils.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 12_000;
const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

function buildTelegramMethodUrl(token, method) {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

async function callTelegramApi(token, method, { json, formData } = {}) {
  if (!token) {
    throw new Error("Missing Telegram bot token");
  }

  const hasJsonBody = typeof json !== "undefined";
  const response = await fetchWithTimeout(buildTelegramMethodUrl(token, method), {
    method: "POST",
    headers: hasJsonBody ? { "content-type": "application/json" } : undefined,
    body: hasJsonBody ? JSON.stringify(json) : formData,
    timeoutMs: TELEGRAM_TIMEOUT_MS,
  });

  const payload = await safeJson(response);

  if (!response.ok || !payload?.ok) {
    const reason = payload?.description || `HTTP ${response.status}`;
    throw new Error(`Telegram API ${method} failed: ${reason}`);
  }

  return payload.result;
}

export async function sendMessage(token, { chatId, text }) {
  return callTelegramApi(token, "sendMessage", {
    json: {
      chat_id: chatId,
      text: trimForTelegram(text, 3900),
      disable_web_page_preview: true,
    },
  });
}

export async function sendPhoto(
  token,
  { chatId, buffer, filename = "linkedin-image.jpg", caption = "", mimeType = "image/jpeg" },
) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) {
    form.set("caption", trimForTelegram(caption, 1024));
  }

  form.append("photo", new Blob([buffer], { type: mimeType }), filename);
  return callTelegramApi(token, "sendPhoto", { formData: form });
}

export async function sendVideo(
  token,
  { chatId, buffer, filename = "linkedin-video.mp4", caption = "", mimeType = "video/mp4" },
) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("supports_streaming", "true");
  if (caption) {
    form.set("caption", trimForTelegram(caption, 1024));
  }

  form.append("video", new Blob([buffer], { type: mimeType }), filename);
  return callTelegramApi(token, "sendVideo", { formData: form });
}

export async function sendMediaGroup(token, { chatId, mediaFiles }) {
  const files = mediaFiles.slice(0, TELEGRAM_MEDIA_GROUP_LIMIT);
  if (files.length === 0) {
    return null;
  }

  const form = new FormData();
  const media = files.map((file, index) => {
    const isVideo = file.mediaType === "video";
    return {
      type: isVideo ? "video" : "photo",
      media: `attach://media_${index}`,
      ...(isVideo ? { supports_streaming: true } : {}),
    };
  });

  form.set("chat_id", String(chatId));
  form.set("media", JSON.stringify(media));

  files.forEach((file, index) => {
    form.append(
      `media_${index}`,
      new Blob([file.buffer], { type: file.mimeType || "application/octet-stream" }),
      file.filename || `linkedin-media-${index + 1}`,
    );
  });

  return callTelegramApi(token, "sendMediaGroup", { formData: form });
}

export async function sendDocument(
  token,
  {
    chatId,
    buffer,
    filename = "linkedin-file.zip",
    caption = "",
    mimeType = "application/octet-stream",
  },
) {
  const form = new FormData();

  form.set("chat_id", String(chatId));
  if (caption) {
    form.set("caption", trimForTelegram(caption, 1024));
  }

  form.append(
    "document",
    new Blob([buffer], { type: mimeType }),
    filename,
  );

  return callTelegramApi(token, "sendDocument", { formData: form });
}
