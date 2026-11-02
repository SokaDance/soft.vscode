# soft.vscode: contributing

> How to set up a development environment, the Git and Jira workflow and the conventions of `soft.vscode` (Ecorium). Back to the [README](README.md) · [Architecture](ARCHITECTURE.md)

## Development environment

The commands are in the [README](README.md#build); the setup is the same on Windows and Linux.

- Node.js 22 (the version of the CI) and npm. Nothing else: no Java, no Docker, no Ant.
- Visual Studio Code 1.140.0 or later (`engines.vscode`), to run and debug the extension.
- A token for GitHub Packages. `@masagroup/ecore` ([soft.ts](https://github.com/masagroup/soft.ts)) is published on GitHub
  Packages, which needs a token even for public packages: put `//npm.pkg.github.com/:_authToken=<token with read:packages>`
  in your user `.npmrc`. The scope mapping (`@masagroup:registry=https://npm.pkg.github.com`) is already in the `.npmrc` of
  the repository; never commit a token.
- `npm install`, then `npm run compile`.

Run and debug:

- `F5` in VS Code starts the launch configuration "Run Ecorium" (`.vscode/launch.json`): it runs the task `npm: compile`,
  then opens an Extension Development Host on the `samples` folder, with auto save off (`samples/.vscode/settings.json`).
  Press the restart button of the debug toolbar after a rebuild, or run `npm run watch` in a terminal.
- `npm run harness` (after `npm run compile`) serves the real webview in a browser, with the model layer running in Node:
  quick iteration on the UI without an Extension Development Host. Edits are written to `out/harness-output.ecore`, never to
  the input file. Open as Text and opening external files are not available there.
- `npm run package` builds `ecorium-<version>.vsix`; install it with `code --install-extension ecorium-<version>.vsix`.

## Git and Jira workflow

- The organisation repository `masagroup/soft.vscode` is the reference (CI, releases). Work on a branch of it or of a fork,
  and open a pull request to `master`; never commit to `master` directly.
- Branches are named after the change (`feat/...`, `fix/...`, `build/...`, `release/X.Y.Z` in the history). When a Jira ticket
  exists, the SWORD convention is `<TICKET>-<short-description>`.
- Commit message: `<type>(<scope>): <description>` in English, imperative, with `type` in `feat`, `fix`, `refactor`, `test`,
  `build`, `ci`, `perf`, `docs`, `chore`, `style` and `scope` the area (`webview`, `editor`, `samples`, `release`...); add the
  Jira key after the scope (`<type>(<scope>): <TICKET-ID>: <description>`) when there is a ticket. The history uses
  `feat(webview): ...`, `fix(webview): ...`, `chore(release): 0.2.0`. One commit is one coherent change.
- Pull request: the workflow `Build and Test` runs on it (typecheck, tests, build, package) and must be green.
- Release: see [CI/CD](#cicd). A release is a version bump merged into `master`, then a tag.

## Conventions

- English for code, comments, commit messages and documentation.
- Format: `.prettierrc` (no semicolons, 4 spaces, 140 columns, no trailing commas). Prettier is not a dependency of the
  project and no script runs it. Do not reformat a whole file for a small change. <!-- TODO: verify how the maintainers run prettier -->
- Every source file starts with the MPL-2.0 header of the existing `.ts` files (`Copyright(c) 2026 MASA Group`).
- TypeScript is `strict` with `noUnusedLocals` and `noImplicitOverride` (`tsconfig.json` for the extension, the shared types
  and the tests; `tsconfig.webview.json` for the webview and the shared types). `npm run typecheck` (also `npm run lint`) must pass.
- Layering: `src/webview` imports no `vscode` module and no Soft TS value, only types from `src/shared/protocol.ts`, the only
  contract between the host and the webview; the code that uses `@masagroup/ecore` is under `src/extension`.
- Tests: [vitest](https://vitest.dev) (`npm test`), files `test/**/*.test.ts`. `test/ecoreModel.test.ts` covers the model layer
  (the samples and small inline models); `test/extension.test.ts` activates the extension against `test/vscode.stub.ts`, a minimal
  stand-in of the `vscode` module. The webview has no automated test: check it with `npm run harness` or `F5`.
- Samples: re-serialize `samples/*.ecore` with the current `@masagroup/ecore` after upgrading it (the 0.2.0 history does it).
- The model is read-only (`EcoreModel.isReadOnly()`) when the library reports an error, so that a file Soft TS cannot round-trip
  is never overwritten: keep it that way when touching the load path.
- Documentation: the README set (README, ARCHITECTURE, CONTRIBUTING, README.LEGACY) is the source of the
  [SWORD wiki](https://github.com/masagroup/wiki/wiki/soft.vscode); keep the metadata block at the top of the README up to date.
  The page of the extension inside VS Code is [docs/USER_README.md](docs/USER_README.md), packaged in place of the README by`n  `npm run package` (`vsce --readme-path`): keep it in step with the features, commands and settings.
- User-visible changes go to [CHANGELOG.md](CHANGELOG.md) under a `## X.Y.Z` heading.

## CI/CD

The two workflows run on GitHub-hosted runners (`ubuntu-latest`) and do not use the shared reusable workflows of
[cicd](https://github.com/masagroup/cicd), nor repository variables. Both need `packages: read` to install
`@masagroup/ecore` with the `GITHUB_TOKEN`.

| Workflow | Triggers | What it does |
|---|---|---|
| `.github/workflows/build_and_test.yaml` ("Build and Test") | pull request to `master` (opened, synchronize, reopened, ready_for_review), push to `master`, `workflow_dispatch`, `workflow_call` | setup-node 22 with the npm cache and the GitHub Packages registry, `npm ci --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, `npm run package`, uploads `*.vsix` as the workflow artifact `ecorium-vsix` |
| `.github/workflows/release.yaml` ("Release") | push of a tag `v*` | checks that the tag is `vX.Y.Z` or `vX.Y.Z-suffix` and equals the `package.json` version, runs Build and Test on the tagged commit, then creates the GitHub release "Ecorium X.Y.Z" with `ecorium-X.Y.Z.vsix`; the release notes are the `## X.Y.Z` section of `CHANGELOG.md` (generated notes if there is none); a tag with a suffix (`v1.0.0-rc.1`) gives a pre-release; if the release already exists, the VSIX asset is replaced |

Releasing a version:

1. In a pull request, bump the version and describe the changes: `npm version X.Y.Z --no-git-tag-version`, then add a
   `## X.Y.Z` section to `CHANGELOG.md`.
2. After the merge, tag the merge commit and push the tag to the `masagroup/soft.vscode` remote:
   `git tag vX.Y.Z <merge-commit>` then `git push <remote> vX.Y.Z`.
3. The Release workflow does the rest. The VSIX is attached to the GitHub release only: no workflow publishes it to the
   Visual Studio Marketplace or Open VSX. <!-- TODO: verify whether the extension is published on a marketplace by hand -->

There is no deployment, no Docker image, no npm package and no Slack notification.
