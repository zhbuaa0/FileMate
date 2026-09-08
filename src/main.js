const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const { collectFolderFiles, decryptFile, encryptFile } = require("./crypto");

const MAX_FILES = 5000;
let mainWindow;
let activeJob;
let lastOutputs = new Set();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: "#f4f6fb",
    autoHideMenuBar: true,
    title: "FileMate",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

function trustedWindow(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window !== mainWindow) throw new Error("拒绝未知页面请求");
  return window;
}

async function describeFiles(paths) {
  const files = [];
  for (const filePath of paths) {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) {
      files.push({ path: filePath, name: path.basename(filePath), size: stat.size });
    }
  }
  return files;
}

function validateBatch(payload) {
  if (!payload || !["encrypt", "decrypt"].includes(payload.mode)) {
    throw new Error("请选择加密或解密模式");
  }
  if (!Array.isArray(payload.paths) || !payload.paths.length) {
    throw new Error("请先添加文件");
  }
  if (payload.paths.length > MAX_FILES) throw new Error(`单次最多处理 ${MAX_FILES} 个文件`);
  if (
    payload.paths.some(
      (filePath) => typeof filePath !== "string" || !path.isAbsolute(filePath),
    )
  ) {
    throw new Error("文件路径无效");
  }
  if (typeof payload.password !== "string" || payload.password.length > 1024) {
    throw new Error("密码无效");
  }
  if (payload.destination != null) {
    if (typeof payload.destination !== "string" || !path.isAbsolute(payload.destination)) {
      throw new Error("输出目录无效");
    }
  }
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

function outputFilename(inputPath, mode) {
  const filename = path.basename(inputPath);
  if (mode === "encrypt") return `${filename}.sbox`;
  if (filename.toLowerCase().endsWith(".sbox")) {
    return filename.slice(0, -5) || "解密文件";
  }
  return `${filename}.decrypted`;
}

async function availableOutput(inputPath, mode, destination) {
  const directory = destination || path.dirname(inputPath);
  const filename = outputFilename(inputPath, mode);
  const parsed = path.parse(filename);

  for (let number = 0; ; number += 1) {
    const suffix = number ? ` (${number + 1})` : "";
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
}

function messageFor(error) {
  const messages = {
    AUTH_FAILED: "密码错误或文件已损坏",
    CANCELLED: "已取消",
    INVALID_FILE: "不是有效的 FileMate 加密文件",
    MISSING_PASSWORD: "请输入密码",
    NOT_A_FILE: "不是普通文件",
    OUTPUT_EXISTS: "目标文件已存在",
    WEAK_PASSWORD: "密码至少需要 8 个字符",
  };
  return messages[error.code] || error.message || "处理失败";
}

function sendProgress(event, data) {
  if (!event.sender.isDestroyed()) event.sender.send("batch:progress", data);
}

async function runBatch(event, payload) {
  trustedWindow(event);
  validateBatch(payload);
  if (activeJob) throw new Error("已有任务正在运行");

  if (payload.destination) {
    const stat = await fs.stat(payload.destination);
    if (!stat.isDirectory()) throw new Error("输出位置不是文件夹");
  }

  const uniquePaths = [...new Set(payload.paths)];
  const job = { cancelled: false };
  activeJob = job;
  lastOutputs = new Set();
  const results = [];

  try {
    for (let index = 0; index < uniquePaths.length; index += 1) {
      const inputPath = uniquePaths[index];
      if (job.cancelled) break;

      sendProgress(event, {
        type: "file-start",
        path: inputPath,
        index,
        count: uniquePaths.length,
      });

      let lastUpdate = 0;
      try {
        const outputPath = await availableOutput(
          inputPath,
          payload.mode,
          payload.destination,
        );
        const processFile = payload.mode === "encrypt" ? encryptFile : decryptFile;
        await processFile(inputPath, outputPath, payload.password, {
          isCancelled: () => job.cancelled,
          onProgress: (completed, total) => {
            const now = Date.now();
            if (completed === total || now - lastUpdate >= 80) {
              lastUpdate = now;
              sendProgress(event, {
                type: "file-progress",
                path: inputPath,
                index,
                count: uniquePaths.length,
                completed,
                total,
              });
            }
          },
        });
        lastOutputs.add(outputPath);
        results.push({ path: inputPath, ok: true, outputPath });
        sendProgress(event, { type: "file-done", path: inputPath, outputPath });
      } catch (error) {
        const cancelled = error.code === "CANCELLED";
        if (cancelled) job.cancelled = true;
        results.push({ path: inputPath, ok: false, cancelled, message: messageFor(error) });
        sendProgress(event, {
          type: cancelled ? "file-cancelled" : "file-error",
          path: inputPath,
          message: messageFor(error),
        });
      }
    }

    if (job.cancelled) {
      const finished = new Set(results.map((result) => result.path));
      for (const inputPath of uniquePaths) {
        if (!finished.has(inputPath)) {
          results.push({ path: inputPath, ok: false, cancelled: true, message: "已取消" });
          sendProgress(event, { type: "file-cancelled", path: inputPath, message: "已取消" });
        }
      }
    }

  } finally {
    activeJob = undefined;
  }

  return { cancelled: job.cancelled, results };
}

function registerIpc() {
  ipcMain.handle("files:pick", async (event, mode) => {
    const window = trustedWindow(event);
    const result = await dialog.showOpenDialog(window, {
      title: mode === "decrypt" ? "选择要解密的文件" : "选择要加密的文件",
      buttonLabel: "添加",
      properties: ["openFile", "multiSelections"],
      filters:
        mode === "decrypt"
          ? [
              { name: "FileMate 加密文件", extensions: ["sbox"] },
              { name: "所有文件", extensions: ["*"] },
            ]
          : undefined,
    });
    return result.canceled ? [] : describeFiles(result.filePaths);
  });

  ipcMain.handle("folder:pick", async (event, mode) => {
    const window = trustedWindow(event);
    const result = await dialog.showOpenDialog(window, {
      title: mode === "decrypt" ? "选择要解密的文件夹" : "选择要加密的文件夹",
      buttonLabel: "扫描文件",
      properties: ["openDirectory"],
    });
    if (result.canceled) return [];
    const paths = await collectFolderFiles(result.filePaths[0], mode, MAX_FILES);
    return describeFiles(paths);
  });

  ipcMain.handle("destination:pick", async (event) => {
    const window = trustedWindow(event);
    const result = await dialog.showOpenDialog(window, {
      title: "选择输出文件夹",
      buttonLabel: "选择",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("batch:start", runBatch);
  ipcMain.handle("batch:cancel", (event) => {
    trustedWindow(event);
    if (activeJob) activeJob.cancelled = true;
  });
  ipcMain.handle("output:reveal", (event, outputPath) => {
    trustedWindow(event);
    if (typeof outputPath === "string" && lastOutputs.has(outputPath)) {
      shell.showItemInFolder(outputPath);
    }
  });
}

app.setName("FileMate");
app.whenReady().then(() => {
  createWindow();
  registerIpc();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
