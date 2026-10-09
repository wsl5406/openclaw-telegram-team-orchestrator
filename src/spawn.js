const { spawn } = require("child_process");

function spawnAsync(cmd, args, { input, timeout = 180000, env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timer = null;
    let killed = false;

    const child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });

    if (timeout > 0) {
      timer = setTimeout(() => {
        killed = true;
        try {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", child.pid.toString(), "/T", "/F"]).on("error", () => {});
          } else {
            child.kill("SIGKILL");
          }
        } catch {}
        const err = new Error(`Command timed out after ${timeout}ms: ${cmd} ${args.join(" ")}`);
        err.code = "ETIMEDOUT";
        reject(err);
      }, timeout);
    }

    // A child that exits before reading stdin raises EPIPE on this stream; without a listener
    // that error is thrown and takes down the whole orchestrator.
    child.stdin.on("error", () => {});
    if (input != null) {
      child.stdin.end(input, "utf8");
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killed) return;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

module.exports = { spawnAsync };
