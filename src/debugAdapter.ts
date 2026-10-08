import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

type DapMessage = {
  seq?: number;
  type: "request" | "response" | "event";
  command?: string;
  arguments?: Record<string, unknown>;
  request_seq?: number;
  success?: boolean;
  body?: Record<string, unknown>;
  event?: string;
};

function stringArgument(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Lightweight ORust launch adapter.
 *
 * The compiler remains the source of truth: the adapter runs `orust run`, so
 * generated Rust, Cargo dependencies, and ORust diagnostics all use the same
 * path as the CLI. This gives us a real Debug Console session now while
 * leaving room to attach a native Rust debugger to target/orust later.
 */
export class OrustDebugAdapter implements vscode.DebugAdapter {
  private readonly messages = new vscode.EventEmitter<DapMessage>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private sequence = 1;

  readonly onDidSendMessage = this.messages.event;
  readonly onError = new vscode.EventEmitter<Error>().event;
  readonly onExit = this.closeEmitter.event;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const request = message as DapMessage;
    if (request.type !== "request" || !request.command) return;

    switch (request.command) {
      case "initialize":
        this.respond(request, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
          supportsRestartRequest: false,
          supportsEvaluateForHovers: false,
        });
        this.event("initialized");
        break;
      case "launch":
        this.respond(request);
        void this.launch(request.arguments);
        break;
      case "configurationDone":
        this.respond(request);
        break;
      case "disconnect":
      case "terminate":
        this.respond(request);
        this.stop();
        break;
      case "threads":
        this.respond(request, { threads: [{ id: 1, name: "ORust process" }] });
        break;
      case "stackTrace":
        this.respond(request, { stackFrames: [], totalFrames: 0 });
        break;
      case "scopes":
        this.respond(request, { scopes: [] });
        break;
      case "variables":
        this.respond(request, { variables: [] });
        break;
      case "setBreakpoints":
        this.respond(request, { breakpoints: [] });
        break;
      default:
        this.respond(request, undefined, `ORust debug adapter does not support ${request.command}`);
        break;
    }
  }

  dispose(): void {
    this.stop();
    this.messages.dispose();
    this.closeEmitter.dispose();
  }

  private async launch(args: Record<string, unknown> | undefined): Promise<void> {
    const file = stringArgument(args, "program");
    const cwd = stringArgument(args, "cwd") ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const configuredCli = stringArgument(args, "orust")?.trim();
    const workspaceCli = cwd
      ? path.join(cwd, "target", "debug", process.platform === "win32" ? "orust.exe" : "orust")
      : "";
    const cliPath = configuredCli || (workspaceCli && fs.existsSync(workspaceCli) ? workspaceCli : "orust");
    if (!file) {
      this.event("output", { category: "stderr", output: "ORust launch requires a program (.or) file.\n" });
      this.event("terminated");
      return;
    }

    this.process = spawn(cliPath || "orust", ["run", file], {
      cwd,
      env: process.env,
      stdio: "pipe",
    });
    this.process.stdout.on("data", (data: Buffer) => this.event("output", { category: "stdout", output: data.toString() }));
    this.process.stderr.on("data", (data: Buffer) => {
      const output = data.toString();
      const category = output.trimStart().startsWith("warning[") ? "console" : "stderr";
      this.event("output", { category, output });
    });
    this.process.on("error", (error: Error) => {
      this.event("output", { category: "stderr", output: `${error.message}\n` });
      this.event("terminated");
      this.process = undefined;
    });
    this.process.on("close", (code, signal) => {
      this.event("exited", { exitCode: code ?? 1, signal });
      this.event("terminated");
      this.process = undefined;
    });
  }

  private stop(): void {
    this.process?.kill();
    this.process = undefined;
  }

  private respond(request: DapMessage, body?: Record<string, unknown>, message?: string): void {
    this.messages.fire({
      seq: this.sequence++,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success: !message,
      body,
      ...(message ? { message } : {}),
    });
  }

  private event(event: string, body?: Record<string, unknown>): void {
    this.messages.fire({ seq: this.sequence++, type: "event", event, body });
  }
}
