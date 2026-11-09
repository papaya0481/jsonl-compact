# Changelog

Versions follow Semantic Versioning. The version in `package.json` determines the VSIX filename and manifest; Git release tags use a `v` prefix.

## [Unreleased]

## [0.2.1] - 2026-10-26

### Fixed

- Strings clipped by a narrow pane could show an ellipsis without any way to reveal the full value if they were shorter than the summary's 90-character threshold.
- Clicking a shortened string in a collapsed object or array preview now opens the corresponding string field directly, instead of only opening the surrounding container.

### Changed

- Every string value has an expandable full-text view and explicit expand/collapse controls, including root-level and array values.
- Full text preserves original characters and newlines, wraps within the pane, and scrolls vertically when needed. Summaries remain compact and keyboard-accessible.

## [0.2.0] - 2026-10-26

### Fixed

- Large JSONL files could fail before the viewer opened with `Unable to retrieve document from URI` because the custom text editor required a complete VS Code text model.
- Large records could exhaust the page transfer budget and hide valid neighboring records. File-backed pages now split by byte size as well as record count.

### Changed

- Use a custom read-only document with streaming UTF-8 line indexing and on-demand file-range reads for local and remote-host file URIs.
- Preserve source line numbers, BOM/CRLF handling, unsaved text changes, and source navigation without opening a full text model for the viewer.
- Show indexing/search progress; cancel stale requests and rebuild indexes after source changes.
- Scan complete records during filtering, including records too large to preview, with bounded chunk buffers.
- Bound non-file virtual resource fallback to 32 MiB and single-record clipboard copies to the preview limits.

## [0.1.0] - 2026-10-26

### Added

- Initial JSONL, NDJSON, and JSON Lines custom editor for VS Code 1.85+.
- Compact single-row record summaries with inline expandable JSON trees.
- Nested object/array navigation, lazy child batches, and full long-string inspection.
- Whole-document text filtering, pagination, record copying, and physical source-line navigation.
- Exact number-token display, duplicate object keys, and isolated malformed-line diagnostics.
- Live document updates, keyboard controls, and VS Code theme integration.
- English and Chinese documentation, an MIT license, contributor and agent guides, GitHub templates, and CI configuration.
- Dependency-free unit tests and offline VSIX packaging, plus optional browser and extension-host tests.
