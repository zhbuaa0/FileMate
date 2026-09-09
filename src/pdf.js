"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PDFDocument } = require("pdf-lib");

const MAX_PARTS = 500;

function invalid(message) {
  const error = new Error(message);
  error.code = "INVALID_PDF_SPLIT";
  return error;
}

async function inspectPdf(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || path.extname(filePath).toLowerCase() !== ".pdf") {
    throw invalid("请选择 PDF 文件");
  }
  const document = await PDFDocument.load(await fs.readFile(filePath));
  return { pageCount: document.getPageCount(), size: stat.size };
}

function normalizeParts(parts, pageCount) {
  if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS) {
    throw invalid(`拆分清单需要包含 1–${MAX_PARTS} 个文件`);
  }

  const names = new Set();
  return parts.map((part, index) => {
    const start = Number(part?.start);
    const end = Number(part?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > pageCount) {
      throw invalid(`第 ${index + 1} 项的页码范围无效`);
    }

    const base = String(part?.name || "").trim().replace(/\.pdf$/i, "");
    if (
      !base ||
      base === "." ||
      base === ".." ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(base) ||
      /[. ]$/.test(base) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)
    ) {
      throw invalid(`第 ${index + 1} 项的文件名无效`);
    }
    const filename = `${base}.pdf`;
    const key = filename.toLocaleLowerCase();
    if (names.has(key)) throw invalid(`文件名重复：${filename}`);
    names.add(key);
    return { start, end, filename };
  });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function availableOutput(directory, filename) {
  const parsed = path.parse(filename);
  for (let number = 0; ; number += 1) {
    const suffix = number ? ` (${number + 1})` : "";
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
}

async function splitPdf(inputPath, parts, destination, options = {}) {
  const source = await PDFDocument.load(await fs.readFile(inputPath));
  const normalized = normalizeParts(parts, source.getPageCount());
  const directory = destination || path.dirname(inputPath);
  const outputs = [];

  for (let index = 0; index < normalized.length; index += 1) {
    if (options.isCancelled?.()) {
      const error = new Error("已取消");
      error.code = "CANCELLED";
      error.outputs = outputs;
      throw error;
    }

    const part = normalized[index];
    const output = await PDFDocument.create();
    const pageIndexes = Array.from(
      { length: part.end - part.start + 1 },
      (_, offset) => part.start - 1 + offset,
    );
    const pages = await output.copyPages(source, pageIndexes);
    for (const page of pages) output.addPage(page);

    const outputPath = await availableOutput(directory, part.filename);
    const temporaryPath = path.join(directory, `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, await output.save());
      await fs.rename(temporaryPath, outputPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    outputs.push(outputPath);
    options.onProgress?.(index + 1, normalized.length, outputPath);
  }

  return outputs;
}

module.exports = { inspectPdf, normalizeParts, splitPdf };
