// Runs `node --check` on every source file so CI catches syntax errors in all modules, not just the entry point.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "src");
const files = fs.readdirSync(srcDir).filter((name) => name.endsWith(".js"));
for (const name of files) {
  execFileSync(process.execPath, ["--check", path.join(srcDir, name)], { stdio: "inherit" });
}
console.log(`Syntax OK: ${files.length} files in src/`);
