const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const MAGIC = Buffer.from("SAFEBOX1");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class SafeBoxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SafeBoxError";
    this.code = code;
  }
}

function checkCancelled(isCancelled) {
  if (isCancelled?.()) {
    throw new SafeBoxError("CANCELLED", "操作已取消");
  }
}

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    const secret = Buffer.from(password, "utf8");
    crypto.scrypt(secret, salt, 32, SCRYPT_OPTIONS, (error, key) => {
      secret.fill(0);
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function makeHeader(salt, iv) {
  return Buffer.concat([MAGIC, salt, iv]);
}

function validateEncryptPassword(password) {
  if (typeof password !== "string" || [...password].length < 8) {
    throw new SafeBoxError("WEAK_PASSWORD", "密码至少需要 8 个字符");
  }
}

async function collectFolderFiles(root, mode, limit = 5000) {
  if (!["encrypt", "decrypt"].includes(mode)) {
    throw new SafeBoxError("INVALID_MODE", "请选择加密或解密模式");
  }

  const paths = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (
        entry.isFile() &&
        (mode !== "decrypt" || entry.name.toLowerCase().endsWith(".sbox")) &&
        (mode !== "encrypt" || !entry.name.toLowerCase().endsWith(".sbox"))
      ) {
        paths.push(entryPath);
        // ponytail: keep the file list responsive; add pagination before raising this ceiling.
        if (paths.length >= limit) return paths;
      }
    }
  }
  return paths;
}

async function fileInfo(inputPath) {
  const stat = await fsp.stat(inputPath);
  if (!stat.isFile()) {
    throw new SafeBoxError("NOT_A_FILE", "只能处理普通文件");
  }
  return stat;
}

function temporaryPath(outputPath) {
  return path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.partial-${crypto.randomUUID()}`,
  );
}

async function commitTemporaryFile(tempPath, outputPath) {
  try {
    await fsp.access(outputPath);
    throw new SafeBoxError("OUTPUT_EXISTS", "目标文件已存在");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fsp.rename(tempPath, outputPath);
}

async function encryptFile(inputPath, outputPath, password, options = {}) {
  validateEncryptPassword(password);
  const stat = await fileInfo(inputPath);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const header = makeHeader(salt, iv);
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const tempPath = temporaryPath(outputPath);
  cipher.setAAD(header);

  async function* encryptedChunks() {
    yield header;
    let completed = 0;
    for await (const chunk of fs.createReadStream(inputPath)) {
      checkCancelled(options.isCancelled);
      completed += chunk.length;
      const encrypted = cipher.update(chunk);
      if (encrypted.length) yield encrypted;
      options.onProgress?.(completed, stat.size);
    }
    checkCancelled(options.isCancelled);
    const final = cipher.final();
    if (final.length) yield final;
    yield cipher.getAuthTag();
    options.onProgress?.(stat.size, stat.size);
  }

  try {
    await pipeline(
      Readable.from(encryptedChunks()),
      fs.createWriteStream(tempPath, { flags: "wx" }),
    );
    checkCancelled(options.isCancelled);
    await commitTemporaryFile(tempPath, outputPath);
    return outputPath;
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  } finally {
    key.fill(0);
  }
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (!bytesRead) throw new SafeBoxError("INVALID_FILE", "文件格式不完整");
    offset += bytesRead;
  }
  return buffer;
}

async function readEnvelope(inputPath) {
  const stat = await fileInfo(inputPath);
  if (stat.size < HEADER_BYTES + TAG_BYTES) {
    throw new SafeBoxError("INVALID_FILE", "不是有效的 SafeBatch 文件");
  }

  const handle = await fsp.open(inputPath, "r");
  try {
    const header = await readExactly(handle, HEADER_BYTES, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new SafeBoxError("INVALID_FILE", "不是有效的 SafeBatch 文件");
    }
    const tag = await readExactly(handle, TAG_BYTES, stat.size - TAG_BYTES);
    return {
      stat,
      header,
      tag,
      salt: header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES),
      iv: header.subarray(MAGIC.length + SALT_BYTES),
      encryptedBytes: stat.size - HEADER_BYTES - TAG_BYTES,
    };
  } finally {
    await handle.close();
  }
}

async function decryptFile(inputPath, outputPath, password, options = {}) {
  if (typeof password !== "string" || !password.length) {
    throw new SafeBoxError("MISSING_PASSWORD", "请输入密码");
  }

  const envelope = await readEnvelope(inputPath);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const key = await deriveKey(password, envelope.salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, envelope.iv);
  const tempPath = temporaryPath(outputPath);
  decipher.setAAD(envelope.header);
  decipher.setAuthTag(envelope.tag);

  async function* decryptedChunks() {
    let completed = 0;
    if (envelope.encryptedBytes) {
      const source = fs.createReadStream(inputPath, {
        start: HEADER_BYTES,
        end: envelope.stat.size - TAG_BYTES - 1,
      });
      for await (const chunk of source) {
        checkCancelled(options.isCancelled);
        completed += chunk.length;
        const decrypted = decipher.update(chunk);
        if (decrypted.length) yield decrypted;
        options.onProgress?.(completed, envelope.encryptedBytes);
      }
    }
    checkCancelled(options.isCancelled);
    try {
      const final = decipher.final();
      if (final.length) yield final;
    } catch {
      throw new SafeBoxError("AUTH_FAILED", "密码错误或文件已损坏");
    }
    options.onProgress?.(envelope.encryptedBytes, envelope.encryptedBytes);
  }

  try {
    await pipeline(
      Readable.from(decryptedChunks()),
      fs.createWriteStream(tempPath, { flags: "wx" }),
    );
    checkCancelled(options.isCancelled);
    await commitTemporaryFile(tempPath, outputPath);
    return outputPath;
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  } finally {
    key.fill(0);
  }
}

module.exports = {
  HEADER_BYTES,
  MAGIC,
  SafeBoxError,
  collectFolderFiles,
  decryptFile,
  encryptFile,
  readEnvelope,
};
