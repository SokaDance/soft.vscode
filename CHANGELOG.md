# Changelog

## 0.2.0

- Ctrl+click a referenced type to go to its declaration, including declarations in external packages; navigable elements show as links while Ctrl is held, and the target row flashes after a go-to.
- External packages panel under the tree, with relative package paths; click a package to open it.
- Filter the tree on attribute values, with the matches highlighted.
- `Open as Text` opens on the selected element.
- Only the type names of a tree label are links.
- Enum literal icons have their own color.
- Fixes: rows with and without children are aligned, the element selected from the host scrolls into view, and URI fragments show with their percent escapes decoded.
- Updated `@masagroup/ecore` to 1.8.0 and re-serialized the samples with it.

## 0.1.0

- Initial release: tree and properties editor for `.ecore` files backed by Soft TS (`@masagroup/ecore`).
- Create, delete, reorder elements; edit attributes and references; filter; keyboard navigation.
- Edits are written back as XMI into the text document (standard undo/redo and save).
- Parse problems reported in the Problems view; read-only mode when the file cannot be round-tripped.
- `Ecorium: New Ecore Model`, `Open with Ecorium`, `Open as Text`, `Reload Model` commands.
