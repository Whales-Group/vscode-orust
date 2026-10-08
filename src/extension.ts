import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  TransportKind,
} from "vscode-languageclient/node";
import { RustBridge } from "./rustBridge";
import { OrustDebugAdapter } from "./debugAdapter";
import { ImportDocumentLinkProvider, MainCodeLensProvider, createLaunchConfiguration, debugFile, openImport, runFile } from "./run";

let client: LanguageClient | undefined;
let rustBridge: RustBridge | undefined;
let output: vscode.OutputChannel;
const RELEASES_URL = "https://github.com/Jesse-Dan/Orust/releases";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function bundledServerPath(context: vscode.ExtensionContext): string | undefined {
  const platform = `${process.platform}-${process.arch}`;
  const platformDirectory = platform === "darwin-arm64"
    ? "darwin-arm64"
    : platform === "darwin-x64"
      ? "darwin-x64"
      : platform === "linux-x64"
        ? "linux-x64"
        : platform === "win32-x64"
          ? "win32-x64"
          : undefined;
  if (!platformDirectory) return undefined;
  const executable = process.platform === "win32" ? "orust-lsp.exe" : "orust-lsp";
  const candidate = path.join(context.extensionPath, "server", platformDirectory, executable);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function serverOptions(context: vscode.ExtensionContext): ServerOptions {
  const configured = vscode.workspace
    .getConfiguration("orust")
    .get<string>("lspPath", "")
    .trim();
  const command = (
    bundledServerPath(context) || configured || "orust-lsp"
  ).split("${workspaceFolder}").join(workspaceRoot() ?? "");
  return {
    command,
    args: [],
    options: { cwd: workspaceRoot() },
    transport: TransportKind.stdio,
  };
}

let missingRustAnalyzerNotified = false;

async function startLanguageServer(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("ORust Language Server");
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "orust" }],
    workspaceFolder: vscode.workspace.workspaceFolders?.[0],
    outputChannel: output,
    traceOutputChannel: output,
  };
  const bundled = bundledServerPath(context);
  client = new LanguageClient("orust", "ORust Language Server", serverOptions(context), clientOptions);
  output.appendLine(
    bundled
      ? `Using bundled ORust language server: ${bundled}`
      : "No bundled ORust language server found; using orust.lspPath or PATH.",
  );
  client.onDidChangeState((event) => {
    if (event.newState === State.Stopped) output.appendLine("ORust language server stopped.");
  });
  context.subscriptions.push(client, output);
  void client.start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Failed to start orust-lsp: ${message}`);
    void vscode.window.showErrorMessage(
      `Unable to start orust-lsp: ${message}`,
      "Open ORust Releases",
    ).then((choice) => {
      if (choice === "Open ORust Releases") {
        void vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
      }
    });
  });
  const rustAnalyzer = await RustBridge.resolveCommand();
  if (rustAnalyzer) {
    rustBridge = new RustBridge(output, rustAnalyzer);
    void rustBridge.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Rust-analyzer bridge unavailable: ${message}`);
    });
    context.subscriptions.push(rustBridge);
  } else {
    output.appendLine("rust-analyzer was not found; embedded Rust features are disabled.");
    if (!missingRustAnalyzerNotified) {
      missingRustAnalyzerNotified = true;
      const installed = Boolean(vscode.extensions.getExtension("rust-lang.rust-analyzer"));
      const action = installed ? "Open Rust Analyzer Settings" : "Install Rust Analyzer";
      const message = installed
        ? "The Rust Analyzer extension is installed, but its server executable is unavailable."
        : "Rust Analyzer is needed for Rust code inside ORust files.";
      void vscode.window.showInformationMessage(message, action).then((choice) => {
        if (choice !== action) return;
        if (installed) {
          void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:rust-lang.rust-analyzer rust-analyzer.server.path");
        } else {
          void vscode.commands.executeCommand("workbench.extensions.action.showExtensionsWithQuery", "@id:rust-lang.rust-analyzer");
        }
      });
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  void startLanguageServer(context);
  const installRustAnalyzer = vscode.commands.registerCommand("orust.installRustAnalyzer", () =>
    vscode.commands.executeCommand("workbench.extensions.action.showExtensionsWithQuery", "@id:rust-lang.rust-analyzer"),
  );
  const restart = vscode.commands.registerCommand("orust.restartLanguageServer", async () => {
    if (client) await client.stop();
    if (rustBridge) await rustBridge.stop();
    rustBridge = undefined;
    await startLanguageServer(context);
  });
  context.subscriptions.push(
    installRustAnalyzer,
    restart,
    vscode.commands.registerCommand("orust.runFile", runFile),
    vscode.commands.registerCommand("orust.debugFile", debugFile),
    vscode.commands.registerCommand("orust.openImport", openImport),
    vscode.commands.registerCommand("orust.createLaunchConfiguration", createLaunchConfiguration),
    vscode.languages.registerCodeLensProvider({ scheme: "file", language: "orust" }, new MainCodeLensProvider()),
    vscode.languages.registerDocumentLinkProvider({ scheme: "file", language: "orust" }, new ImportDocumentLinkProvider()),
    vscode.debug.registerDebugAdapterDescriptorFactory("orust", {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new OrustDebugAdapter()),
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (client) await client.stop();
  if (rustBridge) await rustBridge.stop();
}
