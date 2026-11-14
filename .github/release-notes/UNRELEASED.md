# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

## Behaviour changes

## Fixes

- **Container mode in the editor mounts the workspace.** With `continuous.terminal.shell` set to `container`, the editor's terminal tool built the `docker run` (or `podman run`) line from the editor process's own working folder, so the container mounted that folder read-write instead of your workspace, and a command saw the wrong files. The mount is now the workspace folder the command starts in. The CLI, which starts in the workspace, was not affected.
