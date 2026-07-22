# LAAA marketing site contract

Governed OM, BOV, and marketing repositories publish committed static output. The trusted workflow reads the resulting repository tree and never executes repository-controlled build scripts or configuration code.

Each site includes `.laaa-marketing.json` with a versioned declarative contract:

```json
{
  "schemaVersion": 1,
  "deliverable": "om",
  "entrypoint": "index.html",
  "requireNoindex": true
}
```

The rendered entrypoint must include:

- One `h1`, `main`, navigation, and footer landmarks.
- Image-backed `header` and `footer` brand slots. Each slot declares `data-laaa-brand-slot`, `data-logo-variant`, and `data-brand-context`; the referenced file must match `branding/logo_manifest.json` byte-for-byte.
- `data-laaa-hero-content` and `data-laaa-hero-kpis` on the two hero regions when a KPI strip is present.
- `data-laaa-menu-toggle`, `data-laaa-menu-label`, and `data-laaa-menu` on mobile-navigation controls.
- A keyboard-focusable region and a visible `data-laaa-scroll-cue` for every horizontally overflowing data table.

The brand slots may not contain inline SVG, canvas, base64 images, styled text, or altered/unknown logo files. Ordinary prose references to “LAAA Team” remain allowed outside a wordmark or brand slot.
