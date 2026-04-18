import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { FeedbackThumbs, type ThumbsRating } from "./FeedbackThumbs";

const meta: Meta<typeof FeedbackThumbs> = {
  title: "UI / FeedbackThumbs",
  component: FeedbackThumbs,
};

export default meta;
type Story = StoryObj<typeof FeedbackThumbs>;

function InteractiveDemo({ size = "sm" as "sm" | "lg" }) {
  const [value, setValue] = useState<ThumbsRating>(null);
  return (
    <div className="flex items-center gap-4">
      <FeedbackThumbs
        value={value}
        onChange={setValue}
        size={size}
        label="Rate cluster"
      />
      <span
        className="text-xs"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Current: {value ?? "none"}
      </span>
    </div>
  );
}

export const Interactive: Story = {
  render: () => <InteractiveDemo />,
};

export const InteractiveLarge: Story = {
  render: () => <InteractiveDemo size="lg" />,
};

export const Unvoted: Story = {
  args: { value: null, onChange: () => {}, label: "Rate spec" },
};

export const ThumbsUp: Story = {
  args: { value: "up", onChange: () => {}, label: "Rate spec" },
};

export const ThumbsDown: Story = {
  args: { value: "down", onChange: () => {}, label: "Rate spec" },
};

export const Disabled: Story = {
  args: { value: "up", onChange: () => {}, disabled: true },
};
