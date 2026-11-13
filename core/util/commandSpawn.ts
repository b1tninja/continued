/**
 * How a command the agent starts is given its standard streams, in one place
 * for every terminal tool (the editor's, the CLI's, background jobs and loop
 * checks).
 *
 * Nobody is there to type an answer, so standard input is not a pipe that
 * stays open: a command that reads it (`read x` in bash, `Read-Host`, a
 * confirmation, `git commit` with no message) used to wait until the tool's
 * timeout. With "ignore" the child reads the null device and sees end of file
 * at once, in WSL and in a container as well: `wsl.exe` and `docker run -i`
 * pass their own standard input on.
 *
 * A caller that really feeds a command (a hook's JSON on standard input) does
 * not use this and keeps its pipe.
 */
export const COMMAND_STDIO: ["ignore", "pipe", "pipe"] = [
  "ignore",
  "pipe",
  "pipe",
];
