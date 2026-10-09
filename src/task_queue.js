const { logEvent } = require("./logger");

// Runs tasks one at a time per chat, with a global concurrency cap across chats.
class TaskQueue {
  constructor(maxGlobalConcurrent = 3, { maxTrackedTasks = 1000 } = {}) {
    this.maxGlobalConcurrent = maxGlobalConcurrent;
    this.maxTrackedTasks = maxTrackedTasks;
    this.groupQueues = new Map(); // chatId -> Array of task descriptors
    this.activeGroups = new Set(); // set of chatIds currently running a task
    this.runningCount = 0;
    this.taskStatuses = new Map(); // taskId -> { status, chatId, messageId, queuedAt, startedAt, endedAt, durationMs, error }
  }

  getTaskStatus(taskId) {
    return this.taskStatuses.get(taskId) || null;
  }

  getActiveTasks() {
    const tasks = [];
    for (const [taskId, info] of this.taskStatuses.entries()) {
      if (info.status === "queued" || info.status === "running") {
        tasks.push({ taskId, ...info });
      }
    }
    return tasks;
  }

  enqueue(chatId, taskDescriptor) {
    const key = String(chatId);
    if (!this.groupQueues.has(key)) {
      this.groupQueues.set(key, []);
    }
    this.taskStatuses.set(taskDescriptor.taskId, {
      status: "queued",
      chatId: key,
      messageId: taskDescriptor.messageId,
      queuedAt: new Date().toISOString(),
    });

    const promise = new Promise((resolve, reject) => {
      this.groupQueues.get(key).push({
        ...taskDescriptor,
        chatId: key,
        resolve,
        reject,
      });
    });
    this.drain();
    return promise;
  }

  drain() {
    if (this.runningCount >= this.maxGlobalConcurrent) {
      return;
    }

    for (const [chatId, queue] of this.groupQueues.entries()) {
      if (this.runningCount >= this.maxGlobalConcurrent) break;
      if (this.activeGroups.has(chatId) || queue.length === 0) continue;

      const item = queue.shift();
      if (!item) continue;

      this.activeGroups.add(chatId);
      this.runningCount++;

      this.runItem(item).finally(() => {
        this.activeGroups.delete(chatId);
        this.runningCount--;
        this.pruneStatuses();
        this.drain();
      });
    }
  }

  // Finished task statuses are kept for observability, but bounded so a long-running process does not leak memory.
  pruneStatuses() {
    for (const [taskId, info] of this.taskStatuses) {
      if (this.taskStatuses.size <= this.maxTrackedTasks) break;
      if (info.status !== "queued" && info.status !== "running") this.taskStatuses.delete(taskId);
    }
  }

  async runItem(item) {
    const startTime = Date.now();
    const taskInfo = this.taskStatuses.get(item.taskId) || {};
    this.taskStatuses.set(item.taskId, {
      ...taskInfo,
      status: "running",
      startedAt: new Date().toISOString(),
    });

    logEvent("task_status", {
      task_id: item.taskId,
      chat_id: item.chatId,
      message_id: item.messageId,
      status: "running",
    });

    try {
      const result = await item.execute();
      const durationMs = Date.now() - startTime;
      this.taskStatuses.set(item.taskId, {
        ...this.taskStatuses.get(item.taskId),
        status: "succeeded",
        endedAt: new Date().toISOString(),
        durationMs,
      });

      logEvent("task_status", {
        task_id: item.taskId,
        chat_id: item.chatId,
        message_id: item.messageId,
        duration_ms: durationMs,
        status: "succeeded",
      });
      item.resolve(result);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const isTimeout = err.code === "ETIMEDOUT" || /timeout/i.test(err.message);
      const status = isTimeout ? "timed_out" : "failed";
      this.taskStatuses.set(item.taskId, {
        ...this.taskStatuses.get(item.taskId),
        status,
        endedAt: new Date().toISOString(),
        durationMs,
        error: err.message,
        error_code: err.code || (isTimeout ? "ETIMEDOUT" : "EXEC_ERROR"),
      });

      logEvent("task_status", {
        task_id: item.taskId,
        chat_id: item.chatId,
        message_id: item.messageId,
        duration_ms: durationMs,
        error_code: err.code || (isTimeout ? "ETIMEDOUT" : "EXEC_ERROR"),
        error: err.message,
        status,
      });
      item.reject(err);
    }
  }
}

module.exports = { TaskQueue };
