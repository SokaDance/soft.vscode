[![License](https://img.shields.io/github/license/masagroup/soft.vscode.svg)](https://github.com/masagroup/soft.vscode/blob/master/LICENSE)
![Build and Test](https://github.com/masagroup/soft.vscode/actions/workflows/build_and_test.yaml/badge.svg)

# Ecorium – Ecore Model Editor for VS Code

Ecorium is a tree and properties editor for [EMF](https://eclipse.dev/emf/) Ecore metamodels (`.ecore` files),
in the spirit of the Eclipse "Sample Ecore Model Editor", running inside Visual Studio Code.

The model is loaded, edited and serialized with [Soft TS](https://github.com/masagroup/soft.ts)
(`@masagroup/ecore`), the TypeScript implementation of the EMF core that is part of the
[Soft](https://github.com/masagroup/soft) project. No Java, no Eclipse.

## Features

- **Tree view** of the metamodel: packages, classifiers, structural features, operations, parameters,
  enum literals, annotations and their details, with EMF-like labels (`books : Book`, `Writer -> Person`,
  `RED = 0`, ...).
- **Properties panel** for the selected element: typed editors for attributes (text, number, boolean, enum),
  and combo boxes for references (`eType`, `eSuperTypes`, `eOpposite`, ...). Candidates include the elements
  of the edited file, the Ecore data types (`EString`, `EInt`, ...) and the elements of other `.ecore` files
  referenced by the model.
- **Create / delete / move**: right-click an element for `New Child`, `New Sibling`, `Move Up`,
  `Move Down` and `Delete`. Deleting an element also removes the references pointing to it.
- **Keyboard**: arrows to navigate, `Delete` to delete, `F2` to rename, `Ctrl+Up/Down` to reorder,
  `Enter` to jump to the properties. `Ctrl+Click` an element, a reference chip or the `→` button next to a
  type to go to its declaration; a type from another file or from Ecore itself opens in its own editor.
- **Filter** box to find elements by name.
- **External packages** panel under the tree: the `.ecore` files and built-in packages the document refers
  to, with their full path. `+` loads another file so its elements become reference candidates; `×` forgets
  a package again, and is greyed out while an element of the document still points into it.
- **Plain text underneath**: the editor writes standard XMI back into the text document, so **undo/redo,
  save, hot exit and source control** are the regular VS Code ones. `Open as Text` switches to the XML
  source at any time, and parse problems are listed in the **Problems** view.
- **Ecorium: New Ecore Model** command to create a file with an empty package.

## Usage

Open any `.ecore` file: Ecorium is the default editor. Use `Open as Text` (editor title or context menu)
to see the XMI, and `Open with Ecorium` to come back. Right-click in the tree to add elements.

When a file cannot be parsed, or uses constructs that Soft TS does not know (see limitations), the editor
becomes read-only and shows a banner: fix the file in the text editor, the model reloads automatically.

## Settings

| Setting                       | Default | Description                                                              |
| ----------------------------- | ------- | ------------------------------------------------------------------------ |
| `ecorium.autoNameNewElements` | `true`  | Give new named elements a default name (`NewClass`, `newAttribute`, ...). |

## Limitations

- Soft TS does not implement Ecore generics (`eGenericType`, `eTypeParameters`, `eGenericSuperTypes`).
  A file using them is opened read-only so that nothing is lost on save.
- The XMI is re-serialized on each edit: formatting is the canonical EMF layout, comments are not preserved.
- Cross-file references are resolved from disk when the file is opened; use `Ecorium: Reload Model` after
  changing a referenced file.

## Development

`@masagroup/ecore` is published on [GitHub Packages](https://github.com/orgs/masagroup/packages), which
requires a token even for public packages: put `//npm.pkg.github.com/:_authToken=<token with read:packages>`
in your user `.npmrc` (the scope mapping itself is in the project `.npmrc`).

```bash
npm install
npm run compile      # bundles dist/extension.js and dist/webview.js
npm test             # unit tests (vitest)
npm run typecheck
npm run harness      # serves the real webview against the model in Node, without VS Code
npm run package      # builds ecorium-<version>.vsix
```

Press `F5` in VS Code to launch an Extension Development Host with the `samples` folder.

## Releasing

Releases are driven by `vX.Y.Z` tags, like the other Soft repositories.

1. In a pull request, bump the version and describe the changes:
   `npm version X.Y.Z --no-git-tag-version`, then add a `## X.Y.Z` section to `CHANGELOG.md`.
2. After the merge, tag the merge commit and push the tag:
   `git tag vX.Y.Z masa/master` then `git push masa vX.Y.Z`.
3. The **Release** workflow checks that the tag matches `package.json`, builds and tests the tagged commit,
   and creates the GitHub release "Ecorium X.Y.Z" with `ecorium-X.Y.Z.vsix` attached and the CHANGELOG
   section as release notes. A tag with a suffix (`v1.0.0-rc.1`) produces a pre-release.

## License

[MPL-2.0](LICENSE) – Copyright (c) MASA Group.
