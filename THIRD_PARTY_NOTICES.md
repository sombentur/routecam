# Third-party components

Everything in this repository was written for Routecam. No third-party library, font, icon, image or dataset is bundled, and the panel downloads nothing at run time.

| Component | Where | Licence | Notes |
|---|---|---|---|
| Adobe CEP (Common Extensibility Platform) runtime | Part of After Effects | Adobe | The panel targets Adobe's documented extension format (`CSXS/manifest.xml`, `__adobe_cep__`, ExtendScript). No Adobe code or SDK files are included. |
| Fonts | None bundled | - | The panel uses the system UI font ("Segoe UI" on Windows, the system font elsewhere) through CSS; nothing is shipped. The sample composition's number labels use After Effects' default text font on the computer that opens it. |
| Node.js (for the tests and the build script only) | Not included | MIT | Users of the panel do not need it. |

## Screenshots in `docs/screenshots/`

All frames were rendered by After Effects from the plugin's own sample composition (solid colour cards, a grid effect and text layers). The two panel screenshots show the plugin's own interface. Nothing from other people's projects or imagery appears in them.

## Trademarks

Adobe and After Effects are trademarks of Adobe Inc. Routecam is an independent project and is not affiliated with or endorsed by Adobe.
