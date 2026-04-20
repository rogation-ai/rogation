import type { Meta, StoryObj } from "@storybook/react";
import { StreamingCursor } from "./StreamingCursor";

const meta: Meta<typeof StreamingCursor> = {
  title: "UI / StreamingCursor",
  component: StreamingCursor,
};

export default meta;
type Story = StoryObj<typeof StreamingCursor>;

export const Inline: Story = {
  render: () => (
    <p
      style={{
        color: "var(--color-text-primary)",
        fontSize: "0.875rem",
      }}
    >
      As a PM, I want to filter evidence by segment so I can tell mobile
      and desktop pain apart
      <StreamingCursor />
    </p>
  ),
};

export const Block: Story = {
  render: () => (
    <h2
      style={{
        fontFamily: "var(--font-display)",
        color: "var(--color-text-primary)",
        fontSize: "1.5rem",
      }}
    >
      Filter by segment
      <StreamingCursor variant="block" />
    </h2>
  ),
};
