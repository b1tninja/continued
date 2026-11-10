import { IDE } from "..";

import {
  findUriInDirs,
  joinEncodedUriPathSegmentToUri,
  joinPathsToUri,
  pathToUriPathSegment,
} from "./uri";

/*
  This function takes a relative (to workspace) filepath
  And checks each workspace for if it exists or not
  Only returns fully resolved URI if it exists
*/
export async function resolveRelativePathInDir(
  path: string,
  ide: IDE,
  dirUriCandidates?: string[],
): Promise<string | undefined> {
  const dirs = dirUriCandidates ?? (await ide.getWorkspaceDirs());
  for (const dirUri of dirs) {
    const fullUri = joinPathsToUri(dirUri, path);
    // A path that climbs out of this directory is not inside it, even when
    // the file exists. Callers treat a returned URI as contained.
    if (findUriInDirs(fullUri, [dirUri]).foundInDir === null) continue;
    if (await ide.fileExists(fullUri)) {
      return fullUri;
    }
  }

  return undefined;
}

/** Decoded path of a URI, or the string itself when it is not one. */
function pathOfUri(uri: string): string {
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) {
      return decodeURIComponent(new URL(uri).pathname).replace(/\\/g, "/");
    }
  } catch {
    // Not a URI.
  }
  return uri.replace(/\\/g, "/");
}

/**
 * True when `filepath` is the whole path or a separator-bounded suffix.
 * `a.ts` matches `/src/a.ts` and does not match `/src/data.ts`.
 */
export function uriHasPathSuffix(uri: string, filepath: string): boolean {
  const want = filepath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (
    !want ||
    want.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    return false;
  }
  const got = pathOfUri(uri).replace(/\/+$/, "");
  return got === want || got.endsWith("/" + want);
}

/**
 * The single open file that ends with `filepath` and sits inside a workspace
 * directory. A file outside the workspace, or two matches, is not a target.
 */
export async function uniqueOpenFileInWorkspace(
  filepath: string,
  ide: IDE,
): Promise<string | undefined> {
  const dirs = await ide.getWorkspaceDirs();
  const hits = (await ide.getOpenFiles()).filter(
    (uri) =>
      uriHasPathSuffix(uri, filepath) &&
      findUriInDirs(uri, dirs).foundInDir !== null,
  );
  return hits.length === 1 ? hits[0] : undefined;
}

/*
  Same as above but in this case the relative path does not need to exist (e.g. file to be created, etc)
  Checks closes match with the dirs, path segment by segment
  and based on which workspace has the closest matching path, returns resolved URI
  If no meaninful path match just concatenates to first dir's uri
*/
export async function inferResolvedUriFromRelativePath(
  _relativePath: string,
  ide: IDE,
  dirCandidates?: string[],
): Promise<string> {
  const relativePath = _relativePath.trim().replaceAll("\\", "/");
  const dirs = dirCandidates ?? (await ide.getWorkspaceDirs());

  if (dirs.length === 0) {
    throw new Error("inferResolvedUriFromRelativePath: no dirs provided");
  }

  const segments = pathToUriPathSegment(relativePath).split("/");
  // Generate all possible suffixes from shortest to longest
  const suffixes: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    suffixes.push(segments.slice(i).join("/"));
  }

  // For each suffix, try to find a unique matching dir/file
  for (const suffix of suffixes) {
    const uris = dirs.map((dir) => ({
      dir,
      partialUri: joinEncodedUriPathSegmentToUri(dir, suffix),
    }));
    const promises = uris.map(async ({ partialUri, dir }) => {
      const exists = await ide.fileExists(partialUri);
      return {
        dir,
        partialUri,
        exists,
      };
    });
    const existenceChecks = await Promise.all(promises);

    const existingUris = existenceChecks.filter(({ exists }) => exists);

    // If exactly one directory matches, use it
    if (existingUris.length === 1) {
      return joinEncodedUriPathSegmentToUri(
        existingUris[0].dir,
        segments.join("/"),
      );
    }
  }

  // Sometimes the model will decide to only output the base name or small number of path parts
  // in which case we shouldn't create a new file if it matches the current file
  const activeFile = await ide.getCurrentFile();
  if (
    activeFile &&
    uriHasPathSuffix(activeFile.path, relativePath) &&
    findUriInDirs(activeFile.path, dirs).foundInDir
  ) {
    return activeFile.path;
  }

  // If no unique match found, use the first directory
  return joinPathsToUri(dirs[0], relativePath);
}
