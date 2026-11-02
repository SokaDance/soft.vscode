<!--
sword:
  schema: 1
  name: soft.vscode
  family: ecore-esync
  kind: build-tooling
  generation: shared
  shipped: false
  languages: [TypeScript, JavaScript, CSS]
  build: [npm]
  ng: [ecore-model]
  apps:
    - name: ecorium
      kind: extension
      run: "code --install-extension ecorium-<version>.vsix"
      ports: ["none"]
      launched_by: ["VS Code: the custom editor ecorium.ecoreEditor opens a .ecore file (activation is implicit, activationEvents is empty), or one of the ecorium.* commands is run"]
      artifacts: "ecorium-<version>.vsix: asset of the GitHub release vX.Y.Z of masagroup/soft.vscode, and workflow artifact ecorium-vsix of Build and Test"
      status: internal-tool
      # UNVERIFIED: publication on the Visual Studio Marketplace or Open VSX (no workflow of the repository does it)
-->

For the previous documentation of the project, see [README.LEGACY.md](README.LEGACY.md).

# soft.vscode

> Ecorium: a tree and properties editor for EMF Ecore metamodels (`.ecore` files) inside Visual Studio Code, built on the TypeScript Ecore runtime [soft.ts](https://github.com/masagroup/soft.ts) (`@masagroup/ecore`). No Java, no Eclipse.

[![License](https://img.shields.io/github/license/masagroup/soft.vscode.svg)](https://github.com/masagroup/soft.vscode/blob/master/LICENSE)
![Build and Test](https://github.com/masagroup/soft.vscode/actions/workflows/build_and_test.yaml/badge.svg)

| | |
|---|---|
| **Family** | Ecore / esync stack |
| **Languages** | TypeScript (extension host and webview), CSS, Node scripts (`.mjs`) |
| **Build systems** | npm scripts (`package.json`) with esbuild and `vsce` · no Ant, no Docker |

**[Architecture](ARCHITECTURE.md)** · [Contributing](CONTRIBUTING.md) · [previous README](README.LEGACY.md) · [known issues and open questions](https://github.com/masagroup/wiki/wiki/known-issues#soft.vscode) · [repository on GitHub](https://github.com/masagroup/soft.vscode)

## Overview

Ecorium edits `.ecore` files in the spirit of the Eclipse "Sample Ecore Model Editor": a tree of the metamodel on the
left, a properties panel for the selected element on the right. The model is loaded, edited and serialized with
[soft.ts](https://github.com/masagroup/soft.ts), the TypeScript implementation of the EMF core of the
[Soft](https://github.com/masagroup/soft) project. The editor writes standard XMI back into the text document, so undo/redo,
save, hot exit and source control are the regular VS Code ones. It needs VS Code 1.140.0 or later (`engines.vscode`).

Install: take `ecorium-<version>.vsix` from the [releases](https://github.com/masagroup/soft.vscode/releases) and run
`code --install-extension ecorium-<version>.vsix` (details in [Quickstart](#quickstart)). Then open any `.ecore` file:
Ecorium is the default editor for it.

### Features

- **Tree view** of the metamodel: packages, classifiers, structural features, operations, parameters, enum literals,
  annotations and their details, with EMF-like labels (`books : Book`, `Writer -> Person`, `RED = 0`...).
- **Properties panel** for the selected element: typed editors for attributes (text, number, boolean, enum) and combo
  boxes for references (`eType`, `eSuperTypes`, `eOpposite`...). Candidates are the elements of the edited file, the Ecore
  data types (`EString`, `EInt`...) and the elements of the other `.ecore` files the model refers to.
- **Create, delete, move**: right-click an element for `New Child`, `New Sibling`, `Move Up`, `Move Down` and `Delete`.
  Deleting an element also removes the references pointing to it.
- **Keyboard**: arrows to navigate, `Delete` to delete, `F2` to rename, `Ctrl+Up` / `Ctrl+Down` to reorder, `Enter` to jump
  to the properties. `Ctrl+Click` an element, a reference chip or the `→` button next to a type goes to its declaration; a
  type from another file or from Ecore itself opens in its own editor.
- **Filter** box: finds elements by name or by the value of any attribute set on them (nsURI, instance class name,
  annotation details...); matches are highlighted in the tree and in the properties, `Enter` selects the first one.
- **Open as Text** (toolbar or editor title) opens the XMI on the element selected in the tree.
- **External packages** panel under the tree: the `.ecore` files and built-in packages the document refers to, with their
  path relative to the document; click one to open it, `+` loads another file so its elements become reference
  candidates, `×` forgets a package (greyed out while an element of the document still points into it).
- **Problems**: parse problems are listed in the Problems view; a file that cannot be parsed makes the editor read-only
  with a banner, and the model reloads by itself once the text is fixed.
- **Ecorium: New Ecore Model** creates a file with an empty package.

### Limitations

- Soft TS does not implement Ecore generics (`eGenericType`, `eTypeParameters`, `eGenericSuperTypes`); a file using them
  is opened read-only so that nothing is lost on save. <!-- TODO: verify: no test covers it; the editor goes read-only on any error reported while loading -->
- The XMI is re-serialized on each edit: the layout is the canonical EMF one and comments are not preserved.
- Cross-file references are resolved from disk when the file is opened; run `Ecorium: Reload Model` after changing a
  referenced file.

## Where to start

| You want to... | Read |
|---|---|
| install Ecorium and open a model | [Quickstart](#quickstart) |
| see the commands, the setting and the keyboard | [Interfaces and access methods](#interfaces-and-access-methods) |
| understand how the editor is made (host, webview, model layer) | [ARCHITECTURE.md](ARCHITECTURE.md) |
| build, test, debug and release the extension | [CONTRIBUTING.md](CONTRIBUTING.md) |
| read the page shown to users in VS Code | [docs/USER_README.md](docs/USER_README.md) |
| see what changed in each version | [CHANGELOG.md](CHANGELOG.md) |
| read the documentation before the rewrite to the template | [README.LEGACY.md](README.LEGACY.md) |

## Build

### package.json (Windows and Linux)

Node.js 22 and npm are required (the CI uses Node 22). `@masagroup/ecore` is published on GitHub Packages, which asks for a
token even for public packages: add `//npm.pkg.github.com/:_authToken=<token with read:packages>` to your user `.npmrc`
(the scope mapping is in the `.npmrc` of the repository).

```bash
npm install
npm run compile      # bundles dist/extension.js and dist/webview.js
npm test             # unit tests (vitest)
npm run typecheck    # tsc --noEmit on the extension and on the webview
npm run package      # production build, then ecorium-<version>.vsix
```

<details>
<summary>Details</summary>

| Script | Command | Purpose |
|---|---|---|
| `compile` | `node esbuild.mjs` | development bundles with source maps |
| `watch` | `node esbuild.mjs --watch` | rebuild on change |
| `build` | `node esbuild.mjs --production` | minified bundles; run by `vscode:prepublish` |
| `typecheck` / `lint` | `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.webview.json` | `lint` is the same as `typecheck` |
| `test` | `vitest run` | `test/**/*.test.ts`, with a stub of the `vscode` module |
| `package` | `vsce package --no-dependencies --readme-path docs/USER_README.md` | `ecorium-<version>.vsix` at the root (git-ignored), with [docs/USER_README.md](docs/USER_README.md) as the page of the extension |
| `harness` | `node scripts/harness.mjs [file.ecore] [--port 3939]` | serves the real webview against the model layer in Node, without VS Code (run `npm run compile` first); edits go to `out/harness-output.ecore` |
| `icon` | `node scripts/make-icon.mjs` | regenerates `media/icon.png` |

The build, the CI and the release are described in [CONTRIBUTING.md](CONTRIBUTING.md#cicd).

</details>

## Quickstart

Install the extension from a `.vsix`, either downloaded from the [GitHub releases](https://github.com/masagroup/soft.vscode/releases)
or built with `npm run package`:

```bash
code --install-extension ecorium-<version>.vsix
```

(or `Extensions: Install from VSIX...` in the Command Palette). Then:

1. Open any `.ecore` file: Ecorium is the default editor (`priority: default`). Try the files of [samples](samples/).
2. Right-click in the tree to add elements, select one to edit it in the properties panel.
3. `Open as Text` (editor title) shows the XMI, `Open with Ecorium` (editor title or Explorer context menu) comes back.
4. When a file cannot be parsed, or the model is read-only, a banner says why: fix the file in the text editor, the model
   reloads automatically.

To run it from the sources, open the repository in VS Code and press `F5`: the launch configuration "Run Ecorium" compiles
the extension and starts an Extension Development Host on the `samples` folder.

## Interfaces and access methods

Ecorium is a VS Code extension (`masagroup.ecorium`, `package.json` name `ecorium`): it has no executable, no port and no
network access; VS Code starts it when a `.ecore` file is opened in the custom editor or when one of its commands runs.

| Interface | Id | Where |
|---|---|---|
| Custom editor | `ecorium.ecoreEditor` ("Ecorium Ecore Editor") | `*.ecore`, priority `default` |
| Command | `ecorium.openWithEcorium` ("Open with Ecorium") | Command Palette and editor title for a `.ecore` file; Explorer context menu |
| Command | `ecorium.openAsText` ("Open as Text") | editor title and Command Palette while Ecorium is the active editor |
| Command | `ecorium.reload` ("Reload Model") | editor title and Command Palette while Ecorium is the active editor: drops the cached files and reloads the model |
| Command | `ecorium.newModel` ("New Ecore Model") | Command Palette: save dialog, then a file holding an empty package opened in Ecorium |
| Setting | `ecorium.autoNameNewElements` (boolean, default `true`) | gives new named elements a default name (`NewClass`, `newAttribute`...) |
| Language | `.ecore` files get the `xml` language id | `contributes.languages` |
| Diagnostics | collection `ecorium` | parse problems in the Problems view |
| Document scheme | `ecorium-package` | read-only view of a package built into Soft TS (Ecore itself), opened by `Ctrl+Click` on one of its types |

All commands are shown with the category `Ecorium` in the Command Palette. The extension contributes no keybinding: the keys
of the tree (arrows, `Home`, `End`, `Enter`, `F2`, `Delete`, `Ctrl+Up` / `Ctrl+Down`, `Shift+F10`) are handled by the editor
webview.

## Documentation and guides

- [Architecture](ARCHITECTURE.md): position in the ecosystem, repository layout, internal structure, how it works (diagrams), dependencies.
- [Contributing](CONTRIBUTING.md): development environment, Git and Jira workflow, conventions, CI/CD.
- [User README](docs/USER_README.md): the page of the extension shown to users in VS Code.
- [Changelog](CHANGELOG.md): the changes of each version, also the release notes of the GitHub releases.
- [Previous README](README.LEGACY.md): the documentation of the repository before the rewrite to the template.
- [Known issues and open questions](https://github.com/masagroup/wiki/wiki/known-issues#soft.vscode): the known defects and open points of the repository, kept in the SWORD wiki.
- Related repositories: [soft](https://github.com/masagroup/soft), [soft.ts](https://github.com/masagroup/soft.ts), [soft.gen](https://github.com/masagroup/soft.gen), [soft.models](https://github.com/masagroup/soft.models).
- Transverse pages: [Ecosystem next gen](https://github.com/masagroup/wiki/wiki/ecosystem-nextgen), [Ecore models, code generation and esync](https://github.com/masagroup/wiki/wiki/esync-ecore), [Glossary](https://github.com/masagroup/wiki/wiki/glossary).
- Repository on GitHub: [masagroup/soft.vscode](https://github.com/masagroup/soft.vscode).
- The same documentation in the SWORD wiki: [soft.vscode](https://github.com/masagroup/wiki/wiki/soft.vscode), [architecture](https://github.com/masagroup/wiki/wiki/soft.vscode-architecture), [contributing](https://github.com/masagroup/wiki/wiki/soft.vscode-contributing), [previous README](https://github.com/masagroup/wiki/wiki/soft.vscode-legacy).

License: [MPL-2.0](LICENSE), Copyright (c) MASA Group.
