// Render brand-src SVGs to PNG/ICO using sharp (installed in core/).
// Run from the repository root:  node brand-src/render.js
const path = require("path");
const fs = require("fs");
const sharp = require(
  path.join(__dirname, "..", "core", "node_modules", "sharp"),
);

const ROOT = path.join(__dirname, "..");
const SRC = path.join(__dirname, "mark.svg");

const targets = [
  // VS Code extension icon (Marketplace requires >= 128px)
  ["extensions/vscode/media/icon.png", 256],
  // Activity-bar / sidebar icon
  ["extensions/vscode/media/sidebar-icon.png", 128],
  // Docs favicon and GUI logo
  ["docs/favicon.png", 128],
  ["gui/public/logos/continued.png", 256],
];

async function main() {
  const svg = fs.readFileSync(SRC);
  for (const [rel, size] of targets) {
    const out = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out);
    console.log(`wrote ${rel} (${size}px)`);
  }

  // Multi-size ICO: PNG-compressed frames inside an ICO container.
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = await Promise.all(
    sizes.map((s) =>
      sharp(svg, { density: 384 }).resize(s, s).png().toBuffer(),
    ),
  );
  fs.writeFileSync(
    path.join(ROOT, "gui/public/favicon.ico"),
    buildIco(sizes, frames),
  );
  console.log("wrote gui/public/favicon.ico");
}

// ICO container with PNG frames (Windows Vista+ format).
function buildIco(sizes, pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const o = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, o); // width (0 = 256)
    dir.writeUInt8(s >= 256 ? 0 : s, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(pngs[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, dir, ...pngs]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
