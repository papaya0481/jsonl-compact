# Contributing

Thank you for helping improve JSONL Compact Viewer. Keep changes focused on making JSON Lines easier to inspect in a compact, read-only view.

## Report an issue

Use the bug report or feature request template in GitHub Issues. For bugs, include the extension version, VS Code version, operating system, reproduction steps, and a small synthetic or anonymized JSONL example. Explain what you expected and what actually happened.

## Local development

You need Node.js 18+, Python 3, and VS Code 1.85+. Clone the repository and open its root directory in VS Code. There are no required npm dependencies to install.

```sh
npm run check
npm test
npm run package
```

Press `F5` to run the extension in an Extension Development Host. The included launch configuration opens `examples/sample.jsonl`.

The project uses CommonJS JavaScript and Python's standard library. Follow the conventions in [AGENTS.md](AGENTS.md) and preserve exact number display, source line numbers, per-line error handling, and the compact default layout.

## Optional browser tests

The browser suite exercises the actual shipped webview and extension message handlers with a mocked VS Code host. It requires a separate Playwright installation and a Chrome-compatible browser.

For example, in a POSIX shell:

```sh
npm install --no-save --package-lock=false playwright
CHROME_PATH="/path/to/chrome" node scripts/ui-test.cjs
```

On macOS, `CHROME_PATH` defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. If Playwright is installed outside this repository, set `PLAYWRIGHT_MODULE` to its module path instead of installing it here.

The script writes screenshots and results to the ignored `artifacts/` directory. It also regenerates `media/preview.png`; review that tracked image before including it in a change. Check both light and dark screenshots and verify keyboard interaction when changing the UI.

## Optional VS Code integration test

With the `code` CLI on your PATH, run this from a POSIX shell in the repository root:

```sh
mkdir -p artifacts
JSONL_TEST_PROFILE=$(mktemp -d)
JSONL_TEST_RESULT="$PWD/artifacts/extension-host-result.json" code \
  --user-data-dir="$JSONL_TEST_PROFILE/profile" \
  --extensions-dir="$JSONL_TEST_PROFILE/extensions" \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test/extension-host.js" \
  --skip-welcome --skip-release-notes --disable-workspace-trust \
  --new-window --wait "$PWD/examples/sample.jsonl"
```

The test checks extension activation, command registration, JSONL's default custom editor, and document behavior. It writes a JSON result to `artifacts/extension-host-result.json` and does not save source edits. The profile and extension directories are isolated from your normal VS Code configuration.

Set `JSONL_LARGE_FILE` to an absolute JSONL path when running the command to include a large-file regression check. This verifies that the custom editor opens without a VS Code text model and checks the streaming backend's first/last pages and source reads. It reports counts and sizes without writing record contents into the result.

## Pull requests

- Describe the concrete problem and resulting behavior.
- Add focused regression coverage when behavior changes.
- Update English and Chinese documentation for user-visible behavior or setting changes.
- Run the required checks above; include browser screenshots for layout changes where appropriate.
- Keep generated `.vsix` files, test artifacts, dependencies, and private data out of the pull request.

The GitHub Actions workflow checks JavaScript syntax, runs unit tests, builds the VSIX, and uploads the package as a workflow artifact. Browser and VS Code integration tests are optional local checks.

## Versioning and releases

The current version is `0.2.1`; the initial version was `0.1.0`. `package.json` is the source of truth; do not edit versions inside generated VSIX files.

For a release:

1. Set the intended version in `package.json` and update version references in both README files.
2. Add the release entry and date to `CHANGELOG.md`, moving completed changes out of `Unreleased`.
3. Run `npm run check`, `npm test`, and `npm run package`.
4. Install the generated VSIX in an isolated VS Code profile and verify a representative JSONL file.
5. Commit the release changes and create the matching tag, such as `v0.2.1`.
6. Push the commit and tag to the configured repository, then create a GitHub Release with that version's changelog and matching `.vsix` asset.

Generated VSIX packages are release assets and stay out of source control. GitHub Releases and VS Code Marketplace publishing are separate steps; the local `publisher` value is not a registered Marketplace identity.

## License

Contributions are provided under the project's [MIT License](LICENSE).
