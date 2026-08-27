# Project LoneWolf Launcher

**FirstBase Deployment Suite** — desktop app for building FirstBase / LoneWolf Windows deployment USB sticks (WinPE imaging, Windows Update payload, QA workflow).

Source for this repository is **private**. The public [Project-Lonewolf-Releases](https://github.com/joshuameadors-eng/Project-Lonewolf-Releases) repo holds **payload/scripts**, portable `LoneWolf-Launcher.exe`, and `latest.json` in the **git tree**. The GitHub **Releases** page has **only** the installer (`LoneWolf-Launcher-Setup.exe`). Packaged updates read versions from public source `latest.json` (raw / Contents API) — **not** from the ISO network share and not from private `VERSION.json` as the live source.

<p align="center">
  <a href="https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/download/installer/LoneWolf-Launcher-Setup.exe">
    <img src="https://img.shields.io/github/v/release/joshuameadors-eng/Project-Lonewolf-Releases?label=Download%20installer&style=for-the-badge" alt="Download installer">
  </a>
</p>

**[Download the installer](https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/download/installer/LoneWolf-Launcher-Setup.exe)** (`LoneWolf-Launcher-Setup.exe`, unversioned; one stable link) — no GitHub account required.

Public files: [joshuameadors-eng/Project-Lonewolf-Releases](https://github.com/joshuameadors-eng/Project-Lonewolf-Releases) · source (private): this repo.

| Download | Where |
| --- | --- |
| **Installer** (styled UI, one UAC) | **One URL:** [LoneWolf-Launcher-Setup.exe](https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/download/installer/LoneWolf-Launcher-Setup.exe) (stable tag `installer`; only release asset) |
| **Portable exe** | Public **repo files**: `bin/LoneWolf-Launcher.exe` |
| **Scripts / payload** | Public **repo files**: `payload/`, `powershell/`, and `FirstBase-payload.zip` |
| Version manifest | Public **repo files**: `latest.json` |

---

## What it is

| Piece | Role |
| --- | --- |
| **LoneWolf Launcher** | Electron GUI: pick a workflow, detect USB disks, full rebuild or overlay destage |
| **FirstBase payload** | Scripts copied onto the stick (`src/payload`) that run in WinPE / Audit / OOBE |
| **Builder** | PowerShell + optional .NET provisioner that lays out WinPE and the data partition |

## Install (packaged)

1. Download **`LoneWolf-Launcher-Setup.exe`** from the [single installer URL](https://github.com/joshuameadors-eng/Project-Lonewolf-Releases/releases/download/installer/LoneWolf-Launcher-Setup.exe).
2. Run it. Windows shows **one** UAC prompt for the whole first install.
3. The installer UI checks for **.NET 8 Desktop Runtime (x64)** (needed by `LoneWolf.Provisioner`, which targets `net8.0-windows` and is published `win-x64` not self-contained). If it is already present, download is skipped. If not, it installs quietly from Microsoft (`aka.ms`) with no second UAC.
4. It then **downloads the latest portable** `LoneWolf-Launcher.exe` from public `latest.json` / `bin/`, copies it to a **stable path** (`C:\Program Files\Project LoneWolf Launcher\`), and creates a **desktop shortcut** (Run as Administrator) and Start Menu shortcut. That shortcut stays across later launcher/payload updates.
5. Launch **Project LoneWolf Launcher** from the desktop shortcut.

The Windows package is **unsigned**. **SmartScreen may warn** (“Windows protected your PC”) until the file builds reputation. That is expected. This project does **not** hide, disable, or bypass Microsoft Defender.

Optional portable file: `bin/LoneWolf-Launcher.exe` in the public repo (not a Releases asset).

### What the installer includes

- .NET 8 Desktop Runtime x64 (installed from Microsoft if missing; skipped if present).
- The latest portable launcher (fetched at install time from the public source tree; this Setup file is not a launcher version).
- Not Node.js (the packaged app does not need a system Node install).
- Not the Windows ADK. **USB imaging** still needs WinPE optional components / ADK on the **machine that builds sticks**. Install those separately; the launcher will not silently install the ADK.

## Quick Update vs Launcher Update

These are **separate channels**. A script/payload change does **not** require a new launcher exe. Installed/packaged version compare uses public **`latest.json`** in the [Project-Lonewolf-Releases](https://github.com/joshuameadors-eng/Project-Lonewolf-Releases) **source tree**. The network share is **ISO staging only** (WinPE / Windows images). It must not host launcher exe, payload zip, or version files.

| Action | Downloads | Replaces |
| --- | --- | --- |
| **Quick Update** | `FirstBase-payload.zip` from the public **source tree** | Payload and PowerShell scripts only (never the shortcut or Setup) |
| **Launcher Update** | `bin/LoneWolf-Launcher.exe` from the public **source tree** | The exe at the same install path (refreshes the shortcut only if missing; never runs Setup) |

Use **USB Builder → Quick Update** (overlay) on both `npm start` and the **packaged/installed** launcher to destage scripts onto an existing LoneWolf stick. That is independent of replacing `LoneWolf-Launcher.exe`. If the stick's **image build date** is older than the current share ISO, Full Rebuild is selected by default; Quick Update stays available.

In a **packaged/installed** app, Settings → Updates pulls payload from public **source** (`latest.json` / `payload/`), not a new Setup.exe. `latest.json` keeps `launcherVersion` and `payloadVersion` distinct.

## Dev workflow (USB testing)

Payload and builder live in **`src/`**. Destage/test USB sticks from that tree:

```bash
npm start
```

(`npm start` runs Electron against this checkout. **Quick Update / destage uses local `src/`.**)

Do **not** package (`npm run build`) in order to test a payload or destage fix. A packaged `dist/` build is a later shipping step, not the USB test loop.

Publishing to the public repo (when you are ready): `npm run publish:public` (uses your logged-in `gh` CLI; no token in git). That commits payload + portable exe + `latest.json` to the public **source tree** and **overwrites** `LoneWolf-Launcher-Setup.exe` on the stable **`installer`** release tag. If `dist/` does not yet contain the portable exe, run `npm run build` once (after the dev installer is confirmed), compile the bootstrapper (`npm run installer:compile`), then `npm run publish:public`.

## Requirements

- **Windows** 10/11 x64
- Administrator (launcher + USB imaging)
- **.NET 8 Desktop Runtime x64** (the installer installs it; required for the WinPE provisioner)
- For **building** imaging sticks: network access to the FirstBase **ISO** staging share (unless Local Build Mode) and Windows ADK / WinPE OCs as used by the builder. Launcher exe and versioning do **not** come from the share.
- For **installing** the GUI: the Setup bootstrapper from Releases

## Tests

```bash
npm test
```

Installer/updater smoke (`scripts/e2e-installer-updater.ps1`). If `dist/LoneWolf-Launcher-Setup.exe` is missing, the silent-install step is skipped on purpose.
