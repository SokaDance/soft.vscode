# Ecorium – Ecore Model Editor

Tree and properties editor for [EMF](https://eclipse.dev/emf/) Ecore metamodels (`.ecore` files), in the spirit of the
Eclipse "Sample Ecore Model Editor", running inside Visual Studio Code.

The model is loaded, edited and serialized with [Soft TS](https://github.com/masagroup/soft.ts) (`@masagroup/ecore`), the
TypeScript implementation of the EMF core of the [Soft](https://github.com/masagroup/soft) project. No Java, no Eclipse.

## Getting started

Open any `.ecore` file: Ecorium is the default editor for it.

1. Right-click in the tree to add elements, select one to edit it in the properties panel.
2. `Open as Text` (editor title) shows the XMI, `Open with Ecorium` (editor title or Explorer context menu) comes back.
3. When a file cannot be parsed, or the model is read-only, a banner says why: fix the file in the text editor, the model
   reloads automatically.

The editor writes standard XMI back into the text document, so undo/redo, save, hot exit and source control are the
regular VS Code ones.

## Features

- **Tree view** of the metamodel: packages, classifiers, structural features, operations, parameters, enum literals,
  annotations and their details, with EMF-like labels (`books : Book`, `Writer -> Person`, `RED = 0`...).
- **Properties panel** for the selected element: typed editors for attributes (text, number, boolean, enum) and combo
  boxes for references (`eType`, `eSuperTypes`, `eOpposite`...). Candidates are the elements of the edited file, the Ecore
  data types (`EString`, `EInt`...) and the elements of the other `.ecore` files the model refers to.
- **Create, delete, move**: right-click an element for `New Child`, `New Sibling`, `Move Up`, `Move Down` and `Delete`.
  Deleting an element also removes the references pointing to it.
- **Filter** box: finds elements by name or by the value of any attribute set on them (nsURI, instance class name,
  annotation details...); matches are highlighted in the tree and in the properties, `Enter` selects the first one.
- **Go to declaration**: `Ctrl+Click` an element, a reference chip or the `→` button next to a type; a type from another
  file or from Ecore itself opens in its own editor.
- **External packages** panel under the tree: the `.ecore` files and built-in packages the document refers to, with their
  path relative to the document; click one to open it, `+` loads another file so its elements become reference
  candidates, `×` forgets a package (greyed out while an element of the document still points into it).
- **Problems**: parse problems are listed in the Problems view.

## Keyboard

| Key | Action |
| --- | --- |
| Arrows, `Home`, `End` | navigate the tree |
| `Enter` | jump to the properties |
| `F2` | rename |
| `Delete` | delete |
| `Ctrl+Up` / `Ctrl+Down` | move up / down |
| `Shift+F10` | context menu |

## Commands

| Command | Description |
| --- | --- |
| Ecorium: Open with Ecorium | Open a `.ecore` file in Ecorium (also in the Explorer context menu) |
| Ecorium: Open as Text | Open the XMI on the element selected in the tree |
| Ecorium: Reload Model | Drop the cached files and reload the model |
| Ecorium: New Ecore Model | Create a file holding an empty package and open it in Ecorium |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ecorium.autoNameNewElements` | `true` | Give new named elements a default name (`NewClass`, `newAttribute`...). |

## Limitations

- Soft TS does not implement Ecore generics (`eGenericType`, `eTypeParameters`, `eGenericSuperTypes`); a file using them
  is opened read-only so that nothing is lost on save.
- The XMI is re-serialized on each edit: the layout is the canonical EMF one and comments are not preserved.
- Cross-file references are resolved from disk when the file is opened; run `Ecorium: Reload Model` after changing a
  referenced file.

## Feedback

Report problems on [GitHub](https://github.com/masagroup/soft.vscode/issues). The changes of each version are in the
[changelog](https://github.com/masagroup/soft.vscode/blob/master/CHANGELOG.md).

License: [MPL-2.0](https://github.com/masagroup/soft.vscode/blob/master/LICENSE), Copyright (c) MASA Group.
