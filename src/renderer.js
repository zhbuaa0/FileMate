const elements = {
  cancelButton: document.querySelector("#cancel-button"),
  clearButton: document.querySelector("#clear-button"),
  confirmPassword: document.querySelector("#confirm-password"),
  confirmRow: document.querySelector("#confirm-row"),
  destinationButton: document.querySelector("#destination-button"),
  destinationPath: document.querySelector("#destination-path"),
  destinationTitle: document.querySelector("#destination-title"),
  emptyAddButton: document.querySelector("#empty-add-button"),
  emptyDescription: document.querySelector("#empty-description"),
  emptyState: document.querySelector("#empty-state"),
  fileCount: document.querySelector("#file-count"),
  fileList: document.querySelector("#file-list"),
  fileTable: document.querySelector("#file-table"),
  filesButton: document.querySelector("#files-button"),
  folderButton: document.querySelector("#folder-button"),
  globalProgress: document.querySelector("#global-progress"),
  globalProgressFill: document.querySelector("#global-progress-fill"),
  modeSwitch: document.querySelector("#mode-switch"),
  password: document.querySelector("#password"),
  passwordHelp: document.querySelector("#password-help"),
  queueSummary: document.querySelector("#queue-summary"),
  resetDestination: document.querySelector("#reset-destination"),
  showPassword: document.querySelector("#show-password"),
  settingsTitle: document.querySelector("#settings-title"),
  startButton: document.querySelector("#start-button"),
  statusDetail: document.querySelector("#status-detail"),
  statusDot: document.querySelector("#status-dot"),
  statusText: document.querySelector("#status-text"),
  toast: document.querySelector("#toast"),
  totalSize: document.querySelector("#total-size"),
};

const files = new Map();
const rowRefs = new Map();
let mode = "encrypt";
let destination = null;
let running = false;
let toastTimer;

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function extensionLabel(filename) {
  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot + 1) : "FILE";
  return extension.slice(0, 4).toUpperCase();
}

function showToast(message, tone = "error") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast ${tone}`;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function setFooter(title, detail, tone = "idle") {
  elements.statusText.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.statusDot.className = `status-dot ${tone === "idle" ? "" : tone}`;
}

function createTextElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function renderFile(file) {
  const row = document.createElement("div");
  row.className = "file-row";
  row.setAttribute("role", "listitem");

  const main = document.createElement("div");
  main.className = "file-main";
  const icon = createTextElement("span", "file-icon", extensionLabel(file.name));
  icon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("div");
  copy.className = "file-copy";
  const name = createTextElement("div", "file-name", file.name);
  const filePath = createTextElement("div", "file-path", file.path);
  name.title = file.name;
  filePath.title = file.path;
  copy.append(name, filePath);
  main.append(icon, copy);

  const size = createTextElement("div", "file-size", formatBytes(file.size));
  const statusCell = document.createElement("div");
  statusCell.className = "file-status-cell";
  const status = createTextElement("span", "status-pill", "等待");
  statusCell.append(status);

  const remove = createTextElement("button", "remove-button", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", `移除 ${file.name}`);
  remove.addEventListener("click", () => {
    if (running) return;
    files.delete(file.path);
    renderQueue();
  });

  const progress = document.createElement("div");
  progress.className = "row-progress";
  const progressFill = document.createElement("span");
  progress.append(progressFill);

  row.append(main, size, statusCell, remove, progress);
  rowRefs.set(file.path, { row, status, statusCell, progressFill, remove });
  return row;
}

function renderQueue() {
  rowRefs.clear();
  elements.fileList.replaceChildren(...[...files.values()].map(renderFile));
  const hasFiles = files.size > 0;
  elements.emptyState.hidden = hasFiles;
  elements.fileTable.hidden = !hasFiles;
  elements.queueSummary.hidden = !hasFiles;
  elements.clearButton.disabled = !hasFiles || running;
  elements.startButton.disabled = !hasFiles || running;
  elements.fileCount.textContent = `${files.size} 个文件`;
  elements.totalSize.textContent = formatBytes(
    [...files.values()].reduce((total, file) => total + file.size, 0),
  );
  if (!running) {
    setFooter(
      hasFiles ? "等待开始" : "准备就绪",
      hasFiles ? `已选择 ${files.size} 个文件` : "选择文件夹后即可开始",
    );
  }
}

function addFiles(items) {
  for (const item of items) {
    if (!files.has(item.path)) files.set(item.path, { ...item });
  }
  renderQueue();
}

function updateFile(filePath, state, message, progress, outputPath) {
  const refs = rowRefs.get(filePath);
  if (!refs) return;
  refs.row.classList.toggle("is-working", state === "working");
  refs.status.className = `status-pill ${state === "waiting" ? "" : state}`;
  refs.status.textContent = message;
  refs.progressFill.style.width = `${Math.max(0, Math.min(100, progress || 0))}%`;
  refs.remove.hidden = running;

  refs.statusCell.querySelector(".reveal-button")?.remove();
  if (outputPath) {
    const reveal = createTextElement("button", "reveal-button", "↗");
    reveal.type = "button";
    reveal.title = "在文件夹中显示";
    reveal.setAttribute("aria-label", `显示 ${filePath} 的输出文件`);
    reveal.addEventListener("click", () => window.safeBox.reveal(outputPath));
    refs.statusCell.append(reveal);
  }
}

function resetRows() {
  for (const filePath of files.keys()) updateFile(filePath, "waiting", "等待", 0);
}

function setMode(nextMode) {
  mode = nextMode;
  const encrypting = mode === "encrypt";
  elements.confirmRow.hidden = !encrypting;
  elements.settingsTitle.textContent = encrypting ? "加密设置" : "解密设置";
  elements.passwordHelp.textContent = encrypting
    ? "至少 8 个字符，建议使用长密码短语"
    : "输入加密时使用的原密码";
  elements.emptyDescription.textContent = encrypting
    ? "递归扫描子文件夹，所有普通文件都会逐个加密"
    : "递归查找子文件夹中的 .sbox 文件并逐个恢复";
  if (!destination) {
    elements.destinationPath.textContent = encrypting
      ? "每个文件旁生成 .sbox 副本"
      : "在每个 .sbox 文件旁恢复内容";
  }
  elements.startButton.firstChild.textContent = encrypting ? "开始加密 " : "开始解密 ";
  if (!running) resetRows();
}

function setRunning(value) {
  running = value;
  const controls = [
    elements.clearButton,
    elements.destinationButton,
    elements.emptyAddButton,
    elements.filesButton,
    elements.folderButton,
    elements.password,
    elements.confirmPassword,
    elements.resetDestination,
    elements.showPassword,
    ...elements.modeSwitch.querySelectorAll("input"),
  ];
  for (const control of controls) control.disabled = value;
  elements.startButton.hidden = value;
  elements.cancelButton.hidden = !value;
  elements.globalProgress.hidden = !value;
  elements.clearButton.disabled = value || !files.size;
  for (const refs of rowRefs.values()) refs.remove.hidden = value;
}

async function pickFiles() {
  try {
    addFiles(await window.safeBox.pickFiles(mode));
  } catch (error) {
    showToast(error.message || "无法选择文件");
  }
}

async function pickFolder() {
  try {
    const items = await window.safeBox.pickFolder(mode);
    addFiles(items);
    if (!items.length) {
      showToast(
        mode === "decrypt"
          ? "文件夹中没有 .sbox 文件"
          : "文件夹中没有可加密文件；已有 .sbox 会自动跳过",
        "neutral",
      );
    }
  } catch (error) {
    showToast(error.message || "无法扫描文件夹");
  }
}

elements.filesButton.addEventListener("click", pickFiles);
elements.emptyAddButton.addEventListener("click", pickFolder);
elements.folderButton.addEventListener("click", pickFolder);

elements.clearButton.addEventListener("click", () => {
  files.clear();
  renderQueue();
});

elements.modeSwitch.addEventListener("change", (event) => setMode(event.target.value));

elements.showPassword.addEventListener("click", () => {
  const visible = elements.password.type === "text";
  elements.password.type = visible ? "password" : "text";
  elements.confirmPassword.type = visible ? "password" : "text";
  elements.showPassword.setAttribute("aria-pressed", String(!visible));
  elements.showPassword.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
});

elements.destinationButton.addEventListener("click", async () => {
  try {
    const selected = await window.safeBox.pickDestination();
    if (!selected) return;
    destination = selected;
    elements.destinationTitle.textContent = selected.split(/[\\/]/).pop() || selected;
    elements.destinationPath.textContent = selected;
    elements.destinationPath.title = selected;
    elements.resetDestination.hidden = false;
  } catch (error) {
    showToast(error.message || "无法选择输出文件夹");
  }
});

elements.resetDestination.addEventListener("click", () => {
  destination = null;
  elements.destinationTitle.textContent = "各文件原目录";
  elements.destinationPath.textContent =
    mode === "encrypt" ? "每个文件旁生成 .sbox 副本" : "在每个 .sbox 文件旁恢复内容";
  elements.destinationPath.title = "";
  elements.resetDestination.hidden = true;
});

elements.startButton.addEventListener("click", async () => {
  const password = elements.password.value;
  if (!files.size) return showToast("请先添加文件");
  if (!password) return showToast("请输入密码");
  if (mode === "encrypt" && [...password].length < 8) {
    return showToast("密码至少需要 8 个字符");
  }
  if (mode === "encrypt" && password !== elements.confirmPassword.value) {
    return showToast("两次输入的密码不一致");
  }

  resetRows();
  setRunning(true);
  elements.globalProgressFill.style.width = "0%";
  setFooter(mode === "encrypt" ? "正在加密" : "正在解密", "正在准备…", "active");

  try {
    const result = await window.safeBox.start({
      mode,
      paths: [...files.keys()],
      password,
      destination,
    });
    const succeeded = result.results.filter((item) => item.ok).length;
    const failed = result.results.filter((item) => !item.ok && !item.cancelled).length;
    elements.globalProgressFill.style.width = result.cancelled ? "0%" : "100%";

    if (result.cancelled) {
      setFooter("任务已取消", `已完成 ${succeeded} 个文件`, "error");
    } else if (failed) {
      setFooter("处理完成", `${succeeded} 个成功，${failed} 个失败`, "error");
    } else {
      setFooter("全部完成", `${succeeded} 个文件已安全处理`, "success");
    }
  } catch (error) {
    setFooter("任务失败", error.message || "无法完成操作", "error");
    showToast(error.message || "无法完成操作");
  } finally {
    elements.password.value = "";
    elements.confirmPassword.value = "";
    elements.cancelButton.disabled = false;
    elements.cancelButton.textContent = "取消任务";
    setRunning(false);
  }
});

elements.cancelButton.addEventListener("click", async () => {
  elements.cancelButton.disabled = true;
  elements.cancelButton.textContent = "正在取消…";
  await window.safeBox.cancel();
});

window.safeBox.onProgress((event) => {
  if (event.type === "file-start") {
    updateFile(event.path, "working", mode === "encrypt" ? "加密中" : "解密中", 0);
    setFooter(
      mode === "encrypt" ? "正在加密" : "正在解密",
      `${event.index + 1} / ${event.count}`,
      "active",
    );
  } else if (event.type === "file-progress") {
    const filePercent = event.total ? (event.completed / event.total) * 100 : 100;
    const globalPercent = ((event.index + filePercent / 100) / event.count) * 100;
    updateFile(
      event.path,
      "working",
      `${Math.round(filePercent)}%`,
      filePercent,
    );
    elements.globalProgressFill.style.width = `${globalPercent}%`;
  } else if (event.type === "file-done") {
    updateFile(event.path, "done", "已完成", 100, event.outputPath);
  } else if (event.type === "file-error") {
    updateFile(event.path, "error", "失败", 0);
    const refs = rowRefs.get(event.path);
    if (refs) refs.status.title = event.message;
  } else if (event.type === "file-cancelled") {
    updateFile(event.path, "cancelled", "已取消", 0);
  }
});

renderQueue();
