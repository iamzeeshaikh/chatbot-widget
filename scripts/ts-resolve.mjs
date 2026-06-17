// Minimal resolve hook so `node` can run our TypeScript directly in tests:
// it retries failed relative specifiers with a `.ts` extension (Node's native
// type-stripping runs the file, but doesn't add extensions for bare imports
// like `./workspaces`). Used only for local test runs, not the app build.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
        const candidate = new URL(specifier + '.ts', context.parentURL)
        if (existsSync(fileURLToPath(candidate))) {
          // No explicit format — let Node infer TypeScript from the .ts extension
          // so its native type-stripping applies (same as a direct .ts import).
          return { url: candidate.href, shortCircuit: true }
        }
      }
      throw err
    }
  },
})
