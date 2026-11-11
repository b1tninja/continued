/**
 * Owner-only files and folders for the product's own persisted text
 * (ROADMAP X15). POSIX: 0600 for files, 0700 for folders. Windows ignores the
 * mode bits: the folder under the user profile inherits an ACL that grants
 * the user, SYSTEM and Administrators, and that inheritance is all the
 * protection there is. Nothing here changes ACLs.
 */
import fs from "node:fs";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

/** Create `dir` (and parents) owner-only. An existing folder is left alone. */
export function ensurePrivateDir(dir: string): void {
  if (!fs.existsSync(dir))
    fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/** Append to a file that is created owner-only. */
export function appendPrivate(file: string, data: string): void {
  fs.appendFileSync(file, data, { mode: PRIVATE_FILE_MODE });
}

/** Write a file owner-only. The mode applies when the file is created. */
export function writePrivate(file: string, data: string): void {
  fs.writeFileSync(file, data, { mode: PRIVATE_FILE_MODE });
}

/** True when group or others can read or write the file (POSIX only). */
export function isLooselyShared(mode: number): boolean {
  return process.platform !== "win32" && (mode & 0o077) !== 0;
}
