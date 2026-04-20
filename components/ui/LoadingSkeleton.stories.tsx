import type { Meta, StoryObj } from "@storybook/react";
import {
  SkeletonCard,
  SkeletonHeading,
  SkeletonLine,
  SkeletonList,
} from "./LoadingSkeleton";

const meta: Meta = {
  title: "UI / LoadingSkeleton",
};

export default meta;
type Story = StoryObj;

export const Line: Story = {
  render: () => <SkeletonLine />,
};

export const Heading: Story = {
  render: () => <SkeletonHeading />,
};

export const Card: Story = {
  render: () => (
    <div className="w-96">
      <SkeletonCard lines={3} />
    </div>
  ),
};

export const List: Story = {
  name: "List (default use)",
  render: () => (
    <div className="w-96">
      <SkeletonList count={4} />
    </div>
  ),
};
