#!/usr/bin/env python3
"""Package this dependency-free extension as a VSIX using Python's standard library.

The manifest and content types follow the VSIX 2.0 format used by VS Code.
The result can also be reproduced with `npx @vscode/vsce package --no-dependencies`.
"""
import json
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent.parent
package = json.loads((ROOT / "package.json").read_text())
ns = "http://schemas.microsoft.com/developer/vsx-schema/2011"
manifest = Element("PackageManifest", {"Version": "2.0.0", "xmlns": ns})
metadata = SubElement(manifest, "Metadata")
SubElement(metadata, "Identity", {
    "Language": "en-US", "Id": package["name"], "Version": package["version"], "Publisher": package["publisher"]
})
SubElement(metadata, "DisplayName").text = package["displayName"]
SubElement(metadata, "Description", {"xml:space": "preserve"}).text = package["description"]
SubElement(metadata, "Tags").text = ",".join(package["keywords"])
SubElement(metadata, "Categories").text = ",".join(package["categories"])
SubElement(metadata, "License").text = "extension/LICENSE"
properties = SubElement(metadata, "Properties")
for name, value in {
    "Engine": package["engines"]["vscode"], "ExtensionDependencies": "", "ExtensionPack": "",
    "ExtensionKind": "workspace", "LocalizedLanguages": "", "EnabledApiProposals": "", "ExecutesCode": "true"
}.items():
    SubElement(properties, "Property", {"Id": "Microsoft.VisualStudio.Code." + name, "Value": value})
installation = SubElement(manifest, "Installation")
SubElement(installation, "InstallationTarget", {"Id": "Microsoft.VisualStudio.Code"})
SubElement(manifest, "Dependencies")
assets = SubElement(manifest, "Assets")
for kind, filename in [
    ("Microsoft.VisualStudio.Code.Manifest", "package.json"),
    ("Microsoft.VisualStudio.Services.Content.Details", "README.md"),
    ("Microsoft.VisualStudio.Services.Content.Changelog", "CHANGELOG.md"),
    ("Microsoft.VisualStudio.Services.Content.License", "LICENSE")
]:
    SubElement(assets, "Asset", {"Type": kind, "Path": "extension/" + filename, "Addressable": "true"})

types = Element("Types", {"xmlns": "http://schemas.openxmlformats.org/package/2006/content-types"})
for suffix, mime in {
    "json": "application/json", "js": "application/javascript", "css": "text/css",
    "md": "text/markdown", "jsonl": "application/x-ndjson", "png": "image/png", "vsixmanifest": "text/xml"
}.items():
    SubElement(types, "Default", {"Extension": suffix, "ContentType": mime})
SubElement(types, "Override", {"PartName": "/extension/LICENSE", "ContentType": "text/plain"})

files = [ROOT / name for name in ["package.json", "README.md", "README.zh-CN.md", "CHANGELOG.md", "LICENSE"]]
for folder in ["src", "media", "examples"]:
    files.extend(sorted(path for path in (ROOT / folder).rglob("*") if path.is_file()))
target = ROOT / (package["name"] + "-" + package["version"] + ".vsix")
with ZipFile(target, "w", ZIP_DEFLATED) as archive:
    archive.writestr("extension.vsixmanifest", tostring(manifest, encoding="utf-8", xml_declaration=True))
    archive.writestr("[Content_Types].xml", tostring(types, encoding="utf-8", xml_declaration=True))
    for source in files:
        archive.write(source, "extension/" + str(source.relative_to(ROOT)))
print(f"Created {target} ({target.stat().st_size:,} bytes, {len(files)} extension files)")
