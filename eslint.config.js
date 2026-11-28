/**
 * Minimal, high-signal ESLint setup.
 *
 * This is a bug net, not a style police: the project has no formatter and is not going to get one
 * (see AGENTS.md — "avoid formatting-only changes"). Every rule below catches something that is
 * almost certainly a real defect: a duplicated key that silently wins, code after a return, an
 * assignment to a constant, a comparison that is always true. Style rules stay out, so the config
 * does not fight the existing 66k lines.
 *
 * `no-undef` is deliberately NOT enabled: it needs an accurate list of Node and browser globals,
 * and a wrong list turns a useful check into noise. ESLint's own `recommended` is not extended
 * either — it drags style rules in.
 */
export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    linterOptions: {
      reportUnusedDisableDirectives: false
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unexpected-multiline': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-constant-binary-expression': 'error',
      'no-obj-calls': 'error',
      'no-sparse-arrays': 'error',
      'for-direction': 'error',
      'valid-typeof': 'error',
      'no-compare-neg-zero': 'error',
      'no-fallthrough': 'error',
      'no-redeclare': 'error',
      'no-case-declarations': 'error',
      'no-empty-pattern': 'error',
      'no-async-promise-executor': 'error',
      'no-misleading-character-class': 'error',
      'no-prototype-builtins': 'error',
      'no-useless-catch': 'error',
      'no-with': 'error',
      'require-atomic-updates': 'off'
    }
  }
];
