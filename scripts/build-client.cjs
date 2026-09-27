const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "client");
const destination = path.join(root, "dist", "public");

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });

const fontAwesomeCss = require.resolve(
    "@fortawesome/fontawesome-free/css/all.min.css",
);
const fontAwesomeRoot = path.dirname(path.dirname(fontAwesomeCss));
const fontAwesomeCssDestination = path.join(
    destination,
    "fontawesome",
    "css",
);
const fontAwesomeFontsDestination = path.join(
    destination,
    "fontawesome",
    "webfonts",
);
fs.mkdirSync(fontAwesomeCssDestination, { recursive: true });
fs.mkdirSync(fontAwesomeFontsDestination, { recursive: true });
fs.copyFileSync(
    fontAwesomeCss,
    path.join(fontAwesomeCssDestination, "all.min.css"),
);
const fontAwesomeCssText = fs.readFileSync(fontAwesomeCss, "utf8");
const fontFiles = [
    ...fontAwesomeCssText.matchAll(
        /url\(\.\.\/webfonts\/([^)?#]+)/g,
    ),
].map((match) => match[1]);
for (const fontFile of [...new Set(fontFiles)]) {
    fs.copyFileSync(
        path.join(fontAwesomeRoot, "webfonts", fontFile),
        path.join(fontAwesomeFontsDestination, fontFile),
    );
}

const sourceArchive = path.join(destination, "download-source.tar.gz");
execFileSync(
    "tar",
    [
        "-czf",
        sourceArchive,
        "--exclude=./node_modules",
        "--exclude=./dist",
        "--exclude=./data",
        "--exclude=./.env",
        "--exclude=./.env.*",
        ".",
    ],
    { cwd: root, stdio: "ignore" },
);
const archiveEntries = execFileSync(
    "tar",
    ["-tzf", sourceArchive],
    { encoding: "utf8" },
)
    .trim()
    .split("\n")
    .filter(Boolean);

console.log(
    `Copied BonziWorld client to ${path.relative(root, destination)} and packaged ${archiveEntries.length} source files`,
);