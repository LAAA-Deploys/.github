#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html as html_module
import json
import re
import struct
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
LOGO_LIKE = re.compile(r"(?:laaa|logo|brand)", re.IGNORECASE)
UNRESOLVED = re.compile(r"{{|}}|\bTODO\b|\bPLACEHOLDER\b", re.IGNORECASE)
ATTR_RE = re.compile(r"([:\w-]+)\s*=\s*([\"'])(.*?)\2", re.DOTALL)
SLOT_RE = re.compile(
    r"<(?P<tag>[a-z][\w:-]*)(?P<attrs>[^>]*\bdata-laaa-brand-slot\s*=\s*['\"][^'\"]+['\"][^>]*)>"
    r"(?P<body>.*?)</(?P=tag)\s*>",
    re.IGNORECASE | re.DOTALL,
)


class DocumentAudit(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.h1_count = 0
        self.landmarks = {"main": 0, "nav": 0, "footer": 0}
        self.ids: set[str] = set()
        self.references: list[tuple[str, str]] = []
        self.fragments: list[str] = []
        self.image_errors: list[str] = []
        self.has_noindex = False

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        attrs = {key.lower(): value or "" for key, value in attrs_list}
        tag = tag.lower()
        if tag == "h1":
            self.h1_count += 1
        if tag in self.landmarks:
            self.landmarks[tag] += 1
        if attrs.get("id"):
            self.ids.add(attrs["id"])
        if tag == "meta" and attrs.get("name", "").lower() == "robots":
            directives = {item.strip().lower() for item in attrs.get("content", "").split(",")}
            self.has_noindex = "noindex" in directives
        if tag == "img":
            if not attrs.get("alt", "").strip():
                self.image_errors.append(f"Image is missing non-empty alt text: {attrs.get('src', '<no src>')}")
            if attrs.get("src"):
                self.references.append(("img", attrs["src"]))
            for candidate in attrs.get("srcset", "").split(","):
                if candidate.strip():
                    self.references.append(("img", candidate.strip().split()[0]))
        elif tag == "script" and attrs.get("src"):
            self.references.append(("script", attrs["src"]))
        elif tag == "link" and attrs.get("href"):
            self.references.append(("link", attrs["href"]))
        elif tag == "a" and attrs.get("href"):
            href = attrs["href"]
            if href.startswith("#") and len(href) > 1:
                self.fragments.append(unquote(href[1:]))

    handle_startendtag = handle_starttag


def fail(errors: list[str], message: str) -> None:
    if message not in errors:
        errors.append(message)


def safe_child(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"Path escapes site root: {relative}")
    return candidate


def png_dimensions(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Invalid PNG header: {path.name}")
    return struct.unpack(">II", header[16:24])


def local_reference_path(entrypoint: Path, root: Path, reference: str) -> Path | None:
    parts = urlsplit(reference)
    if parts.scheme or parts.netloc or reference.startswith("//") or reference.startswith("#"):
        return None
    if reference.startswith(("mailto:", "tel:", "sms:", "data:")):
        return None
    raw_path = unquote(parts.path)
    if not raw_path:
        return None
    if raw_path.startswith("/"):
        return safe_child(root, raw_path.lstrip("/"))
    return safe_child(root, str(entrypoint.parent.relative_to(root) / raw_path))


def load_contract(site: Path, errors: list[str]) -> dict[str, object]:
    contract_path = site / ".laaa-marketing.json"
    if not contract_path.exists():
        fail(errors, "Missing declarative .laaa-marketing.json contract")
        return {"schemaVersion": 1, "deliverable": "none", "entrypoint": "index.html", "requireNoindex": False}
    try:
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(errors, f"Invalid .laaa-marketing.json: {exc}")
        return {"schemaVersion": 1, "deliverable": "none", "entrypoint": "index.html", "requireNoindex": False}
    if contract.get("schemaVersion") != 1:
        fail(errors, "Unsupported site-contract schemaVersion")
    if contract.get("deliverable") not in {"bov", "om", "marketing"}:
        fail(errors, "deliverable must be bov, om, or marketing")
    allowed_keys = {"schemaVersion", "deliverable", "entrypoint", "requireNoindex"}
    unknown = sorted(set(contract) - allowed_keys)
    if unknown:
        fail(errors, f"Unknown site-contract fields: {', '.join(unknown)}")
    return contract


def load_manifest(path: Path, errors: list[str]) -> dict[str, dict[str, object]]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(errors, f"Invalid logo manifest: {exc}")
        return {}
    if manifest.get("schemaVersion") != 1:
        fail(errors, "Unsupported logo-manifest schemaVersion")
    by_filename: dict[str, dict[str, object]] = {}
    ids: set[str] = set()
    for asset in manifest.get("assets", []):
        required = {"id", "filename", "format", "bytes", "sha256", "allowedContexts"}
        missing = required - set(asset)
        if missing:
            fail(errors, f"Manifest asset missing fields: {', '.join(sorted(missing))}")
            continue
        if asset["id"] in ids:
            fail(errors, f"Duplicate manifest asset ID: {asset['id']}")
        ids.add(asset["id"])
        by_filename[asset["filename"]] = asset
    return by_filename


def audit_brand_slots(source: str, entrypoint: Path, site: Path, manifest: dict[str, dict[str, object]], errors: list[str]) -> set[Path]:
    seen_slots: dict[str, int] = {}
    approved_paths: set[Path] = set()
    for match in SLOT_RE.finditer(source):
        attrs = {key.lower(): value for key, _, value in ATTR_RE.findall(match.group("attrs"))}
        slot = attrs.get("data-laaa-brand-slot", "").lower()
        variant = attrs.get("data-logo-variant", "").lower()
        context = attrs.get("data-brand-context", "").lower()
        seen_slots[slot] = seen_slots.get(slot, 0) + 1
        body = match.group("body")
        if re.search(r"<(?:svg|canvas)\b|data:image|\bstyle\s*=", body, re.IGNORECASE):
            fail(errors, f"Brand slot {slot or '<unnamed>'} contains prohibited inline or synthesized content")
        visible_text = html_module.unescape(re.sub(r"<[^>]+>", "", body)).strip()
        if visible_text:
            fail(errors, f"Brand slot {slot or '<unnamed>'} contains styled text")
        images = re.findall(r"<img\b([^>]*)>", body, re.IGNORECASE | re.DOTALL)
        if len(images) != 1:
            fail(errors, f"Brand slot {slot or '<unnamed>'} must contain exactly one image")
            continue
        image_attrs = {key.lower(): value for key, _, value in ATTR_RE.findall(images[0])}
        src = image_attrs.get("src", "")
        if not src:
            fail(errors, f"Brand slot {slot or '<unnamed>'} image has no src")
            continue
        try:
            logo_path = local_reference_path(entrypoint, site, src)
        except ValueError as exc:
            fail(errors, str(exc))
            continue
        if logo_path is None or not logo_path.exists():
            fail(errors, f"Brand slot {slot or '<unnamed>'} references missing asset: {src}")
            continue
        approved = manifest.get(logo_path.name)
        if not approved:
            fail(errors, f"Brand slot {slot or '<unnamed>'} references unknown logo: {src}")
            continue
        approved_paths.add(logo_path)
        expected_filename = {"black": "LAAA_Team_Black.png", "blue": "LAAA_Team_Blue.png", "white": "LAAA_Team_White.png"}.get(variant)
        if expected_filename != logo_path.name:
            fail(errors, f"Brand slot {slot or '<unnamed>'} variant does not match {logo_path.name}")
        expected_context = f"web-{context}"
        if expected_context not in approved.get("allowedContexts", []):
            fail(errors, f"Logo {logo_path.name} is not approved for {expected_context}")
        payload = logo_path.read_bytes()
        if len(payload) != approved["bytes"]:
            fail(errors, f"Logo byte-count mismatch: {src}")
        if hashlib.sha256(payload).hexdigest().upper() != str(approved["sha256"]).upper():
            fail(errors, f"Logo SHA-256 mismatch: {src}")
        dimensions = approved.get("rasterDimensions")
        if dimensions:
            try:
                if png_dimensions(logo_path) != (dimensions["width"], dimensions["height"]):
                    fail(errors, f"Logo dimension mismatch: {src}")
            except ValueError as exc:
                fail(errors, str(exc))

    for required_slot in ("header", "footer"):
        if seen_slots.get(required_slot) != 1:
            fail(errors, f"Expected exactly one {required_slot} brand slot")

    for wordmark in re.finditer(r"<(?P<tag>[a-z][\w:-]*)(?P<attrs>[^>]*class\s*=\s*['\"][^'\"]*wordmark[^'\"]*['\"][^>]*)>(?P<body>.*?)</(?P=tag)\s*>", source, re.I | re.S):
        text = html_module.unescape(re.sub(r"<[^>]+>", "", wordmark.group("body"))).strip()
        if re.search(r"\bLAAA\b", text, re.IGNORECASE):
            fail(errors, "Styled-text LAAA wordmark detected")
        if "data-laaa-brand-slot" not in wordmark.group(0):
            fail(errors, "Wordmark container does not include an approved brand slot")
    return approved_paths


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a committed LAAA marketing static tree without executing site code")
    parser.add_argument("--site", required=True, type=Path)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().parents[1] / "branding" / "logo_manifest.json")
    args = parser.parse_args()

    site = args.site.resolve()
    errors: list[str] = []
    if not site.is_dir():
        print(f"MARKETING QUALITY FAILED\n- Site is not a directory: {site}")
        return 1
    for path in site.rglob("*"):
        if path.is_symlink():
            fail(errors, f"Symlink is not permitted in governed static output: {path.relative_to(site)}")

    contract = load_contract(site, errors)
    try:
        entrypoint = safe_child(site, str(contract.get("entrypoint", "index.html")))
    except ValueError as exc:
        fail(errors, str(exc))
        entrypoint = site / "index.html"
    if not entrypoint.exists():
        fail(errors, f"Missing entrypoint: {entrypoint.relative_to(site)}")
        source = ""
    else:
        source = entrypoint.read_text(encoding="utf-8", errors="strict")

    manifest = load_manifest(args.manifest.resolve(), errors)
    audit = DocumentAudit()
    audit.feed(source)
    if audit.h1_count != 1:
        fail(errors, f"Expected exactly one h1; found {audit.h1_count}")
    for landmark, count in audit.landmarks.items():
        if count < 1:
            fail(errors, f"Missing {landmark} landmark")
    for message in audit.image_errors:
        fail(errors, message)
    for fragment in audit.fragments:
        if fragment not in audit.ids:
            fail(errors, f"Broken in-page anchor: #{fragment}")
    for tag, reference in audit.references:
        try:
            referenced = local_reference_path(entrypoint, site, reference)
        except ValueError as exc:
            fail(errors, str(exc))
            continue
        if referenced is not None and not referenced.is_file():
            fail(errors, f"Missing local {tag} asset: {reference}")
    if UNRESOLVED.search(source):
        fail(errors, "Unresolved template or placeholder marker detected")
    if contract.get("requireNoindex") and not audit.has_noindex:
        fail(errors, "Required noindex robots meta is missing")

    approved_paths = audit_brand_slots(source, entrypoint, site, manifest, errors)
    for candidate in site.rglob("*"):
        if not candidate.is_file() or candidate.suffix.lower() not in IMAGE_EXTENSIONS or not LOGO_LIKE.search(candidate.name):
            continue
        if candidate.resolve() not in approved_paths:
            fail(errors, f"Unknown or unused logo-like asset: {candidate.relative_to(site).as_posix()}")
    for css in site.rglob("*.css"):
        if re.search(r"content\s*:\s*['\"][^'\"]*LAAA", css.read_text(encoding="utf-8", errors="ignore"), re.I):
            fail(errors, f"CSS-generated LAAA wordmark detected: {css.relative_to(site)}")

    if errors:
        print(f"MARKETING QUALITY FAILED ({len(errors)})")
        for error in errors:
            print(f"- {error}")
        return 1
    print("MARKETING STATIC QUALITY PASSED")
    print(json.dumps({"entrypoint": entrypoint.relative_to(site).as_posix(), "deliverable": contract.get("deliverable"), "filesInspected": sum(1 for path in site.rglob('*') if path.is_file())}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
