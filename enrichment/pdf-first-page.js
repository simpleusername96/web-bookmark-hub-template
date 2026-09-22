"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { RegistryError } = require("../registry/errors.js");

const runFile = promisify(execFile);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function renderPdfFirstPage(bytes, dataDir, options = {}) {
  const directory = await fs.mkdtemp(path.join(path.resolve(dataDir), "ai-pdf-page-"));
  const inputFile = path.join(directory, "source.pdf");
  const outputPrefix = path.join(directory, "first-page");
  const filePath = `${outputPrefix}.png`;
  try {
    await fs.writeFile(inputFile, bytes);
    await (options.runFile || runFile)(options.command || "pdftoppm", [
      "-f", "1", "-l", "1", "-singlefile", "-scale-to", "1600", "-png",
      inputFile, outputPrefix
    ], { timeout: 20_000, windowsHide: true, maxBuffer: 8192 });
    const stat = await fs.stat(filePath);
    if (!stat.size || stat.size > MAX_IMAGE_BYTES) {
      throw new RegistryError("AI_PDF_RENDER_FAILED", "First PDF page image is empty or too large.");
    }
    return { filePath, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(error.code === "ENOENT" ? "AI_PDF_RENDER_UNAVAILABLE" : "AI_PDF_RENDER_FAILED",
      "The first PDF page could not be rendered.");
  }
}

module.exports = { renderPdfFirstPage };
