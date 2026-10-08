import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import {
  CompletionRequest,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

type Span = { start: number; end: number };

type Projection = {
  uri: vscode.Uri;
  source: string;
  version: number;
  rustSpans: Span[];
};

const projections = new Map<string, Projection>();
const virtualToOriginal = new Map<string, vscode.Uri>();

function hash(value: string): string {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16);
}

function rustSpans(source: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  while (true) {
    const relative = source.slice(cursor).search(/\brust\s*\{/);
    if (relative < 0) break;
    const start = cursor + relative;
    const open = source.indexOf("{", start);
    let depth = 0;
    let end = open;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end <= open) break;
    spans.push({ start, end });
    cursor = end;
  }
  return spans;
}

function inSpan(offset: number, spans: Span[]): boolean {
  return spans.some((span) => offset >= span.start && offset <= span.end);
}

function projectionSource(source: string, spans: Span[]): string {
  const output: string[] = Array.from(source, (character) => (character === "\n" ? "\n" : " "));
  const copy = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) output[index] = source[index];
  };

  for (const span of spans) copy(span.start, span.end);

  const lines = source.split(/(?<=\n)/);
  let offset = 0;
  for (const line of lines) {
    const content = line.replace(/\r?\n$/, "");
    const trimmed = content.trimStart();
    const lineStart = offset;
    const lineEnd = offset + content.length;
    if (trimmed.startsWith("rust use ")) {
      const start = lineStart + content.indexOf("rust use ");
      const replacement = content.slice(start - lineStart).replace(/^rust\s+/, "");
      for (let index = 0; index < replacement.length; index += 1) output[start + index] = replacement[index];
    } else {
      const rustType = content.match(/^(\s*)(?:export\s+)?@rustType\("([^"]+)"\)\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
      if (rustType) {
        const replacement = `${rustType[1]}type ${rustType[3]} = ${rustType[2]};`;
        for (let index = 0; index < replacement.length && lineStart + index < lineEnd; index += 1) output[lineStart + index] = replacement[index];
      }
      const main = content.indexOf("void main()");
      if (main >= 0) {
        const replacement = "fn main()";
        for (let index = 0; index < replacement.length; index += 1) output[lineStart + main + index] = replacement[index];
      }
      const rustExpression = content.match(/^(\s*)([A-Za-z_][A-Za-z0-9_<>:]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*rust\s+(.+);\s*$/);
      if (rustExpression) {
        const replacement = `${rustExpression[1]}let ${rustExpression[3]} = ${rustExpression[4]};`;
        for (let index = 0; index < replacement.length && lineStart + index < lineEnd; index += 1) output[lineStart + index] = replacement[index];
      }
    }
    // A Rust block's marker is an ORust keyword, not valid Rust. Preserve its
    // brace while replacing only the marker; the body then remains position-stable.
    const marker = content.indexOf("rust");
    if (marker >= 0 && content.slice(marker).match(/^rust\s*\{/)) {
      for (let index = 0; index < 4; index += 1) output[lineStart + marker + index] = " ";
    }
    // Keep the closing brace for the ORust main function and Rust blocks.
    if (content.trim() === "}") copy(lineStart, lineEnd);
    offset += line.length;
  }
  return output.join("");
}

function isRustPosition(document: vscode.TextDocument, position: vscode.Position, spans: Span[]): boolean {
  const offset = document.offsetAt(position);
  if (inSpan(offset, spans)) return true;
  const line = document.lineAt(position.line).text.trimStart();
  return line.startsWith("rust use ") || line.includes("@rustType") || /\brust\s+/.test(line);
}

function mapUri(value: string): vscode.Uri {
  const original = virtualToOriginal.get(value);
  return original ?? vscode.Uri.parse(value);
}

export class RustBridge implements vscode.Disposable {
  private readonly client: LanguageClient;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("orust-rust");
  private readonly disposables: vscode.Disposable[] = [];

  constructor(output: vscode.OutputChannel, command: string) {
    const serverOptions: ServerOptions = {
      command,
      args: [],
      options: { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath },
      transport: TransportKind.stdio,
    };
    const options: LanguageClientOptions = {
      // No VS Code providers are registered by this client. Rust requests for
      // embedded ranges are sent manually through the bridge below.
      documentSelector: [],
      workspaceFolder: vscode.workspace.workspaceFolders?.[0],
      outputChannel: output,
      traceOutputChannel: output,
      middleware: {
        handleDiagnostics: (uri, diagnostics) => {
          const original = virtualToOriginal.get(uri.toString());
          if (!original) return;
          this.diagnostics.set(original, diagnostics.map((diagnostic) => ({
            ...diagnostic,
            range: diagnostic.range,
            source: "rust-analyzer",
          })) as vscode.Diagnostic[]);
        },
      },
    };
    this.client = new LanguageClient("orust-rust", "Rust Analyzer for ORust", serverOptions, options);
  }

  static async resolveCommand(): Promise<string | undefined> {
    const orustPath = vscode.workspace.getConfiguration("orust").get<string>("rustAnalyzerPath", "").trim();
    const rustAnalyzerPath = vscode.workspace.getConfiguration("rust-analyzer").get<string>("server.path", "").trim();
    const candidates = [orustPath, rustAnalyzerPath];
    const extension = vscode.extensions.getExtension("rust-lang.rust-analyzer");
    if (extension) {
      const binary = process.platform === "win32" ? "rust-analyzer.exe" : "rust-analyzer";
      candidates.push(path.join(extension.extensionPath, "server", binary));
    }
    candidates.push("rust-analyzer");
    for (const candidate of candidates) {
      if (!candidate || (candidate.includes(path.sep) && !fs.existsSync(candidate))) continue;
      try {
        await execFileAsync(candidate, ["--version"], { timeout: 2_000 });
        return candidate;
      } catch {
        // Try the next configured, bundled, or PATH candidate.
      }
    }
    return undefined;
  }

  async start(): Promise<void> {
    await this.client.start();
    this.disposables.push(
      vscode.languages.registerHoverProvider("orust", { provideHover: (document, position) => this.hover(document, position) }),
      vscode.languages.registerCompletionItemProvider("orust", { provideCompletionItems: (document, position) => this.completion(document, position) }, ".", ":"),
      vscode.languages.registerDefinitionProvider("orust", { provideDefinition: (document, position) => this.definition(document, position) }),
      vscode.workspace.onDidChangeTextDocument((event) => this.sync(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.close(document)),
    );
    for (const document of vscode.workspace.textDocuments) this.sync(document);
  }

  async stop(): Promise<void> {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.diagnostics.clear();
    await this.client.stop();
  }

  private async projection(document: vscode.TextDocument): Promise<Projection> {
    const key = document.uri.toString();
    const spans = rustSpans(document.getText());
    const existing = projections.get(key);
    const source = projectionSource(document.getText(), spans);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = root ? vscode.Uri.joinPath(root, "target", "orust", "editor", `${hash(key)}.rs`) : vscode.Uri.parse(`orust-rust:/${hash(key)}.rs`);
    const next = { uri, source, version: document.version, rustSpans: spans };
    projections.set(key, next);
    virtualToOriginal.set(uri.toString(), document.uri);
    if (root) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "target", "orust", "editor"));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(source, "utf8"));
    }
    if (!existing) {
      await this.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri: uri.toString(), languageId: "rust", version: document.version, text: source } });
    } else if (existing.source !== source) {
      await this.client.sendNotification(DidChangeTextDocumentNotification.type, { textDocument: { uri: uri.toString(), version: document.version }, contentChanges: [{ text: source }] });
    }
    return next;
  }

  private async sync(document: vscode.TextDocument): Promise<void> {
    if (document.languageId === "orust") await this.projection(document);
  }

  private async close(document: vscode.TextDocument): Promise<void> {
    const projection = projections.get(document.uri.toString());
    if (projection) await this.client.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri: projection.uri.toString() } });
    projections.delete(document.uri.toString());
  }

  private async request(document: vscode.TextDocument, position: vscode.Position, method: "hover" | "completion" | "definition"): Promise<unknown> {
    const projection = await this.projection(document);
    if (!isRustPosition(document, position, projection.rustSpans)) return undefined;
    const params = { textDocument: { uri: projection.uri.toString() }, position: { line: position.line, character: position.character } };
    if (method === "hover") return this.client.sendRequest(HoverRequest.type, params);
    if (method === "completion") return this.client.sendRequest(CompletionRequest.type, params);
    return this.client.sendRequest(DefinitionRequest.type, params);
  }

  private async hover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    return (await this.request(document, position, "hover")) as vscode.Hover | undefined;
  }

  private async completion(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined> {
    return (await this.request(document, position, "completion")) as vscode.CompletionList | vscode.CompletionItem[] | undefined;
  }

  private async definition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | undefined> {
    const result = await this.request(document, position, "definition");
    if (!result) return undefined;
    const locations = Array.isArray(result) ? result : [result];
    return locations.map((location: { uri: string; range: vscode.Range }) => new vscode.Location(mapUri(location.uri), location.range));
  }

  dispose(): void {
    void this.stop().finally(() => this.diagnostics.dispose());
  }
}
