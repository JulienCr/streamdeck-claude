import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";
import { userInfo } from "node:os";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.julien.claudesessions.sdPlugin";

// Build-time values for src/env.ts. The Windows-side SD app launches the
// plugin without HOME / WSL_DISTRO_NAME set, so we bake build-host values
// into the bundle as a fallback. Builds from WSL inject the live values;
// macOS builds inject HOME (used at runtime) and a harmless "Ubuntu" for
// WSL_DISTRO_NAME (never accessed on darwin, since wsl.exe is never spawned).
const BUILD_WSL_HOME = process.env.HOME || `/home/${userInfo().username}`;
const BUILD_WSL_DISTRO = process.env.WSL_DISTRO_NAME || "Ubuntu";

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
    {
      name: "inject-build-env",
      transform(code, id) {
        if (!id.endsWith("/src/env.ts")) return null;
        return {
          code: code
            .replace(/__BUILD_WSL_HOME__/g, BUILD_WSL_HOME)
            .replace(/__BUILD_WSL_DISTRO__/g, BUILD_WSL_DISTRO),
          map: null,
        };
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
