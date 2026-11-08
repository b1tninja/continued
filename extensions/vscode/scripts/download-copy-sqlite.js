const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");

const { ProxyAgent } = require("undici");
const { rimrafSync } = require("rimraf");

const { execCmdSync } = require("../../../scripts/util");

const DOWNLOAD_ATTEMPTS = 6;
const DOWNLOAD_RETRY_BASE_MS = 5000;

/**
 * download a file using fetch API
 * @param {string} url
 * @param {string} outputPath
 */
async function downloadFile(url, outputPath) {
  // Use proxy if set in environment variables
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  const agent = proxy ? new ProxyAgent(proxy) : undefined;

  // GitHub release downloads return 5xx for minutes at a time, so a server
  // error or a dropped connection is worth waiting out. A 4xx is not.
  let buffer;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "follow", // Automatically follow redirects
        dispatcher: agent,
      });
      if (!response.ok) {
        const error = new Error(
          `Failed to download file, status code: ${response.status}`,
        );
        error.retryable = response.status >= 500 || response.status === 429;
        throw error;
      }
      buffer = await response.arrayBuffer();
      break;
    } catch (error) {
      // fetch rejects with a TypeError when the connection fails
      const retryable = error.retryable ?? true;
      if (!retryable || attempt >= DOWNLOAD_ATTEMPTS) throw error;
      const delayMs = DOWNLOAD_RETRY_BASE_MS * 2 ** (attempt - 1);
      console.log(
        `[info] Download failed (${error.message}); retrying in ${delayMs / 1000}s (${attempt}/${DOWNLOAD_ATTEMPTS})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Create output directory if it doesn't exist
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

/**
 *
 * @param {string} target platform specific target
 * @param {string} targetDir the directory to download into
 */
async function downloadSqlite(target, targetDir) {
  const downloadUrl =
    // node-sqlite3 doesn't have a pre-built binary for win32-arm64
    target === "win32-arm64"
      ? "https://continue-server-binaries.s3.us-west-1.amazonaws.com/win32-arm64/node_sqlite3.tar.gz"
      : `https://github.com/TryGhost/node-sqlite3/releases/download/v5.1.7/sqlite3-v5.1.7-napi-v6-${
          target
        }.tar.gz`;
  await downloadFile(downloadUrl, targetDir);
}

async function installAndCopySqlite(target) {
  // Replace the installed with pre-built
  console.log("[info] Downloading pre-built sqlite3 binary");
  rimrafSync("../../core/node_modules/sqlite3/build");
  await downloadSqlite(target, "../../core/node_modules/sqlite3/build.tar.gz");
  execCmdSync("cd ../../core/node_modules/sqlite3 && tar -xvzf build.tar.gz");
  fs.unlinkSync("../../core/node_modules/sqlite3/build.tar.gz");
}

async function installAndCopyEsbuild(target) {
  // Download and unzip esbuild
  console.log("[info] Downloading pre-built esbuild binary");
  rimrafSync("node_modules/@esbuild");
  fs.mkdirSync("node_modules/@esbuild", { recursive: true });
  await downloadFile(
    `https://continue-server-binaries.s3.us-west-1.amazonaws.com/${target}/esbuild.zip`,
    "node_modules/@esbuild/esbuild.zip",
  );
  execCmdSync("cd node_modules/@esbuild && unzip esbuild.zip");
  fs.unlinkSync("node_modules/@esbuild/esbuild.zip");
}

process.on("message", (msg) => {
  const { operation, target } = msg.payload;
  if (operation === "sqlite") {
    installAndCopySqlite(target)
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
  if (operation === "esbuild") {
    installAndCopyEsbuild(target)
      .then(() => process.send({ done: true }))
      .catch((error) => {
        console.error(error); // show the error in the parent process
        process.send({ error: true });
      });
  }
});

/**
 * @param {string} target the platform to build for
 */
async function copySqlite(target) {
  const child = fork(__filename, { stdio: "inherit", cwd: process.cwd() });
  child.send({
    payload: {
      operation: "sqlite",
      target,
    },
  });

  return new Promise((resolve, reject) => {
    child.on("message", (msg) => {
      if (msg.error) {
        reject();
      } else {
        resolve();
      }
    });
  });
}

/**
 * @param {string} target the platform to build for
 */
async function copyEsbuild(target) {
  const child = fork(__filename, { stdio: "inherit", cwd: process.cwd() });
  child.send({
    payload: {
      operation: "esbuild",
      target,
    },
  });

  return new Promise((resolve, reject) => {
    child.on("message", (msg) => {
      if (msg.error) {
        reject();
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  downloadSqlite,
  copySqlite,
  copyEsbuild,
};
