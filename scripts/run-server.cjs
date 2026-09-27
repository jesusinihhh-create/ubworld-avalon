const path = require("path");
const { spawn } = require("child_process");

const packageRoot = path.join(__dirname, "..");
const serverPath = path.join(packageRoot, "server.cjs");

let child;
let stopping = false;
let restartTimer;

function startServer() {
  if (stopping) return;

  child = spawn(process.execPath, [serverPath], {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error("BonziWorld server process failed:", error);
  });

  child.on("exit", (code, signal) => {
    child = undefined;
    if (stopping) {
      process.exitCode = code || (signal ? 1 : 0);
      return;
    }

    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    console.log(`BonziWorld server stopped (${reason}); restarting...`);
    restartTimer = setTimeout(startServer, 250);
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child && child.exitCode === null) child.kill(signal);
  else process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

startServer();