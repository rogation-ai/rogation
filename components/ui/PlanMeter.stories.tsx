import type { Meta, StoryObj } from "@storybook/react";
import { PlanMeter } from "./PlanMeter";

const meta: Meta<typeof PlanMeter> = {
  title: "UI / PlanMeter",
  component: PlanMeter,
  args: {
    label: "Evidence",
    plan: "free",
    onUpgrade: () => {},
  },
  argTypes: {
    plan: { control: "inline-radio", options: ["free", "solo", "pro"] },
  },
};

export default meta;
type Story = StoryObj<typeof PlanMeter>;

export const Empty: Story = { args: { current: 0, max: 10 } };
export const Low: Story = { args: { current: 3, max: 10 } };
export const Half: Story = { args: { current: 5, max: 10 } };
export const SoftCap: Story = { args: { current: 8, max: 10 } };
export const AtLimit: Story = {
  args: { current: 10, max: 10 },
  parameters: {
    docs: { description: { story: "Free tier at cap shows the inline Upgrade button." } },
  },
};
export const OverLimit: Story = { args: { current: 12, max: 10 } };
export const Unlimited: Story = {
  args: { current: 47, max: "unlimited", plan: "pro" },
  parameters: {
    docs: { description: { story: "Paid tiers show only the count — no bar, no CTA." } },
  },
};
