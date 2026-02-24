import archiver from "archiver";
import { PassThrough } from "node:stream";

export async function createZipBuffer(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("No files provided for ZIP creation");
  }

  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const output = new PassThrough();
    const chunks = [];

    output.on("data", (chunk) => {
      chunks.push(chunk);
    });

    output.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);

    for (const file of files) {
      archive.append(file.buffer, { name: file.filename });
    }

    try {
      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
}
