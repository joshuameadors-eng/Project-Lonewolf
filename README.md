# Project LoneWolf Launcher

**FirstBase Deployment Suite** — desktop app for building FirstBase / LoneWolf Windows deployment USB sticks (WinPE imaging, Windows Update payload, QA workflow).

Source for this repository is **private**. Installers and payload zips are published to a **public releases-only** repository.

<p align="center">
  <a href="https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/latest">
    <img src="https://img.shields.io/github/v/release/joshuameadors-eng/Project-Lonewolf-Releases?label=Download%20latest%20release&style=for-the-badge" alt="Download latest release">
  </a>
</p>

**[Download the latest release](https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/latest)**

Public binaries: [joshuameadors-eng/Project-Lonewolf-Releases](https://github.com/joshuameadors-eng/Project-Lonewolf-Releases) · source (private): this repo.

---

## What it is

| Piece | Role |
| --- | --- |
| **LoneWolf Launcher** | Electron GUI: pick a workflow, detect USB disks, full rebuild or overlay destage |
| **FirstBase payload** | Scripts copied onto the stick (`src/payload`) that run in WinPE / Audit / OOBE |
| **Builder** | PowerShell + optional .NET provisioner that lays out WinPE and the data partition |

## Install (packaged)

1. Download **`LoneWolf-Launcher-Setup.exe`** from the [latest release](https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/latest).
2. Run the installer **as Administrator** (UAC). It requests `requireAdministrator`, creates a **desktop shortcut**, and installs per-machine.
3. Launch **Project LoneWolf Launcher** from the desktop shortcut. The exe also requests elevation.

The Windows package is **unsigned**. **SmartScreen may warn** (“Windows protected your PC”) until the file builds reputation. That is expected. This project does **not** hide, disable, or bypass Microsoft Defender.

Optional portable asset: `LoneWolf-Launcher.exe` (same elevation requirement).

### What the installer includes

- The Electron app and bundled FirstBase scripts/payload.
- Not Node.js (the packaged app does not need a system Node install).
- Not the Windows ADK. **USB imaging** still needs WinPE optional components / ADK on the **machine that builds sticks**. Install those separately; the launcher will not silently install the ADK.

## Quick Update vs Launcher Update

These are **separate channels**. A script/payload change does **not** require a new launcher exe.

| Action | Downloads | Replaces |
| --- | --- | --- |
| **Quick Update** | `FirstBase-payload.zip` from public Releases | Payload and PowerShell scripts only |
| **Launcher Update** | `LoneWolf-Launcher-Setup.exe` (or portable exe) | The launcher application / installer |

Use **USB Builder → Quick Update** (overlay) to destage scripts onto an existing LoneWolf stick. That is independent of replacing `LoneWolf-Launcher.exe`.

In a **packaged/installed** app, Settings → Updates can pull those GitHub assets. `latest.json` on the release keeps `launcherVersion` and `payloadVersion` distinct.

## Dev workflow (USB testing)

Payload and builder live in **`src/`**. Destage/test USB sticks from that tree:

```bash
npm start
```

(`npm start` runs Electron against this checkout. **Quick Update / destage uses local `src/`.**)

Do **not** package (`npm run build`) in order to test a payload or destage fix. A packaged `dist/` build is a later shipping step, not the USB test loop.

Publishing binaries to the public repo (when you are ready): `npm run publish:public` (uses your logged-in `gh` CLI; no token in git).

## Requirements

- **Windows** 10/11 x64
- Administrator (launcher + USB imaging)
- For **building** imaging sticks: network access to the FirstBase staging share (unless Local Build Mode) and Windows ADK / WinPE OCs as used by the builder
- For **installing** the GUI only: the NSIS setup from Releases

## Tests

```bash
npm test
```

Installer/updater smoke (`scripts/e2e-installer-updater.ps1`). If `dist/LoneWolf-Launcher-Setup.exe` is missing, the silent-install step is skipped on purpose.
