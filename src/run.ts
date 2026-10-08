import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

function hasMain(source: string): boolean {
  return /\bvoid\s+main\s*\(/.test(source) || /\bfn\s+main\s*\(/.test(source);
}

function cliPath(): string {
  const configured = vscode.workspace.getConfiguration("orust").get<string>("cliPath", "").trim();
  if (configured) return configured;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const workspaceCli = root ? path.join(root, "target", "debug", process.platform === "win32" ? "orust.exe" : "orust") : "";
  return workspaceCli && fs.existsSync(workspaceCli) ? workspaceCli : "orust";
}

export class MainCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== "orust") return [];
    const lines = document.getText().split(/\r?\n/);
    const lenses: vscode.CodeLens[] = [];
    if (hasMain(document.getText())) {
      const line = lines.findIndex((value) => /\b(?:void|fn)\s+main\s*\(/.test(value));
      const range = new vscode.Range(Math.max(line, 0), 0, Math.max(line, 0), 0);
      lenses.push(
        new vscode.CodeLens(range, { title: "Run ORust", command: "orust.runFile", arguments: [document.uri] }),
        new vscode.CodeLens(range, { title: "Debug ORust", command: "orust.debugFile", arguments: [document.uri] }),
      );
    }
    return lenses;
  }
}

export class ImportDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    if (document.languageId !== "orust") return [];
    const links: vscode.DocumentLink[] = [];
    const lines = document.getText().split(/\r?\n/);
    lines.forEach((line, lineNumber) => {
      const importMatch = line.match(/\bimport\s+'([^']+)'/);
      if (importMatch) {
        const target = resolveImportPath(document.uri, importMatch[1]);
        if (target) {
          const start = line.indexOf(importMatch[1]);
          links.push(new vscode.DocumentLink(
            new vscode.Range(lineNumber, start, lineNumber, start + importMatch[1].length),
            vscode.Uri.file(target),
          ));
          links[links.length - 1].tooltip = `Open ${target}`;
        }
      }
      const rustImport = line.match(/@(?:rustImport|externRust)\("([^"]+)"\)/);
      if (rustImport) {
        const target = resolveImportPath(document.uri, `rust:${rustImport[1]}`);
        if (target) {
          const start = line.indexOf(rustImport[1]);
          links.push(new vscode.DocumentLink(
            new vscode.Range(lineNumber, start, lineNumber, start + rustImport[1].length),
            vscode.Uri.file(target),
          ));
          links[links.length - 1].tooltip = `Open ${target}`;
        }
      }
    });
    return links;
  }
}

export async function runFile(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) return;
  await startDebugSession(target, `Run ${path.basename(target.fsPath)}`);
}

export async function debugFile(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) return;
  await startDebugSession(target, `Debug ${path.basename(target.fsPath)}`);
}

async function startDebugSession(target: vscode.Uri, name: string): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(target);
  const started = await vscode.debug.startDebugging(folder, {
    type: "orust",
    request: "launch",
    name,
    program: target.fsPath,
    cwd: folder?.uri.fsPath ?? path.dirname(target.fsPath),
    orust: cliPath(),
  });
  if (!started) {
    void vscode.window.showErrorMessage("Unable to start the ORust debug session.");
    return;
  }
  await vscode.commands.executeCommand("workbench.debug.action.focusRepl");
}

export async function createLaunchConfiguration(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("Open an ORust workspace before creating launch.json.");
    return;
  }
  const launchDirectory = vscode.Uri.joinPath(folder.uri, ".vscode");
  await vscode.workspace.fs.createDirectory(launchDirectory);
  const launchFile = vscode.Uri.joinPath(launchDirectory, "launch.json");
  const configuration = {
    version: "0.2.0",
    configurations: [{
      type: "orust",
      request: "launch",
      name: "Debug current ORust file",
      program: "${file}",
      cwd: "${workspaceFolder}",
      orust: "${config:orust.cliPath}",
    }],
  };
  await vscode.workspace.fs.writeFile(launchFile, Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`));
  const document = await vscode.workspace.openTextDocument(launchFile);
  await vscode.window.showTextDocument(document);
}

export async function openImport(documentUri?: vscode.Uri, importPath?: string): Promise<void> {
  if (!documentUri || !importPath) return;
  const candidate = resolveImportPath(documentUri, importPath);
  if (!candidate || !(await exists(candidate))) {
    void vscode.window.showWarningMessage(`Could not resolve import: ${importPath}`);
    return;
  }
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(candidate));
}

function resolveImportPath(documentUri: vscode.Uri, importPath: string): string | undefined {
  const documentPath = documentUri.fsPath;
  const workspace = vscode.workspace.getWorkspaceFolder(documentUri)?.uri.fsPath;
  const raw = importPath.startsWith("rust:") ? importPath.slice("rust:".length) : importPath;
  let candidate: string;
  if (raw.startsWith("crate::")) {
    const module = raw.slice("crate::".length).split("::")[0];
    const root = workspace ?? path.dirname(documentPath);
    const inSrc = path.join(root, "src", `${module}.rs`);
    const atRoot = path.join(root, `${module}.rs`);
    candidate = fs.existsSync(inSrc) ? inSrc : atRoot;
  } else {
    candidate = path.resolve(path.dirname(documentPath), raw);
  }
  if (!path.extname(candidate)) {
    const orust = `${candidate}.or`;
    const rust = `${candidate}.rs`;
    candidate = fs.existsSync(orust) ? orust : rust;
  }
  return fs.existsSync(candidate) ? candidate : undefined;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}
