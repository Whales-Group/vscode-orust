# ORust VS Code Extension

Language support for ORust `.or` files backed by the Rust `orust-lsp`
language server.

## Current features

- `.or` file association
- Syntax highlighting for ORust keywords, types, strings, numbers, comments, functions, and operators
- Basic bracket and quote handling
- Diagnostics, completion, hover, symbols, navigation, references, rename,
  code actions, signature help, and inlay hints through `orust-lsp`

## Development

```sh
npm install
npm run compile
npm run package
```

The extension starts `orust-lsp` from `orust.lspPath` when configured, or from
the user's `PATH` when the setting is empty. In an Orust checkout, build it
with `cargo build -p orust-lsp` and point the setting at `target/debug/orust-lsp`.

## Rust interoperability

This extension is intentionally additive. It registers only the `orust`
language ID and only starts `orust-lsp` for `.or` documents. Rust `.rs` files
remain owned by the normal Rust extension and `rust-analyzer`; this extension
does not replace, proxy, or duplicate Rust language-server features.

In a mixed Cargo project, both servers operate in the same workspace:

```text
src/main.or  ── orust-lsp ── ORust symbols, diagnostics, rename, completion
src/lib.rs   ── rust-analyzer ── Rust symbols, borrow checking, macros, tools
                         │
                         └── Cargo/rustc compile the generated and native Rust together
```

ORust diagnostics and generated-Rust signatures use the same parser/emitter
as the compiler. Rust diagnostics and Rust source navigation continue to come
from `rust-analyzer`.

## Run and debug

When an `.or` file contains `void main()`, the editor shows `Run ORust` and
`Debug ORust` CodeLens actions above the entry point. The editor title exposes
the same actions.

Import paths are inline document links. Paths such as
`'rust:./helpers.rs'`, `'./consumer.or'`, and `@rustImport("crate::helpers::shout")`
are underlined when they resolve; hover shows the target and clicking opens the
source file.

`Run ORust` starts a launch session backed by the real CLI and shows all output
in the VS Code Debug Console:

```text
orust run path/to/main.or
```

`Debug ORust` uses the same Debug Console launch path and is the entry point for
future breakpoints and stepping. Neither action creates an integrated terminal.
The ORust language server continues to publish source diagnostics in the
Problems panel. Use
`ORust: Create launch.json` to create a workspace launch configuration:

Documentation lints such as missing API documentation are warnings only. They
appear in the Problems panel and Debug Console, but they do not prevent the
program from compiling or running. Compiler errors and runtime failures remain
fatal and produce a non-zero debug session exit code.

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "orust",
      "request": "launch",
      "name": "Debug current ORust file",
      "program": "${file}",
      "cwd": "${workspaceFolder}",
      "orust": "${config:orust.cliPath}"
    }
  ]
}
```

The launch path uses the same compiler pipeline as the terminal: ORust emits
Rust under `target/rust/`, Cargo compiles it, and the resulting program runs.
The current adapter provides reliable launch and console output; native Rust
breakpoints and stepping can be added as a later debugger layer on the
generated Cargo target.

Rust islands inside an ORust file are projected into a line-preserving Rust
document and sent to `rust-analyzer` for Rust hover, completion, definition,
and diagnostics. Results are shown back on the original `.or` source.

The bridge is optional and verifies `rust-analyzer --version` before starting.
It checks `orust.rustAnalyzerPath`, `rust-analyzer.server.path`, the official
extension's bundled server, and then `PATH`. If the official extension is not
installed, ORust shows an **Install Rust Analyzer** action that opens its
Marketplace page directly. If the extension is installed but its executable is
unavailable, ORust offers to open the Rust Analyzer server-path setting.

For a rustup-managed installation, install the component with:

```sh
rustup component add rust-analyzer
```

or set `orust.rustAnalyzerPath` to a working `rust-analyzer` executable.

For workspaces where an installed `rust-analyzer` still scans unknown `.or`
files, add this to the workspace `.vscode/settings.json`:

```json
{
  "rust-analyzer.files.exclude": ["**/*.or"]
}
```

Open this folder in VS Code and press `F5` to launch an Extension Development Host.
