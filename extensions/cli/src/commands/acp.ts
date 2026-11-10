import { AcpAgent } from "../acp/agent.js";
import { createCliBackend } from "../acp/backend.js";
import { JsonRpcPeer } from "../acp/rpc.js";
import { getVersion } from "../version.js";

import { ExtendedCommandOptions } from "./BaseCommandOptions.js";

/**
 * `continuous acp`: speak the Agent Client Protocol on stdin and stdout, so an
 * editor that runs ACP agents (Zed, JetBrains, the Neovim and Emacs plugins)
 * can start this CLI as a subprocess and drive it.
 *
 * stdout carries the protocol and nothing else: once the protocol has its own
 * handle, everything else that writes to process.stdout (the logger, a stray
 * console.log) is sent to stderr.
 */
export async function acp(options: ExtendedCommandOptions = {}) {
  const protocolWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(
    process.stderr,
  ) as typeof process.stdout.write;

  const peer = new JsonRpcPeer((line) => {
    protocolWrite(line);
  });
  const agent = new AcpAgent(peer, createCliBackend(options), {
    name: "continuous",
    title: "Continuous",
    version: getVersion(),
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => peer.feed(chunk));
  await new Promise<void>((resolve) => {
    process.stdin.on("end", () => {
      agent.shutdown();
      peer.close();
      resolve();
    });
  });
}
