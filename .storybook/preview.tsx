import type { Preview } from "@storybook/react";
import "../app/globals.css";

/*
  Every story gets wrapped in the project's Tailwind 4 + DESIGN.md
  tokens. Storybook's backgrounds addon lets reviewers flip between
  marketing (warm cream) and app (white) surfaces without writing
  two variants per story.

  Dark mode: the preview loads globals.css which has the
  prefers-color-scheme rule, so toggling the browser's system dark
  mode flips every component. Explicit dark-mode addon is a follow-up
  if per-story toggling becomes painful.
*/
const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: "app",
      values: [
        { name: "app", value: "#FFFFFF" },
        { name: "marketing", value: "#F8F1E6" },
        { name: "sunken", value: "#F5F2EC" },
        { name: "dark-app", value: "#0E0D0B" },
        { name: "dark-marketing", value: "#14120F" },
      ],
    },
    a11y: {
      test: "error",
    },
  },
};

export default preview;
