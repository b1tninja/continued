# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Add files and folders to the chat from the VS Code Explorer and editor tabs.** Right-click files or folders in the Explorer (several at once), an editor tab, or an editor with nothing selected, and choose **Add to Continuous Chat**; **Add All Open Tabs to Continuous Chat** is on the tab menu and in the Command Palette. Files become `@` file chips, read when you send, and folders become `@` folder chips (a search scope; needs the `folder` context provider). The chat opens if it is closed, the input is focused, chips already in the message are not added twice, and the result is announced to screen readers. Files that look like they hold secrets (`.env` files, keys and certificates, `.ssh` and cloud credential folders), files outside the workspace folders and unsaved editors are not added, and a notification names them. This is the route that works while VS Code 1.140 and later do not deliver Explorer and tab drops to extension webviews (microsoft/vscode#339036). Remote and virtual workspaces are supported. This replaces the Explorer's **Select Files as Context** item, which pasted every selected file in full (folders recursively) with no size limit or credential check; its command id, `continuous.selectFilesAsContext`, still works for existing keybindings and now adds chips the same way.

## Behaviour changes
