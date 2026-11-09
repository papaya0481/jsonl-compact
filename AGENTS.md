# Repository instructions

These instructions apply to the entire repository.

## Project purpose

JSONL Compact Viewer is a read-only VS Code custom editor for `.jsonl`, `.ndjson`, and `.jsonlines` files. Preserve its compact, DevTools-style layout: records start collapsed on a single row and expand in place.

## Repository map

- `src/extension.js`: custom-editor registration, VS Code APIs, webview messages, and document updates.
- `src/document.js`: independent read-only document lifecycle, dirty text snapshots, filesystem watchers, and virtual-resource fallback.
- `src/file-source.js`: streaming UTF-8 scans, chunked byte-offset indexes, bounded file-range reads, and search cancellation.
- `src/records.js`: physical source lines, filtering, pagination, and transfer limits.
- `media/model.js`: iterative JSON parser and compact summaries.
- `media/viewer.js`: browser rendering, lazy child nodes, navigation, and state.
- `media/viewer.css`: layout and VS Code theme integration.
- `test/*.test.js`: dependency-free parser and record-model tests.
- `test/extension-host.js`: optional integration test loaded by VS Code.
- `scripts/ui-test.cjs`: optional Playwright test of the shipped webview and message handlers.
- `scripts/package.py`: offline VSIX packaging using the Python standard library.
- `examples/`: synthetic sample data only.

## Implementation conventions

- Use CommonJS and two-space indentation for JavaScript; use four spaces for Python.
- Keep the shipped extension free of runtime third-party dependencies and network requests.
- Keep file processing compatible with remote and virtual workspaces. Stream `file:` URIs through Node filesystem APIs on the current workspace extension host; use bounded VS Code filesystem reads for other schemes and existing dirty text documents for unsaved changes.
- Keep the custom editor independent of VS Code's complete `TextDocument` model, so large files can open before or without that model being available.
- Preserve original number tokens, duplicate keys, physical line numbers, and per-record error isolation.
- Keep the JSON parser iterative so deeply nested input does not overflow the JavaScript call stack.
- Render file content through text nodes or `textContent`. Keep the restrictive webview CSP and local-resource boundary.
- Render nested children lazily in bounded batches; keep record/page transfer limits explicit.
- Maintain keyboard navigation and light, dark, and high-contrast theme support.
- Keep string contents inspectable whenever a summary or the viewport shortens them. Preserve original text and newlines in the expanded view, and keep summary string actions accessible by keyboard.
- Avoid unrelated UI changes. The current UI is Simplified Chinese; English and Chinese documentation should describe it accurately.

## Validation

Run these commands from the repository root after relevant code or packaging changes:

```sh
npm run check
npm test
npm run package
```

No dependency installation is needed for these commands. Use `python scripts/package.py` or `py -3 scripts/package.py` if `python3` is unavailable.

For webview interaction or layout changes, run the optional browser checks described in `CONTRIBUTING.md` when a browser and Playwright are available. Review generated screenshots, including the tracked `media/preview.png`. For VS Code API changes, use the extension-host integration test or the F5 development host. Report which checks actually ran and any unavailable environment; local checks do not establish that GitHub-hosted CI passed.

Do not add tests that merely restate implementation details. Add focused coverage for changed parsing, pagination, messaging, or data-handling behavior.

## Documentation and release files

- `README.md` is the English landing page; `README.zh-CN.md` is the Chinese guide. Keep shared behavior and settings consistent.
- `package.json` is the version source of truth. Packaging derives the VSIX name and manifest version from it.
- When changing the version, update both README version references and `CHANGELOG.md`; release tags use `v<version>`.
- The packager explicitly lists shipped files. Include user-facing release documentation and exclude development-only files.
- Keep generated VSIX files, browser artifacts, caches, logs, and credentials out of Git. `media/preview.png` is the intentional screenshot exception.
- Use relative documentation links. Add actual repository, issue, or Marketplace URLs only when those destinations are known.
