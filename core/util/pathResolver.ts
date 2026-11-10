import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "path";
import untildify from "untildify";
import { IDE } from "..";
import { resolveRelativePathInDir } from "./ideUtils";
import { findUriInDirs, joinPathsToUri } from "./uri";

export interface ResolvedPath {
  uri: string;
  displayPath: string;
  isAbsolute: boolean;
  isWithinWorkspace: boolean;
}

/**
 * The local file a URI names, following symlinks. Remote URIs are unchanged.
 * A missing file follows its nearest existing parent, so a new file under a
 * symlinked directory is judged by where it would be created.
 */
function followLocalSymlink(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  let fsPath: string;
  try {
    fsPath = fileURLToPath(uri);
  } catch {
    return uri;
  }
  const real = realpathOrParent(fsPath);
  if (!real || path.resolve(real) === path.resolve(fsPath)) return uri;
  return pathToFileURL(real).href;
}

function realpathOrParent(fsPath: string): string | undefined {
  try {
    return fs.realpathSync.native(fsPath);
  } catch {
    const parent = path.dirname(fsPath);
    if (parent === fsPath) return undefined;
    try {
      return path.join(fs.realpathSync.native(parent), path.basename(fsPath));
    } catch {
      return undefined;
    }
  }
}

/**
 * Checks if a URI is within any of the workspace directories.
 * Also verifies the file actually exists, matching resolveRelativePathInDir.
 * Both the file and the workspace roots are followed through symlinks first.
 */
async function isUriWithinWorkspace(ide: IDE, uri: string): Promise<boolean> {
  const workspaceDirs = (await ide.getWorkspaceDirs()).map(followLocalSymlink);
  const realUri = followLocalSymlink(uri);
  const { foundInDir } = findUriInDirs(realUri, workspaceDirs);

  if (foundInDir !== null) {
    return await ide.fileExists(realUri);
  }

  return false;
}

async function asResolved(
  ide: IDE,
  uri: string,
  displayPath: string,
  isAbsolute: boolean,
): Promise<ResolvedPath> {
  const realUri = followLocalSymlink(uri);
  return {
    uri: realUri,
    displayPath,
    isAbsolute,
    isWithinWorkspace: await isUriWithinWorkspace(ide, realUri),
  };
}

export async function resolveInputPath(
  ide: IDE,
  inputPath: string,
): Promise<ResolvedPath | null> {
  const trimmedPath = inputPath.trim();

  // Handle file:// URIs
  if (trimmedPath.startsWith("file://")) {
    return asResolved(ide, trimmedPath, fileURLToPath(trimmedPath), true);
  }

  // Expand tilde paths (handles ~/ and ~username/)
  const expandedPath = untildify(trimmedPath);

  // Check if it's an absolute path (including Windows paths)
  const isAbsolute =
    path.isAbsolute(expandedPath) ||
    // Windows network paths
    expandedPath.startsWith("\\\\") ||
    // Windows drive letters
    /^[a-zA-Z]:/.test(expandedPath);

  if (isAbsolute) {
    return asResolved(
      ide,
      pathToFileURL(expandedPath).href,
      expandedPath,
      true,
    );
  }

  // Handle relative paths. A file that exists inside a workspace directory
  // is inside; one that is only reached by climbing out is not.
  const workspaceUri = await resolveRelativePathInDir(expandedPath, ide);
  if (workspaceUri) {
    return asResolved(ide, workspaceUri, expandedPath, false);
  }

  const dirs = await ide.getWorkspaceDirs();
  for (const dirUri of dirs) {
    const fullUri = joinPathsToUri(dirUri, expandedPath);
    if (findUriInDirs(fullUri, [dirUri]).foundInDir !== null) continue;
    if (await ide.fileExists(fullUri)) {
      return asResolved(ide, fullUri, expandedPath, false);
    }
  }

  // A missing file whose parent is a symlink is judged by where that link
  // points, not by the path as written.
  for (const dirUri of dirs) {
    const fullUri = joinPathsToUri(dirUri, expandedPath);
    const realUri = followLocalSymlink(fullUri);
    if (realUri === fullUri) continue;
    const realDirs = dirs.map(followLocalSymlink);
    if (findUriInDirs(realUri, realDirs).foundInDir !== null) continue;
    return {
      uri: realUri,
      displayPath: expandedPath,
      isAbsolute: false,
      isWithinWorkspace: false,
    };
  }

  return null;
}
