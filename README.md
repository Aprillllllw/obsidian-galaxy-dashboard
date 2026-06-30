# 🌌 Knowledge Galaxy

Turn your Obsidian vault into an explorable 3D galaxy. Each top-level folder
becomes a glowing planet; subfolders orbit as moons; clicking a planet flies
the camera in and opens a panel with the folder's notes. Built with Three.js
(WebGL + bloom + a custom atmosphere shader) in a single static HTML file —
**no build step, no plugin, no server required. Just open it.**

![Knowledge Galaxy](screenshots/galaxy.png)

> _Per aspera ad astra_ — through hardship to the stars.

## ✨ Features

- **Real folder → planet mapping.** A small Python script scans your vault and
  generates the data; planet size scales with note count.
- **Full 3D interaction.** Drag to orbit the galaxy, scroll to zoom, drag a
  planet to spin it, click to fly in. Press `Esc` to return.
- **Live drill-down.** Entering a planet shows its subfolders as orbiting moons
  and lists recent notes in a side panel. Click any note to open it in Obsidian.
- **Five views.** Galaxy, Grid, Timeline, Stats, and a Search box that hands off
  to Obsidian's full-vault search.
- **Looks the part.** Bloom post-processing, a custom Fresnel atmosphere with
  animated electric arcs, a 9,000-point spiral galaxy core, and your own galaxy
  background image.
- **Zero dependencies to run.** Textures are embedded as base64 so the page
  works straight from `file://` — double-click and go.

## 🚀 Quick start

**1. See the demo.** Clone the repo and open `index.html` in your browser.
It ships with demo data so the galaxy renders immediately.

```bash
git clone https://github.com/Aprillllllw/obsidian-galaxy-dashboard.git
cd obsidian-galaxy-dashboard
open index.html        # macOS — or just double-click the file
```

**2. Point it at your own vault.** Run the scanner with your vault path:

```bash
python3 scripts/update_dashboard.py --vault "/path/to/your/Vault"
```

Then refresh the page (`Cmd/Ctrl+R`). That's it — you're flying through your
own notes. Re-run the scanner whenever you want fresh data.

Useful options:

```bash
# scan only a sub-folder as the galaxy root
python3 scripts/update_dashboard.py --vault "/path/to/Vault" --root "PARA"

# set the vault name used for obsidian:// links (defaults to the folder name)
python3 scripts/update_dashboard.py --vault "/path/to/Vault" --name "MyVault"

# hide folders with fewer than N notes (default 2)
python3 scripts/update_dashboard.py --vault "/path/to/Vault" --min 3
```

> 💡 The `obsidian://` links need the **vault name** to match exactly what
> Obsidian shows in its sidebar. If clicking a note does nothing, re-run with
> `--name "Your Vault Name"`.

## 🎨 Customize

Open **`config.js`** — one small file. Map each folder to a color, subtitle,
description, and optional Saturn rings:

```js
window.GALAXY_CONFIG = {
  title: "KNOWLEDGE GALAXY",
  subtitle: "YOUR  SECOND  BRAIN  AS  A  UNIVERSE",
  quote: "Per aspera ad astra",
  style: {
    "01_Projects": { sub:"Active work", color:"#4cc3ff", ring:true,
                     desc:"Things you are actively pushing forward." },
    // ...add an entry per folder. Anything you skip gets an auto color.
  },
};
```

Folders you don't list still appear, with a color picked from `palette`. So the
galaxy looks good even before you configure anything.

### Use your own planet art

Each planet can wear a custom texture — a **2:1 equirectangular** image (a
sphere "unwrapped" into a flat rectangle). Name the file after the folder and
re-pack:

```bash
# add textures/01_Projects.jpg, textures/02_Areas.jpg, ...
python3 scripts/embed_textures.py
```

This bundles `textures/*.jpg` and `assets/bg.jpg` into `textures.js` as base64
(needed because Chrome blocks WebGL from reading local images under `file://`).
Folders without a matching texture fall back to a procedurally generated planet.

## 🛠 How it works

```
index.html        ← the whole app: Three.js scene, shaders, interaction
config.js         ← your folder → planet styling
data.demo.js      ← demo data shipped with the repo (renders on first open)
data.js           ← generated from your vault; overrides the demo (gitignored)
textures.js       ← base64-packed planet textures + background
scripts/
  update_dashboard.py   scan vault → data.js
  embed_textures.py     pack textures/ + assets/bg.jpg → textures.js
  make_demo_data.py     regenerate the shipped demo data
assets/bg.jpg     ← galaxy background (drawn behind the planets)
textures/*.jpg    ← source planet textures (re-packed by embed_textures.py)
```

The dashboard is **read-only and offline**: it never writes to your vault and
makes no network calls except loading Three.js from a CDN. Your notes stay on
your machine.

## 🔒 Privacy

`data.js` contains your real note **titles and paths**. The repo only ships
`data.demo.js` (fake folders); your generated `data.js` is listed in
`.gitignore` and loaded *on top of* the demo. So git never tracks it and you
can't accidentally commit your notes — even if you fork. Delete `data.js` to
fall back to the demo at any time.

## 📦 Optional: run over http

You don't need a server (base64 textures make `file://` work). But if you
prefer `http://localhost`:

```bash
node serve.js            # http://localhost:8770
PORT=9000 node serve.js  # custom port
```

## 🖼 Assets & license

Code is released under the **MIT License** (see `LICENSE`). The bundled planet
and background images were generated with OpenAI's image tools and are provided
for free use alongside this project — swap in your own anytime.

Built with [Three.js](https://threejs.org/). Inspired by every PKM nerd who
wishes their notes felt like a universe. 🪐
