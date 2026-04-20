import type { Meta, StoryObj } from "@storybook/react";
import { FrequencyBar } from "./FrequencyBar";

const meta: Meta<typeof FrequencyBar> = {
  title: "UI / FrequencyBar",
  component: FrequencyBar,
};

export default meta;
type Story = StoryObj<typeof FrequencyBar>;

export const Low: Story = {
  args: { value: 2, max: 20 },
};

export const Medium: Story = {
  args: { value: 9, max: 20 },
};

export const High: Story = {
  args: { value: 18, max: 20 },
};

export const WithLabel: Story = {
  args: { value: 7, max: 20, label: "7 mentions" },
};

export const Large: Story = {
  args: { value: 15, max: 20, size: "lg", label: "15 / 20" },
};

export const ClusterListPreview: Story = {
  render: () => {
    const rows = [
      { title: "Onboarding is confusing", count: 18 },
      { title: "Share links expire", count: 14 },
      { title: "Mobile search lag", count: 11 },
      { title: "Pricing unclear", count: 7 },
      { title: "CSV export loses columns", count: 3 },
    ];
    const max = Math.max(...rows.map((r) => r.count));
    return (
      <div className="flex max-w-sm flex-col gap-3">
        {rows.map((r) => (
          <div key={r.title} className="flex flex-col gap-1">
            <span
              className="text-sm"
              style={{ color: "var(--color-text-primary)" }}
            >
              {r.title}
            </span>
            <FrequencyBar
              value={r.count}
              max={max}
              label={`${r.count} pieces`}
            />
          </div>
        ))}
      </div>
    );
  },
};
