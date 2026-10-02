const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

class FileColorDecorationProvider {
  constructor() {
    this._onDidChangeFileDecorations = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    this._dirCache = new Map();
    this._loadConfig();

    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('fileColorizer')) {
        this._loadConfig();
        this._dirCache.clear();
        this._onDidChangeFileDecorations.fire(undefined);
      }
    });
  }

  _loadConfig() {
    const config = vscode.workspace.getConfiguration('fileColorizer');
    this._fileRules = config.get('rules', []);
    this._folderRules = config.get('folderRules', []);
  }

  _isDirectory(fsPath) {
    if (this._dirCache.has(fsPath)) return this._dirCache.get(fsPath);
    try {
      const result = fs.statSync(fsPath).isDirectory();
      this._dirCache.set(fsPath, result);
      return result;
    } catch {
      return false;
    }
  }

  _getFolderDepth(uri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) return -1;
    const rootPath = workspaceFolder.uri.fsPath;
    const relativePath = path.relative(rootPath, uri.fsPath);
    if (!relativePath || relativePath === '.') return 0;
    return relativePath.split(path.sep).length;
  }

  provideFileDecoration(uri) {
    const fsPath = uri.fsPath;

    // File extension rules (files only)
    for (const rule of this._fileRules) {
      if (fsPath.endsWith(rule.ext)) {
        return { color: new vscode.ThemeColor(rule.color) };
      }
    }

    // Only apply folder rules and depth coloring to directories
    if (!this._isDirectory(fsPath)) return undefined;

    // Folder name rules
    const folderName = path.basename(fsPath);
    for (const rule of this._folderRules) {
      if (folderName === rule.name) {
        return { color: new vscode.ThemeColor(rule.color) };
      }
    }

    // Folder depth gradient
    const depth = this._getFolderDepth(uri);
    if (depth >= 1) {
      const level = Math.min(depth, 5);
      return { color: new vscode.ThemeColor(`fileColorizer.depth.${level}`) };
    }

    return undefined;
  }
}

function activate(context) {
  const provider = new FileColorDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
