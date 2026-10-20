# AutoRep

AutoRep is a Chrome Manifest V3 extension prototype for turning plain-English tasks into controlled web actions. The current slice focuses on **page intelligence**: it identifies the visited domain, describes the page structure, and produces a bounded inventory of actionable controls without sending literal `outerHTML` to the model.

## Current flow

```text
page → structured scan
     → site/domain + URL facts
     → headings/forms/tables/dialogs/content signals
     → bounded control inventory
     → AI planner receives structured JSON
     → snapshot-scoped action id
```

The Run loop now validates model actions against the current inventory, binds actions to the scan's `snapshotId`, and pauses when the page contains auth, payment, OTP, CAPTCHA, or similar sensitive-flow signals.

The side panel now has a visual workflow: inspect the page, see the target domain and control count, filter the discovered controls, highlight a control on the website, try a click/type/select action without writing code, and read whether the page visibly responded. Diagnostics remain available below the main workflow instead of being the primary interface.

The current inventory includes ordinary controls, open Shadow DOM controls, and accessible same-origin iframe controls. Cross-origin iframe controls are reported as inaccessible rather than guessed.

## Requirements

- Node.js `24.14.0` for the offline smoke checks (`.nvmrc`)
- Google Chrome or Chromium for loading the extension manually
- An API key only when using the AI Run flow

## Install and test

This project currently has no third-party npm dependencies.

```bash
npm test
```

The test command validates the MV3 manifest, JavaScript syntax, the structured page-intelligence contract, snapshot-aware actor wiring, and the manual fixture. Browser behavior still requires the manual steps below.

## Load the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this project directory.
5. Open the extension's **Details** page and enable **Allow access to file URLs** if you are testing `test-page.html` directly from disk.
6. Open `test-page.html` in a normal tab and reload it after enabling the extension.
7. Click the AutoRep toolbar action, open the side panel, and press **Inspect page**.
8. Use **Show on page** or **Try click** on a visible control to confirm the website-side marker and response.

## Test fixture

`test-page.html` intentionally contains:

- Links and buttons
- A search input
- A checkbox
- A select control
- A dynamic delete button
- An open Shadow DOM button and input
- A hidden control that should not appear
- A small table

## Design boundary

AutoRep does **not** send the whole serialized HTML document to the model. Full HTML is large, noisy, can contain secrets, and mixes page instructions with page data. The structured snapshot gives the planner the information it needs while retaining a clear boundary for future safety and privacy controls.

## Known limitations

- Chrome/browser integration tests are not automated yet.
- Provider adapters still use the existing OpenAI-compatible request path.
- Native select and contenteditable actions are now supported; file uploads remain intentionally unsupported.
- Action results distinguish verified page changes from actions that were sent but produced no visible response.
- A later slice can move more run state into the service worker for persistence across side-panel closes.
