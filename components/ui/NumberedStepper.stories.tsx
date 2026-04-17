import type { Meta, StoryObj } from "@storybook/react";
import { NumberedStepper } from "./NumberedStepper";

const meta: Meta<typeof NumberedStepper> = {
  title: "UI / NumberedStepper",
  component: NumberedStepper,
};

export default meta;
type Story = StoryObj<typeof NumberedStepper>;

export const OnboardingStart: Story = {
  args: {
    steps: [
      { label: "Upload", state: "current" },
      { label: "Cluster", state: "upcoming" },
      { label: "First insight", state: "upcoming" },
    ],
  },
};

export const OnboardingClustering: Story = {
  args: {
    steps: [
      { label: "Upload", state: "completed" },
      { label: "Cluster", state: "current" },
      { label: "First insight", state: "upcoming" },
    ],
  },
};

export const OnboardingDone: Story = {
  args: {
    steps: [
      { label: "Upload", state: "completed" },
      { label: "Cluster", state: "completed" },
      { label: "First insight", state: "completed" },
    ],
  },
};
