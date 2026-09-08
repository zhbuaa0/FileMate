const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  HEADER_BYTES,
  collectFolderFiles,
  decryptFile,
  encryptFile,
} = require("../src/crypto");

test("文件夹递归选取且文件可安全往返解密", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "safebatch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const folder = path.join(directory, "合同资料");
  const nested = path.join(folder, "归档", "二级目录");
  await fs.mkdir(nested, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(folder, "合同.docx"), "word"),
    fs.writeFile(path.join(folder, "附件.pdf"), "pdf"),
    fs.writeFile(path.join(nested, "材料.zip"), "zip"),
    fs.writeFile(path.join(nested, "已加密.sbox"), "encrypted"),
  ]);
  const relative = (filePath) => path.relative(folder, filePath);
  assert.deepEqual(
    (await collectFolderFiles(folder, "encrypt")).map(relative).sort(),
    ["合同.docx", path.join("归档", "二级目录", "材料.zip"), "附件.pdf"].sort(),
  );
  assert.deepEqual(
    (await collectFolderFiles(folder, "decrypt")).map(relative),
    [path.join("归档", "二级目录", "已加密.sbox")],
  );

  const source = path.join(directory, "旅行照片.txt");
  const encrypted = `${source}.sbox`;
  const restored = path.join(directory, "restored.txt");
  const original = Buffer.concat([
    Buffer.from("SafeBatch 往返测试\n"),
    Buffer.alloc(1024 * 1024, 0xa5),
  ]);
  await fs.writeFile(source, original);

  await encryptFile(source, encrypted, "一条足够长的测试密码");
  await decryptFile(encrypted, restored, "一条足够长的测试密码");
  assert.deepEqual(await fs.readFile(restored), original);

  const wrongOutput = path.join(directory, "wrong.txt");
  await assert.rejects(
    decryptFile(encrypted, wrongOutput, "完全错误的密码"),
    { code: "AUTH_FAILED" },
  );
  await assert.rejects(fs.access(wrongOutput), { code: "ENOENT" });

  const damaged = path.join(directory, "damaged.sbox");
  const bytes = await fs.readFile(encrypted);
  bytes[HEADER_BYTES + 3] ^= 1;
  await fs.writeFile(damaged, bytes);
  const damagedOutput = path.join(directory, "damaged.txt");
  await assert.rejects(
    decryptFile(damaged, damagedOutput, "一条足够长的测试密码"),
    { code: "AUTH_FAILED" },
  );
  await assert.rejects(fs.access(damagedOutput), { code: "ENOENT" });
});
