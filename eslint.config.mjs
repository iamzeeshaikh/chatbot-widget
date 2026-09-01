import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Throwaway probes and one-off verification scripts (gitignored). Linting
    // them made the documented lint baseline drift every session depending on
    // which scripts happened to be lying around.
    "scratch/**",
    // Vendored, minified worker: opus-recorder's libopus encoder, copied into
    // public/ so it is served from our own origin. Linting somebody else's
    // minified build moved the baseline by 46 problems and says nothing about
    // this codebase.
    "public/opus/**",
  ]),
]);

export default eslintConfig;
