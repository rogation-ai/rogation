import type { Meta, StoryObj } from "@storybook/react";
import { SeverityPill } from "./SeverityPill";

const meta: Meta<typeof SeverityPill> = {
  title: "UI / SeverityPill",
  component: SeverityPill,
};

export default meta;
type Story = StoryObj<typeof SeverityPill>;

export const Low: Story = { args: { severity: "low" } };
export const Medium: Story = { args: { severity: "medium" } };
export const High: Story = { args: { severity: "high", count: 34 } };
export const Critical: Story = { args: { severity: "critical", count: 2 } };

export const Ladder: Story = {
  render: () => (
    <div className="flex gap-2">
      <SeverityPill severity="low" />
      <SeverityPill severity="medium" />
      <SeverityPill severity="high" />
      <SeverityPill severity="critical" />
    </div>
  ),
};
