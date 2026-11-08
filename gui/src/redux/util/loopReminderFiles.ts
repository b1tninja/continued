import type { IDE } from "core";
import { resolveRelativePathInDir } from "core/util/ideUtils";
import { reminderFileStamp } from "core/util/loopReminders";

async function stampFile(ide: IDE, file: string): Promise<string> {
  try {
    const uri = await resolveRelativePathInDir(file, ide);
    return reminderFileStamp(uri ? await ide.readFile(uri) : undefined);
  } catch {
    return reminderFileStamp(undefined);
  }
}

/** The current stamps of a reminder's files, by path. */
export async function stampLoopFiles(
  ide: IDE,
  files: string[],
): Promise<Record<string, string>> {
  const stamps = await Promise.all(files.map((file) => stampFile(ide, file)));
  return Object.fromEntries(files.map((file, i) => [file, stamps[i]]));
}
