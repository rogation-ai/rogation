import type { Meta, StoryObj } from "@storybook/react";
import { ConfidenceBadge } from "./ConfidenceBadge";

const meta: Meta<typeof ConfidenceBadge> = {
  title: "UI / ConfidenceBadge",
  component: ConfidenceBadge,
  argTypes: {
    score: { control: { type: "range", min: 0, max: 1, step: 0.01 } },
  },
};

export default meta;
type Story = StoryObj<typeof ConfidenceBadge>;

export const Low: Story = { args: { score: 0.25, explanation: "Only 3 supporting evidence rows." } };
export const Medium: Story = { args: { score: 0.6, explanation: "Seen across 2 segments." } };
export const High: Story = { args: { score: 0.9, explanation: "Supported by 47 evidence rows in 3 segments." } };

export const Ladder: Story = {
  render: () => (
    <div className="flex flex-col gap-2">
      <ConfidenceBadge score={0.1} />
      <ConfidenceBadge score={0.55} />
      <ConfidenceBadge score={0.95} />
    </div>
  ),
};
