import { getCoreLogsPath } from "core/util/paths";
import { appendPrivate } from "core/util/privateFiles";
import { scrubForDisk } from "core/util/secretScan/scrubForDisk";

export function setupCoreLogging() {
  const logger = (message: any, ...optionalParams: any[]) => {
    const logFilePath = getCoreLogsPath();
    const timestamp = new Date().toISOString().split(".")[0];
    // X15: a logged request, header or error never keeps a credential
    const logMessage = scrubForDisk(
      `[${timestamp}] ${message} ${optionalParams.join(" ")}\n`,
    );
    appendPrivate(logFilePath, logMessage);
  };
  console.log = logger;
  console.error = logger;
  console.warn = logger;
  console.debug = logger;
  console.log("[info] Starting Continue core...");
}
