const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PDFDocument } = require("pdf-lib");

const { splitPdf } = require("../src/pdf");

test("按页码范围拆分 PDF 并使用指定文件名", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "filemate-pdf-"));
  try {
    const source = await PDFDocument.create();
    for (let index = 0; index < 5; index += 1) source.addPage();
    const inputPath = path.join(directory, "扫描.pdf");
    await fs.writeFile(inputPath, await source.save());

    const outputs = await splitPdf(inputPath, [
      { start: 1, end: 2, name: "合同" },
      { start: 3, end: 5, name: "发票.pdf" },
    ]);

    assert.deepEqual(outputs.map((output) => path.basename(output)), ["合同.pdf", "发票.pdf"]);
    assert.equal((await PDFDocument.load(await fs.readFile(outputs[0]))).getPageCount(), 2);
    assert.equal((await PDFDocument.load(await fs.readFile(outputs[1]))).getPageCount(), 3);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
