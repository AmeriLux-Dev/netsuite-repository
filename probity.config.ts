import { basename } from 'node:path'
import {
  defineConfig,
  enforceTdd,
  forbidCommandPattern,
  forbidContentPattern,
  requireCommand,
  type Rule,
} from '@nizos/probity'

const allowFlexibleButCleanFilenames: Rule = (action) => {
  if (action.kind !== 'write') return { kind: 'pass' }

  const name = basename(action.path)
  if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name)) {
    return { kind: 'pass' }
  }

  return {
    kind: 'violation',
    reason: 'Use clean filenames without spaces or unusual punctuation.',
  }
}

const limitSourceFileLength =
  (maxLines = 350): Rule =>
  (action) => {
    if (action.kind !== 'write') return { kind: 'pass' }
    if (!/\/src\/.*\.ts$/.test(action.path)) return { kind: 'pass' }

    const name = basename(action.path)
    if (name === 'index.ts' || name === 'types.ts') {
      return { kind: 'pass' }
    }

    const lineCount = action.content.split(/\r?\n/).length
    if (lineCount <= maxLines) {
      return { kind: 'pass' }
    }

    return {
      kind: 'violation',
      reason: `Keep source files under ${maxLines} lines unless there is a strong reason to keep them larger.`,
    }
  }

export default defineConfig({
  rules: [
    forbidCommandPattern({
      match: /rm\s+-rf/,
      reason: '`rm -rf` is too broad; remove specific paths instead.',
    }),
    forbidCommandPattern({
      match: /git\s+commit\b[^\n]*--no-verify/,
      reason: 'Do not bypass hooks with `--no-verify`; fix the failing check instead.',
    }),
    forbidCommandPattern({
      match: /git\s+push\s+--force(?!-with-lease)\b/,
      reason: 'Use `--force-with-lease` if a forced push is truly necessary.',
    }),
    requireCommand({
      before: { kind: 'command', match: /git\s+commit\b/ },
      command: /npm\s+test\b/,
      after: { kind: 'write' },
      reason: 'Run npm test after code changes before creating a commit.',
    }),
    requireCommand({
      before: { kind: 'command', match: /git\s+commit\b/ },
      command: /npm\s+run\s+build\b/,
      after: { kind: 'write' },
      reason: 'Run npm run build after code changes before creating a commit.',
    }),
    {
      files: ['src/**', 'tests/**'],
      rules: [
        allowFlexibleButCleanFilenames,
        enforceTdd({
          instructions: (defaults) => `${defaults}

### Project standards

Treat a write as acceptable only when it also reflects professional TypeScript design:

1. Keep modules, classes, and functions focused on one responsibility unless the file is clearly orchestration code.
2. Prefer small abstractions and injected seams over hard-coded dependencies when that improves testability or separation of concerns.
3. Keep public contracts explicit and type-safe; do not introduce placeholder logic or weaken types to make a test pass.
4. Favor small extractions over long branch-heavy routines when the extraction makes intent materially clearer.
5. Keep changes narrowly scoped to the behavior under test; do not mix opportunistic refactors into the same step.
6. For bug fixes and features, add or update focused tests that capture the changed behavior.
`,
        }),
        forbidContentPattern({
          match: 'eslint-disable',
          reason: 'Fix the lint violation rather than disabling the rule.',
        }),
        forbidContentPattern({
          match: /@ts-(?:ignore|nocheck)/,
          reason: 'Fix the typing issue instead of suppressing TypeScript.',
        }),
        forbidContentPattern({
          match: /\b(?:TODO|FIXME)\b/,
          reason: 'Finish the behavior or track it outside the codebase; do not leave TODO/FIXME markers in committed code.',
        }),
      ],
    },
    {
      files: ['src/**/*.ts'],
      rules: [
        limitSourceFileLength(350),
        forbidContentPattern({
          match: /:\s*any\b|<any>|\bas any\b/,
          reason: 'Prefer explicit domain types in source files instead of any.',
        }),
      ],
    },
    {
      files: ['tests/**/*.ts'],
      rules: [
        forbidContentPattern({
          match: /\b(?:describe|it|test)\.(?:only|skip)\s*\(/,
          reason: 'Do not leave focused or skipped tests in committed test files.',
        }),
      ],
    },
  ],
})