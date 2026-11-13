export default {
  extends: ['stylelint-config-standard'],
  /*
   * Mirrors `packages/config/eslint/base.mjs`. Build output is not project CSS, and neither is the
   * vendored MSW worker or the agent workspaces `.gitignore` lists: linting them reports on files
   * no contributor writes.
   */
  ignoreFiles: [
    '**/dist/**',
    '**/dist-demo/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/temp/**',
    '**/.turbo/**',
    '**/.codex/**',
    '**/.claude/**',
    '**/.cursor/**',
    '**/.windsurf/**',
    '**/.continue/**',
    '**/.gemini/**',
    '**/.roo/**',
    '**/.kiro/**',
    '**/.openhands/**',
    '**/.specstory/**',
    '**/.codebuddy/**',
    '**/.trae/**',
    '**/.qoder/**',
    '**/public/**',
  ],
  rules: {
    'at-rule-no-unknown': [
      true,
      {
        ignoreAtRules: [
          'theme',
          'apply',
          'tailwind',
          'custom-variant',
          'variant',
          'utility',
          'source',
          'plugin',
          'reference',
          'layer',
        ],
      },
    ],

    /*
     * Notation, in the shorter of the two forms each rule accepts.
     *
     * These four are the only rules in this file that *override* `stylelint-config-standard`
     * rather than add to it: the shared preset asks for `url()` imports, `angle` hue, `percentage`
     * lightness and percentage alpha (with per-property exceptions), while every stylesheet here
     * writes `@import './x.css'`, `120`, `50` and `/ 0.5`. Adopting the preset's values would be
     * churn across the token layer with no rendering difference, so the deviation is declared
     * once, here, where the next reader will look for it.
     *
     * `color-function-notation` and `media-feature-range-notation` are deliberately absent: the
     * preset already sets `modern` and `context`, and restating them is a second place to forget.
     */
    'import-notation': 'string',
    'alpha-value-notation': 'number',
    'hue-degree-notation': 'number',
    'lightness-notation': 'number',

    'selector-class-pattern': null,
    'custom-property-pattern': null,
    'no-descending-specificity': null,
    'declaration-block-no-redundant-longhand-properties': null,
    'keyframes-name-pattern': null,
    /*
     * `@utility name { &::after { … } }` is the Tailwind v4 form of a custom utility: the
     * at-rule *is* the scoping root, but stylelint does not know that and reports every
     * nested selector inside it. The rule stays on for ordinary CSS nesting.
     */
    'nesting-selector-no-missing-scoping-root': [true, { ignoreAtRules: ['utility'] }],

    /*
     * The token layer is the single source of colour. `color-no-hex` is exempted for
     * `tokens.css` alone (it is the one file allowed to hold a literal); every other sheet
     * must reach a literal through a token, so a one-off shade cannot be introduced inside
     * a component-adjacent stylesheet where nobody looks for it.
     */
    'color-no-hex': true,
    'color-named': 'never',

    /*
     * Nothing in the stylesheet needs `!important`: every override that must beat a utility
     * is already unlayered, and unlayered declarations win over every cascade layer.
     */
    'declaration-no-important': true,

    /*
     * Sizes that must follow a token: a font size belongs to the type scale, and a focus
     * offset belongs to `--focus-ring-offset`.
     */
    'declaration-property-value-disallowed-list': {
      '/^font-size$/': ['/^[0-9.]+px$/'],
      '/^outline-offset$/': ['/^[0-9.]+px$/'],
    },
  },
  overrides: [
    {
      files: ['**/styles/tokens.css'],
      rules: {
        // The one place a colour literal is allowed to live.
        'color-no-hex': null,
        // Token pairs carry `light-dark()` colours, not sizes, so the px bans still apply.
      },
    },
    {
      /*
       * `adaptations.css` holds *conditional* values: a preference (`prefers-contrast: more`)
       * that must re-pair a token. A pair cannot live in `@theme` because it is not the
       * default value, and writing it as a `var()` reference to a token that nothing else
       * uses would add a dozen names for one media query. The literals stay here on the
       * condition that they are always `light-dark(light, dark)` pairs — never a single
       * scheme — so this file cannot reintroduce the high-contrast bug it replaced.
       */
      files: ['**/styles/adaptations.css'],
      rules: {
        'color-no-hex': null,
      },
    },
  ],
};
