/* Guides page — accordion help sections and FAQ */
;(function () {

  const SECTIONS = [
    {
      id: 'getting-started',
      title: '&#128196; Getting Started',
      content: `
        <p><strong>Project LoneWolf Launcher</strong> is a desktop application that allows technicians
        to quickly build deployment USB sticks. No configuration is needed — simply launch the app
        and it is ready to use.</p>

        <p><strong>Before you begin:</strong></p>
        <ul>
          <li>Make sure you are connected to the company network</li>
          <li>Have your USB sticks ready (32 GB or larger recommended)</li>
          <li>The app will automatically request administrator access when opened</li>
        </ul>

        <p><strong>How to get started:</strong></p>
        <ol>
          <li>Double-click the launcher to open it. Allow the administrator prompt if it appears.</li>
          <li>After the splash screen, you will land on the <strong>Home</strong> screen.</li>
          <li>Select the workflow that matches the device type you are preparing.</li>
          <li>Follow the on-screen steps to build your USB sticks.</li>
        </ol>
      `
    },
    {
      id: 'usb-builder',
      title: '&#128190; USB Builder — How to Use',
      content: `
        <div class="steps">
          <div class="step">
            <div class="step-n">1</div>
            <div class="step-b">
              <h4>Plug in USB sticks</h4>
              <p>Insert one or more USB drives (32 GB recommended). Everything on them
              will be erased — make sure they do not contain anything important.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-n">2</div>
            <div class="step-b">
              <h4>Pick a workflow on the Home screen</h4>
              <p>Select <strong>AMD64 Imaging</strong> for most standard laptops and desktops,
              or <strong>ARM64 Imaging</strong> for ARM-based devices. This opens the Builder screen.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-n">3</div>
            <div class="step-b">
              <h4>Select your USB sticks</h4>
              <p>The app automatically detects connected USB drives. Each drive is shown as a card
              with its name, size, and whether it has been previously built. Click each card to
              select it — selected cards are highlighted. All drives are selected by default.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-n">4</div>
            <div class="step-b">
              <h4>Wait for the pre-cache to finish, then start</h4>
              <p>The app prepares necessary files in the background. When ready, a prompt will
              appear asking if you want to start now. Click <strong>Start Now</strong> or use
              the <strong>Start Build</strong> button at the bottom.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-n">5</div>
            <div class="step-b">
              <h4>Confirm the build</h4>
              <p>A confirmation window will list the drives that will be erased. Review the list
              and click <strong>Confirm &amp; Proceed</strong> to begin. This cannot be undone.</p>
            </div>
          </div>
          <div class="step">
            <div class="step-n">6</div>
            <div class="step-b">
              <h4>Monitor and wait for completion</h4>
              <p>Each stick shows its own progress. All sticks build at the same time. When a
              stick is finished, its card turns green. A desktop notification will also appear.
              Once all sticks are complete, safely eject and hand them off.</p>
            </div>
          </div>
        </div>
        <div style="margin-top:1.25rem;padding-top:1rem;border-top:1px solid var(--card-border)">
          <button class="btn btn-out btn-sm" id="guides-launch-tutorial-btn">Launch interactive getting started guide</button>
        </div>
      `
    },
    {
      id: 'qa-workflow',
      title: '&#9711; Windows Updates Workflow',
      content: `
        <p><strong>AMD64 vs ARM64 — which do I pick?</strong> AMD64 covers the majority of standard
        laptops and desktops (Intel and AMD processors). ARM64 is for ARM-based Windows devices.
        If you are unsure, choose AMD64.</p>

        <p><strong>What this workflow does:</strong> The USB stick boots the device into a
        pre-deployment environment that automatically installs the current approved Windows build
        and applies all required updates and configurations without any interaction from the technician.
        The process runs entirely on its own from start to finish.</p>

        <p><strong>What to expect after plugging in the USB and booting the device:</strong></p>
        <ol>
          <li>The device boots from USB into a dark deployment screen</li>
          <li>Windows installation runs automatically in the background</li>
          <li>The device reboots on its own to the internal drive</li>
          <li>A full-screen dark <strong>Project LoneWolf Updates</strong> screen appears &mdash; this is normal, let it run</li>
          <li>The device may reboot multiple times automatically &mdash; this is expected</li>
          <li>Near the end a <strong>Settings</strong> window opens in front of the updates screen &mdash; close it to release the device</li>
          <li>The device seals itself and restarts on its own into the Windows setup screen (OOBE). The build is finished when the language/region screen appears &mdash; power the device off from that screen to pack it</li>
        </ol>

        <div class="callout callout-info">
          <span class="ci">&#8505;</span>
          To access a command prompt during deployment, press and hold <strong>Shift + F10</strong>.
          To switch to the Settings window at completion, press <strong>Alt + Tab</strong>.
        </div>

        <div class="callout callout-warn">
          <span class="ci">&#9888;</span>
          Do <u>not</u> power off the device while the updates screen is running. Let it complete on its own.
        </div>
      `
    },
    {
      id: 'media-creator',
      title: '&#128190; Media Creator',
      content: `
        <p><strong>Media Creator</strong> mounts ISO files and builds bootable USB sticks from
        Linux, Windows, and other OS images you choose, or from images staged on the deployment share.</p>
        <p><strong>Mount:</strong> Select an ISO, then click <strong>Mount ISO</strong>. Windows
        assigns a drive letter via Mount-DiskImage. Use <strong>Eject ISO</strong> when you are done.</p>
        <p><strong>Bootable USB:</strong> Confirm the listed USB disk, then start. Hybrid ISOs
        (ISO 9660 plus MBR/GPT at the start, typical of many Linux images) are written as a raw
        disk image. Windows installer ISOs with <code>sources\\install.wim</code> or
        <code>install.esd</code> use a FAT32 EFI partition plus NTFS data (files larger than 4 GB).
        Other ISOs try raw write; if that fails you get a clear error.</p>
        <p><strong>Local vs share:</strong> A local ISO file you pick works even when you are not on
        FirstbaseHQ. Listing or copying ISOs from the deployment share still requires FirstbaseHQ.</p>
        <p><strong>Not supported:</strong> Apple macOS restore / .dmg-style images, and some
        vendor utilities that need a custom tool (not Ventoy). Those will not boot from this writer.</p>
      `
    },
    {
      id: 'data-destruction',
      title: '&#128465; Secure Wipe USB',
      content: `
        <p><strong>Secure Wipe USB</strong> provisions sticks with the IT-staged destruction ISO
        from <code>Remote\\Staging\\Destruction\\</code>. The newest ISO on that share path is used
        automatically — there is no manual source picker.</p>
        <p>If no image is staged, contact IT to place the required wipe ISO on the share.</p>
      `
    },
    {
      id: 'bitraser',
      title: '&#128737; Bitraser USB',
      content: `
        <p><strong>Bitraser USB</strong> provisions sticks with the vendor Bitraser ISO staged
        by IT at <code>Remote\\Staging\\Bitraser\\</code>. The newest ISO in that folder is used
        automatically — there is no manual source picker.</p>
        <p>This workflow is separate from <strong>Media Creator</strong>, which lets you pick
        local or share ISOs for general bootable media.</p>
      `
    },
    {
      id: 'smart-app-control',
      title: '&#128737; Smart App Control / unsigned Setup',
      content: `<div id="guides-sac-body"></div>`
    },
    {
      id: 'faq',
      title: '&#10067; FAQ',
      content: `
        <div class="faq-q">The app says it cannot connect or find the share &mdash; what do I do?</div>
        <div class="faq-a">Make sure you are connected to the company network. If you are connected
        and still seeing this message, contact <strong>Joshua Meadors</strong> for assistance.</div>

        <div class="faq-q">One USB stick failed &mdash; do I have to redo everything?</div>
        <div class="faq-a">No. Each USB stick is built independently. Completed sticks are ready
        to use. Go back to the Builder screen, select only the stick that failed, and run the
        build again. The other sticks are not affected.</div>

        <div class="faq-q">A USB stick is not showing up in the app &mdash; what should I try?</div>
        <div class="faq-a">Unplug and re-insert the drive, then click <strong>Refresh</strong>
        on the Builder screen. Try a different USB port if possible, and avoid using USB hubs.
        If it still does not appear, contact <strong>Joshua Meadors</strong>.</div>

        <div class="faq-q">How do I tell which card in the app matches which physical stick?</div>
        <div class="faq-a">The app shows the drive name and size on each card. For multi-stick
        setups, label your sticks with tape before starting and match them to the names shown.</div>

        <div class="faq-q">Can I build multiple sticks at the same time?</div>
        <div class="faq-a">Yes &mdash; select all the sticks you want before clicking <strong>Start Build</strong>.
        They all build at the same time, so it is faster to do them all at once rather than one at a time.</div>

        <div class="faq-q">Does the app need a network connection?</div>
        <div class="faq-a">Yes. The app requires a connection to the company network to access
        the deployment files. Make sure you are on the network before launching a build.</div>

        <div class="faq-q">What is the "Pre-caching" bar at the top of the Builder screen?</div>
        <div class="faq-a">When you open a workflow, the app quietly prepares some files in the
        background. This only takes a minute or two and makes the actual build faster once it starts.
        You do not need to do anything &mdash; just wait for the prompt to appear.</div>

        <div class="faq-q">I am seeing an error I do not understand &mdash; what do I do?</div>
        <div class="faq-a">Take a screenshot or note the error message shown on screen, then
        contact <strong>Joshua Meadors</strong> directly. Do not attempt to resolve unknown
        errors on your own.</div>
      `
    }
  ]

  function renderSection(sec, isFirst) {
    const openClass = isFirst ? ' open' : ''
    return `
      <div class="ac-item${openClass}" id="ac-${sec.id}">
        <button class="ac-hdr" data-id="${sec.id}">
          ${sec.title}
          <span class="ac-chev">&#9662;</span>
        </button>
        <div class="ac-body">
          <div class="ac-content">${sec.content}</div>
        </div>
      </div>
    `
  }

  function init(root, _params, _navigate) {
    const page = document.createElement('div')
    page.className = 'page'
    page.innerHTML = `
      <div class="wrap">
        <div class="hero" style="padding-bottom:1.5rem">
          <div class="badge-pill">Help &amp; Guides</div>
          <h1 class="hero-h1">Interactive <span>Help</span></h1>
          <p class="hero-sub">Everything you need to use the Launcher — step-by-step guides, FAQ, and troubleshooting.</p>
        </div>

        <div class="accord" id="guides-accord">
          ${SECTIONS.map((s, i) => renderSection(s, i === 0)).join('')}
        </div>
      </div>
    `
    root.appendChild(page)

    page.querySelectorAll('.ac-hdr').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.ac-item')
        const isOpen = item.classList.contains('open')
        page.querySelectorAll('.ac-item.open').forEach(i => i.classList.remove('open'))
        if (!isOpen) item.classList.add('open')
      })
    })

    const tutorialBtn = page.querySelector('#guides-launch-tutorial-btn')
    if (tutorialBtn) {
      tutorialBtn.addEventListener('click', () => {
        if (window.__navigateTo) window.__navigateTo('#home')
        setTimeout(() => { if (window.__tutorial) window.__tutorial.start() }, 400)
      })
    }

    const sac = page.querySelector('#guides-sac-body')
    if (sac && window.LoneWolfSmartAppControlGuide) {
      sac.innerHTML = window.LoneWolfSmartAppControlGuide.HTML
    }
  }

  window.__pages.guides = { init }
})()
