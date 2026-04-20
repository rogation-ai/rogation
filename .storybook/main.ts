import type { StorybookConfig } from "@storybook/nextjs";

/*
  Storybook 10 config for Rogation's shared UI primitives.

  Component stories live next to the component under `components/ui/`.
  Keep the glob specific so a random *.stories.tsx in app/ or lib/
  doesn't get picked up accidentally.

  Addons:
  - docs: auto-generated prop tables + MDX support.
  - a11y: live axe-core checks against every story (DESIGN.md §9
    WCAG 2.2 AA baseline).
  - onboarding: Storybook's first-run tutorial. Safe to delete once
    the team is onboarded.
*/
const config: StorybookConfig = {
  stories: ["../components/**/*.stories.@(ts|tsx|mdx)"],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-onboarding",
  ],
  framework: {
    name: "@storybook/nextjs",
    options: {},
  },
  typescript: {
    check: false,
    reactDocgen: "react-docgen-typescript",
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
    },
  },
};

export default config;
