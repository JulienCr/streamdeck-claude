import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.julien.claudesessions.sdPlugin";

/** @type {import('rollup').RollupOptions} */
export default {
  input: "src/plugin.ts",
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    sourcemap: isWatching,
    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) =>
      url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href,
  },
  plugins: [
    {
      name: "watch-externals",
      buildStart() {
        this.addWatchFile(`${sdPlugin}/manifest.json`);
      },
    },
    typescript({ mapRoot: isWatching ? "./" : undefined }),
    nodeResolve({
      browser: false,
      exportConditions: ["node"],
      preferBuiltins: true,
      extensions: [".ts", ".js", ".mjs", ".json"],
    }),
    commonjs(),
    !isWatching && terser(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
      },
    },
    {
      name: "emit-build-info",
      generateBundle() {
        const now = new Date();
        const info = {
          builtAt: now.toISOString(),
          builtAtLocal: now.toLocaleString("sv-SE"), // YYYY-MM-DD HH:MM:SS, locale-stable
          unix: now.getTime(),
        };
        this.emitFile({ fileName: "build-info.json", source: JSON.stringify(info, null, 2), type: "asset" });
      },
    },
  ],
};
