import { z } from "zod";
import {
  extractFirstUrl,
  isValidLinkedInPostUrl,
  logError,
  trimForTelegram,
} from "../lib/utils.js";
import {
  LinkedInExtractionError,
  downloadLinkedInMedia,
  scrapeLinkedInPost,
} from "../lib/linkedin.js";
import {
  sendDocument,
  sendMediaGroup,
  sendMessage,
  sendPhoto,
  sendVideo,
} from "../lib/telegram.js";
import { createZipBuffer } from "../lib/zip.js";

const INVALID_URL_MESSAGE =
  "الرابط غير صالح. الرجاء إرسال رابط منشور من لينكدإن.";
const NO_CONTENT_MESSAGE =
  "لم أستطع استخراج محتوى المنشور. قد يكون خاصًا أو محميًا.";
const PRIVATE_POST_MESSAGE = "قد يكون المنشور خاصًا أو يتطلب تسجيل دخول.";
const GENERIC_ERROR_MESSAGE =
  "حدث خطأ أثناء معالجة الرابط. حاول مرة أخرى لاحقًا.";
const SUCCESS_HEADER = "تم استخراج المنشور بنجاح ✅";

const TelegramMessageSchema = z.object({
  chat: z.object({
    id: z.union([z.number(), z.string()]),
  }),
  text: z.string().optional(),
});

const TelegramUpdateSchema = z
  .object({
    update_id: z.number().optional(),
    message: TelegramMessageSchema.optional(),
    edited_message: TelegramMessageSchema.optional(),
    channel_post: TelegramMessageSchema.optional(),
  })
  .passthrough();

function getIncomingMessage(update) {
  return update.message || update.edited_message || update.channel_post || null;
}

async function parseBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }

  if (Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString("utf8"));
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }

  if (!raw) {
    return {};
  }

  return JSON.parse(raw);
}

async function safeReply(token, chatId, text) {
  try {
    await sendMessage(token, { chatId, text });
  } catch (error) {
    logError("Failed to send Telegram message", error, { chatId });
  }
}

async function sendErrorByType(token, chatId, error) {
  if (error instanceof LinkedInExtractionError) {
    if (error.code === "INVALID_URL") {
      await safeReply(token, chatId, INVALID_URL_MESSAGE);
      return;
    }

    if (error.code === "TEXT_NOT_FOUND") {
      await safeReply(token, chatId, NO_CONTENT_MESSAGE);
      return;
    }

    if (error.code === "PRIVATE_OR_PROTECTED") {
      await safeReply(token, chatId, PRIVATE_POST_MESSAGE);
      return;
    }
  }

  await safeReply(token, chatId, GENERIC_ERROR_MESSAGE);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logError("Missing TELEGRAM_BOT_TOKEN", new Error("Missing env variable"));
    res.status(500).json({ ok: false });
    return;
  }

  let chatId = null;

  try {
    const body = await parseBody(req);
    const parsed = TelegramUpdateSchema.safeParse(body);

    if (!parsed.success) {
      logError(
        "Invalid Telegram webhook payload",
        new Error("Validation failed"),
        { issues: parsed.error.issues },
      );
      res.status(400).json({ ok: false });
      return;
    }

    const message = getIncomingMessage(parsed.data);
    const text = message?.text?.trim();
    chatId = message?.chat?.id ?? null;

    if (!text || chatId === null) {
      res.status(200).json({ ok: true });
      return;
    }

    const maybeUrl = extractFirstUrl(text);
    if (!maybeUrl || !isValidLinkedInPostUrl(maybeUrl)) {
      await safeReply(token, chatId, INVALID_URL_MESSAGE);
      res.status(200).json({ ok: true });
      return;
    }

    const post = await scrapeLinkedInPost(maybeUrl);
    const safeText = trimForTelegram(post.text, 3600);
    await sendMessage(token, {
      chatId,
      text: `${SUCCESS_HEADER}\n\n${safeText}`,
    });

    const mediaTargets = [
      ...post.imageUrls.map((url) => ({ url, type: "image" })),
      ...post.videoUrls.map((url) => ({ url, type: "video" })),
      ...post.documentUrls.map((url) => ({ url, type: "document" })),
    ];

    if (mediaTargets.length === 0) {
      res.status(200).json({ ok: true });
      return;
    }

    const downloadedMedia = await downloadLinkedInMedia(mediaTargets, {
      referer: post.preferredReferer,
    });
    if (downloadedMedia.length === 0) {
      res.status(200).json({ ok: true });
      return;
    }

    const streamableMedia = downloadedMedia.filter(
      (item) => item.mediaType === "image" || item.mediaType === "video",
    );
    const documentMedia = downloadedMedia.filter(
      (item) => item.mediaType === "document",
    );

    if (streamableMedia.length === 1) {
      const singleFile = streamableMedia[0];
      if (singleFile.mediaType === "video") {
        await sendVideo(token, {
          chatId,
          buffer: singleFile.buffer,
          filename: singleFile.filename || "linkedin-video.mp4",
          mimeType: singleFile.mimeType || "video/mp4",
        });
      } else {
        await sendPhoto(token, {
          chatId,
          buffer: singleFile.buffer,
          filename: singleFile.filename || "linkedin-image.jpg",
          mimeType: singleFile.mimeType || "image/jpeg",
        });
      }
    } else if (streamableMedia.length > 1 && streamableMedia.length <= 10) {
      await sendMediaGroup(token, { chatId, mediaFiles: streamableMedia });
    } else if (streamableMedia.length > 10) {
      const zipBuffer = await createZipBuffer(streamableMedia);
      await sendDocument(token, {
        chatId,
        buffer: zipBuffer,
        filename: "linkedin-media.zip",
        mimeType: "application/zip",
        caption: "تم تجميع صور/فيديوهات المنشور في ملف ZIP.",
      });
    }

    for (const file of documentMedia) {
      await sendDocument(token, {
        chatId,
        buffer: file.buffer,
        filename: file.filename || "linkedin-document.pdf",
        mimeType: file.mimeType || "application/pdf",
        caption: "تم استخراج ملف من المنشور.",
      });
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    logError("Failed to process Telegram update", error, { chatId });

    if (chatId !== null) {
      await sendErrorByType(token, chatId, error);
    }

    res.status(200).json({ ok: true });
  }
}
