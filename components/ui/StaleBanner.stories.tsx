import type { Meta, StoryObj } from "@storybook/react";
import { StaleBanner } from "./StaleBanner";

const meta: Meta<typeof StaleBanner> = {
  title: "UI / StaleBanner",
  component: StaleBanner,
  args: {
    message: "Add ~10 more pieces for stronger clusters",
    onAction: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof StaleBanner>;

export const ThinCorpus: Story = {
  args: {
    message: "Add ~10 more pieces for stronger clusters",
    actionLabel: "Upload more",
  },
};

export const StaleClusters: Story = {
  args: {
    message: "New evidence added — refresh clusters to include it",
  },
};

export const Refreshing: Story = {
  args: {
    message: "New evidence added — refresh clusters to include it",
    isRunning: true,
  },
};

export const Dismissible: Story = {
  args: {
    message: "New evidence added — refresh clusters to include it",
    onDismiss: () => {},
  },
};
